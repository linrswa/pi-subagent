# Pi Subagent

A Pi package for delegating work to isolated child Pi agents. It registers subagent tools, bundled agents, background runs, scheduled runs, and workflow prompt templates.

## Features

- `subagent` tool: single, parallel, and chained child-agent runs
- `bg_agent` tool and `/bg` command for non-blocking background runs
- `subagent_control` tool for list/status/ask/stop/delete on existing runs
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
| `subagent` | Run one agent, parallel agents, or a chain with `{previous}` handoff. |
| `bg_agent` | Start a background agent and return immediately with a run id. |
| `subagent_control` | List, inspect, ask follow-up, stop, or delete existing runs. |
| `subagent_schedule` | Add/list/delete scheduled background agents for the current session. |

### `subagent` modes

| Mode | Shape |
|---|---|
| Single | `{ "agent": "reviewer", "task": "Review the current diff" }` |
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

Run refs like `&1` can be used in normal prompts; Pi injects the previous run context automatically.

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

Project-local agents are repo-controlled prompts. They are only loaded with `agentScope: "both"` or `"project"`, and TUI mode asks for confirmation by default.

Child agents run as separate `pi --mode json -p --no-session` processes with `subagent`, `bg_agent`, and `subagent_schedule` excluded to prevent recursive delegation.

## Development

```bash
npm install
npm run check
npm test
```

Useful limits: max 8 parallel tasks, 4 concurrent child processes, 50 KB model-visible output per parallel task.
