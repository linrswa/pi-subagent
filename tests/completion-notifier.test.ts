import assert from "node:assert/strict";
import test from "node:test";
import { CompletionNotifier } from "../completion-notifier.ts";
import { restoreRunPointers, RUN_POINTER_ENTRY_TYPE, toRunPointer } from "../run-pointers.ts";
import { subagentRunStore } from "../store.ts";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("completion notifier batches UI status and injects results on the next input", async () => {
	const notices: string[] = [];
	const owner = "completion-owner";
	subagentRunStore.setActiveOwner(owner);
	const notifier = new CompletionNotifier();
	notifier.activate(owner, { hasUI: true, ui: { notify: (message: string) => notices.push(message) } } as any);

	const first = subagentRunStore.create({ mode: "single", agent: "explorer", agentSource: "user", task: "one", ownerSessionId: owner, completionNotification: "pending" });
	const second = subagentRunStore.create({ mode: "single", agent: "reviewer", agentSource: "user", task: "two", ownerSessionId: owner, completionNotification: "pending" });
	let resolveFirst!: () => void;
	let resolveSecond!: () => void;
	const firstDone = new Promise<void>((resolve) => { resolveFirst = resolve; });
	const secondDone = new Promise<void>((resolve) => { resolveSecond = resolve; });
	notifier.watch(first, firstDone);
	notifier.watch(second, secondDone);
	subagentRunStore.update(first.id, { status: "completed", endedAt: Date.now(), finalOutput: "one done" }, owner);
	subagentRunStore.update(second.id, { status: "failed", endedAt: Date.now(), errorMessage: "two failed" }, owner);
	resolveFirst();
	resolveSecond();
	await delay(140);

	assert.equal(notices.length, 1);
	assert.match(notices[0], /2 subagents finished/);
	assert.equal(subagentRunStore.get(first.id, owner)?.completionNotification, "pending");
	const staged = notifier.stageForNextInput(owner);
	assert.match(staged.content ?? "", /one done/);
	assert.match(staged.content ?? "", /two failed/);
	assert.equal(staged.runs.length, 2);
	assert.equal(subagentRunStore.get(first.id, owner)?.completionNotification, "pending");
	assert.equal(notifier.acknowledgeStaged(owner).length, 2);
	assert.equal(subagentRunStore.get(first.id, owner)?.completionNotification, "delivered");
	notifier.deactivate(owner);
});

test("an explicitly aborted background run is delivered on the next input", async () => {
	const owner = "aborted-completion-owner";
	subagentRunStore.setActiveOwner(owner);
	const notifier = new CompletionNotifier();
	notifier.activate(owner, { hasUI: false, ui: { notify: () => undefined } } as any);
	const run = subagentRunStore.create({ mode: "single", agent: "explorer", agentSource: "user", task: "stop", ownerSessionId: owner, completionNotification: "pending" });
	notifier.watch(run, Promise.reject(new Error("aborted")));
	subagentRunStore.update(run.id, { status: "aborted", endedAt: Date.now(), errorMessage: "Subagent was aborted" }, owner);
	await Promise.resolve();
	const staged = notifier.stageForNextInput(owner);
	assert.match(staged.content ?? "", /aborted/);
	assert.equal(notifier.acknowledgeStaged(owner).length, 1);
	notifier.deactivate(owner);
});

test("a pending completion survives pointer hydration with a bounded summary", () => {
	const owner = "reload-completion-owner";
	subagentRunStore.setActiveOwner(owner);
	const run = subagentRunStore.create({ mode: "single", agent: "explorer", agentSource: "user", task: "reload", ownerSessionId: owner, completionNotification: "pending" });
	const completed = subagentRunStore.update(run.id, { status: "completed", endedAt: Date.now(), finalOutput: "survived reload" }, owner)!;
	const pointer = toRunPointer(completed);
	const restored = restoreRunPointers([{ type: "custom", customType: RUN_POINTER_ENTRY_TYPE, data: pointer }], owner);
	subagentRunStore.hydrate(owner, restored.runs, restored.maxRunNumber);

	const notifier = new CompletionNotifier();
	notifier.activate(owner, { hasUI: false, ui: { notify: () => undefined } } as any);
	notifier.resume(subagentRunStore.getSnapshot(owner));
	const staged = notifier.stageForNextInput(owner);
	assert.match(staged.content ?? "", /survived reload/);
	assert.equal(staged.runs.length, 1);
	assert.equal(notifier.acknowledgeStaged(owner).length, 1);
	assert.equal(subagentRunStore.get(run.id, owner)?.completionNotification, "delivered");
	notifier.deactivate(owner);
});

test("completion from a deactivated session remains pending for a future activation", async () => {
	const owner = "old-completion-owner";
	subagentRunStore.setActiveOwner(owner);
	const notifier = new CompletionNotifier();
	notifier.activate(owner, { hasUI: false, ui: { notify: () => undefined } } as any);
	const run = subagentRunStore.create({ mode: "single", agent: "explorer", agentSource: "user", task: "old", ownerSessionId: owner, completionNotification: "pending" });
	let resolve!: () => void;
	const completion = new Promise<void>((done) => { resolve = done; });
	notifier.watch(run, completion);
	notifier.deactivate(owner);
	subagentRunStore.update(run.id, { status: "completed", endedAt: Date.now(), finalOutput: "late" }, owner);
	resolve();
	await delay(140);
	assert.equal(notifier.stageForNextInput(owner).content, undefined);
	assert.equal(subagentRunStore.get(run.id, owner)?.completionNotification, "pending");
});
