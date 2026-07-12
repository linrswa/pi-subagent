import assert from "node:assert/strict";
import test from "node:test";
import { runSingleAgent } from "../runner.ts";
import { SubagentRunStore, makeEmptyUsage } from "../store.ts";
import type { SubagentDetails } from "../types.ts";

const sessionMetadata = {
	agentScope: "both" as const,
	sessionId: "child-session-id",
	sessionDir: "/managed/subagent-sessions/main",
	sessionFile: "/managed/subagent-sessions/main/child-session-id.jsonl",
	leafId: "leaf-id",
	continuedFromRunId: "subagent-1",
	continuedFromLeafId: "source-leaf-id",
};

test("run store creates, updates, and clones child-session pointer metadata", () => {
	const store = new SubagentRunStore();
	const created = store.create({
		mode: "single",
		agent: "explorer",
		agentSource: "user",
		task: "inspect metadata",
		...sessionMetadata,
	});
	assert.deepEqual(Object.fromEntries(Object.keys(sessionMetadata).map((key) => [key, created[key as keyof typeof sessionMetadata]])), sessionMetadata);

	const updated = store.update(created.id, { leafId: "new-leaf-id", continuedFromLeafId: "new-source-leaf-id" });
	assert.equal(updated?.leafId, "new-leaf-id");
	assert.equal(updated?.continuedFromLeafId, "new-source-leaf-id");
	assert.equal(updated?.sessionFile, sessionMetadata.sessionFile);

	// Returned values are clones, so callers cannot mutate stored run data.
	updated!.messages.push({ role: "assistant", content: [] });
	const stored = store.get(created.id)!;
	assert.equal(stored.messages.length, 0);
	assert.equal(stored.leafId, "new-leaf-id");
	assert.equal(store.getSnapshot()[0].continuedFromRunId, sessionMetadata.continuedFromRunId);
});

test("runner maps child-session pointer metadata to created runs and results", async () => {
	let createdRun: { sessionId?: string; agentScope?: string } | undefined;
	const makeDetails = (results: any[]): SubagentDetails => ({
		mode: "single",
		agentScope: "both",
		packageAgentsDir: "/agents",
		userAgentsDir: "/users",
		projectAgentsDir: null,
		results,
	});
	const result = await runSingleAgent({
		mode: "single",
		defaultCwd: process.cwd(),
		agents: [],
		agentName: "missing",
		task: "does not run",
		...sessionMetadata,
		makeDetails,
		onRunCreated: (run) => {
			createdRun = run;
		},
	});

	assert.equal(result.exitCode, 1);
	assert.deepEqual(
		Object.fromEntries(Object.keys(sessionMetadata).map((key) => [key, result[key as keyof typeof sessionMetadata]])),
		sessionMetadata,
	);
	assert.equal(createdRun?.sessionId, sessionMetadata.sessionId);
	assert.equal(createdRun?.agentScope, sessionMetadata.agentScope);
	assert.deepEqual(result.usage, makeEmptyUsage());
});
