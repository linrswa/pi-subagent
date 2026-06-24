---
description: Explorer gathers context, then planner creates a plan without implementation
argument-hint: "<task>"
---

Use the subagent tool with the chain parameter to execute this workflow:

1. Use the `explorer` agent to find all code relevant to: $@
2. Use the `planner` agent to create a concrete implementation plan for "$@" using the context from the previous step. Use the `{previous}` placeholder.

Execute this as a chain and pass output between steps via `{previous}`. Do NOT implement; return only the plan.
