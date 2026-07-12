import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { getChildSessionsRoot, readChildSessionMessages } from "../child-sessions.ts";
import { runSingleAgent } from "../runner.ts";
import { subagentRunStore } from "../store.ts";
import type { SubagentDetails } from "../types.ts";

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
	await writeFile(
		script,
		`import { SessionManager } from ${JSON.stringify(sdkUrl)};
const args = process.argv.slice(2);
const sessionFile = args[args.indexOf("--session") + 1];
const task = args.at(-1);
const manager = SessionManager.open(sessionFile);
manager.appendMessage({ role: "user", content: task, timestamp: Date.now() });
manager.appendMessage({ role: "assistant", content: "answer: " + task, provider: "test", model: "test", timestamp: Date.now(), usage: { input: 1, output: 1, totalTokens: 2 }, stopReason: "stop" });
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "answer: " + task }], stopReason: "stop" } }));
`,
	);
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
	await writeFile(
		script,
		`import { SessionManager } from ${JSON.stringify(sdkUrl)};
const args = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1];
const manager = SessionManager.create(process.cwd(), value("--session-dir"), { id: value("--session-id") });
manager.appendMessage({ role: "user", content: "child task", timestamp: Date.now() });
manager.appendMessage({ role: "assistant", content: "child answer", provider: "test", model: "test", timestamp: Date.now(), usage: { input: 1, output: 1, totalTokens: 2 }, stopReason: "stop" });
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "child answer" }], stopReason: "stop" } }));
`,
	);
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
			assert.deepEqual(context.messages.map((message) => message.content), ["child task", "child answer"]);
			const viewerMessages = await readChildSessionMessages(result.sessionFile!, result.leafId);
			assert.deepEqual(viewerMessages.map((message) => message.content), [
				[{ type: "text", text: "child task" }],
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
