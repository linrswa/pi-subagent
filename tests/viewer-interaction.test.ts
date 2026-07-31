import assert from "node:assert/strict";
import test from "node:test";
import { subagentRunStore } from "../store.ts";
import { SubagentRunViewerComponent } from "../viewer.ts";

const tui = { terminal: { rows: 40 }, requestRender: () => undefined } as any;
const theme = { fg: (_color: string, text: string) => text } as any;

test("live viewer renders streaming progress and offers one-key guidance", () => {
	const owner = "viewer-guide-owner";
	subagentRunStore.setActiveOwner(owner);
	const run = subagentRunStore.create({ ownerSessionId: owner, mode: "single", agent: "worker", agentSource: "user", task: "work" });
	subagentRunStore.update(run.id, {
		status: "running",
		currentTool: "bash",
		currentToolArgs: { command: "npm test" },
		liveMessage: "checking the implementation",
		liveToolOutput: "halfway through tests",
		pendingInputs: [{ message: "also check cancellation", delivery: "steer" }],
	}, owner);
	const guided: string[] = [];
	const component = new SubagentRunViewerComponent(
		tui,
		theme,
		run.id,
		owner,
		() => undefined,
		() => undefined,
		(runId) => guided.push(runId),
	);
	try {
		component.handleInput("i");
		assert.deepEqual(guided, [run.id]);
		const rendered = component.render(100).join("\n");
		assert.match(rendered, /assistant \(streaming\)/);
		assert.match(rendered, /checking the implementation/);
		assert.match(rendered, /halfway through tests/);
		assert.match(rendered, /queued guidance/);
		assert.match(rendered, /i guide/);

		subagentRunStore.update(run.id, { status: "completed", endedAt: Date.now() }, owner);
		component.handleInput("i");
		assert.deepEqual(guided, [run.id], "closed runs cannot be guided from the viewer");
	} finally {
		component.dispose();
		subagentRunStore.remove(run.id, owner);
	}
});

test("chain viewer automatically follows the active child", () => {
	const owner = "viewer-chain-owner";
	subagentRunStore.setActiveOwner(owner);
	const parent = subagentRunStore.create({ ownerSessionId: owner, mode: "chain", agent: "chain", agentSource: "unknown", task: "two steps", childRunIds: [] });
	const child = subagentRunStore.create({ ownerSessionId: owner, mode: "chain", agent: "worker", agentSource: "user", task: "step one", parentRunId: parent.id });
	subagentRunStore.update(parent.id, { status: "running", childRunIds: [child.id], currentTool: "step 1/2: worker" }, owner);
	subagentRunStore.update(child.id, { status: "running", liveMessage: "active child progress" }, owner);
	const component = new SubagentRunViewerComponent(tui, theme, parent.id, owner, () => undefined, () => undefined, () => undefined);
	try {
		const rendered = component.render(100).join("\n");
		assert.match(rendered, /active child: .*worker/);
		assert.match(rendered, /active child progress/);
	} finally {
		component.dispose();
		subagentRunStore.remove(child.id, owner);
		subagentRunStore.remove(parent.id, owner);
	}
});
