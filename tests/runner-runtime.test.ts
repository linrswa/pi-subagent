import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test, { type TestContext } from "node:test";
import { startChain } from "../chain-runner.ts";
import { getChildSessionsRoot } from "../child-sessions.ts";
import { getFinalOutput, getTerminalRunStatus, isFailedResult, toParentResult } from "../results.ts";
import { childProcessPool } from "../process-pool.ts";
import { runSingleAgent } from "../runner.ts";
import { subagentRunStore } from "../store.ts";
import type { SubagentRun } from "../types.ts";

const makeDetails = () => ({ mode: "single" as const, agentScope: "user" as const, packageAgentsDir: "", userAgentsDir: "", projectAgentsDir: null, results: [] });

async function fixture(t: TestContext, handle: string) {
	const owner = `runner-runtime-${randomUUID()}`;
	const temp = await mkdtemp(path.join(tmpdir(), "pi-subagent-runtime-"));
	const script = path.join(temp, "fake-pi.mjs");
	const trace = path.join(temp, "commands.jsonl");
	const sdkUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
	// Use the installed host's actual serializer: SDK snapshots are not the wire format.
	const serializerUrl = new URL("./modes/json-event.js", sdkUrl).href;
	await writeFile(script, `
import { SessionManager } from ${JSON.stringify(sdkUrl)};
import { toJsonEvent } from ${JSON.stringify(serializerUrl)};
import { appendFileSync, closeSync } from "node:fs";
const args = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1];
const manager = SessionManager.create(process.cwd(), value("--session-dir"), { id: value("--session-id") });
const usage = { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const assistant = (text, stopReason = "stop", errorMessage) => ({ role: "assistant", content: text ? [{ type: "text", text }] : [], api: "openai-completions", provider: "test", model: "wire-model", usage, stopReason, errorMessage, timestamp: Date.now() });
const emit = (event) => process.stdout.write(JSON.stringify(toJsonEvent(event)) + "\\n");
const respond = (command, data) => emit({ id: command.id, type: "response", command: command.type, success: true, data });
const finish = (text, stopReason = "stop", errorMessage) => {
  const message = assistant(text, stopReason, errorMessage);
  manager.appendMessage(message);
  emit({ type: "message_end", message });
};
const update = (event, content = []) => {
  const message = { ...assistant("", "pending"), content };
  emit({ type: "message_update", message, assistantMessageEvent: { ...event, partial: message } });
};
let prompt;
let firstInput;
async function handle(command) {
  appendFileSync(${JSON.stringify(trace)}, JSON.stringify(command) + "\\n");
  if (command.type === "prompt") {
    prompt = command;
    manager.appendMessage({ role: "user", content: command.message, timestamp: Date.now() });
    emit({ type: "message_end", message: { role: "user", content: command.message, timestamp: Date.now() } });
  }
  ${handle}
}
let buffer = "";
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
	const controller = new AbortController();
	t.after(async () => {
		controller.abort();
		process.argv[1] = originalScript;
		await rm(temp, { recursive: true, force: true });
		await rm(path.join(getChildSessionsRoot(), owner), { recursive: true, force: true });
	});
	return {
		owner,
		options: {
			mode: "single" as const, defaultCwd: process.cwd(),
			agents: [{ name: "fake", description: "", systemPrompt: "", source: "user" as const, filePath: script }],
			agentName: "fake", task: "test", ownerSessionId: owner, signal: controller.signal, makeDetails,
		},
		commands: async () => (await readFile(trace, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)),
	};
}

async function waitFor(owner: string, predicate: (run: SubagentRun) => boolean): Promise<SubagentRun> {
	for (let attempt = 0; attempt < 400; attempt++) {
		const run = subagentRunStore.getSnapshot(owner).find(predicate);
		if (run) return run;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("Timed out waiting for child progress");
}

for (const recovery of ["retry", "overflow", "length"] as const) {
	test(`runner replaces historical ${recovery} failure with the recovered final outcome`, { timeout: 10_000 }, async (t) => {
		const f = await fixture(t, `
  if (command.type !== "prompt") return respond(command);
  respond(command, { disposition: "started" });
  finish("partial", ${JSON.stringify(recovery === "length" ? "length" : "error")}, ${recovery === "length" ? "undefined" : JSON.stringify(recovery === "retry" ? "529 overloaded" : "context overflow")});
  emit({ type: "agent_end", messages: [], willRetry: true });
  ${recovery === "overflow"
			? 'emit({ type: "compaction_start", reason: "overflow" }); emit({ type: "compaction_end", reason: "overflow", aborted: false, willRetry: true });'
			: 'emit({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 1, errorMessage: "retry" });'}
  finish("recovered answer");
  emit({ type: "auto_retry_end", success: true, attempt: 1 });
  emit({ type: "agent_end", messages: [], willRetry: false });
  emit({ type: "agent_settled", aborted: false });
`);
		const result = await runSingleAgent(f.options);
		assert.equal(result.exitCode, 0);
		assert.equal(result.stopReason, "stop");
		assert.equal(result.errorMessage, undefined);
		assert.equal(result.usage.turns, 2);
		assert.equal(result.usage.input, 4);
		assert.equal(getFinalOutput(result.messages), "recovered answer");
		assert.equal(toParentResult(result).status, "completed");
		const stored = subagentRunStore.get(result.runId!, f.owner)!;
		assert.equal(stored.status, "completed");
		assert.equal(stored.errorMessage, undefined);
	});
}

test("unrecovered length is failed and cannot advance a chain", { timeout: 10_000 }, async (t) => {
	const f = await fixture(t, `
  if (command.type !== "prompt") return respond(command);
  respond(command, { disposition: "started" });
  finish("unfinished answer", "length");
  emit({ type: "agent_settled", aborted: false });
`);
	const chain = startChain({
		...f.options, agentScope: "user", completionNotification: "pending",
		steps: [{ agent: "fake", task: "first" }, { agent: "fake", task: "must never start {previous}" }],
	});
	const result = await chain.completion;
	assert.equal(result.status, "failed");
	assert.equal(result.results.length, 1);
	assert.equal(result.run.childRunIds?.length, 1);
	assert.match(result.finalOutput, /incomplete.*length limit/);
	const child = result.results[0];
	assert.equal(getTerminalRunStatus(child), "failed");
	assert.equal(isFailedResult({ ...child, exitCode: 0 }), true, "length itself is failure even with a zero process exit");
	assert.equal(toParentResult(child).status, "failed");
});

test("Pi 1.3 serialized deltas reconstruct bounded live text and commit only message_end", { timeout: 10_000 }, async (t) => {
	const f = await fixture(t, `
  if (command.type === "prompt") {
    respond(command, { disposition: "started" });
    emit({ type: "message_start", message: assistant("", "pending") });
    update({ type: "text_start", contentIndex: 0 });
    update({ type: "text_delta", contentIndex: 0, delta: "Hello wrong" });
    update({ type: "text_end", contentIndex: 0, content: "Hello" });
    update({ type: "thinking_delta", contentIndex: 1, delta: "not displayable".repeat(2000) });
    update({ type: "text_delta", contentIndex: 2, delta: " world" });
    update({ type: "text_end", contentIndex: 2, content: " world!" });
    update({ type: "toolcall_start", contentIndex: 3 }, [null, null, null, { type: "toolCall", id: "call-1", name: "bash", arguments: {} }]);
    update({ type: "toolcall_delta", contentIndex: 3, delta: "x".repeat(20000) });
    update({ type: "text_delta", contentIndex: 4, delta: "x".repeat(18000) });
    update({ type: "text_delta", contentIndex: 4, delta: "TAIL" });
    update({ type: "text_end", contentIndex: 4, content: "x".repeat(18000) + "TAIL" });
    emit({ type: "tool_execution_start", toolName: "ready", args: {} });
  } else if (command.type === "follow_up") {
    respond(command, { disposition: "queued" });
    finish("authoritative final answer");
    setTimeout(() => emit({ type: "agent_settled", aborted: false }), 50);
  } else respond(command);
`);
	const seen: SubagentRun[] = [];
	const unsubscribe = subagentRunStore.subscribeChanges((run) => { if (run.ownerSessionId === f.owner) seen.push(run); });
	t.after(unsubscribe);
	const completion = runSingleAgent(f.options);
	const live = await waitFor(f.owner, (run) => run.currentTool === "ready");
	assert.equal(live.model, "wire-model");
	assert.equal(live.usage.turns, 0);
	assert.equal(live.messages.filter((message) => message.role === "assistant").length, 0);
	assert.ok(seen.some((run) => run.liveMessage === "Hello world!"));
	assert.ok(seen.some((run) => run.currentTool === "bash"));
	assert.match(live.liveMessage!, /^\.\.\.\[truncated 6016 chars\]\n/);
	assert.ok(live.liveMessage!.endsWith("TAIL"));
	assert.ok(seen.every((run) => (run.liveMessage?.length ?? 0) < 12_060));
	await live.sendInput!("finish", "followUp");
	const result = await completion;
	assert.equal(result.exitCode, 0);
	assert.equal(result.usage.turns, 1);
	assert.equal(getFinalOutput(result.messages), "authoritative final answer");
	assert.ok(seen.some((run) => run.status === "running" && run.finalOutput === "authoritative final answer" && run.liveMessage === undefined));
});

for (const stage of ["prompt", "flush", "publish"] as const) {
	test(`stop during ${stage} acceptance clears guidance and never sends later inputs`, { timeout: 10_000 }, async (t) => {
		const f = await fixture(t, `
  if (command.type === "prompt") {
    ${stage === "prompt" ? "" : 'respond(command, { disposition: "started" });'}
    emit({ type: "tool_execution_start", toolName: "prompt-held", args: {} });
  } else if (command.type === "steer" || command.type === "follow_up") {
    firstInput = command;
    emit({ type: "tool_execution_start", toolName: "flush-held", args: {} });
  } else if (command.type === "abort") {
    respond(prompt, { disposition: "started" });
    if (firstInput) respond(firstInput, { disposition: "queued" });
    emit({ type: "queue_update", steering: ["late queue event"], followUp: ["must stay cleared"] });
    respond(command);
    setTimeout(() => emit({ type: "agent_settled", aborted: true }), 80);
  } else respond(command);
`);
		const seen: SubagentRun[] = [];
		let stopped = false;
		const unsubscribe = subagentRunStore.subscribeChanges((run) => {
			if (run.ownerSessionId !== f.owner) return;
			seen.push(run);
			if (stage === "publish" && !stopped && run.status === "running" && run.pendingInputs?.length === 1) {
				stopped = true;
				run.abort!();
			}
		});
		t.after(unsubscribe);
		const completion = runSingleAgent({ ...f.options, onRunCreated: (run) => {
			void run.sendInput!("first", "steer");
			void run.sendInput!("second", "followUp");
		} });
		const rejection = assert.rejects(completion, /Subagent was aborted/);
		if (stage !== "publish") {
			const live = await waitFor(f.owner, (run) => run.currentTool === (stage === "prompt" ? "prompt-held" : "flush-held"));
			live.abort!();
			await assert.rejects(live.sendInput!("too late", "steer"), /no longer accepting/);
		}
		await rejection;
		const commands = await f.commands();
		assert.deepEqual(commands.filter((command) => ["steer", "follow_up"].includes(command.type)).map((command) => command.message), stage === "flush" ? ["first"] : []);
		assert.deepEqual(commands.slice(-2).map((command) => command.type), ["clear_queue", "abort"]);
		const abortedIndex = seen.findIndex((run) => run.status === "aborted");
		assert.ok(abortedIndex >= 0);
		assert.ok(seen.slice(abortedIndex).every((run) => !run.pendingInputs?.length && !run.sendInput));
	});
}

test("synchronous cancellation at spawn never submits the initial prompt", { timeout: 10_000 }, async (t) => {
	const f = await fixture(t, `
  respond(command);
  if (command.type === "abort") emit({ type: "agent_settled", aborted: true });
`);
	const unsubscribe = subagentRunStore.subscribeChanges((run) => {
		if (run.ownerSessionId === f.owner && run.status === "running") run.abort?.();
	});
	t.after(unsubscribe);
	await assert.rejects(runSingleAgent(f.options), /Subagent was aborted/);
	assert.deepEqual((await f.commands()).map((command) => command.type), ["clear_queue", "abort"]);
});

test("handled prompt disposition terminates instead of waiting forever for agent_settled", { timeout: 10_000 }, async (t) => {
	const f = await fixture(t, `respond(command, { disposition: "handled" });`);
	const result = await runSingleAgent(f.options);
	assert.equal(getTerminalRunStatus(result), "failed");
	assert.match(result.errorMessage!, /handled without starting a run/);
	assert.equal(subagentRunStore.get(result.runId!, f.owner)?.sendInput, undefined);
});

test("stdin EPIPE fails and cleans up the runner even if the child emits a late successful answer", { timeout: 10_000 }, async (t) => {
	const f = await fixture(t, `
  if (command.type !== "prompt") return respond(command);
  respond(command, { disposition: "started" });
  process.removeAllListeners("SIGTERM");
  process.on("SIGTERM", () => {
    finish("late successful answer");
    emit({ type: "agent_settled", aborted: false });
    setTimeout(() => process.exit(0), 30);
  });
  setInterval(() => {}, 1000); // Keep the RPC process alive after closing its input.
  setTimeout(() => {
    process.stdin.destroy();
    try { closeSync(0); } catch {}
    emit({ type: "tool_execution_start", toolName: "input-closed", args: {} });
  }, 30);
`);
	const completion = runSingleAgent(f.options);
	const live = await waitFor(f.owner, (run) => run.currentTool === "input-closed");
	await assert.rejects(live.sendInput!("x".repeat(100_000), "steer"), /EPIPE|closed|writable/);
	const result = await completion;
	assert.equal(getTerminalRunStatus(result), "failed");
	assert.match(result.errorMessage!, /EPIPE|closed|writable/);
	assert.equal(getFinalOutput(result.messages), "late successful answer");
	const closed = subagentRunStore.get(result.runId!, f.owner)!;
	assert.equal(closed.sendInput, undefined);
	assert.equal(closed.abort, undefined);
	assert.equal(closed.pendingInputs, undefined);
	assert.equal(childProcessPool.activeCount, 0);
	assert.equal(childProcessPool.queuedCount, 0);
});
