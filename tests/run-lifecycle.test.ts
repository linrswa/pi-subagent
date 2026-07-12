import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { OwnerRunLifecycle } from "../run-lifecycle.ts";
import { getChildSessionsRoot } from "../child-sessions.ts";
import { runSingleAgent } from "../runner.ts";
import { SubagentRunStore, subagentRunStore } from "../store.ts";
import type { SubagentDetails } from "../types.ts";

const input = (ownerSessionId: string) => ({
	mode: "single" as const, ownerSessionId, agent: "explorer", agentSource: "user" as const, task: "delayed child",
});

test("owner shutdown aborts queued runs and waits for a delayed terminal update", async () => {
	const store = new SubagentRunStore();
	const owner = "lifecycle-owner";
	const lifecycle = new OwnerRunLifecycle(store);
	lifecycle.activate(owner);
	const run = store.create(input(owner));
	lifecycle.track(run);
	let aborts = 0;
	store.update(run.id, {
		abort: () => {
			aborts++;
			setTimeout(() => store.update(run.id, { status: "aborted", endedAt: Date.now(), abort: undefined }, owner), 35);
		},
	}, owner);

	assert.equal(await lifecycle.shutdown(owner, 500), true);
	assert.ok(aborts > 0);
	const stopped = store.get(run.id, owner)!;
	assert.equal(stopped.status, "aborted");
	assert.ok(stopped.endedAt);
});

test("repeated activation retains tracked ownership until shutdown", async () => {
	const store = new SubagentRunStore();
	const owner = "repeat-owner";
	const lifecycle = new OwnerRunLifecycle(store);
	lifecycle.activate(owner);
	const run = store.create(input(owner));
	lifecycle.track(run);
	// Duplicate session-start must not replace the controller/run set.
	lifecycle.activate(owner);
	store.update(run.id, { abort: () => store.update(run.id, { status: "aborted", endedAt: Date.now(), abort: undefined }, owner) }, owner);
	assert.equal(await lifecycle.shutdown(owner, 500), true);
	// A new activation after shutdown owns a fresh, independently settled run.
	lifecycle.activate(owner);
	const next = store.create(input(owner));
	lifecycle.track(next);
	store.update(next.id, { abort: () => store.update(next.id, { status: "aborted", endedAt: Date.now(), abort: undefined }, owner) }, owner);
	assert.equal(await lifecycle.shutdown(owner, 500), true);
});

test("lifecycle shutdown waits for a delayed child process to publish endedAt", async () => {
	const owner = `delayed-child-${randomUUID()}`;
	const lifecycle = new OwnerRunLifecycle();
	lifecycle.activate(owner);
	const temp = await mkdtemp(path.join(tmpdir(), "pi-subagent-delayed-"));
	const script = path.join(temp, "fake-pi.mjs");
	await writeFile(script, `process.on("SIGTERM", () => setTimeout(() => process.exit(0), 45)); setInterval(() => {}, 1000);`);
	const originalScript = process.argv[1];
	process.argv[1] = script;
	let createdId = "";
	try {
		const child = runSingleAgent({
			mode: "single", defaultCwd: process.cwd(), ownerSessionId: owner,
			agents: [{ name: "fake", description: "", systemPrompt: "", source: "user", filePath: script }], agentName: "fake", task: "wait",
			makeDetails: (results): SubagentDetails => ({ mode: "single", agentScope: "user", packageAgentsDir: "", userAgentsDir: "", projectAgentsDir: null, results }),
			onRunCreated: (run) => { createdId = run.id; lifecycle.track(run); },
		});
		void child.catch(() => {});
		for (let i = 0; i < 100 && subagentRunStore.get(createdId, owner)?.status !== "running"; i++) await new Promise((resolve) => setTimeout(resolve, 10));
		assert.equal(subagentRunStore.get(createdId, owner)?.status, "running");
		assert.equal(await lifecycle.shutdown(owner, 1_000), true);
		await assert.rejects(child);
		const stopped = subagentRunStore.get(createdId, owner)!;
		assert.equal(stopped.status, "aborted");
		assert.ok(stopped.endedAt);
	} finally {
		process.argv[1] = originalScript;
		await rm(temp, { recursive: true, force: true });
		await rm(path.join(getChildSessionsRoot(), owner), { recursive: true, force: true });
	}
});

test("shutdown waits for queued continuation setup and removes its aborted branch", async () => {
	const owner = `queued-continuation-${randomUUID()}`;
	const lifecycle = new OwnerRunLifecycle();
	lifecycle.activate(owner);
	const sessionDir = path.join(getChildSessionsRoot(), owner);
	const source = SessionManager.create(process.cwd(), sessionDir, { id: randomUUID() });
	source.appendMessage({ role: "user", content: "source", timestamp: Date.now() } as any);
	const sourceLeaf = source.appendMessage({ role: "assistant", content: "answer", provider: "test", model: "test", timestamp: Date.now(), usage: { input: 1, output: 1, totalTokens: 2 }, stopReason: "stop" } as any);
	const sourceFile = source.getSessionFile()!;
	let createdId = "";
	try {
		// branchChildSession awaits managed-path checks before it creates the branch.
		// Shutdown therefore lands while continuation setup is still queued.
		const child = runSingleAgent({
			mode: "single", defaultCwd: process.cwd(), ownerSessionId: owner,
			agents: [{ name: "fake", description: "", systemPrompt: "", source: "user", filePath: "" }], agentName: "fake", task: "never spawn",
			continueFrom: { runId: "source", sessionFile: sourceFile, leafId: sourceLeaf },
			makeDetails: (results): SubagentDetails => ({ mode: "single", agentScope: "user", packageAgentsDir: "", userAgentsDir: "", projectAgentsDir: null, results }),
			onRunCreated: (run) => { createdId = run.id; lifecycle.track(run); },
		});
		void child.catch(() => {});
		assert.equal(await lifecycle.shutdown(owner, 1_000), true);
		await assert.rejects(child);
		const stopped = subagentRunStore.get(createdId, owner)!;
		assert.equal(stopped.status, "aborted");
		assert.ok(stopped.endedAt);
		assert.deepEqual(await readdir(sessionDir), [path.basename(sourceFile)]);
	} finally {
		await rm(path.join(getChildSessionsRoot(), owner), { recursive: true, force: true });
	}
});

test("an already-aborted signal closes a queued runner before child setup", async () => {
	const owner = "queued-owner";
	const controller = new AbortController();
	controller.abort();
	let createdId = "";
	await assert.rejects(runSingleAgent({
		mode: "single", defaultCwd: process.cwd(), ownerSessionId: owner,
		agents: [{ name: "fake", description: "", systemPrompt: "", source: "user", filePath: "" }],
		agentName: "fake", task: "never starts", signal: controller.signal,
		makeDetails: (results): SubagentDetails => ({ mode: "single", agentScope: "user", packageAgentsDir: "", userAgentsDir: "", projectAgentsDir: null, results }),
		onRunCreated: (run) => { createdId = run.id; },
	}));
	const run = subagentRunStore.get(createdId, owner)!;
	assert.equal(run.status, "aborted");
	assert.ok(run.endedAt);
});
