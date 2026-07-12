import assert from "node:assert/strict";
import test from "node:test";
import { getMode } from "../manager.ts";
import { findRunByRef } from "../run-refs.ts";
import { SubagentParamsSchema } from "../schemas.ts";
import type { SubagentRun } from "../types.ts";

test("continuation API exposes its schema and permits only single mode", () => {
	assert.ok("continueFrom" in SubagentParamsSchema.properties);
	assert.equal(getMode({ agent: "explorer", task: "x" }), "single");
	assert.equal(getMode({ continueFrom: "&1", task: "x" }), "single");
	assert.equal(getMode({ continueFrom: "&1", agent: "reviewer", task: "x" }), "single");
	assert.equal(getMode({ continueFrom: "&1" }), undefined);
	assert.equal(getMode({ continueFrom: "&1", task: "x", tasks: [] }), undefined);
	assert.equal(getMode({ continueFrom: "&1", task: "x", chain: [] }), undefined);
});

test("continuation source references resolve all public run-id forms", () => {
	const run = { id: "subagent-3" } as SubagentRun;
	for (const ref of ["subagent-3", "&3", "3"]) assert.equal(findRunByRef(ref, [run]), run);
});
