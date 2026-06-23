# Subagent TUI Side Panel Plan

## Goal

Add a lazygit-style subagent control UI: a passive right-side panel that shows active/completed subagents, can be focused with `ctrl+0`, and opens floating detail/intervention windows when focused.

## UX Summary

### Normal mode

- Main Pi session/editor keeps focus.
- Subagent side panel is visible when enabled but does not capture keyboard input.
- Chat/tool rendering stays compact, e.g.:
  - `Dispatched scout: inspect auth/session flow`
  - `worker running: implementing cache layer`
  - `reviewer completed: 2 warnings`

### Panel focus mode

- Press `ctrl+0` to focus/toggle the subagent panel.
- While focused, panel handles lazygit-like shortcuts.
- Press `q` or `Esc` to unfocus and return to the main session.

## Proposed Layout

```text
╭─ Subagents ───────────────╮
│ ● #12 scout        00:24  │
│   探索 auth/session        │
│   → read src/auth.ts       │
│                            │
│ ◐ #13 worker       01:10  │
│   實作 Redis cache         │
│   → edit src/cache.ts      │
│                            │
│ ✓ #14 reviewer     done   │
│   2 warnings              │
│                            │
│ j/k move  enter open      │
│ i intervene  a abort      │
│ q unfocus  ? help         │
╰────────────────────────────╯
```

Detail floating window:

```text
╭─ Agent #13 worker ─────────────────────╮
│ Task: 實作 Redis cache                  │
│ Status: running                         │
│ Model: claude/...                       │
│                                         │
│ Timeline                                │
│ → read src/session.ts                   │
│ → edit src/cache.ts                     │
│ worker: 正在調整 cache invalidation...  │
│                                         │
│ i intervene  a abort  r retry           │
│ tab switch view  esc close              │
╰─────────────────────────────────────────╯
```

## Keybindings

### Global

| Key | Action |
| --- | --- |
| `ctrl+0` | Toggle/focus subagent side panel |

### Panel focused

| Key | Action |
| --- | --- |
| `j` / `down` | Select next subagent |
| `k` / `up` | Select previous subagent |
| `enter` / `o` | Open detail floating window |
| `i` | Intervene in selected subagent |
| `a` | Abort selected subagent |
| `r` | Retry/restart selected subagent |
| `f` | Toggle follow latest output |
| `tab` | Switch view/filter |
| `?` | Show help |
| `q` / `Esc` | Unfocus panel and return to main session |

## Technical Design

### 1. Shared run store

Create an in-memory store owned by the extension runtime.

```ts
type RunStatus = "queued" | "running" | "completed" | "failed" | "aborted";

interface SubagentRun {
  id: string;
  mode: "single" | "parallel" | "chain";
  agent: string;
  agentSource: AgentSource | "unknown";
  task: string;
  status: RunStatus;
  startedAt: number;
  endedAt?: number;
  step?: number;
  cwd?: string;
  currentTool?: string;
  messages: AgentMessage[];
  finalOutput?: string;
  errorMessage?: string;
  usage: UsageStats;
  model?: string;
  abort?: () => void;
}
```

Responsibilities:

- Add run when subagent starts.
- Update run on child JSON events.
- Track current tool call and final output.
- Mark run completed/failed/aborted.
- Notify panel subscribers to re-render.

### 2. Hook store into `runSingleAgent()`

Modify `runSingleAgent()` to:

1. Create a `SubagentRun` before spawning the child process.
2. Save abort handler connected to child process / abort controller.
3. Append assistant/tool events to `messages`.
4. Update `currentTool`, usage, model, status.
5. Emit updates to panel store on every parsed child event.

### 3. Passive side panel overlay

Use Pi TUI overlay support:

- `ctx.ui.custom(..., { overlay: true })` or `tui.showOverlay(...)` depending on lifecycle needs.
- Overlay options:

```ts
{
  anchor: "right-center",
  width: "25%",
  minWidth: 32,
  margin: { right: 1 },
  visible: (termWidth) => termWidth >= 100,
  nonCapturing: true
}
```

Behavior:

- Panel is non-capturing by default.
- `ctrl+0` calls `OverlayHandle.focus()`.
- `q` / `Esc` calls `OverlayHandle.unfocus()` to return focus to the previous/main editor target.

### 4. Register shortcut

```ts
pi.registerShortcut("ctrl+0", {
  description: "Toggle/focus subagent panel",
  handler: async (ctx) => {
    subagentPanelController.toggleFocus(ctx);
  },
});
```

Notes:

- Keep the key configurable later via namespaced keybinding id if Pi extension shortcuts expose that mapping.
- Display help text as `ctrl+0` in panel footer for first version.

### 5. Detail floating window

When panel is focused and user presses `enter`/`o`:

- Open an overlay centered or right-center with larger width.
- Show selected run timeline, final output, task, model, usage, status.
- Support scrolling.
- Support `tab` to switch between:
  1. Timeline
  2. Final output
  3. Metadata/usage

### 6. Intervention flow

MVP intervention should be safe and simple:

1. User presses `i` on a selected running subagent.
2. Floating input asks for intervention instruction.
3. Abort original run.
4. Start a new run with the same agent and task plus intervention context:

```text
Original task:
...

User intervention:
...

Restart the task with this instruction applied. Reuse any useful findings from the previous run if present:
...
```

Reason: current child process is spawned with `--mode json -p --no-session` and `stdin: ignore`, so true live steering is not available yet.

### 7. Abort/retry

- `a`: call selected run's abort handler; mark `aborted`.
- `r`: restart selected run with same agent/task/cwd.
- Preserve lineage metadata:

```ts
parentRunId?: string;
restartReason?: "retry" | "intervention";
```

### 8. Simplify chat rendering

Update `renderCall()` / `renderResult()` to keep main chat compact:

- Single: `⏳ scout: 探索 auth/session`
- Parallel: `⏳ subagents: 2 running, 1 done`
- Chain: `⏳ chain step 2/3: planner`

Expanded tool output can still show the current rich rendering, but default collapsed view should point users to the panel:

```text
Ctrl+0 to open subagent panel
```

## Implementation Phases

### Phase 1: Store + compact rendering

- Add run IDs and store.
- Wire `runSingleAgent()` updates to store.
- Compact default `renderResult()`.
- Keep existing expanded rendering as fallback.

### Phase 2: Passive side panel

- Implement `SubagentPanelComponent`.
- Add lifecycle/controller to show panel in TUI mode.
- Add `ctrl+0` shortcut to focus/toggle.
- Support `j/k`, `up/down`, `q/Esc`.

### Phase 3: Detail overlay

- Add selected run detail floating window.
- Add scroll and tabbed views.
- Add help overlay.

### Phase 4: Controls

- Add abort.
- Add retry.
- Add intervention as abort + restart.

### Phase 5: True live intervention later

Requires architectural change:

- Run child agents as persistent sessions or RPC-controlled child processes.
- Keep stdin/control channel open.
- Floating input sends steer/follow-up messages into the child session.
- Preserve child session logs for reopen/resume.

## Risks / Open Questions

- Overlay lifecycle from a tool execution may be tricky; panel may need to be initialized on `session_start` and updated by store events.
- `nonCapturing` is demonstrated in examples but should be verified against current exported types.
- Need to ensure `ctrl+0` works in common terminals.
- True live intervention is not possible with current `stdin: ignore` + `--no-session` child process design.
- Parallel subagents need clear lineage/status updates so panel does not reorder unexpectedly.

## First Implementation Target

Build Phase 1 + Phase 2 only:

- `ctrl+0` focuses a passive right-side subagent panel.
- Panel lists active/completed agents.
- `j/k` selection works.
- `q/Esc` returns focus to main session.
- Main chat render remains concise.
