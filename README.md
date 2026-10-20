# Pi Subagent

A Pi package for delegating work to isolated child Pi agents. It provides background-by-default runs, persisted child sessions, continuations, chains, scheduling, cancellation, and a live viewer.

## Features

- `subagent` starts one child agent in background and immediately returns a run id
- `wait: true` optionally waits for the final output
- Multiple sibling `subagent` calls run concurrently through Pi's normal parallel tool execution
- Process-wide FIFO queue with at most 4 child Pi processes running at once
- Chained workflows with `{previous}` handoff and a cancellable parent run
- Persisted child sessions and isolated continuation branches
- `subagent_control` for list, status, live guidance, stop, and delete
- Session-scoped scheduled runs
- Batched completion messages that wake an idle parent or queue behind its current work
- Optional stable todo links and a versioned progress event bus
- Persistent Agents widget and footer count while runs are queued or running
- Live viewer with streaming text/tool output and one-key guidance via `/subagent-view <runId>`
- Bundled agents: `explorer`, `planner`, `reviewer`, and `worker`

## Install

Requires **Pi 1.3.0 or newer**. Install the current GitHub version:

```bash
pi install git:github.com/linrswa/pi-subagent
```

For a reproducible installation, append a published tag or commit with `@<ref>`.

Try it for one Pi session without changing settings:

```bash
pi -e git:github.com/linrswa/pi-subagent
```

Pi clones the tagged repository and runs `npm install` automatically because the package has runtime dependencies.

For local development:

```bash
git clone https://github.com/linrswa/pi-subagent.git
cd pi-subagent
npm install
pi install "$(pwd)"
```

After editing a locally installed checkout, run `/reload` in Pi.

## Quick start

Background run (default):

```json
{
  "agent": "explorer",
  "task": "Find where auth sessions are created"
}
```

The tool immediately returns a reference such as `&1`. The main agent remains available while the child runs. In TUI mode, an Agents widget stays above the editor and shows each active run's id, role, status, elapsed time, and current activity; the footer also shows the active count. Both hide automatically when no runs are queued or running.

Open `/subagent-view &1` to watch it. While it is queued or running, press `i`, type a correction or additional instruction, and submit. No separate command syntax is required.

Wait for the result when the current turn depends on it:

```json
{
  "agent": "reviewer",
  "task": "Review the current diff",
  "wait": true
}
```

`agent` is optional for a fresh run; `explorer` is preferred when available.

## Migration from the previous API

This release changes the default execution model:

| Previous API | Current API |
|---|---|
| `bg_agent({ prompt, agent })` | `subagent({ task, agent })` |
| `subagent({ agent, task })` waited for completion | Background by default; add `wait: true` to wait |
| `subagent({ tasks: [...] })` | Emit multiple sibling `subagent` calls |
| A chain waited for completion | Chain is background by default; add `wait: true` when needed |

The `bg_agent` tool is no longer registered. The interactive `/bg` command remains as a convenience alias for starting one background run.

Removed batch example:

```json
{
  "tasks": [
    { "agent": "explorer", "task": "Inspect auth" },
    { "agent": "explorer", "task": "Inspect storage" }
  ]
}
```

Replace it with two sibling tool calls in the same assistant turn. Each run then receives an independent id and cancellation lifecycle.

## Parallel work

There is no `tasks` batch mode. Ask Pi to emit multiple sibling calls instead:

```text
Start three explorer subagents in parallel: inspect authentication, storage, and tests.
```

Each call receives its own run id and can be inspected or stopped independently. Pi executes sibling tool calls concurrently, while this package limits the whole process to 4 active child processes. Extra runs remain `queued` and can be stopped before spawning.

Avoid concurrent agents which modify the same files. Child context and session history are isolated, but the workspace is currently shared.

## Chains

```json
{
  "chain": [
    { "agent": "explorer", "task": "Find code relevant to Redis session caching" },
    { "agent": "planner", "task": "Create a plan from this context: {previous}" },
    { "agent": "worker", "task": "Implement this plan: {previous}" }
  ]
}
```

A chain is background by default and immediately returns a synthetic parent run id. Stopping that parent stops the active child and prevents later steps from starting.

Use `"wait": true` when the caller needs the final chain output immediately. The bundled `/implement`, `/explorer-and-plan`, and `/implement-and-review` templates do this.

## Continuations

Continue a fully closed run from its persisted child session:

```json
{
  "continueFrom": "&1",
  "task": "Now inspect the error paths"
}
```

Omitting `agent` reuses the source agent. Supplying another agent changes the role while retaining the source conversation. A continuation always uses the source run's cwd and forks its child session, so sibling continuations do not modify one another's history.

## Tools and commands

| Tool | Purpose |
|---|---|
| `subagent` | Start a fresh run, continuation, or chain. Background by default; supports `wait: true`. |
| `subagent_control` | List, inspect, guide, stop, or delete runs. |
| `subagent_schedule` | Add, list, or delete session-scoped schedules. |

| Command | Purpose |
|---|---|
| `/bg [agent] <prompt>` | Convenience alias for a background single run. |
| `/subagents [user\|project\|both]` | List available agents. |
| `/subagent-view <runId>` | Open the live run viewer. |
| `/subagent-schedules [delete] <id>` | List or delete schedules. |
| `/subagent-setting` | Configure per-agent model defaults. |

Control examples:

```json
{ "action": "list" }
{ "action": "status", "runId": "&1" }
{ "action": "send", "runId": "&1", "message": "Check the error path before editing" }
{ "action": "stop", "runId": "&1" }
{ "action": "delete", "runId": "&1" }
```

`send` defaults to live steering: Pi delivers the instruction at the next safe turn boundary, after the current tool batch. This does not terminate an active shell command. Set `"delivery": "followUp"` only when the instruction should wait until the subagent finishes its current work. Sending to a running chain parent automatically targets its active child.

Once a run is closed, use `subagent({ continueFrom: "&1", task: "..." })` instead.

## Completion delivery

Background terminal events are debounced into bounded custom messages. An idle parent starts a result-review turn automatically; a busy parent receives a `followUp` after its current work. **No new user input is required, and results are never appended to user text.** The main agent remains responsible for the primary task and delegates independent work only when useful.

A run stays durably `pending` until the completion message is present in the session history. Receipts are acknowledged at post-persistence lifecycle boundaries, not on `agent_start` or the pre-persistence `message_end` hook. Reload replays receipts to avoid duplicate wake-ups; messages queued but not persisted remain retryable. Failed delivery is not retried in an automatic model loop.

Pressing Escape to abort the parent pauses automatic wake-ups, including across reload. A deliberate user-started run resumes delivery. Navigating the session tree also pauses automatic delivery so an old task does not silently restart on a different branch. Session shutdown stops owned child work. Print/JSON one-shot callers should use `wait: true`; background operation requires a live parent process.

**Delivered is not reviewed, and execution completed is not task success.** The parent must inspect evidence, update the appropriate todo, and report or continue only within existing authorization. Aborted work must not be restarted automatically. Automatic result-review turns consume model usage.

Full child transcripts stay in managed child-session files. Parent context receives bounded summaries; `subagent_control status` lazily loads the full final answer after reload (with a 51,200-character safety limit and a session-file reference for larger results). Model/usage/error metadata is retained in pointers.

## Todo integration (optional)

When `pi-plan-tracker` is installed, `subagent` accepts an optional `taskId` from `todo_write`. Without it, the sole in-progress todo is selected when available. A continuation can retain its source task link. Run status is displayed alongside the checklist but **never automatically marks a todo complete**.

The packages communicate through `pi.events`, not private stores:

- `pi-plan:context-request`: `{ ownerSessionId, respond({ readOnly, taskId? }) }`.
- `pi-subagent:state`: `{ version: 1, ownerSessionId, runs: [{ id, task, taskId?, status, completionNotification? }] }`.
- `pi-subagent:snapshot-request`: `{ ownerSessionId, respond(snapshot) }` for initial/reloaded UI.

Snapshots are session-scoped, contain no transcript, and are emitted only for meaningful metadata changes. Stable task IDs keep old results from modifying a new checklist. The plan extension owns read-only policy and disallows new delegation while enforced plan mode is active.

## Child session retention and scope

Child sessions live under:

```text
<getAgentDir()>/subagent-sessions/<main-session-or-runtime-id>/
```

They are outside the repository and Pi's normal `/resume` list. Runs, `&N` references, control actions, and viewers are scoped to the current main Pi session. Reloading the same session restores minimal run pointers, not child transcripts.

Deleting a run removes its managed child session after safety checks. Deleting a chain parent does not automatically delete already-created child runs or sessions.

## Agent definitions

Agents are Markdown files with YAML frontmatter:

```md
---
name: my-agent
description: What this subagent is good at
tools: read, grep, find, ls
model: anthropic/claude-haiku-4-5
---

System prompt for the agent goes here.
```

Discovery order:

1. Bundled agents
2. `~/.pi/agent/agents/*.md`
3. `.pi/agents/*.md` when `agentScope` is `project` or `both`

Later sources override earlier agents with the same name.

## Model defaults

Configure globally in `~/.pi/agent/settings.json` or per project in `.pi/settings.json`:

```json
{
  "subagent": {
    "agentModels": {
      "explorer": "anthropic/claude-haiku-4-5",
      "planner": "anthropic/claude-sonnet-4-5:high"
    }
  }
}
```

Project settings override global settings. Agents without a configured or frontmatter model inherit the parent model.

## Scheduling

```json
{
  "action": "add",
  "name": "flaky-check",
  "schedule": "30m",
  "prompt": "Check for flaky test clues",
  "agent": "explorer"
}
```

Schedules support intervals (`30s`, `5m`, `1h`, `2d`), relative one-shots (`+10m`), ISO timestamps, and six-field cron expressions. Scheduled runs use the same global child-process queue.

## Security and current workspace limitation

Project-local agents are repository-controlled prompts. They require `agentScope: "project"` or `"both"`, and interactive mode asks for confirmation by default.

Child agents cannot recursively call `subagent` or `subagent_schedule`.

The current implementation isolates process context and Pi session history, but not source files: child processes use the selected `cwd`. Background agents that write to a shared workspace can conflict with the main agent or another child. A future workspace provider is planned in `workspace_provider_plan.md`.

## Development

```bash
npm install --ignore-scripts
npm run check
npm test
```

The test suite includes real Pi 1.3 session/lifecycle tests with a synthetic provider (no network/model usage), protocol-shaped RPC tests, cancellation/scheduler races, and receipt replay. Runtime compatibility is checked against Pi 1.3 rather than relying on legacy RPC fixtures.

## License

[MIT](LICENSE) © 2026 linrswa
