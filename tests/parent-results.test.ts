import assert from "node:assert/strict";
import test from "node:test";
import { toParentResult } from "../results.ts";
import type { SingleResult } from "../types.ts";

const result: SingleResult = {
	runId: "subagent-123",
	agent: "worker",
	agentSource: "user",
	task: "private task",
	exitCode: 0,
	messages: [{ role: "assistant", content: [{ type: "text", text: "final answer" }] }],
	stderr: "",
	usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.01, contextTokens: 5, turns: 1 },
	model: "test/model",
	sessionId: "child-session",
	continuedFromRunId: "subagent-122",
};

test("parent result retains output and metadata without child messages", () => {
	const parent = toParentResult(result);
	assert.deepEqual(parent, {
		runId: "subagent-123",
		agent: "worker",
		status: "completed",
		finalOutput: "final answer",
		usage: result.usage,
		model: "test/model",
		sessionId: "child-session",
		continuedFromRunId: "subagent-122",
	});
	assert.equal("messages" in parent, false);
	assert.equal("task" in parent, false);
});
