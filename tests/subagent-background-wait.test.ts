import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import registerExtension from "../index.ts";
import { getChildSessionsRoot } from "../child-sessions.ts";
import { subagentRunStore } from "../store.ts";

async function waitForTerminal(runId: string, owner: string): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt++) {
		const status = subagentRunStore.get(runId, owner)?.status;
		if (status === "completed" || status === "failed" || status === "aborted") return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Timed out waiting for ${runId}`);
}

test("subagent defaults to background and wait=true returns final output", async (t) => {
	const owner = `tool-background-${randomUUID()}`;
	const temp = await mkdtemp(path.join(tmpdir(), "pi-subagent-tool-background-"));
	const script = path.join(temp, "fake-pi.mjs");
	const sdkUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
	await writeFile(script, `
import { SessionManager } from ${JSON.stringify(sdkUrl)};
const args = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1];
await new Promise((resolve) => setTimeout(resolve, 160));
const manager = SessionManager.create(process.cwd(), value("--session-dir"), { id: value("--session-id") });
manager.appendMessage({ role: "user", content: args.at(-1), timestamp: Date.now() });
manager.appendMessage({ role: "assistant", content: "finished", provider: "test", model: "test", timestamp: Date.now(), usage: { input: 1, output: 1, totalTokens: 2 }, stopReason: "stop" });
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "finished" }], stopReason: "stop" } }));
`);
	const originalScript = process.argv[1];
	process.argv[1] = script;
	t.after(async () => {
		process.argv[1] = originalScript;
		await rm(temp, { recursive: true, force: true });
		await rm(path.join(getChildSessionsRoot(), owner), { recursive: true, force: true });
	});

	const tools = new Map<string, any>();
	const pi = {
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerCommand: () => undefined,
		on: () => undefined,
		appendEntry: () => undefined,
		sendMessage: () => undefined,
		getThinkingLevel: () => undefined,
	} as any;
	registerExtension(pi);
	const tool = tools.get("subagent");
	assert.ok(tool);
	const ctx = {
		cwd: process.cwd(),
		model: undefined,
		hasUI: false,
		mode: "json",
		isProjectTrusted: () => true,
		sessionManager: { getSessionId: () => owner },
		ui: { notify: () => undefined },
	} as any;

	const startedAt = Date.now();
	const background = await tool.execute("background", { agent: "explorer", task: "background work" }, new AbortController().signal, undefined, ctx);
	assert.ok(Date.now() - startedAt < 140, "default call should return before the child finishes");
	assert.match(background.content[0].text, /Started explorer &\d+ in background/);
	const runId = background.details.results[0].runId as string;
	await waitForTerminal(runId, owner);
	assert.equal(subagentRunStore.get(runId, owner)?.status, "completed");

	const waitStartedAt = Date.now();
	const waited = await tool.execute("wait", { agent: "explorer", task: "foreground work", wait: true }, new AbortController().signal, undefined, ctx);
	assert.ok(Date.now() - waitStartedAt >= 140, "wait=true should await the child");
	assert.equal(waited.content[0].text, "finished");
});
