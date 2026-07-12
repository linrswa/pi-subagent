import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { getChildSessionsRoot } from "../child-sessions.ts";
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
			const stored = subagentRunStore.get(result.runId!);
			assert.equal(stored?.sessionFile, result.sessionFile);
			assert.equal(stored?.leafId, result.leafId);
			const context = SessionManager.open(result.sessionFile!).buildSessionContext();
			assert.deepEqual(context.messages.map((message) => message.content), ["child task", "child answer"]);
		}
		assert.notEqual(first.sessionId, second.sessionId);
		assert.notEqual(first.sessionFile, second.sessionFile);
	} finally {
		process.argv[1] = originalScript;
		await rm(temp, { recursive: true, force: true });
		await rm(path.join(getChildSessionsRoot(), owner), { recursive: true, force: true });
	}
});
