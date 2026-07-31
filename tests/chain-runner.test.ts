import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import { getChildSessionsRoot } from "../child-sessions.ts";
import { startChain } from "../chain-runner.ts";
import { subagentRunStore } from "../store.ts";
import { fakeRpcPiSource } from "./fake-rpc-pi.ts";

test("background chain has a cancellable parent run and passes previous output", async (t) => {
	const owner = `chain-test-${randomUUID()}`;
	const temp = await mkdtemp(path.join(tmpdir(), "pi-subagent-chain-"));
	const script = path.join(temp, "fake-pi.mjs");
	const sdkUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
	await writeFile(script, fakeRpcPiSource(sdkUrl, {
		answerExpression: 'task.includes("first") ? "alpha" : "received:" + task',
		delayMs: 40,
	}));
	const originalScript = process.argv[1];
	process.argv[1] = script;
	t.after(async () => {
		process.argv[1] = originalScript;
		await rm(temp, { recursive: true, force: true });
		await rm(path.join(getChildSessionsRoot(), owner), { recursive: true, force: true });
	});

	const makeDetails = (results: any[]) => ({ mode: "chain" as const, agentScope: "user" as const, packageAgentsDir: "", userAgentsDir: "", projectAgentsDir: null, results: [] });
	const handle = startChain({
		defaultCwd: process.cwd(),
		agents: [{ name: "explorer", description: "", systemPrompt: "", source: "user", filePath: script }],
		steps: [
			{ agent: "explorer", task: "first" },
			{ agent: "explorer", task: "second {previous}" },
		],
		agentScope: "user",
		ownerSessionId: owner,
		completionNotification: "pending",
		makeDetails,
	});

	assert.equal(handle.run.status, "running");
	assert.equal(handle.run.childRunIds?.length, 0);
	const completed = await handle.completion;
	assert.equal(completed.status, "completed");
	assert.match(completed.finalOutput, /received:Task: second alpha/);
	const parent = subagentRunStore.get(handle.run.id, owner)!;
	assert.equal(parent.status, "completed");
	assert.equal(parent.childRunIds?.length, 2);
	for (const childId of parent.childRunIds ?? []) assert.equal(subagentRunStore.get(childId, owner)?.parentRunId, parent.id);

	const canceled = startChain({
		defaultCwd: process.cwd(),
		agents: [{ name: "explorer", description: "", systemPrompt: "", source: "user", filePath: script }],
		steps: [
			{ agent: "explorer", task: "first" },
			{ agent: "explorer", task: "must never start {previous}" },
		],
		agentScope: "user",
		ownerSessionId: owner,
		completionNotification: "pending",
		makeDetails,
	});
	assert.equal(subagentRunStore.abort(canceled.run.id, owner), true);
	const canceledResult = await canceled.completion;
	assert.equal(canceledResult.status, "aborted");
	assert.ok((subagentRunStore.get(canceled.run.id, owner)?.childRunIds?.length ?? 0) <= 1, "cancel must prevent later chain steps");

	const childCanceled = startChain({
		defaultCwd: process.cwd(),
		agents: [{ name: "explorer", description: "", systemPrompt: "", source: "user", filePath: script }],
		steps: [
			{ agent: "explorer", task: "first" },
			{ agent: "explorer", task: "must never start after child abort {previous}" },
		],
		agentScope: "user",
		ownerSessionId: owner,
		completionNotification: "pending",
		makeDetails,
	});
	let activeChildId: string | undefined;
	for (let attempt = 0; attempt < 100 && !activeChildId; attempt++) {
		activeChildId = subagentRunStore.get(childCanceled.run.id, owner)?.childRunIds?.[0];
		if (!activeChildId) await new Promise((resolve) => setTimeout(resolve, 5));
	}
	assert.ok(activeChildId);
	assert.equal(subagentRunStore.abort(activeChildId!, owner), true);
	const childCanceledResult = await childCanceled.completion;
	assert.equal(childCanceledResult.status, "aborted");
	assert.ok((subagentRunStore.get(childCanceled.run.id, owner)?.childRunIds?.length ?? 0) <= 1, "aborting the child must stop the chain");
});
