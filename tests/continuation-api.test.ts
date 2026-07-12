import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildRunRefContext, getContinuationCallDisplay, getMode, getRunRefCompletions } from "../manager.ts";
import { findRunByRef } from "../run-refs.ts";
import { SubagentParamsSchema } from "../schemas.ts";
import { subagentRunStore } from "../store.ts";
import type { SubagentRun } from "../types.ts";

test("continuation API exposes its schema and permits only single mode", () => {
	assert.ok("continueFrom" in SubagentParamsSchema.properties);
	assert.ok("wait" in SubagentParamsSchema.properties);
	assert.equal("tasks" in SubagentParamsSchema.properties, false);
	assert.equal(getMode({ agent: "explorer", task: "x" }), "single");
	assert.equal(getMode({ continueFrom: "&1", task: "x" }), "single");
	assert.equal(getMode({ continueFrom: "&1", agent: "reviewer", task: "x" }), "single");
	assert.equal(getMode({ continueFrom: "&1" }), undefined);
	assert.equal(getMode({ continueFrom: "&1", task: "x", tasks: [] } as any), undefined);
	assert.equal(getMode({ continueFrom: "&1", task: "x", chain: [] }), undefined);
});

test("continuation source references resolve all public run-id forms", () => {
	const run = { id: "subagent-3" } as SubagentRun;
	for (const ref of ["subagent-3", "&3", "3"]) assert.equal(findRunByRef(ref, [run]), run);
});

test("continuation call display inherits source metadata and marks an unresolved source unknown", () => {
	const source = {
		id: "subagent-42",
		agent: "project-agent",
		agentSource: "project",
		agentScope: "project",
	} as SubagentRun;
	assert.deepEqual(getContinuationCallDisplay({ continueFrom: "&42", task: "follow up" }, source), {
		agentName: "project-agent",
		agentScope: "project",
	});
	assert.deepEqual(getContinuationCallDisplay({ continueFrom: "&42", task: "follow up" }, { ...source, agentScope: "both" }), {
		agentName: "project-agent",
		agentScope: "both",
	});
	assert.deepEqual(getContinuationCallDisplay({ continueFrom: "&404", task: "follow up" }), {
		agentName: "unknown",
		agentScope: "unknown",
	});
});

test("run-ref context recommends continuation only for fully closed eligible sources", () => {
	const queued = subagentRunStore.create({ mode: "single", agent: "explorer", agentSource: "user", task: "queued" });
	const stopping = subagentRunStore.create({ mode: "single", agent: "explorer", agentSource: "user", task: "stopping" });
	const closed = subagentRunStore.create({
		mode: "single", agent: "explorer", agentSource: "user", task: "closed", status: "completed", endedAt: Date.now(),
		cwd: "/tmp", sessionFile: "/tmp/child.jsonl", leafId: "leaf",
	});
	try {
		subagentRunStore.update(stopping.id, { status: "aborted", abort: () => {} });
		const context = buildRunRefContext(`Check ${formatRunRef(queued.id)} ${formatRunRef(stopping.id)} ${formatRunRef(closed.id)}`);
		assert.ok(context);
		assert.match(context, new RegExp(`${formatRunRef(queued.id).replace("&", "\\&")}[^\\n]*wait for it to finish and check its status`));
		assert.match(context, new RegExp(`${formatRunRef(stopping.id).replace("&", "\\&")}[^\\n]*stopping; wait for it to fully close`));
		assert.match(context, new RegExp(`continueFrom: "${formatRunRef(closed.id)}"`));
		assert.doesNotMatch(context, new RegExp(`continueFrom: "${formatRunRef(queued.id)}"|continueFrom: "${formatRunRef(stopping.id)}"`));
	} finally {
		for (const run of [queued, stopping, closed]) subagentRunStore.remove(run.id);
	}
});

test("run-ref context directs follow-ups to continueFrom and autocomplete stays concise", () => {
	const run = subagentRunStore.create({
		mode: "single",
		agent: "explorer",
		agentSource: "user",
		task: "Investigate the continuation implementation and report all relevant session details.",
		status: "completed",
		endedAt: Date.now(),
		cwd: "/tmp",
		sessionFile: "/tmp/child.jsonl",
		leafId: "leaf",
	});
	try {
		const context = buildRunRefContext(`Continue ${formatRunRef(run.id)}`);
		assert.ok(context);
		assert.match(context, /subagent_control with runId &\d+ for status\/stop\/delete/);
		assert.match(context, /subagent with \{ continueFrom: "&\d+", task: "\.\.\." \}/);
		assert.doesNotMatch(context, /\bask\b/i);

		const completion = getRunRefCompletions(formatRunRef(run.id)).find((item) => item.value === formatRunRef(run.id));
		assert.equal(completion?.value, formatRunRef(run.id));
		assert.ok((completion?.description.length ?? Infinity) < 80);
	} finally {
		subagentRunStore.remove(run.id);
	}
});

test("continuation relationships are rendered in tool output and the viewer", async () => {
	const [implementation, viewer] = await Promise.all([
		readFile(new URL("../index.ts", import.meta.url), "utf8"),
		readFile(new URL("../viewer.ts", import.meta.url), "utf8"),
	]);
	assert.match(implementation, /continued from \$\{formatShortRunId\(runId\)\}/);
	assert.match(implementation, /formatContinuedFrom\(args\.continueFrom\)/);
	assert.match(implementation, /formatContinuedFrom\(entry\.continuedFromRunId\)/);
	assert.match(viewer, /session id:/);
	assert.match(viewer, /parent run:/);
});

function formatRunRef(id: string): string {
	return `&${id.match(/(\d+)$/)?.[1]}`;
}
