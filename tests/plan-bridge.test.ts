import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { SubagentPlanBridge } from "../plan-bridge.ts";
import { SubagentRunStore } from "../store.ts";

function setup() {
	const emitter = new EventEmitter();
	const events = { on(name: string, fn: (value: unknown) => void) { emitter.on(name, fn); return () => { emitter.off(name, fn); }; }, emit(name: string, value: unknown) { emitter.emit(name, value); } };
	const bridge = new SubagentPlanBridge({ events } as any);
	const store = new SubagentRunStore();
	const run = store.create({ ownerSessionId: "owner-A", mode: "single", agent: "worker", agentSource: "package", task: "check", taskId: "todo-1" });
	return { events, bridge, store, run };
}

test("bridge publishes bounded metadata changes and provides an immediate snapshot", () => {
	const s = setup();
	const seen: any[] = [];
	s.events.on("pi-subagent:state", (value) => seen.push(value));
	s.bridge.activate("owner-A", [s.run]);
	s.bridge.record({ ...s.run, liveMessage: "streaming token" });
	assert.equal(seen.length, 1, "token streaming does not flood the integration bus");
	s.bridge.record({ ...s.run, status: "completed", finalOutput: "semantic success not established" });
	assert.equal(seen.length, 2);
	assert.equal(seen[1].runs[0].taskId, "todo-1");
	assert.equal("finalOutput" in seen[1].runs[0], false);
	let snapshot: any;
	s.events.emit("pi-subagent:snapshot-request", { ownerSessionId: "owner-A", respond: (value: unknown) => { snapshot = value; } });
	assert.equal(snapshot.runs[0].status, "completed");
	s.bridge.remove(s.run);
	assert.equal(seen.at(-1).runs.length, 0);
	s.bridge.deactivate();
});

test("bridge isolates sessions and unsubscribes on deactivate", () => {
	const s = setup();
	s.bridge.activate("owner-A", [s.run]);
	let calls = 0;
	s.events.emit("pi-subagent:snapshot-request", { ownerSessionId: "owner-B", respond: () => { calls++; } });
	assert.equal(calls, 0);
	s.bridge.activate("owner-B", []);
	s.bridge.record(s.run);
	s.events.emit("pi-subagent:snapshot-request", { ownerSessionId: "owner-B", respond: (value: any) => { calls++; assert.equal(value.runs.length, 0); } });
	assert.equal(calls, 1);
	s.bridge.deactivate();
	s.events.emit("pi-subagent:snapshot-request", { ownerSessionId: "owner-B", respond: () => { calls++; } });
	assert.equal(calls, 1);
});

test("bridge asks plan owner for a stable task id without importing the plan store", () => {
	const s = setup();
	assert.equal(s.bridge.currentTaskId("owner-A"), undefined);
	s.events.on("pi-plan:context-request", (value: any) => {
		if (value.ownerSessionId === "owner-A") value.respond({ readOnly: false, taskId: "stable-task" });
	});
	assert.equal(s.bridge.currentTaskId("owner-A"), "stable-task");
	assert.equal(s.bridge.currentTaskId("owner-B"), undefined);
});
