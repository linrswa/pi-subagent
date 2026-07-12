import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, rm } from "node:fs/promises";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { branchChildSession, ensureChildSessionDir, getChildSessionsRoot } from "../child-sessions.ts";
import { SubagentManager } from "../manager.ts";
import { RUN_POINTER_ENTRY_TYPE, restoreRunPointers } from "../run-pointers.ts";
import { SubagentRunStore, subagentRunStore } from "../store.ts";

async function persistedSession(owner: string) {
	const sessionDir = await ensureChildSessionDir(owner);
	const sessionId = randomUUID();
	const manager = SessionManager.create(process.cwd(), sessionDir, { id: sessionId });
	manager.appendMessage({ role: "user", content: "question", timestamp: Date.now() } as any);
	const leafId = manager.appendMessage({
		role: "assistant", content: "answer", provider: "test", model: "test", timestamp: Date.now(),
		usage: { input: 1, output: 1, totalTokens: 2 }, stopReason: "stop",
	} as any);
	return { sessionId, sessionDir, sessionFile: manager.getSessionFile()!, leafId };
}

function addRun(owner: string, session: Awaited<ReturnType<typeof persistedSession>>, status: "completed" | "running" = "completed") {
	const run = subagentRunStore.create({
		ownerSessionId: owner, mode: "single", agent: "explorer", agentSource: "user", task: "task",
		cwd: process.cwd(), sessionId: session.sessionId, sessionDir: session.sessionDir, sessionFile: session.sessionFile, leafId: session.leafId,
	});
	subagentRunStore.update(run.id, { status, ...(status === "completed" ? { endedAt: Date.now() } : {}) }, owner);
	return run;
}

test("delete aborts a running run before cleaning only its own session and tombstoning it", async () => {
	const owner = `delete-test-${randomUUID()}`;
	subagentRunStore.setActiveOwner(owner);
	const tombstones: string[] = [];
	try {
		const session = await persistedSession(owner);
		const run = addRun(owner, session, "running");
		let aborted = false;
		subagentRunStore.update(run.id, {
			abort: () => {
				if (aborted) return;
				aborted = true;
				subagentRunStore.update(run.id, { status: "aborted", abort: undefined }, owner);
				setTimeout(() => subagentRunStore.update(run.id, { endedAt: Date.now() }, owner), 35);
			},
		}, owner);
		const manager = new SubagentManager({} as any, (deleted) => tombstones.push(deleted.id));

		const unknown = await manager.deleteRun("subagent-999");
		assert.equal(unknown.deleted, false);
		await access(session.sessionFile);
		assert.equal(unknown.message, "Unknown subagent run.");

		const result = await manager.deleteRun(run.id);
		assert.equal(result.deleted, true);
		assert.equal(aborted, true);
		assert.equal(subagentRunStore.get(run.id, owner), undefined);
		assert.deepEqual(tombstones, [run.id]);
		await assert.rejects(access(session.sessionFile));
	} finally {
		await rm(`${getChildSessionsRoot()}/${owner}`, { recursive: true, force: true });
	}
});

test("deleting a hydrated stale running pointer cleans its session and tombstones promptly", async () => {
	const owner = `delete-hydrated-${randomUUID()}`;
	const store = new SubagentRunStore();
	store.setActiveOwner(owner);
	const tombstones: string[] = [];
	try {
		const session = await persistedSession(owner);
		const restored = restoreRunPointers([{
			type: "custom", customType: RUN_POINTER_ENTRY_TYPE,
			data: {
				version: 1, runId: "subagent-1", agent: "explorer", agentSource: "user", task: "interrupted",
				status: "running", cwd: process.cwd(), sessionId: session.sessionId, sessionDir: session.sessionDir,
				sessionFile: session.sessionFile, leafId: session.leafId, startedAt: Date.now(),
			},
		}], owner);
		store.hydrate(owner, restored.runs, restored.maxRunNumber);
		const manager = new SubagentManager({} as any, (deleted) => tombstones.push(deleted.id), undefined, store);

		const started = Date.now();
		const result = await manager.deleteRun("subagent-1");
		assert.equal(result.deleted, true);
		assert.ok(Date.now() - started < 1_000, "stale hydrated run should not wait for the live-run timeout");
		assert.equal(store.get("subagent-1", owner), undefined);
		assert.deepEqual(tombstones, ["subagent-1"]);
		await assert.rejects(access(session.sessionFile));
	} finally {
		await rm(`${getChildSessionsRoot()}/${owner}`, { recursive: true, force: true });
	}
});

test("deleting a parent leaves an already-forked continuation session and run intact", async () => {
	const owner = `delete-parent-${randomUUID()}`;
	subagentRunStore.setActiveOwner(owner);
	try {
		const parentSession = await persistedSession(owner);
		const childSession = await branchChildSession(parentSession);
		assert.ok(childSession.sessionFile);
		const parent = addRun(owner, parentSession);
		const child = addRun(owner, { ...childSession, leafId: childSession.leafId! });
		const manager = new SubagentManager({} as any);

		assert.equal((await manager.deleteRun(parent.id)).deleted, true);
		assert.equal(subagentRunStore.get(parent.id, owner), undefined);
		assert.equal(subagentRunStore.get(child.id, owner)?.sessionFile, childSession.sessionFile);
		await access(childSession.sessionFile!);
	} finally {
		await rm(`${getChildSessionsRoot()}/${owner}`, { recursive: true, force: true });
	}
});
