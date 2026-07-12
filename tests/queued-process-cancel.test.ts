import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import { getChildSessionsRoot } from "../child-sessions.ts";
import { childProcessPool } from "../process-pool.ts";
import { runSingleAgent } from "../runner.ts";
import { subagentRunStore } from "../store.ts";

test("a run stopped in the global process queue never spawns", async (t) => {
	const owner = `queued-cancel-${randomUUID()}`;
	const temp = await mkdtemp(path.join(tmpdir(), "pi-subagent-queued-cancel-"));
	const marker = path.join(temp, "spawned");
	const script = path.join(temp, "fake-pi.mjs");
	await writeFile(script, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "spawned");`);
	const originalScript = process.argv[1];
	process.argv[1] = script;
	const releases = await Promise.all(Array.from({ length: childProcessPool.capacity }, () => childProcessPool.acquire()));
	t.after(async () => {
		for (const release of releases) release();
		process.argv[1] = originalScript;
		await rm(temp, { recursive: true, force: true });
		await rm(path.join(getChildSessionsRoot(), owner), { recursive: true, force: true });
	});

	let runId = "";
	const completion = runSingleAgent({
		mode: "single",
		defaultCwd: process.cwd(),
		agents: [{ name: "fake", description: "", systemPrompt: "", source: "user", filePath: script }],
		agentName: "fake",
		task: "must not spawn",
		agentScope: "user",
		ownerSessionId: owner,
		makeDetails: (results) => ({ mode: "single", agentScope: "user", packageAgentsDir: "", userAgentsDir: "", projectAgentsDir: null, results: [] }),
		onRunCreated: (run) => { runId = run.id; },
	});
	assert.ok(runId);
	for (let attempt = 0; attempt < 100 && childProcessPool.queuedCount === 0; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
	assert.ok(childProcessPool.queuedCount > 0);
	assert.equal(subagentRunStore.abort(runId, owner), true);
	await assert.rejects(completion, /aborted/);
	assert.equal(subagentRunStore.get(runId, owner)?.status, "aborted");
	await assert.rejects(access(marker));
});
