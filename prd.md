# PRD：Session-backed Subagent Continuation 與 API 精簡

## 1. 背景

目前 extension 的 follow-up 由 `subagent_control action=ask` 完成。它會將來源 run 的 task、final output 與部分 transcript 組成一個新 prompt，再交給一個使用 `--no-session` 啟動的新 child Pi process。

這會重做 Pi 已有的 conversation/session 能力，並有以下問題：

- history 被壓平成文字，失去 user、assistant、toolResult 等角色結構。
- transcript 需要自行截斷與維護。
- 無法自然使用 Pi session 的 compaction、branch 與持久化。
- `ask` 是建立新 agent run，不屬於 `subagent_control` 的 run-control 職責。
- `ponytailMode` 與 `PONYTAIL_DEFAULT_MODE` 不是 subagent orchestration 的核心能力，卻散布在 schemas、types、runner、scheduler、README 與 tests。

本 PRD 將 child run 改成獨立的 persisted Pi session，並以 `subagent.continueFrom` 取代 `subagent_control ask`。

---

## 2. 目標

1. 完整移除 Ponytail 專屬功能。
2. 將 `subagent_control` 精簡為 `list/status/stop/delete`。
3. 新增 `subagent.continueFrom`，可從既有 run 的 conversation 繼續提問。
4. 每個 child run 使用獨立 Pi session，不再使用 `--no-session`。
5. 每次 continuation 都從來源 run 的完成 leaf 建立新的 branched session，避免多個 process 同時寫同一個 session file。
6. Child history 不拼接進新 prompt，也不進入 main agent 的 LLM context。
7. 保留更換 agent 的能力；未指定 agent 時沿用來源 agent。
8. 維持 single、parallel、chain、background 與 schedule 的既有功能。
9. Run list、status、autocomplete、viewer 與 run refs 僅能存取目前 main Pi session 所擁有的 subagent runs。

---

## 3. 非目標

本階段不做：

- `bg_agent.continueFrom`。
- Scheduled continuation。
- Parallel/chain item 內的 `continueFrom`。
- 多個 child process 共用並同時寫入同一個 session file。
- 將 child session 顯示在 Pi 內建 `/resume` 清單。
- 自訂 child session compaction 策略。
- 跨不同 cwd continuation。第一版 continuation 必須沿用來源 run cwd。

---

## 4. 最終公開 API

### 4.1 Fresh single run

```json
{
  "agent": "explorer",
  "task": "調查 auth 流程"
}
```

### 4.2 Continue existing run

沿用來源 agent：

```json
{
  "continueFrom": "&1",
  "task": "再檢查其中的安全風險"
}
```

改用另一個 agent：

```json
{
  "continueFrom": "&1",
  "agent": "reviewer",
  "task": "審查前面的調查結果"
}
```

### 4.3 Control runs

```json
{ "action": "list" }
```

```json
{ "action": "status", "runId": "&1" }
```

```json
{ "action": "stop", "runId": "&1" }
```

```json
{ "action": "delete", "runId": "&1" }
```

### 4.4 Single-mode validation

合法：

- `{ agent, task }`
- `{ continueFrom, task }`
- `{ continueFrom, agent, task }`

不合法：

- `{ task }`
- `{ continueFrom }`
- `continueFrom` 與 `tasks` 同時出現
- `continueFrom` 與 `chain` 同時出現
- 同時提供 fresh single、parallel 或 chain 等多種模式

### 4.5 Continuation defaults

- `agent`：預設沿用來源 run agent。
- `agentScope`：預設沿用來源 run 的 discovery scope。
- `cwd`：必須沿用來源 run cwd；第一版若明確傳入不同 cwd，回傳 validation error。
- `confirmProjectAgents`：沿用目前安全規則；若 continuation 選到 project agent，TUI 預設仍需確認。

---

## 5. Session 設計決策

### 5.1 Session directory

Child sessions 使用專用目錄，不放入一般 Pi sessions，也不寫入 repository：

```text
<getAgentDir()>/subagent-sessions/<main-session-or-runtime-id>/
```

要求：

- 不出現在 Pi 一般 `/resume` 清單。
- 不在專案 Git working tree 產生 `.pi/subagent-sessions`。
- session file 僅由 extension 管理。

### 5.2 Fresh run

Fresh run 建立唯一 child session id，child process 使用：

```text
--session-id <generated-id>
--session-dir <managed-child-session-dir>
```

child 結束後，extension 解析並保存：

- `sessionId`
- `sessionDir`
- `sessionFile`
- `leafId`

### 5.3 Continuation run

來源 run 必須具有 `sessionFile` 與 `leafId`。

流程：

1. `SessionManager.open(source.sessionFile)`。
2. 從 `source.leafId` 呼叫 `createBranchedSession()`。
3. 取得新的 session file。
4. 新 child process 使用 `--session <new-session-file>`。
5. 僅將新的 `task` 作為 user prompt；不得拼接來源 transcript/output。
6. child 結束後保存新 session 的 leaf。

每次 continuation 都建立不同 session file：

```text
&1
├── &2 continuation A
└── &3 continuation B
```

### 5.4 Main-agent context boundary

允許進入 main agent LLM context：

- 使用者提供的 tool arguments。
- 本次 child run 的 final answer。
- 短錯誤或狀態訊息。

禁止進入 main agent LLM context：

- 完整 child history。
- 來源 run transcript。
- 為 continuation 重建的 `Previous output` prompt。
- child session JSONL 內容。

`pi.appendEntry()` custom entries可以保存 pointer metadata，因為 custom entry 不參與 LLM context。不得使用 `pi.sendMessage()` 或 `appendCustomMessageEntry()` 保存 child history。

### 5.5 Main-session ownership

每個 `SubagentRun` 必須記錄建立它的 main Pi session，例如 `ownerSessionId`。Run refs 是 session-local：`&1` 只在其 owner session 中解析。

- `session_start` 時將 run store 的 active scope 切換成 `ctx.sessionManager.getSessionId()`。
- `list/status/find/stop/delete` 只能操作 active scope。
- Run-ref autocomplete、普通 prompt 中的 `&N` 注入及 viewer 也只能讀 active scope。
- Background/scheduled run 必須捕捉啟動時的 owner session，之後即使 main session 切換，更新也只能寫回原 scope。
- `/new`、切換到不相關的 `/resume` session 時不得看見舊 session runs。
- Resume 原 session 時，可由該 main session 的 custom pointer entries 還原 runs。
- 同一 session file 的 `/tree` branches 共享 session id；本階段採 session-level isolation，不做 branch-level filtering。

---

# 6. Ticket 清單

> 每個 ticket 都應單獨完成、單獨測試，且完成時 repository 必須可通過 typecheck 與既有 tests。除非 ticket 明確要求，請勿提前實作後續 ticket。

---

## SUB-001：完整移除 Ponytail 功能

**依賴：** 無

### 目標

從 extension 的公開 API、agent frontmatter、runtime、schedule、types、tests 與文件中移除 Ponytail。

### 修改檔案

- `agents.ts`
- `schemas.ts`
- `types.ts`
- `runner.ts`
- `manager.ts`
- `index.ts`
- `scheduler.ts`
- `README.md`
- `tests/agents-settings.test.ts`
- `tests/runner-env.test.ts`

### 工作內容

- 移除 `PonytailMode` type。
- 移除 `normalizePonytailMode()`。
- 移除 `AgentConfig.ponytailMode` 與 frontmatter parsing。
- 移除所有 schemas 中的 `ponytailMode`。
- 移除所有 params、run、result、schedule job 中的 `ponytailMode`。
- 移除 `getChildEnv()` 與 `PONYTAIL_DEFAULT_MODE` override。
- child process 恢復自然繼承 parent environment。
- schedule loader 忽略舊 JSON 中的 `ponytailMode`，下一次 save 不再寫回。
- 刪除 `tests/runner-env.test.ts`。
- 移除 agent settings test 中的 Ponytail 測試。
- 更新 README。

### 驗收條件

- 所有 tool schemas 均沒有 `ponytailMode`。
- Agent frontmatter 不再解析 Ponytail。
- Runtime 不再設定 `PONYTAIL_DEFAULT_MODE`。
- Legacy schedule 含 `ponytailMode` 時仍可載入。
- 以下檢查只允許 `prd.md` 或 migration 說明命中：

```bash
rg -i "ponytail|PONYTAIL_DEFAULT_MODE" --glob '!prd.md'
```

### 檢查

```bash
npm run check
npm test
```

---

## SUB-002：將 `runSingleAgent` 改為 options object

**依賴：** SUB-001

### 目標

在加入 session 參數前，先移除 `runSingleAgent()` 過長的 positional parameter list；不得改變現有行為。

### 修改檔案

- `runner.ts`
- `index.ts`
- `manager.ts`
- 必要的 tests

### 工作內容

新增類似：

```ts
interface RunSingleAgentOptions {
  mode: SubagentMode;
  defaultCwd: string;
  agents: AgentConfig[];
  agentName: string;
  fallbackModel?: string;
  fallbackThinkingLevel?: string;
  task: string;
  cwd?: string;
  step?: number;
  signal?: AbortSignal;
  onUpdate?: OnUpdateCallback;
  makeDetails(results: SingleResult[]): SubagentDetails;
  onRunCreated?(run: SubagentRun): void;
}
```

將所有呼叫點改成 named options。

### 驗收條件

- single、parallel、chain、background 行為不變。
- child process arguments 在本 ticket 中仍維持原狀。
- 不加入 `continueFrom`。

### 檢查

```bash
npm run check
npm test
```

---

## SUB-003：新增 child session helper 與單元測試

**依賴：** SUB-002

### 目標

建立獨立模組管理 fresh child session、session lookup、branch 與 leaf 解析，但尚未接入公開 tool。

### 新增檔案

- `child-sessions.ts`
- `tests/child-sessions.test.ts`

### 工作內容

提供清楚且可測試的 helper：

- 建立 managed session directory。
- 產生 fresh child session id/descriptor。
- 依 `sessionId + cwd + sessionDir` 找到 session file。
- 開啟 session 並取得 `leafId`。
- 從指定 `sessionFile + leafId` 建立 branched session。
- 驗證 managed paths，避免未來 delete 任意檔案。

建議 descriptor：

```ts
interface ChildSessionRef {
  sessionId: string;
  sessionDir: string;
  sessionFile?: string;
  leafId?: string;
}
```

### 單元測試

- managed directory 位於 `getAgentDir()/subagent-sessions`。
- fresh ids 唯一且符合 Pi session-id 規則。
- 可從已存在 session 解析 file 與 leaf。
- 從同一 source leaf branch 兩次會產生兩個不同檔案。
- branch 包含來源 leaf 的完整 active path。
- branch 不修改 source session file。
- 非 managed path 不可被 cleanup helper 刪除。

### 驗收條件

- 不手動 parse 或拼接 transcript。
- 優先使用 Pi `SessionManager` API。
- helper 不依賴 TUI。

### 檢查

```bash
npm run check
npm test
```

---

## SUB-004：擴充 run/result session metadata

**依賴：** SUB-003

### 目標

讓每個 run 可以記錄其 child conversation checkpoint。

### 修改檔案

- `types.ts`
- `store.ts`
- `runner.ts`
- `viewer.ts`（只需相容，不要求完整 UI）
- tests

### 工作內容

在 `SubagentRun` 與 `SingleResult` 加入：

```ts
agentScope?: AgentScope;
sessionId?: string;
sessionDir?: string;
sessionFile?: string;
leafId?: string;
continuedFromRunId?: string;
continuedFromLeafId?: string;
```

更新：

- create/update/clone 行為。
- partial tool updates。
- run details/result mapping。
- background `onRunCreated` 回傳資料。

### 驗收條件

- 新欄位可被 run store 正確 create、update、clone。
- 不將完整 session history放入新欄位。
- 現有 run 顯示不因欄位缺失而崩潰。

### 檢查

```bash
npm run check
npm test
```

---

## SUB-005：所有 fresh child run 改用 persisted session

**依賴：** SUB-004

### 目標

讓 single、parallel、chain、background 與 scheduled child runs 都建立獨立 persisted child session。

### 修改檔案

- `runner.ts`
- `manager.ts`
- `index.ts`
- `scheduler.ts`（若 call contract 需要）
- `child-sessions.ts`
- tests

### 工作內容

- 從 child args 移除 `--no-session`。
- Fresh run 使用 managed `--session-id` 與 `--session-dir`。
- run 建立時立即保存 `sessionId/sessionDir`。
- child 完成後 lookup `sessionFile` 並讀取 `leafId`。
- 更新 `SubagentRun` 與 `SingleResult`。
- 若 child 在產生 assistant message 前失敗，允許沒有 session file，但狀態必須正確為 failed/aborted。
- 繼續排除 recursive tools：

```text
subagent,bg_agent,subagent_schedule
```

### 驗收條件

- 每個成功 child run 都有 `sessionFile` 和 `leafId`。
- 兩個 fresh runs 不共用 session file。
- child history 可由 `SessionManager.open(sessionFile).buildSessionContext()` 還原。
- main tool content 不包含完整 child transcript。
- single、parallel、chain、background、schedule 既有功能仍可用。

### 檢查

```bash
npm run check
npm test
```

另增加至少一個 integration test 驗證 child session file 實際建立。

---

## SUB-006：實作 continuation session branch

**依賴：** SUB-005

### 目標

讓 runner 可以從指定來源 run 的 leaf 建立新 child session 並繼續執行，但尚不移除舊 `ask`。

### 修改檔案

- `child-sessions.ts`
- `runner.ts`
- `types.ts`
- tests

### 工作內容

在 runner options 加入類似：

```ts
continueFrom?: {
  runId: string;
  sessionFile: string;
  leafId: string;
};
```

Continuation 流程：

1. 驗證 source session file 與 leaf。
2. 呼叫 `createBranchedSession(sourceLeafId)`。
3. child 使用新 branch file。
4. 只送入新的 `task`。
5. 不在 prompt 中加入來源 output/transcript。
6. 新 result 保存 `continuedFromRunId/continuedFromLeafId`。
7. 完成後保存新 leaf。

### 驗收條件

- 來源 session file 在 continuation 前後內容不變。
- 同一來源 run 同時建立兩個 continuation 時，session files 不同。
- continuation 的 context 包含來源 active branch。
- continuation A 不會看到 continuation B 的問題或回答。
- child prompt 不包含 `Previous output:` 或 `Recent transcript:`。

### 檢查

```bash
npm run check
npm test
```

---

## SUB-007：公開 `subagent.continueFrom` API

**依賴：** SUB-006

### 目標

在 `subagent` tool schema 與 execute flow 中正式提供 `continueFrom`。

### 修改檔案

- `schemas.ts`
- `types.ts`
- `manager.ts`
- `index.ts`
- tests

### 工作內容

- `SubagentParamsSchema` 新增 `continueFrom`。
- 接受 `subagent-3`、`&3`、`3`。
- 更新 `getMode()` validation。
- `continueFrom` 只允許 single mode。
- resolve source run。
- 來源 run 必須為 terminal 狀態，且具有 session file/leaf。
- 未指定 agent 時沿用來源 agent。
- 預設沿用來源 agent scope。
- continuation 強制沿用來源 cwd；不同 cwd 回明確錯誤。
- agent override 仍走正常 agent discovery、model settings 與 project-agent confirmation。
- tool description、prompt snippet、guidelines 加入 continuation 用法。

### 驗收條件

以下合法：

```ts
getMode({ agent: "explorer", task: "x" }) === "single";
getMode({ continueFrom: "&1", task: "x" }) === "single";
getMode({ continueFrom: "&1", agent: "reviewer", task: "x" }) === "single";
```

以下不合法：

```ts
{ continueFrom: "&1" }
{ continueFrom: "&1", task: "x", tasks: [...] }
{ continueFrom: "&1", task: "x", chain: [...] }
```

錯誤情況必須有清楚訊息：

- unknown run
- source still running
- source has no persisted session
- source leaf missing
- invalid cwd override
- unknown override agent

### 檢查

```bash
npm run check
npm test
```

---

## SUB-008：移除 `subagent_control ask` 並修正 status

**依賴：** SUB-007

### 目標

由 `continueFrom` 完整取代 `ask`，讓 control tool 只負責 run lifecycle。

### 修改檔案

- `schemas.ts`
- `types.ts`
- `index.ts`
- `manager.ts`
- tests

### 工作內容

移除：

- `ask` action。
- `question`。
- `context`。
- control 中的 `agent/agentScope/cwd` follow-up options。
- `buildFollowUpTask()`。
- `plainDisplayItems()`。
- 只為舊 ask 使用的 `capText()`。
- control execute 中啟動新 agent 的邏輯。

修正 actions：

- `list`：顯示所有 runs 摘要。
- `status`：要求 `runId`，只顯示該 run 的完整狀態。
- `stop`：要求 `runId`。
- `delete`：要求 `runId`。

新增單 run formatter，至少顯示：

- id/status/agent/source
- task/cwd/current tool
- model/usage
- final output/error
- session id/file
- continued-from relationship

### 驗收條件

- control schema enum 只有 `list/status/stop/delete`。
- control schema 不含 `question/context/agent/agentScope/cwd`。
- `status &1` 不列出其他 runs。
- 所有 follow-up 指引改成 `subagent continueFrom`。
- 以下檢查除 `prd.md` 外不得命中：

```bash
rg "action=ask|buildFollowUpTask|subagent_control.*ask" --glob '!prd.md'
```

### 檢查

```bash
npm run check
npm test
```

---

## SUB-009：更新 run refs、autocomplete 與 UI 文案

**依賴：** SUB-008

### 目標

所有使用者可見提示與 run-ref context 使用新的 continuation 語意。

### 修改檔案

- `manager.ts`
- `index.ts`
- `viewer.ts`
- tests

### 工作內容

- `buildRunRefContext()` 不再提及 `ask`。
- 提示 `subagent_control` 用於 status/stop/delete。
- 提示 `subagent continueFrom` 用於 follow-up。
- `subagent` render call/result 顯示 `continued from &N`。
- Viewer 顯示 session id 與 parent run。
- Run-ref autocomplete description 保持精簡。

### 驗收條件

普通 prompt：

```text
繼續 &1 的調查
```

附加的 context 應引導模型使用：

```json
{ "continueFrom": "&1", "task": "..." }
```

不得再引導 `subagent_control ask`。

### 檢查

```bash
npm run check
npm test
```

---

## SUB-010：依 main Pi session 隔離 run store 與 run refs

**依賴：** SUB-009

### 目標

修正全域 singleton run store 讓不同 main Pi sessions 的 subagent runs 混在一起的問題。所有 run 查詢與 UI 只能看到目前 session 的 runs。

### 修改檔案

- `types.ts`
- `store.ts`
- `runner.ts`
- `manager.ts`
- `index.ts`
- `viewer.ts`
- `run-refs.ts`
- tests

### 工作內容

- `SubagentRun` 新增必要欄位 `ownerSessionId`。
- `session_start` 使用 `ctx.sessionManager.getSessionId()` 設定 active run scope。
- 將 store 改成依 `ownerSessionId` partition；內部 key 必須能處理不同 sessions 具有相同短 run id。
- `create/update/abort/remove` 必須明確作用於 run 的 owner scope，不能因 active session 切換而更新錯誤 run。
- `list/status/find/stop/delete` 僅查詢 active scope。
- `getRunRefCompletions()`、`findRunByRef()`、`buildRunRefContext()` 僅使用 active scope。
- Viewer 必須以 `ownerSessionId + runId` 鎖定 run，不能在 session 切換後顯示同 id 的其他 run。
- Background 與 scheduled run 在啟動時捕捉 owner session id；完成後仍只更新原 owner scope。
- 切換 session 時不得清除其他 scope 的資料，但也不得將其暴露給新 session。
- Run ids 可維持每個 session 從 `&1` 開始；若採此策略，所有內部 lookup 必須使用 composite key。

### 驗收條件

- Session A 建立 `&1` 後切到 Session B，B 的 list/status/autocomplete 看不到 A 的 `&1`。
- Session B 可建立自己的 `&1`，兩者不衝突。
- 切回 Session A 後可再次看到 A 的 runs。
- 在 A 啟動的 background run，即使 active session 已切到 B，也不會出現在 B。
- B 使用 `continueFrom: "&1"` 時只能解析 B 的 `&1`。
- `/tree` 的不同 branches 因共享 session id，本階段可看到同一 session 的全部 runs。

### 檢查

```bash
npm run check
npm test
```

---

## SUB-011：精簡 parent tool details，child session 成為 history source of truth

**依賴：** SUB-010

### 目標

避免把完整 child messages 重複保存到 main session 的 tool-result details。

### 修改檔案

- `types.ts`
- `index.ts`
- `runner.ts`
- `viewer.ts`
- `results.ts`
- tests

### 工作內容

將 parent-visible result details 精簡為：

```ts
{
  runId,
  agent,
  status,
  finalOutput,
  usage,
  model,
  sessionId,
  continuedFromRunId
}
```

要求：

- Tool result `content` 仍回傳 final answer，供 main agent 使用。
- Tool result `details` 不保存完整 child transcript。
- Running viewer 從 `subagentRunStore` 讀 live messages。
- Completed viewer 可從 child session file 讀取 active branch history。
- Parallel 的 50 KB parent-output cap 保留。

### 驗收條件

- Main LLM context 只看到 final answer，不看到完整 child history。
- Main session tool details 不再包含完整 `messages[]`。
- `/subagent-view` 仍能顯示完整 child conversation。
- Expanded tool result 至少仍可顯示 final output、usage 與 run ids。

### 檢查

```bash
npm run check
npm test
```

---

## SUB-012：持久化 run-to-session pointers，不污染 main context

**依賴：** SUB-011

### 目標

讓 main session reload/resume 後仍能用 `&N` 找到 child session，但不將 child history送入 LLM context。

### 新增檔案

- `run-pointers.ts`
- 對應 test

### 修改檔案

- `index.ts`
- `store.ts`
- `types.ts`

### 工作內容

使用：

```ts
pi.appendEntry("pi-subagent.run", metadata)
```

只保存 minimal metadata：

```ts
{
  version: 1,
  runId,
  agent,
  agentSource,
  agentScope,
  task,
  status,
  cwd,
  sessionId,
  sessionDir,
  sessionFile,
  leafId,
  continuedFromRunId,
  startedAt,
  endedAt
}
```

不得保存：

- child messages
- transcript
- tool result history
- 重建後的大 prompt

刪除時寫 tombstone custom entry。

`session_start` 時從目前 main-session branch 的 custom entries 還原：

- run pointers
- tombstones
- 下一個 run number

### 驗收條件

- Custom entries 不參與 `buildSessionContext()`。
- Reload 後 `&N` 仍能 resolve。
- Deleted run 不會在 reload 後復活。
- `nextRunNumber` 不會和 restored ids 衝突。
- Ephemeral main session 仍可運作，只是不保證跨 process restore。
- 背景 run 在 main session 已切換或 extension 已 shutdown 時，不可將 pointer 寫入錯誤 session；需加入 session generation/path guard。

### 檢查

```bash
npm run check
npm test
```

---

## SUB-013：實作 child session delete 與 retention safety

**依賴：** SUB-012

### 目標

讓 `subagent_control delete` 能安全清理該 run 的 session file，避免長期累積。

### 修改檔案

- `manager.ts`
- `child-sessions.ts`
- `index.ts`
- `store.ts`
- tests

### 工作內容

Delete 流程：

1. 若 run 還在執行，先 abort。
2. 驗證 session file 位於 managed child-session directory。
3. 刪除該 run 自己的 session file。
4. 移除 in-memory run。
5. 寫入 pointer tombstone。

由於每次 continuation 都完整 fork active path，刪除 parent session file不得破壞已存在的 descendant session。

### 驗收條件

- 不可刪除 managed directory 外的任何 path。
- Unknown run 不刪除檔案。
- Running run 會先停止。
- 刪除 parent 後，已建立的 child continuation 仍可 status/view/continue。
- 刪除成功後 autocomplete 不再顯示該 run。

### 檢查

```bash
npm run check
npm test
```

---

## SUB-014：README、integration tests 與最終清理

**依賴：** SUB-013

### 目標

完成對外文件、整合測試與 dead-code cleanup。

### 修改檔案

- `README.md`
- `tests/pi-integration.test.ts`
- 其他 tests
- 所有受影響原始碼

### README 必須包含

- `continueFrom` 範例。
- agent override 範例。
- `subagent_control` 新 action 清單。
- child session directory 與 retention 說明。
- continuation 每次 fork，不直接修改 source session。
- child history 不進 main LLM context。
- project-agent confirmation 行為。
- 移除所有 Ponytail 說明。
- Security notes 不再宣稱 child 使用 `--no-session`。

### Integration tests

至少驗證：

1. Package 可載入。
2. 四個 tools 與五個 commands 仍正確註冊。
3. `subagent` schema 包含 `continueFrom`。
4. `subagent_control` schema 不含 `ask`。
5. 所有 schemas 不含 `ponytailMode`。
6. Fresh child run 建立 session。
7. Continuation 可以看到來源 conversation。
8. 兩個 sibling continuations 互相隔離。
9. Main model-visible tool content 不包含來源 transcript。

### 最終檢查

```bash
npm run check
npm test
rg -i "ponytail|PONYTAIL_DEFAULT_MODE" --glob '!prd.md'
rg "action=ask|buildFollowUpTask|subagent_control.*ask" --glob '!prd.md'
```

預期：

- Typecheck 通過。
- 全部 tests 通過。
- 最後兩個 `rg` 無產品程式碼命中。

---

# 7. 全域完成條件

全部 tickets 完成後：

- [ ] `ponytailMode` 已從所有公開與內部 API 移除。
- [ ] `PONYTAIL_DEFAULT_MODE` 不再由 extension 設定。
- [ ] `subagent_control` 只有 list/status/stop/delete。
- [ ] `status(runId)` 真正只查詢指定 run。
- [ ] `subagent` 支援 `continueFrom`。
- [ ] 未指定 agent 時沿用來源 agent。
- [ ] 指定 agent 時可切換 agent 繼續 conversation。
- [ ] 每個 fresh child run 有獨立 persisted session。
- [ ] 每個 continuation 都有獨立 branched session。
- [ ] Source session 不會被 continuation 修改。
- [ ] Sibling continuations 不互相污染。
- [ ] Child history 不被拼接進 prompt。
- [ ] Child history 不進 main agent LLM context。
- [ ] `list/status/run refs/autocomplete/viewer` 只顯示目前 main session 的 runs。
- [ ] 不同 main sessions 可各自使用相同短 run id 而不衝突。
- [ ] Run pointer 可在 main session reload 後還原。
- [ ] Delete 只能刪除 managed child session files。
- [ ] Single、parallel、chain、background、schedule 無 regression。
- [ ] README 與實際行為一致。
- [ ] `npm run check` 通過。
- [ ] `npm test` 通過。

---

# 8. 發給 subagent 的通用 Ticket Prompt

每次只將一個 ticket 發給 worker：

```text
請實作 prd.md 中的 <TICKET-ID>。

要求：
1. 先完整閱讀該 ticket、其依賴 ticket，以及相關原始碼和 tests。
2. 只做這個 ticket 的範圍，不提前實作後續 tickets。
3. 保持現有不相關行為相容。
4. 新增或更新該 ticket 要求的 tests。
5. 執行 npm run check 與 npm test。
6. 完成後回報：
   - 修改摘要
   - 修改檔案
   - 執行的 checks 與結果
   - 尚存風險或後續 ticket 注意事項
```

建議依序執行：

```text
SUB-001 → SUB-002 → SUB-003 → SUB-004 → SUB-005 → SUB-006 →
SUB-007 → SUB-008 → SUB-009 → SUB-010 → SUB-011 → SUB-012 → SUB-013 → SUB-014
```
