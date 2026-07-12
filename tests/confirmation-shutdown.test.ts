import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import { startAgent } from "../manager.ts";
import { OwnerRunLifecycle } from "../run-lifecycle.ts";
import { subagentRunStore } from "../store.ts";

test("shutdown during project-agent confirmation cannot launch an orphan child", async (t) => {
	const cwd = await mkdtemp(path.join(tmpdir(), "pi-subagent-confirm-shutdown-"));
	const agentsDir = path.join(cwd, ".pi", "agents");
	await mkdir(agentsDir, { recursive: true });
	await writeFile(path.join(agentsDir, "project-write.md"), "---\nname: project-write\ndescription: test\n---\nproject prompt\n");
	t.after(() => rm(cwd, { recursive: true, force: true }));
	const owner = `confirm-shutdown-${randomUUID()}`;
	const lifecycle = new OwnerRunLifecycle();
	lifecycle.activate(owner);
	let approve!: (value: boolean) => void;
	const confirmation = new Promise<boolean>((resolve) => { approve = resolve; });
	const ctx = {
		cwd,
		model: undefined,
		hasUI: true,
		isProjectTrusted: () => true,
		sessionManager: { getSessionId: () => owner },
		ui: { confirm: () => confirmation, notify: () => undefined },
	} as any;

	const pending = startAgent({ getThinkingLevel: () => undefined } as any, ctx, {
		task: "must not start",
		agent: "project-write",
		agentScope: "project",
	}, lifecycle);
	assert.equal(await lifecycle.shutdown(owner), true);
	approve(true);
	const result = await pending;
	assert.equal(result.ok, false);
	if (result.ok === false) assert.match(result.message, /shutting down/);
	assert.equal(subagentRunStore.getSnapshot(owner).length, 0);
});
