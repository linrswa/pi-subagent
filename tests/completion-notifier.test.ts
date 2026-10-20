import assert from "node:assert/strict";
import test from "node:test";
import { CompletionNotifier, COMPLETION_MESSAGE_TYPE, DELIVERY_PAUSED_ENTRY_TYPE } from "../completion-notifier.ts";
import { restoreRunPointers, RUN_POINTER_ENTRY_TYPE, toRunPointer } from "../run-pointers.ts";
import { subagentRunStore } from "../store.ts";

const delay = (ms = 140) => new Promise((resolve) => setTimeout(resolve, ms));
let serial = 0;
function setup() {
	const owner = `completion-test-${++serial}`;
	const sends: { message: any; options: any }[] = [];
	const entries: any[] = [];
	const pi = {
		sendMessage(message: any, options: any) { sends.push({ message, options }); },
		appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data }); },
	};
	const ctx = { hasUI: true, hasPendingMessages: () => false, ui: { notify() {} } } as any;
	subagentRunStore.setActiveOwner(owner);
	const notifier = new CompletionNotifier(pi);
	notifier.activate(owner, ctx);
	const make = (output = "done") => {
		const run = subagentRunStore.create({ mode: "single", agent: "worker", agentSource: "package", task: "test task", ownerSessionId: owner, completionNotification: "pending", taskId: "task-1" });
		return subagentRunStore.update(run.id, { status: "completed", endedAt: Date.now(), finalOutput: output }, owner)!;
	};
	return { owner, sends, entries, pi, ctx, notifier, make };
}

test("completion actively wakes an idle parent with a batched follow-up, without input", async () => {
	const s = setup();
	const first = s.make("one done");
	const second = s.make("two done");
	s.notifier.watch(first, Promise.resolve());
	s.notifier.watch(second, Promise.resolve());
	await delay();
	assert.equal(s.sends.length, 1);
	const { message, options } = s.sends[0];
	assert.deepEqual(options, { deliverAs: "followUp", triggerTurn: true });
	assert.equal(message.customType, COMPLETION_MESSAGE_TYPE);
	assert.match(message.content, /one done/);
	assert.match(message.content, /two done/);
	assert.match(message.content, /taskId task-1/);
	assert.match(message.content, /does NOT mean/);
	assert.equal(subagentRunStore.get(first.id, s.owner)?.completionNotification, "pending", "enqueue is not receipt");
	assert.equal(s.notifier.acknowledgeMessage({ role: "custom", ...message }).length, 2);
	assert.equal(s.notifier.acknowledgeMessage({ role: "custom", ...message }).length, 0, "idempotent receipt");
	s.notifier.resume();
	await delay();
	assert.equal(s.sends.length, 1);
	s.notifier.deactivate();
});

test("only the matching persisted custom message acknowledges a result", async () => {
	const s = setup();
	const run = s.make();
	s.notifier.resume();
	await delay();
	const message = s.sends[0].message;
	assert.equal(s.notifier.acknowledgeMessage({ role: "assistant", ...message }).length, 0);
	assert.equal(s.notifier.acknowledgeMessage({ role: "custom", ...message, details: { ...message.details, ownerSessionId: "other" } }).length, 0);
	assert.equal(s.notifier.acknowledgeMessage({ role: "custom", ...message, details: { ...message.details, runs: [{ id: run.id, endedAt: -1 }] } }).length, 0);
	assert.equal(subagentRunStore.get(run.id, s.owner)?.completionNotification, "pending");
	s.notifier.deactivate();
});

test("receipt replay after a crash prevents duplicate wake-up even with a stale pending pointer", async () => {
	const s = setup();
	const run = s.make("survived reload");
	const pointer = toRunPointer(run);
	s.notifier.resume();
	await delay();
	const messageEntry = { type: "custom_message", ...s.sends[0].message };
	s.notifier.deactivate();
	const restored = restoreRunPointers([{ type: "custom", customType: RUN_POINTER_ENTRY_TYPE, data: pointer }], s.owner);
	subagentRunStore.hydrate(s.owner, restored.runs, restored.maxRunNumber);
	assert.equal(s.notifier.activate(s.owner, s.ctx, [messageEntry]).length, 1);
	s.notifier.resume();
	await delay();
	assert.equal(s.sends.length, 1);
	assert.equal(subagentRunStore.get(run.id, s.owner)?.completionNotification, "delivered");
	s.notifier.deactivate();
});

test("pending results survive reload and enqueue without a new user input", async () => {
	const s = setup();
	const run = s.make("durable");
	const restored = restoreRunPointers([{ type: "custom", customType: RUN_POINTER_ENTRY_TYPE, data: toRunPointer(run) }], s.owner);
	s.notifier.deactivate();
	subagentRunStore.hydrate(s.owner, restored.runs, restored.maxRunNumber);
	s.notifier.activate(s.owner, s.ctx);
	s.notifier.resume();
	await delay();
	assert.match(s.sends[0].message.content, /durable/);
	s.notifier.deactivate();
});

test("deactivated owner cannot wake another session", async () => {
	const s = setup();
	const run = s.make();
	let done!: () => void;
	s.notifier.watch(run, new Promise<void>((resolve) => { done = resolve; }));
	s.notifier.activate("other-owner", s.ctx);
	done();
	await delay();
	assert.equal(s.sends.length, 0);
	assert.equal(subagentRunStore.get(run.id, s.owner)?.completionNotification, "pending");
	s.notifier.deactivate();
});

test("parent abort pauses wake-ups durably; an explicit user run resumes them", async () => {
	const s = setup();
	s.make();
	s.notifier.resume();
	s.notifier.pause();
	await delay();
	assert.equal(s.sends.length, 0);
	assert.equal(s.entries[0].customType, DELIVERY_PAUSED_ENTRY_TYPE);
	s.notifier.activate(s.owner, s.ctx, s.entries);
	s.notifier.resume();
	await delay();
	assert.equal(s.sends.length, 0);
	s.notifier.resumeAfterUserInput();
	await delay();
	assert.equal(s.sends.length, 1);
	s.notifier.deactivate();
});

test("synchronous delivery failure remains pending and does not retry automatically", async () => {
	const s = setup();
	const run = s.make();
	let attempts = 0;
	s.pi.sendMessage = () => { attempts++; throw new Error("failed send"); };
	s.notifier.resume();
	await delay();
	s.notifier.resume();
	await delay();
	assert.equal(attempts, 1);
	assert.equal(subagentRunStore.get(run.id, s.owner)?.completionNotification, "pending");
	s.pi.sendMessage = (message, options) => { s.sends.push({ message, options }); };
	s.notifier.resumeAfterUserInput();
	await delay();
	assert.equal(s.sends.length, 1);
	s.notifier.deactivate();
});

test("suppressed or not fully closed runs never enqueue", async () => {
	const s = setup();
	const suppressed = s.make();
	subagentRunStore.update(suppressed.id, { completionNotification: "suppressed" }, s.owner);
	const closing = s.make();
	subagentRunStore.update(closing.id, { abort: () => {} }, s.owner);
	s.notifier.resume();
	await delay();
	assert.equal(s.sends.length, 0);
	s.notifier.deactivate();
});

test("explicitly stopped child reports its abort without restarting the child", async () => {
	const s = setup();
	const run = s.make();
	subagentRunStore.update(run.id, { status: "aborted", finalOutput: "", errorMessage: "stopped by user" }, s.owner);
	s.notifier.watch(run, Promise.reject(new Error("aborted")));
	await delay();
	assert.match(s.sends[0].message.content, /execution aborted/);
	assert.match(s.sends[0].message.content, /Do not restart/);
	s.notifier.deactivate();
});
