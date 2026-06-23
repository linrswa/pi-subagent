# Pi Subagent

Pi package that registers subagent tools, bundled agents, prompt templates, and the subagent TUI panel.


Pi extension that registers a `subagent` tool for delegating focused work to isolated child pi processes.

## What it provides

- `subagent` tool with single, parallel, and chain modes
- `bg_agent` tool and `/bg [agent] <prompt>` command for non-blocking background runs
- Live run viewer via the side panel, `/subagent-view <runId>`, or `&1` refs
- `subagent_schedule` tool and `/subagent-schedules` command for session-scoped scheduled background runs
- Bundled agents: `scout`, `planner`, `reviewer`, `worker`
- Optional user agents from `~/.pi/agent/agents/*.md`
- Optional project agents from `.pi/agents/*.md` when `agentScope` is `both` or `project`
- Prompt templates: `/implement`, `/scout-and-plan`, `/implement-and-review`
- `/subagents [user|project|both]` command to list available agents

## Agent definition

```md
---
name: my-agent
description: What this subagent is good at
tools: read, grep, find, ls
model: claude-haiku-4-5  # optional; omitted agents inherit the parent session model
---

System prompt for the agent goes here.
```

User agents override bundled agents with the same name. Project agents override both when project scope is enabled.

## Tool modes

Single:

```json
{ "agent": "reviewer", "task": "Review the current git diff" }
```

Parallel:

```json
{
  "tasks": [
    { "agent": "scout", "task": "Find auth code" },
    { "agent": "scout", "task": "Find session code" }
  ]
}
```

Chain:

```json
{
  "chain": [
    { "agent": "scout", "task": "Find relevant code for Redis session caching" },
    { "agent": "planner", "task": "Plan the change using this context: {previous}" },
    { "agent": "worker", "task": "Implement this plan: {previous}" }
  ]
}
```

Background:

```json
{ "prompt": "Find likely causes of flaky auth tests", "agent": "scout" }
```

Or type `/bg scout Find likely causes of flaky auth tests`; `/bg` autocompletes agent names.

Use `&1` / `&2` to refer to existing subagent runs in normal prompts; press Tab after `&` for run completion.

Viewer:

- Open the side panel with `Ctrl+0`/`Ctrl+=` or `/subagent-panel`, then press `Space`, `Enter`, or `o` on a run.
- Or run `/subagent-view &1`.
- Keys: `j/k` or arrows scroll, `PageUp/PageDown`, `Home/End`, `q`/`Esc` close, `x` then `x` stop.

Scheduling:

```json
{ "action": "add", "schedule": "30m", "prompt": "Check for flaky test clues", "agent": "scout" }
```

`schedule` accepts recurring intervals (`30s`, `5m`, `1h`, `2d`), one-shot relatives (`+10m`), ISO timestamps, or 6-field cron. Jobs are stored under `.pi/subagent-schedules/<session>.json`; list/delete with `subagent_schedule` or `/subagent-schedules [delete] <id>`.

## Security notes

Project-local agents are repo-controlled prompts. The tool only loads them when `agentScope` is `both` or `project`, and it asks for confirmation in UI mode by default.

Child processes run with `--no-session` and `--exclude-tools subagent,bg_agent,subagent_schedule` to avoid persistent child sessions and recursive delegation.
