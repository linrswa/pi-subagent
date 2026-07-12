# Pi Subagent

A Pi package for delegating work to isolated child Pi agents. It registers subagent tools, bundled agents, background runs, scheduled runs, and workflow prompt templates.

## Features

- `subagent` tool: single, continuation, parallel, and chained child-agent runs
- `bg_agent` tool and `/bg` command for non-blocking background runs
- `subagent_control` tool for list/status/stop/delete on existing runs
- `subagent_schedule` tool and `/subagent-schedules` command for session-scoped schedules
- Live run viewer via `/subagent-view <runId>` or `&1` run references
- Bundled agents: `explorer`, `planner`, `reviewer`, `worker`
- User agents from `~/.pi/agent/agents/*.md`
- Project agents from `.pi/agents/*.md` when `agentScope` is `both` or `project`
- Prompt templates: `/implement`, `/explorer-and-plan`, `/implement-and-review`
- Per-agent model defaults via settings or `/subagent-setting`

## Install

From this directory:

```bash
npm install
pi install "$(pwd)"
```

Temporary, without adding it to settings:

```bash
pi -e "$(pwd)"
```

After editing the package during development, use `/reload` in Pi.

## Quick start

```text
Use the explorer subagent to find where auth sessions are created.
```

Or call the tool directly:

```json
{ "agent": "explorer", "task": "Find where auth sessions are created" }
```

Chained workflow:

```json
{
  "chain": [
    { "agent": "explorer", "task": "Find code relevant to Redis session caching" },
    { "agent": "planner", "task": "Create an implementation plan from this context: {previous}" },
    { "agent": "worker", "task": "Implement this plan: {previous}" }
  ]
}
```

Parallel read-only exploration:

```json
{
  "tasks": [
    { "agent": "explorer", "task": "Find auth code" },
    { "agent": "explorer", "task": "Find session storage code" }
  ]
}
```

Background run:

```text
/bg explorer Find likely causes of flaky auth tests
```

Then inspect it with:

```json
{ "action": "status", "runId": "&1" }
```

## Tools

| Tool | Purpose |
|---|---|
| `subagent` | Run one agent, continue a completed run, run parallel agents, or run a chain with `{previous}` handoff. |
| `bg_agent` | Start a background agent and return immediately with a run id. |
| `subagent_control` | List, inspect, stop, or delete existing runs. |
| `subagent_schedule` | Add/list/delete scheduled background agents for the current session. |

### `subagent` modes

| Mode | Shape |
|---|---|
| Single | `{ "agent": "reviewer", "task": "Review the current diff" }` |
| Continue | `{ "continueFrom": "&1", "task": "Review the previous result" }` |
| Continue with agent override | `{ "continueFrom": "&1", "agent": "reviewer", "task": "Review the previous result" }` |
| Parallel | `{ "tasks": [{ "agent": "explorer", "task": "..." }] }` |
| Chain | `{ "chain": [{ "agent": "explorer", "task": "..." }, { "agent": "planner", "task": "Use {previous}" }] }` |

Optional fields: `cwd`, `agentScope`, and `confirmProjectAgents`.

## Commands and prompt templates

| Command | Description |
|---|---|
| `/bg [agent] <prompt>` | Start a background agent. |
| `/subagents [user\|project\|both]` | List available agents. |
| `/subagent-view <runId>` | Open a live run viewer. |
| `/subagent-schedules [delete] <id>` | List or delete schedules. |
| `/subagent-setting` | Pick default models for agents in TUI mode. |
| `/implement <task>` | `explorer → planner → worker`. |
| `/explorer-and-plan <task>` | `explorer → planner`, no implementation. |
| `/implement-and-review <task>` | `worker → reviewer → worker`. |

Run refs like `&1` can be used in normal prompts; Pi injects run metadata and tool guidance, not the prior child conversation history. Use `continueFrom` to fork a completed run's persisted session for follow-up work. Omitting `agent` reuses the source agent; supplying `agent` selects a different agent while retaining the source conversation. A continuation must use the source run's cwd.

### Child session retention and isolation

Every child run has its own persisted Pi session under `<getAgentDir()>/subagent-sessions/<main-session-id>/`, outside the repository and Pi's normal `/resume` list. A continuation forks the source run's completed leaf into a new session file; it never writes to the source session. Multiple continuations from the same run are therefore isolated from one another.

Child history is kept in those managed session files for the viewer and continuation, not copied into the main agent's model context or tool-result details. The main agent receives only the child run's final answer and short status metadata. Use `{ "action": "delete", "runId": "&1" }` with `subagent_control` to remove a run and its managed child session when it is no longer needed. Deleting a parent does not remove already-created continuation sessions.

### Main-session run scope and reloads

Run list/status/control, `&N` refs and autocomplete, and `/subagent-view` are scoped to the current main Pi session. A different main session cannot inspect or continue its runs, and short IDs may repeat (both sessions can have `&1`). Returning to or reloading the same main session restores its run refs from minimal run-to-session pointers; those pointers contain session metadata only, never a child transcript. Deletion also records a retained tombstone pointer, so a deleted run is not restored after reload.

## Agents

Agent definitions are Markdown files with YAML frontmatter:

```md
---
name: my-agent
description: What this subagent is good at
tools: read, grep, find, ls
model: anthropic/claude-haiku-4-5  # optional
---

System prompt for the agent goes here.
```

Discovery order:

1. Bundled agents in this package
2. User agents in `~/.pi/agent/agents/*.md`
3. Project agents in `.pi/agents/*.md` when enabled

Later sources override earlier agents with the same `name`.

## Model defaults

Set defaults globally in `~/.pi/agent/settings.json` or per project in `.pi/settings.json`:

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

Project settings override global settings. These defaults override agent frontmatter `model`; agents without a model inherit the parent session model.

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

`schedule` accepts intervals (`30s`, `5m`, `1h`, `2d`), one-shot relatives (`+10m`), ISO timestamps, or 6-field cron. Schedules require a persisted Pi session and are stored under `.pi/subagent-schedules/<session>.json`.

## Security notes

Project-local agents are repo-controlled prompts. They are only loaded with `agentScope: "both"` or `"project"`, and TUI mode asks for confirmation by default, including when a continuation inherits or overrides to a project agent. Confirm only for trusted repositories.

Child agents run in separate persisted managed Pi sessions, with `subagent`, `bg_agent`, and `subagent_schedule` excluded to prevent recursive delegation.

## Development

```bash
npm install
npm run check
npm test
```

Useful limits: max 8 parallel tasks, 4 concurrent child processes, 50 KB model-visible output per parallel task.
