import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { RunPointerPersistence, RUN_POINTER_ENTRY_TYPE, RUN_TOMBSTONE_ENTRY_TYPE, restoreRunPointers, toRunPointer } from "../run-pointers.ts";
import { SubagentRunStore } from "../store.ts";

function run(id = "subagent-1", ownerSessionId = "main-A") {
	return {
		id, ownerSessionId, mode: "single" as const, agent: "explorer", agentSource: "user" as const,
		task: "find secret", status: "completed" as const, cwd: "/work", startedAt: 10, endedAt: 20,
		sessionId: "child", sessionDir: "/sessions", sessionFile: "/sessions/child.jsonl", leafId: "leaf",
		messages: [{ role: "assistant", content: [{ type: "text", text: "MUST NOT PERSIST" }] }],
		usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 3, turns: 1 },
	};
}

test("run pointers retain only metadata and restore refs without id collisions", () => {
	const pointer = toRunPointer(run());
	assert.equal(JSON.stringify(pointer).includes("MUST NOT PERSIST"), false);
	assert.equal("messages" in pointer, false);
	const restored = restoreRunPointers([{ type: "custom", customType: RUN_POINTER_ENTRY_TYPE, data: pointer }], "main-A");
	assert.equal(restored.runs[0]?.id, "subagent-1");
	assert.deepEqual(restored.runs[0]?.messages, []);
	const store = new SubagentRunStore();
	store.setActiveOwner("main-A");
	store.hydrate("main-A", restored.runs, restored.maxRunNumber);
	assert.equal(store.create({ mode: "single", agent: "explorer", agentSource: "user", task: "new" }).id, "subagent-2");
});

test("tombstones prevent a deleted pointer from reviving and reserve its number", () => {
	const pointer = toRunPointer(run("subagent-7"));
	const restored = restoreRunPointers([
		{ type: "custom", customType: RUN_POINTER_ENTRY_TYPE, data: pointer },
		{ type: "custom", customType: RUN_TOMBSTONE_ENTRY_TYPE, data: { version: 1, runId: "subagent-7" } },
	], "main-A");
	assert.deepEqual(restored.runs, []);
	const store = new SubagentRunStore();
	store.setActiveOwner("main-A");
	store.hydrate("main-A", restored.runs, restored.maxRunNumber);
	assert.equal(store.create({ mode: "single", agent: "explorer", agentSource: "user", task: "new" }).id, "subagent-8");
});

test("complete SessionManager tree keeps sibling tombstones and high IDs on restore", async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), "pi-subagent-pointer-tree-"));
	try {
		const manager = SessionManager.create(process.cwd(), dir, { id: "main-pointer-tree" });
		const branchPoint = manager.appendMessage({ role: "user", content: "branch here", timestamp: Date.now() } as any);
		manager.appendCustomEntry(RUN_POINTER_ENTRY_TYPE, toRunPointer(run("subagent-2")));
		manager.appendCustomEntry(RUN_TOMBSTONE_ENTRY_TYPE, { version: 1, runId: "subagent-2" });
		manager.appendCustomEntry(RUN_POINTER_ENTRY_TYPE, toRunPointer(run("subagent-91")));

		// The active sibling cannot see the tombstone or high ID via getBranch().
		manager.branch(branchPoint);
		manager.appendCustomEntry(RUN_POINTER_ENTRY_TYPE, toRunPointer(run("subagent-2")));
		assert.equal(restoreRunPointers(manager.getBranch(), "main-A").maxRunNumber, 2);

		const restored = restoreRunPointers(manager.getEntries(), "main-A");
		assert.equal(restored.runs.some((entry) => entry.id === "subagent-2"), false);
		assert.equal(restored.maxRunNumber, 91);
		const store = new SubagentRunStore();
		store.setActiveOwner("main-A");
		store.hydrate("main-A", restored.runs, restored.maxRunNumber);
		assert.equal(store.create({ mode: "single", agent: "explorer", agentSource: "user", task: "new" }).id, "subagent-92");
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("activation closes stale runtime pointers and persists their terminal metadata", async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), "pi-subagent-pointer-stale-"));
	try {
		const manager = SessionManager.create(process.cwd(), dir, { id: "main-pointer-stale" });
		// Pi materializes a branch only after an assistant response.
		manager.appendMessage({ role: "user", content: "resume", timestamp: Date.now() } as any);
		manager.appendMessage({ role: "assistant", content: "resuming", provider: "test", model: "test", timestamp: Date.now() } as any);
		const stale = { ...toRunPointer(run("subagent-4")), status: "running" as const };
		delete stale.endedAt;
		const queued = { ...toRunPointer(run("subagent-5")), status: "queued" as const };
		delete queued.endedAt;
		manager.appendCustomEntry(RUN_POINTER_ENTRY_TYPE, stale);
		manager.appendCustomEntry(RUN_POINTER_ENTRY_TYPE, queued);

		const persistence = new RunPointerPersistence({
			appendEntry: (type: string, data: unknown) => manager.appendCustomEntry(type, data),
		} as any);
		const store = new SubagentRunStore();
		persistence.activate("main-A", manager.getEntries(), store);
		for (const id of ["subagent-4", "subagent-5"]) {
			const reconciled = store.get(id, "main-A");
			assert.equal(reconciled?.status, "aborted");
			assert.ok(reconciled?.endedAt);
		}

		const reloaded = SessionManager.open(manager.getSessionFile()!);
		const restored = new Map(restoreRunPointers(reloaded.getEntries(), "main-A").runs.map((entry) => [entry.id, entry]));
		for (const id of ["subagent-4", "subagent-5"]) {
			assert.equal(restored.get(id)?.status, "aborted");
			assert.ok(restored.get(id)?.endedAt);
		}
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("custom pointer entries are excluded from buildSessionContext", async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), "pi-subagent-pointer-"));
	try {
		const manager = SessionManager.create(process.cwd(), dir, { id: "main-pointer-test" });
		manager.appendMessage({ role: "user", content: "visible", timestamp: Date.now() } as any);
		manager.appendCustomEntry(RUN_POINTER_ENTRY_TYPE, { transcript: "SECRET CHILD TRANSCRIPT" });
		const context = manager.buildSessionContext();
		assert.deepEqual(context.messages.map((message) => message.content), ["visible"]);
		assert.equal(JSON.stringify(context).includes("SECRET CHILD TRANSCRIPT"), false);
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("session-generation guard never appends an old background run into a new session", () => {
	const entries: Array<{ type: string; data: unknown }> = [];
	const persistence = new RunPointerPersistence({ appendEntry: (type: string, data: unknown) => entries.push({ type, data }) } as any);
	const store = new SubagentRunStore();
	persistence.activate("main-A", [], store);
	persistence.record(run());
	assert.equal(entries.length, 1);
	persistence.activate("main-B", [], store);
	persistence.record(run());
	assert.equal(entries.length, 1, "A completion after switching to B is skipped");
	persistence.activate("main-A", [], store);
	persistence.record({ ...run(), status: "failed" });
	assert.equal(entries.length, 1, "even switching back cannot let an old generation append");
	persistence.tombstone("main-A", "subagent-1");
	assert.equal(entries.length, 2);
	persistence.deactivate();
	persistence.record(run("subagent-2", "main-B"));
	assert.equal(entries.length, 2);
});
