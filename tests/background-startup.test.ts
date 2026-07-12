import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { getChildSessionsRoot } from "../child-sessions.ts";
import { startBackgroundAgent } from "../manager.ts";
import { subagentRunStore } from "../store.ts";

async function waitForTerminal(runId: string, ownerSessionId: string): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		const run = subagentRunStore.get(runId, ownerSessionId);
		if (run && ["completed", "failed", "aborted"].includes(run.status)) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Timed out waiting for ${runId}`);
}

test("background startup creates a managed run before the child completes", async (t) => {
	const owner = `background-test-${randomUUID()}`;
	const temp = await mkdtemp(path.join(tmpdir(), "pi-subagent-background-"));
	const script = path.join(temp, "fake-pi.mjs");
	const sdkUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
	await writeFile(
		script,
		`import { SessionManager } from ${JSON.stringify(sdkUrl)};
const args = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1];
if (args.includes("--no-session") || value("--exclude-tools") !== "subagent,bg_agent,subagent_schedule") process.exit(2);
const manager = SessionManager.create(process.cwd(), value("--session-dir"), { id: value("--session-id") });
manager.appendMessage({ role: "user", content: "child task", timestamp: Date.now() });
manager.appendMessage({ role: "assistant", content: "child answer", provider: "test", model: "test", timestamp: Date.now(), usage: { input: 1, output: 1, totalTokens: 2 }, stopReason: "stop" });
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "child answer" }], stopReason: "stop" } }));
`,
	);
	const originalScript = process.argv[1];
	process.argv[1] = script;
	t.after(async () => {
		process.argv[1] = originalScript;
		await rm(temp, { recursive: true, force: true });
		await rm(path.join(getChildSessionsRoot(), owner), { recursive: true, force: true });
	});

	const ctx = {
		cwd: process.cwd(),
		isProjectTrusted: () => true,
		model: undefined,
		hasUI: false,
		sessionManager: { getSessionId: () => owner },
		ui: { notify: () => undefined },
	} as any;
	const result = await startBackgroundAgent({ getThinkingLevel: () => undefined } as any, ctx, {
		prompt: "persist this",
		agent: "explorer",
	});

	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.equal(result.run.status, "queued");
	assert.equal(result.run.sessionDir, path.join(getChildSessionsRoot(), owner));
	assert.ok(result.run.sessionId);
	await waitForTerminal(result.run.id, owner);
	const run = subagentRunStore.get(result.run.id, owner)!;
	assert.equal(run.status, "completed");
	assert.ok(run.sessionFile);
	assert.ok(run.leafId);
});
