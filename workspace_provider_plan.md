# Workspace Provider 實作計畫

## 目的

為 background subagent 提供獨立、可清理、可檢查並可整合回主工作區的 filesystem workspace。

目前 child agent 已隔離 Pi process、context 與 persisted session，但仍直接使用傳入的 `cwd`。Workspace Provider 將位於 subagent orchestration 與 `runner.ts` 之間，負責把來源目錄轉換成 child 專用的執行目錄。

## 本階段不包含

這份文件只描述後續設計，目前不建立 provider interface，也不改變現有 shared-workspace 行為。

初版不處理：

- Remote execution
- 自動建立 GitHub PR
- 跨機器 artifact transport
- 完整 container/VM runtime
- 自動解決所有 merge conflicts
- 自動複製或重建所有語言的 runtime environment

## 核心需求

1. Read-only 與 mutating agent 可以採用不同隔離策略。
2. Git repository 優先使用 dedicated worktree。
3. 非 Git 目錄使用 filesystem snapshot/copy。
4. 每個 workspace 綁定一個 top-level run；chain steps 預設共用 chain workspace。
5. Subagent 的所有工具與 shell command 都以 workspace root 為 `cwd`。
6. 完成後可以 inspect、apply、discard 或保留 workspace。
7. Stop、session shutdown、extension reload 與 delete 都有明確的 cleanup policy。
8. 不因 background completion 自動修改 main workspace。
9. Main workspace 從 task 開始後若有變更，apply 時必須偵測衝突。
10. Workspace metadata 可以持久化，但不可把 secrets、完整檔案內容或 child transcript寫入 main session pointer。

## 建議公開模型

```ts
type WorkspaceKind = "shared" | "git-worktree" | "directory-snapshot";
type WorkspaceAccess = "read" | "write";
type WorkspaceState =
  | "creating"
  | "ready"
  | "running"
  | "completed"
  | "applying"
  | "applied"
  | "conflicted"
  | "discarded"
  | "cleanup-failed";

interface WorkspaceRequest {
  runId: string;
  ownerSessionId: string;
  sourceCwd: string;
  access: WorkspaceAccess;
  preferredKind?: WorkspaceKind | "auto";
}

interface WorkspaceHandle {
  id: string;
  kind: WorkspaceKind;
  state: WorkspaceState;
  sourceCwd: string;
  cwd: string;
  baseRevision?: string;
  branchName?: string;
  metadataPath?: string;
  createdAt: number;
}

interface WorkspaceChangeSet {
  added: string[];
  modified: string[];
  deleted: string[];
  binary: string[];
  commits?: string[];
  patchPath?: string;
}

interface ApplyOptions {
  strategy: "fast-forward" | "merge" | "cherry-pick" | "files" | "three-way";
  paths?: string[];
}

interface WorkspaceProvider {
  canHandle(request: WorkspaceRequest): Promise<boolean>;
  create(request: WorkspaceRequest): Promise<WorkspaceHandle>;
  inspect(handle: WorkspaceHandle): Promise<WorkspaceChangeSet>;
  apply(handle: WorkspaceHandle, options: ApplyOptions): Promise<ApplyResult>;
  discard(handle: WorkspaceHandle): Promise<void>;
  cleanup(handle: WorkspaceHandle): Promise<void>;
}
```

實際 runner 只接收 resolved workspace：

```ts
runSingleAgent({
  cwd: workspace.cwd,
  // existing options
});
```

## Provider 選擇規則

建議 `workspace: "auto"`：

```text
read-only + explicitly shared
  -> SharedWorkspaceProvider

Git repository + write
  -> GitWorktreeProvider

Non-Git directory + write
  -> DirectorySnapshotProvider

Unknown access
  -> 保守視為 write
```

是否會修改 workspace 不應只從 `tools` 推測，因為 `bash` 也能寫檔。建議 agent frontmatter 增加明確 metadata：

```yaml
workspaceAccess: read
```

或：

```yaml
workspaceAccess: write
```

未宣告時視為 `write`。

## GitWorktreeProvider

### 建立

1. 使用 `git rev-parse --show-toplevel` 找 repository root。
2. 使用 `git rev-parse --git-common-dir` 建立穩定 repository identity。
3. 檢查來源 branch、HEAD 與 dirty state。
4. 在 Pi agent directory 外部管理 worktree：

```text
<getAgentDir()>/subagent-workspaces/<repo-id>/<run-id>/
```

5. 建立專用 branch：

```text
pi-agent/<main-session-id>/<run-id>
```

6. 執行：

```bash
git worktree add -b <branch> <workspace-path> <base-revision>
```

7. 將 workspace path 記錄到 run metadata。

### Dirty main workspace policy

Git worktree 從 commit 建立，不會包含 main worktree 的 uncommitted changes。初版建議：

- Mutating background run 預設要求 clean source workspace。
- 若 dirty，回傳明確錯誤並要求使用者 commit，或明確選擇 shared workspace。
- 不自動使用 `git stash`，因為 stash namespace 與 repository state 會被平行 runs 共享。

後續可加入不修改 main index 的 temporary tree snapshot，但不列入 MVP。

### Agent 完成

建議 mutating agent 在 branch 上 commit。若沒有 commit，可以由 provider 建立一個明確標示的 final snapshot commit，或保留 working-tree diff 供 main review；此行為必須可設定。

### Inspect

提供：

```bash
git log <base>..<branch>
git diff --stat <base>...<branch>
git diff --binary <base>...<branch>
```

將 commit list、changed paths 與 diff summary 回傳 main agent，不自動 apply。

### Apply strategies

- `fast-forward`：main branch 沒有 diverge 時使用 `git merge --ff-only`。
- `merge`：允許 merge commit，衝突時停止並回報。
- `cherry-pick`：選擇一個或多個 agent commits。
- `files`：使用 `git restore --source=<branch> -- <paths>` 只取指定檔案。
- `three-way`：rebase/merge 後保留衝突供 main agent處理。

Apply 前必須重新取得 main HEAD 與 working-tree status，不能依賴 task 啟動時的狀態。

### Cleanup

安全順序：

1. 確認 child process 已終止。
2. 確認 workspace 沒有未保存且未被使用者允許丟棄的修改。
3. `git worktree remove <path>`。
4. `git worktree prune` 僅在必要時執行。
5. 已整合或明確 discard 後才刪除 branch。
6. Cleanup 失敗時保留 metadata 和路徑，不使用無條件 `--force` 隱藏資料遺失。

## DirectorySnapshotProvider

### 建立 base snapshot

非 Git 目錄需保留三方合併所需的 base：

```text
B = task 啟動時的 base snapshot
A = agent 完成後的 workspace
M = apply 時的 main workspace
```

優先順序：

1. Filesystem reflink clone：`cp -a --reflink=auto`
2. 支援時使用 APFS/Btrfs/ZFS snapshot
3. `rsync -a` copy
4. 未支援時回報成本並要求確認

建議 layout：

```text
<getAgentDir()>/subagent-workspaces/<source-id>/<run-id>/
├── base/
├── working/
└── metadata.json
```

若空間成本過高，可把 base 改成 content-addressed manifest 加上只保存變更前內容的 lazy backup，但不列入 MVP。

### Ignore policy

非 Git 目錄沒有可靠的 tracked/untracked 邊界。Provider 應支援：

- `.gitignore`（即使沒有 `.git` 也可作為提示）
- `.piworkspaceignore`
- 預設大型 cache：`.venv`, `node_modules`, `dist`, `.cache`, build outputs
- 使用者 override

不能靜默忽略可能影響行為的檔案；建立完成後要記錄實際 exclude list。

### Change detection

對 base 和 working 建立 manifest：

```ts
interface FileManifestEntry {
  path: string;
  type: "file" | "directory" | "symlink";
  size?: number;
  mtimeMs?: number;
  hash?: string;
  linkTarget?: string;
  mode?: number;
}
```

小型文字檔使用 content hash。大型 binary 可先 size/mtime，再需要時 hash。

### Apply

逐檔比較 B/A/M：

| 條件 | 行為 |
|---|---|
| `M == B` 且 `A != B` | 安全套用 agent 版本 |
| `A == B` | 不處理 |
| `M != B` 且 `A != B` | three-way merge 或 conflict |
| Agent 新增且 main 不存在 | 建立檔案 |
| Agent 與 main 新增同名不同內容 | conflict |
| Agent 刪除且 main 未改 | 刪除 |
| Binary 雙方都改 | 不自動 merge |

文字檔可使用 diff3 或 `git merge-file`，即使來源目錄本身不是 Git repository。Apply 必須先寫 temporary file，再 atomic rename，避免中途失敗留下半個檔案。

### Internal temporary Git

可以只在 snapshot workspace 內建立 temporary Git repository，用來產生 diff、commit 與 binary patch；不得未經允許在 source directory 執行 `git init`。

Temporary commit 只是 change bundle，不能對非 Git source 做 fast-forward；最終仍走 file apply/three-way merge。

## SharedWorkspaceProvider

只回傳來源 `cwd`，不建立副本。

使用限制：

- Read-only agent 可預設允許。
- Mutating background agent 必須明確 opt in。
- UI 與 tool result 必須標示 `workspace: shared`。
- 多個 mutating runs 不保證安全；初版可使用 single writer lock。

這個 provider 也讓現有行為可以在導入 workspace abstraction 後保持相容。

## Chain workspace policy

Chain 的 parent run 建立一個 workspace，所有 child steps 共用：

```text
explorer -> planner -> worker
                  same workspace cwd
```

原因：

- 後續 step 需要看見前一步修改。
- 只產生一個整合單位。
- Stop/delete/cleanup 由 parent 管理。

單一 child continuation 的 workspace policy：

- 若 source workspace 仍保留，可以 fork 同一基礎建立新 workspace。
- 不直接重用已完成 workspace 的 writable state，避免 sibling continuations互相影響。
- Git 可從 source run 的 final commit 建新 worktree branch。
- Directory snapshot 可從 source final snapshot建立新 working copy。

## Runtime environment

Workspace isolation 不等於 environment isolation。

Provider metadata 應可記錄：

```ts
interface WorkspaceEnvironment {
  strategy: "inherit" | "per-workspace" | "shared-dependencies";
  virtualEnvPath?: string;
  envOverrides?: Record<string, string>;
}
```

Python 建議：

- 每個 workspace 建立自己的 `.venv`。
- 共用 uv/pip download cache。
- 不繼承指向 main `.venv` 的 `VIRTUAL_ENV`/`PATH`。
- 避免共用指向 main 絕對路徑的 editable install。

Node 建議：

- 每個 workspace 保留自己的 `node_modules` links。
- 共用 pnpm/npm package cache。
- 不讓 background agent 修改 main workspace 的 `node_modules`。

還要隔離或配置：

- test database
- SQLite files
- ports
- temporary directories
- build output directories
- Docker Compose project name

Environment manager 可在 Workspace Provider MVP 之後獨立實作。

## Run metadata 與 persistence

建議在 `SubagentRun` 增加：

```ts
workspace?: {
  id: string;
  kind: WorkspaceKind;
  state: WorkspaceState;
  sourceCwd: string;
  cwd: string;
  baseRevision?: string;
  branchName?: string;
};
```

Main-session pointer 只保存定位、狀態與目前既有的 bounded completion summary。完整 manifest、patch、檔案內容和 provider metadata 放在 agent directory 的 workspace storage。

Reload 時：

- 正在執行的 run 依現有規則標記 aborted。
- Workspace 不自動刪除。
- 使用者仍可 inspect/apply/discard。

## Control API 擴充

後續可擴充 `subagent_control`：

```json
{ "action": "workspace-status", "runId": "&1" }
{ "action": "workspace-diff", "runId": "&1" }
{ "action": "workspace-apply", "runId": "&1", "strategy": "fast-forward" }
{ "action": "workspace-apply", "runId": "&1", "strategy": "files", "paths": ["src/a.ts"] }
{ "action": "workspace-discard", "runId": "&1" }
```

若要維持 control schema 簡潔，也可獨立建立 `subagent_workspace` tool；實作前需比較模型選擇負擔。

## Concurrency 與 locking

- Workspace create/apply/cleanup 不占 child-process pool slot。
- 同一 Git repository 的 `git worktree add/remove` 使用 repository-level mutex。
- 同一 source workspace 的 apply 使用 exclusive lock。
- Inspect 可讀鎖。
- Directory apply 逐次 transaction，不允許兩個 runs 同時套用到同一 source。
- Stop queued run 時，若 workspace 已建立但 child 未 spawn，依 retention policy cleanup 或保留供診斷。

## 安全要求

1. 所有 managed workspace path 必須位於驗證過的 agent directory root。
2. 防止 symlink traversal，沿用 `child-sessions.ts` 的 canonical-path 驗證模式。
3. Cleanup 必須驗證 workspace id、metadata 與 canonical path。
4. 不跟隨 snapshot 內指向來源外部的 symlink 進行複製或刪除。
5. Apply 前驗證 destination path 仍位於 source root。
6. 不自動複製 secrets directory、SSH agent socket 或 credentials cache。
7. 不自動執行 agent branch 中新增的 integration script。
8. 不在未確認情況下 force-remove dirty workspace。

## 實作階段

### Phase 1：Shared abstraction

- 加入 `WorkspaceProvider` interface。
- 實作 `SharedWorkspaceProvider`，保持現有行為。
- Runner 改接收 `WorkspaceHandle.cwd`。
- Run pointer 保存最小 workspace metadata。
- 不改變使用者預設。

### Phase 2：Git worktree MVP

- Repository detection。
- Clean-tree guard。
- Branch/worktree create。
- Diff/commit inspection。
- Fast-forward、cherry-pick、selected-files apply。
- Safe cleanup 與 retention。

### Phase 3：Directory snapshot MVP

- Reflink/rsync copy。
- Base/working manifest。
- Added/modified/deleted detection。
- Safe apply 與 conflict reporting。
- Text three-way merge。

### Phase 4：Environment setup

- Per-workspace command hooks。
- Python `.venv` strategy。
- Node dependency strategy。
- Shared immutable caches。

### Phase 5：進階整合

- Worktree rebase/merge conflict assistance。
- Apply UI/viewer。
- Workspace retention policy與 garbage collection。
- Container/VM provider。

## 測試計畫

### Provider contract

- create 回傳 canonical managed cwd。
- inspect 不修改 source。
- apply 是 explicit operation。
- cleanup idempotent。
- stop/shutdown race 不遺失 workspace metadata。

### Git worktree

- clean repository 建立獨立 branch/worktree。
- main 檔案不受 child edit 影響。
- main 未 diverge 時 fast-forward。
- diverge 時拒絕 `--ff-only` 並回報。
- cherry-pick 與 selected files。
- dirty source guard。
- parallel worktree create/remove lock。
- cleanup 不刪除未整合修改。

### Directory snapshot

- 新增、修改、刪除與 symlink。
- Main 未變更時安全 apply。
- Main 與 agent 修改同一文字檔時 three-way merge。
- Binary conflict。
- Atomic apply failure rollback。
- Ignore policy。
- Reflink unavailable fallback。

### Security

- Source/workspace symlink escape。
- Malicious `../` path。
- Replaced metadata file。
- Cleanup target 被 swap 成 symlink。
- Apply destination escape。

### Integration

- Background single run。
- Chain 共用 workspace。
- Continuation fork workspace。
- Queued stop。
- Running stop。
- Session shutdown/reload。
- Completion notification包含 workspace state但不自動 apply。

## 待決策項目

1. Mutating agent 是否預設要求 clean Git tree？建議是。
2. Agent 是否必須 commit？建議 Git provider 預設要求或建立 final snapshot commit。
3. 完成後 workspace 保留多久？建議至少保留到 explicit apply/discard/delete。
4. Chain child runs 是否個別顯示 workspace？建議只顯示 parent workspace id。
5. Apply 是否放在 `subagent_control` 或獨立 tool？需要用 schema/eval 比較模型可靠度。
6. Read-only explorer 是否也使用 snapshot，取得一致 view？初版可 shared，之後提供 `consistentRead` 選項。
7. Non-Git snapshot 預設 exclude 清單如何讓使用者檢查與覆寫？建議 `.piworkspaceignore` 加設定檔。
