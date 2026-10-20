import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { branchChildSession, ensureChildSessionDir } from "../child-sessions.ts";
import { loadRunDetails } from "../manager.ts";
import { restoreRunPointers, RUN_POINTER_ENTRY_TYPE, toRunPointer } from "../run-pointers.ts";
import { SubagentRunStore } from "../store.ts";

test("status lazily reads the full final answer after restoring a bounded pointer", async () => {
	const owner = `result-test-${randomUUID()}`;
	const dir = await ensureChildSessionDir(owner);
	try {
		const session = SessionManager.create(process.cwd(), dir);
		session.appendMessage({ role: "user", content: "question", timestamp: Date.now() } as any);
		const output = "x".repeat(750) + " IMPORTANT_FAILURE_DETAIL";
		const leafId = session.appendMessage({ role: "assistant", content: [{ type: "text", text: output }], provider: "test", model: "test", stopReason: "stop", timestamp: Date.now(), usage: { input: 2, output: 3, totalTokens: 5 } } as any);
		const store = new SubagentRunStore();
		const run = store.create({ ownerSessionId: owner, mode: "single", agent: "worker", agentSource: "package", task: "test", taskId: "todo-id" });
		const terminal = store.update(run.id, { status: "completed", endedAt: Date.now(), sessionFile: session.getSessionFile()!, leafId, finalOutput: output, model: "test", usage: { ...run.usage, turns: 1, input: 2, output: 3 } }, owner)!;
		const restored = restoreRunPointers([{ type: "custom", customType: RUN_POINTER_ENTRY_TYPE, data: toRunPointer(terminal) }], owner).runs[0];
		assert.equal(restored.finalOutput?.length, 503);
		assert.equal(restored.taskId, "todo-id");
		assert.equal(restored.usage.turns, 1);
		const details = await loadRunDetails(restored);
		assert.match(details, /IMPORTANT_FAILURE_DETAIL/);
		assert.match(details, /task id: todo-id/);
		assert.match(details, /model: test/);
		assert.equal(restored.messages.length, 0, "full history is not restored into parent run state");
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("a failed continuation without its own answer never reports its source's answer", async () => {
	const owner = `result-continuation-${randomUUID()}`;
	const dir = await ensureChildSessionDir(owner);
	try {
		const source = SessionManager.create(process.cwd(), dir);
		source.appendMessage({ role: "user", content: "old task", timestamp: Date.now() } as any);
		const boundary = source.appendMessage({ role: "assistant", content: [{ type: "text", text: "INHERITED_ANSWER_NOT_THIS_RESULT" }], provider: "test", model: "test", stopReason: "stop", timestamp: Date.now(), usage: { input: 1, output: 1, totalTokens: 2 } } as any);
		const fork = await branchChildSession({ sessionFile: source.getSessionFile()!, leafId: boundary });
		const child = SessionManager.open(fork.sessionFile!);
		const leaf = child.appendMessage({ role: "user", content: "new task failed before answer", timestamp: Date.now() } as any);
		const store = new SubagentRunStore();
		const run = store.create({ ownerSessionId: owner, mode: "single", agent: "worker", agentSource: "package", task: "new task", sessionFile: fork.sessionFile, leafId: leaf, continuedFromRunId: "subagent-source", continuedFromLeafId: boundary });
		const failed = store.update(run.id, { status: "aborted", endedAt: Date.now(), errorMessage: "stopped before answer" }, owner)!;
		const restored = restoreRunPointers([{ type: "custom", customType: RUN_POINTER_ENTRY_TYPE, data: toRunPointer(failed) }], owner).runs[0];
		const details = await loadRunDetails(restored);
		assert.doesNotMatch(details, /INHERITED_ANSWER_NOT_THIS_RESULT/);
		assert.match(details, /stopped before answer/);
		assert.equal(restored.continuedFromLeafId, boundary);
		const ownLeaf = child.appendMessage({ role: "assistant", content: [{ type: "text", text: "OWN_ANSWER" }], provider: "test", model: "test", stopReason: "stop", timestamp: Date.now(), usage: { input: 1, output: 1, totalTokens: 2 } } as any);
		assert.match(await loadRunDetails({ ...restored, status: "completed", leafId: ownLeaf }), /OWN_ANSWER/);
	} finally { await rm(dir, { recursive: true, force: true }); }
});
