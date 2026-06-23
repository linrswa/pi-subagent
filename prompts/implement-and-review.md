---
description: Worker implements, reviewer reviews, then worker applies feedback
argument-hint: "<task>"
---

Use the subagent tool with the chain parameter to execute this workflow:

1. Use the `worker` agent to implement: $@
2. Use the `reviewer` agent to review the implementation from the previous step. Use the `{previous}` placeholder and ask it to inspect the changed files/diff.
3. Use the `worker` agent to apply the review feedback from the previous step. Use the `{previous}` placeholder.

Execute this as a chain and pass output between steps via `{previous}`.
