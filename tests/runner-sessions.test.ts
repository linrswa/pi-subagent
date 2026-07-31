import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { getChildSessionsRoot, readChildSessionMessages } from "../child-sessions.ts";
import { getResultOutput, toParentResult } from "../results.ts";
import { runSingleAgent } from "../runner.ts";
import { subagentRunStore } from "../store.ts";
import type { SubagentDetails } from "../types.ts";
import { fakeRpcPiSource } from "./fake-rpc-pi.ts";

const makeDetails = (results: any[]): SubagentDetails => ({
	mode: "single",
	agentScope: "user",
	packageAgentsDir: "/agents",
	userAgentsDir: "/users",
	projectAgentsDir: null,
	results,
});

test("continuations fork an isolated session and send only the new task", async () => {
	const owner = `runner-continuation-${randomUUID()}`;
	const temp = await mkdtemp(path.join(tmpdir(), "pi-subagent-continuation-"));
	const script = path.join(temp, "fake-pi.mjs");
	const sessionDir = path.join(getChildSessionsRoot(), owner);
	const sdkUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
	await writeFile(script, fakeRpcPiSource(sdkUrl, { answerExpression: '"answer: " + task' }));
	const source = SessionManager.create(process.cwd(), sessionDir, { id: randomUUID() });
	source.appendMessage({ role: "user", content: "source question", timestamp: Date.now() } as any);
	const sourceLeaf = source.appendMessage({ role: "assistant", content: "source answer", provider: "test", model: "test", timestamp: Date.now(), usage: { input: 1, output: 1, totalTokens: 2 }, stopReason: "stop" } as any);
	const sourceFile = source.getSessionFile()!;
	const sourceBefore = await readFile(sourceFile, "utf8");
	const originalScript = process.argv[1];
	process.argv[1] = script;
	try {
		const run = (task: string) => runSingleAgent({
			mode: "single",
			defaultCwd: process.cwd(),
			agents: [{ name: "fake", description: "fake", systemPrompt: "", source: "user", filePath: script }],
			agentName: "fake",
			task,
			continueFrom: { runId: "subagent-source", sessionFile: sourceFile, leafId: sourceLeaf },
			makeDetails,
		});
		const [first, second] = await Promise.all([run("follow up A"), run("follow up B")]);

		assert.equal(await readFile(sourceFile, "utf8"), sourceBefore);
		assert.ok(first.sessionFile);
		assert.ok(second.sessionFile);
		assert.notEqual(first.sessionFile, second.sessionFile);
		assert.equal(first.continuedFromRunId, "subagent-source");
		assert.equal(first.continuedFromLeafId, sourceLeaf);
		for (const [result, task] of [[first, "follow up A"], [second, "follow up B"]] as const) {
			const messages = SessionManager.open(result.sessionFile!).buildSessionContext().messages;
			assert.deepEqual(messages.map((message) => message.content), ["source question", "source answer", task, `answer: ${task}`]);
		}
	} finally {
		process.argv[1] = originalScript;
		await rm(temp, { recursive: true, force: true });
		await rm(path.join(getChildSessionsRoot(), owner), { recursive: true, force: true });
	}
});

test("fresh runner invocations use distinct persisted child sessions", async () => {
	const owner = `runner-test-${randomUUID()}`;
	const temp = await mkdtemp(path.join(tmpdir(), "pi-subagent-runner-"));
	const script = path.join(temp, "fake-pi.mjs");
	const sdkUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
	await writeFile(script, fakeRpcPiSource(sdkUrl));
	const originalScript = process.argv[1];
	process.argv[1] = script;
	try {
		const run = () =>
			runSingleAgent({
				mode: "single",
				defaultCwd: process.cwd(),
				agents: [{ name: "fake", description: "fake", systemPrompt: "", source: "user", filePath: script }],
				agentName: "fake",
				task: "persist this",
				ownerSessionId: owner,
				makeDetails,
			});
		const [first, second] = await Promise.all([run(), run()]);

		for (const result of [first, second]) {
			assert.equal(result.exitCode, 0);
			assert.ok(result.sessionFile);
			assert.ok(result.leafId);
			assert.equal(result.sessionDir, path.join(getChildSessionsRoot(), owner));
			const stored = subagentRunStore.get(result.runId!, owner);
			assert.equal(stored?.sessionFile, result.sessionFile);
			assert.equal(stored?.leafId, result.leafId);
			const context = SessionManager.open(result.sessionFile!).buildSessionContext();
			assert.deepEqual(context.messages.map((message) => message.content), ["Task: persist this", "child answer"]);
			const viewerMessages = await readChildSessionMessages(result.sessionFile!, result.leafId);
			assert.deepEqual(viewerMessages.map((message) => message.content), [
				[{ type: "text", text: "Task: persist this" }],
				[{ type: "text", text: "child answer" }],
			]);
		}
		assert.notEqual(first.sessionId, second.sessionId);
		assert.notEqual(first.sessionFile, second.sessionFile);
	} finally {
		process.argv[1] = originalScript;
		await rm(temp, { recursive: true, force: true });
		await rm(path.join(getChildSessionsRoot(), owner), { recursive: true, force: true });
	}
});

test("process-level session lifecycle preserves source context, isolates siblings, and exposes only compact parent output", async () => {
	const owner = `runner-lifecycle-${randomUUID()}`;
	const temp = await mkdtemp(path.join(tmpdir(), "pi-subagent-lifecycle-"));
	const script = path.join(temp, "fake-pi.mjs");
	const sdkUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
	const sourceTranscript = "SOURCE TRANSCRIPT: original investigation";
	await writeFile(script, fakeRpcPiSource(sdkUrl, {
		answerExpression: '"answer: " + task + "; source-context=" + prior.some((content) => content.includes("SOURCE TRANSCRIPT")) + "; sibling-a-context=" + prior.some((content) => content.includes("follow up A"))',
	}));
	const originalScript = process.argv[1];
	process.argv[1] = script;
	try {
		const run = (task: string, continueFrom?: { runId: string; sessionFile: string; leafId: string }) => runSingleAgent({
			mode: "single", defaultCwd: process.cwd(),
			agents: [{ name: "fake", description: "fake", systemPrompt: "", source: "user", filePath: script }],
			agentName: "fake", task, ownerSessionId: owner, continueFrom, makeDetails,
		});
		const source = await run(sourceTranscript);
		assert.ok(source.sessionFile, "a fresh run must persist a child session");
		assert.ok(source.leafId);

		const continuationSource = { runId: source.runId!, sessionFile: source.sessionFile, leafId: source.leafId };
		const [first, second] = await Promise.all([
			run("follow up A", continuationSource),
			run("follow up B", continuationSource),
		]);

		assert.notEqual(first.sessionFile, source.sessionFile);
		assert.notEqual(second.sessionFile, source.sessionFile);
		assert.notEqual(first.sessionFile, second.sessionFile, "sibling continuations must fork independently");
		const freshPrompt = `Task: ${sourceTranscript}`;
		const sourceAnswer = `answer: ${freshPrompt}; source-context=false; sibling-a-context=false`;
		for (const [result, task] of [[first, "follow up A"], [second, "follow up B"]] as const) {
			const context = SessionManager.open(result.sessionFile!).buildSessionContext().messages.map((message) => message.content);
			assert.deepEqual(context.slice(0, 2), [freshPrompt, sourceAnswer]);
			assert.deepEqual(context.slice(2), [task, `answer: ${task}; source-context=true; sibling-a-context=false`]);
		}

		const parentDetails = toParentResult(second);
		const parentContent = getResultOutput(second);
		assert.equal(parentContent, parentDetails.finalOutput, "tool content is the continuation final answer");
		assert.equal(parentContent.includes(sourceTranscript), false);
		assert.equal(JSON.stringify(parentDetails).includes(sourceTranscript), false, "compact parent details exclude the source transcript");
		assert.equal("messages" in parentDetails, false);
	} finally {
		process.argv[1] = originalScript;
		await rm(temp, { recursive: true, force: true });
		await rm(path.join(getChildSessionsRoot(), owner), { recursive: true, force: true });
	}
});
