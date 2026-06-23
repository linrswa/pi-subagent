---
description: Full implementation workflow using scout -> planner -> worker
argument-hint: "<task>"
---

Use the subagent tool with the chain parameter to execute this workflow:

1. Use the `scout` agent to find all code relevant to: $@
2. Use the `planner` agent to create a concrete implementation plan for "$@" using the context from the previous step. Use the `{previous}` placeholder.
3. Use the `worker` agent to implement the plan from the previous step. Use the `{previous}` placeholder.

Execute this as a chain and pass output between steps via `{previous}`.
