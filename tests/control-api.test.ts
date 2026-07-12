import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { formatRunDetails } from "../manager.ts";
import { SubagentControlParamsSchema } from "../schemas.ts";
import type { SubagentRun } from "../types.ts";

test("subagent_control exposes lifecycle actions only", () => {
	assert.deepEqual(SubagentControlParamsSchema.properties.action.enum, ["list", "status", "stop", "delete"]);
	for (const key of ["question", "context", "agent", "agentScope", "cwd"]) {
		assert.equal(key in SubagentControlParamsSchema.properties, false);
	}
});

test("status requires a run id and renders only the selected detailed run", async () => {
	const implementation = await readFile(new URL("../index.ts", import.meta.url), "utf8");
	assert.match(implementation, /action=\$\{action\} requires runId/);
	assert.match(implementation, /if \(action === "status"\) \{\s*return \{ content: \[\{ type: "text", text: formatRunDetails\(run\) \}\]/);
	assert.doesNotMatch(implementation, /action === "status"\) \{\s*return \{ content: \[\{ type: "text", text: formatRunList\(runs\)/);
	const controlBlock = implementation.split('name: "subagent_control"')[1].split('name: "subagent_schedule"')[0];
	assert.doesNotMatch(controlBlock, /runSingleAgent\(/);
});

test("detailed status formatter includes all single-run metadata", () => {
	const run: SubagentRun = {
		id: "subagent-2",
		mode: "single",
		agent: "explorer",
		agentSource: "user",
		task: "selected task",
		status: "failed",
		startedAt: 0,
		cwd: "/tmp/project",
		currentTool: "read",
		model: "test/model",
		finalOutput: "partial result",
		errorMessage: "failure reason",
		messages: [],
		usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 5, turns: 1 },
		sessionId: "child-session",
		sessionFile: "/tmp/child.jsonl",
		leafId: "leaf-2",
		continuedFromRunId: "subagent-1",
		continuedFromLeafId: "leaf-1",
	};
	const text = formatRunDetails(run);
	for (const expected of [
		"(subagent-2)", "status: failed", "agent: explorer", "source: user", "task: selected task",
		"cwd: /tmp/project", "current tool: read", "model: test/model", "usage: 1 turn, input 2, output 3",
		"final output: partial result", "error: failure reason", "session id: child-session",
		"session file: /tmp/child.jsonl", "session leaf: leaf-2", "continued from: &1 (subagent-1) leaf leaf-1",
	]) assert.ok(text.includes(expected), `missing ${expected}`);
});
