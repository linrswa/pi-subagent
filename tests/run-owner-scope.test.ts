import assert from "node:assert/strict";
import test from "node:test";
import { findRunByRef } from "../run-refs.ts";
import { SubagentRunStore } from "../store.ts";

const input = (task: string, ownerSessionId?: string) => ({ mode: "single" as const, agent: "explorer", agentSource: "user" as const, task, ownerSessionId });

test("run store partitions duplicate short ids by main-session owner", () => {
	const store = new SubagentRunStore();
	store.setActiveOwner("main-A");
	const a = store.create(input("A work", "main-A"));
	assert.equal(a.id, "subagent-1");

	store.setActiveOwner("main-B");
	const b = store.create(input("B work", "main-B"));
	assert.equal(b.id, "subagent-1");
	assert.deepEqual(store.getSnapshot().map((run) => run.task), ["B work"]);
	assert.equal(findRunByRef("&1", store.getSnapshot())?.ownerSessionId, "main-B");
	assert.equal(store.update(a.id, { status: "completed" }, "main-A")?.status, "completed");
	assert.equal(store.get(a.id)?.status, "queued", "an owner-bound completion must not update B's duplicate id");

	store.setActiveOwner("main-A");
	assert.deepEqual(store.getSnapshot().map((run) => [run.id, run.task, run.status]), [["subagent-1", "A work", "completed"]]);
	assert.equal(findRunByRef("&1", store.getSnapshot())?.task, "A work");
});

test("owner-bound subscribers remain locked after active session changes", () => {
	const store = new SubagentRunStore();
	store.setActiveOwner("main-A");
	const a = store.create(input("A work", "main-A"));
	const seen: string[][] = [];
	store.subscribe((runs) => seen.push(runs.map((run) => run.task)), "main-A");
	store.setActiveOwner("main-B");
	store.create(input("B work", "main-B"));
	store.update(a.id, { finalOutput: "done" }, "main-A");
	assert.ok(seen.every((tasks) => tasks.every((task) => task === "A work")));
});
