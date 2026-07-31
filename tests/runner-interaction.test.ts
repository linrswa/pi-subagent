import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import { getChildSessionsRoot } from "../child-sessions.ts";
import { runSingleAgent } from "../runner.ts";
import { subagentRunStore } from "../store.ts";

async function waitFor(owner: string, runId: string, predicate: (run: NonNullable<ReturnType<typeof subagentRunStore.get>>) => boolean) {
	for (let attempt = 0; attempt < 200; attempt++) {
		const run = subagentRunStore.get(runId, owner);
		if (run && predicate(run)) return run;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Timed out waiting for ${runId}`);
}

test("RPC runner exposes live progress and accepts steering while running", async (t) => {
	const owner = `runner-interaction-${randomUUID()}`;
	const temp = await mkdtemp(path.join(tmpdir(), "pi-subagent-interaction-"));
	const script = path.join(temp, "fake-pi.mjs");
	const sdkUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
	await writeFile(script, `
import { SessionManager } from ${JSON.stringify(sdkUrl)};
const args = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1];
const manager = SessionManager.create(process.cwd(), value("--session-dir"), { id: value("--session-id") });
let buffer = "";
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
async function handle(command) {
  if (command.type === "prompt") {
    emit({ id: command.id, type: "response", command: "prompt", success: true });
    manager.appendMessage({ role: "user", content: command.message, timestamp: Date.now() });
    emit({ type: "message_end", message: { role: "user", content: [{ type: "text", text: command.message }] } });
    emit({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "investigating now" }], model: "test" }, assistantMessageEvent: { type: "text_delta", delta: "investigating now" } });
    emit({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "bash", args: { command: "long-check" } });
    emit({ type: "tool_execution_update", toolCallId: "tool-1", toolName: "bash", args: { command: "long-check" }, partialResult: { content: [{ type: "text", text: "halfway" }] } });
    return;
  }
  if (command.type === "steer") {
    emit({ id: command.id, type: "response", command: "steer", success: true });
    emit({ type: "queue_update", steering: [command.message], followUp: [] });
    manager.appendMessage({ role: "user", content: command.message, timestamp: Date.now() });
    emit({ type: "message_end", message: { role: "user", content: [{ type: "text", text: command.message }] } });
    emit({ type: "tool_execution_end", toolCallId: "tool-1", toolName: "bash", result: { content: [{ type: "text", text: "done" }] }, isError: false });
    const answer = "FIRST SECOND: " + command.message;
    manager.appendMessage({ role: "assistant", content: answer, provider: "test", model: "test", timestamp: Date.now(), usage: { input: 2, output: 3, totalTokens: 5 }, stopReason: "stop" });
    emit({ type: "queue_update", steering: [], followUp: [] });
    emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: answer }], model: "test", usage: { input: 2, output: 3, totalTokens: 5 }, stopReason: "stop" } });
    emit({ type: "agent_settled" });
  }
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) if (line.trim()) void handle(JSON.parse(line));
});
process.on("SIGTERM", () => process.exit(0));
`);
	const originalScript = process.argv[1];
	process.argv[1] = script;
	t.after(async () => {
		process.argv[1] = originalScript;
		await rm(temp, { recursive: true, force: true });
		await rm(path.join(getChildSessionsRoot(), owner), { recursive: true, force: true });
	});

	let runId = "";
	const completion = runSingleAgent({
		mode: "single",
		defaultCwd: process.cwd(),
		agents: [{ name: "fake", description: "", systemPrompt: "", source: "user", filePath: script }],
		agentName: "fake",
		task: "produce FIRST",
		ownerSessionId: owner,
		makeDetails: (results) => ({ mode: "single", agentScope: "user", packageAgentsDir: "", userAgentsDir: "", projectAgentsDir: null, results: [] }),
		onRunCreated: (run) => { runId = run.id; },
	});

	const live = await waitFor(owner, runId, (run) => run.currentTool === "bash" && run.liveToolOutput === "halfway");
	assert.equal(live.liveMessage, "investigating now");
	assert.deepEqual(live.currentToolArgs, { command: "long-check" });
	assert.ok(live.sendInput);
	assert.equal(await live.sendInput!("include SECOND", "steer"), "sent");

	const result = await completion;
	assert.equal(result.exitCode, 0);
	assert.equal(result.messages.at(-1)?.content[0]?.type, "text");
	assert.equal((result.messages.at(-1)?.content[0] as { text: string }).text, "FIRST SECOND: include SECOND");
	const closed = subagentRunStore.get(runId, owner)!;
	assert.equal(closed.status, "completed");
	assert.equal(closed.sendInput, undefined);
	assert.equal(closed.liveMessage, undefined);
	assert.equal(closed.liveToolOutput, undefined);
});
