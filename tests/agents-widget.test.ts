import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	MAX_VISIBLE_ACTIVE_RUNS,
	SubagentStatusWidget,
	formatActiveRunDuration,
	renderAgentsWidget,
} from "../agents-widget.ts";
import { makeEmptyUsage, SubagentRunStore } from "../store.ts";
import type { SubagentRun } from "../types.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as any;

function makeRun(overrides: Partial<SubagentRun> = {}): SubagentRun {
	return {
		id: "subagent-1",
		ownerSessionId: "widget-owner",
		mode: "single",
		agent: "explorer",
		agentSource: "user",
		task: "Inspect the codebase",
		status: "running",
		startedAt: 1_000,
		messages: [],
		usage: makeEmptyUsage(),
		...overrides,
	};
}

test("Agents widget renders only active runs with elapsed time and activity", () => {
	const now = 66_000;
	const runs = [
		makeRun({
			id: "subagent-1",
			agent: "reviewer",
			startedAt: 1_000,
			currentTool: "read",
			currentToolArgs: { path: "/tmp/project/index.ts" },
		}),
		makeRun({
			id: "subagent-2",
			status: "queued",
			startedAt: 61_000,
			parentRunId: "subagent-1",
			task: "Check lifecycle and concurrency behavior",
		}),
		makeRun({ id: "subagent-3", status: "completed", endedAt: now }),
	];

	const lines = renderAgentsWidget(runs, theme, 64, now);
	assert.equal(lines.length, 3);
	assert.equal(lines[0], "Agents · 2 active");
	assert.match(lines[1], /● &1 reviewer  running 01:05  · read \/tmp\/project\/index\.ts/);
	assert.match(lines[2], /^  ↳ ○ &2 explorer  queued 00:05  · Check lifecycle/);
	assert.doesNotMatch(lines.join("\n"), /&3/);
	assert.ok(lines.every((line) => visibleWidth(line) <= 64));
	assert.equal(formatActiveRunDuration(1_000, 3_662_000), "1:01:01");
});

test("Agents widget caps its height and summarizes hidden active runs", () => {
	const runs = Array.from({ length: MAX_VISIBLE_ACTIVE_RUNS + 3 }, (_, index) => makeRun({
		id: `subagent-${index + 1}`,
		startedAt: index,
	}));
	const lines = renderAgentsWidget(runs, theme, 80, 10_000);
	assert.equal(lines.length, MAX_VISIBLE_ACTIVE_RUNS + 2);
	assert.equal(lines.at(-1), "… 3 more active");
	assert.doesNotMatch(lines.join("\n"), new RegExp(`&${MAX_VISIBLE_ACTIVE_RUNS + 1}\\b`));
});

test("Agents widget reacts to store updates and stops observing after disposal", () => {
	const owner = "widget-reactive-owner";
	const store = new SubagentRunStore();
	const activeCounts: number[] = [];
	let renderRequests = 0;
	const widget = new SubagentStatusWidget(
		{ requestRender: () => { renderRequests++; } } as any,
		theme,
		owner,
		store,
		(count) => activeCounts.push(count),
	);

	assert.deepEqual(widget.render(80), []);
	const run = store.create({
		ownerSessionId: owner,
		mode: "single",
		agent: "worker",
		agentSource: "user",
		task: "Implement the panel",
	});
	assert.deepEqual(activeCounts, [1]);
	assert.match(widget.render(80).join("\n"), /&1 worker  queued/);

	store.update(run.id, { status: "completed", endedAt: Date.now() }, owner);
	assert.deepEqual(activeCounts, [1, 0]);
	assert.deepEqual(widget.render(80), []);

	widget.dispose();
	store.create({
		ownerSessionId: owner,
		mode: "single",
		agent: "reviewer",
		agentSource: "user",
		task: "Should not reach disposed widget",
	});
	assert.deepEqual(activeCounts, [1, 0]);
	assert.equal(renderRequests, 0, "throttled render requests are cancelled during disposal");
});

test("disposing an active widget cancels its render timeout and clock", async () => {
	const owner = "widget-disposal-owner";
	const store = new SubagentRunStore();
	store.create({
		ownerSessionId: owner,
		mode: "single",
		agent: "explorer",
		agentSource: "user",
		task: "Remain active during disposal",
	});
	let renderRequests = 0;
	const widget = new SubagentStatusWidget(
		{ requestRender: () => { renderRequests++; } } as any,
		theme,
		owner,
		store,
	);
	store.update("subagent-1", { liveMessage: "stream update" }, owner);
	widget.dispose();
	await new Promise((resolve) => setTimeout(resolve, 1_150));
	assert.equal(renderRequests, 0);
});
