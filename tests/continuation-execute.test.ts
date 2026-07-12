import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";

function events(output: string): any[] {
	return output.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

test("subagent execute guards continuation closure, source metadata, scope, agent selection, and confirmation", async (t) => {
	const probeDir = await mkdtemp(path.join(tmpdir(), "pi-subagent-continuation-execute-"));
	const projectAgents = path.join(probeDir, ".pi", "agents");
	await mkdir(projectAgents, { recursive: true });
	await writeFile(path.join(projectAgents, "project-agent.md"), "---\nname: project-agent\ndescription: project test agent\n---\nproject prompt\n");
	const storeUrl = import.meta.resolve("../store.ts");
	const indexUrl = import.meta.resolve("../index.ts");
	const probe = path.join(probeDir, "probe.ts");
	await writeFile(probe, `
import registerExtension from ${JSON.stringify(indexUrl)};
import { subagentRunStore } from ${JSON.stringify(storeUrl)};
export default function (pi) {
  let tool;
  const registerTool = pi.registerTool.bind(pi);
  pi.registerTool = (candidate) => {
    if (candidate.name === "subagent") tool = candidate;
    return registerTool(candidate);
  };
  registerExtension(pi);
  pi.registerCommand("probe-continuations", { description: "probe", handler: async (_args, ctx) => {
    const testCtx = { ...ctx, hasUI: true, ui: { ...ctx.ui, confirm: async () => false } };
    const run = (overrides = {}) => subagentRunStore.create({
      mode: "single", agent: "explorer", agentSource: "package", task: "source", cwd: ctx.cwd,
      sessionFile: "/tmp/not-used-by-validation.jsonl", leafId: "leaf", ...overrides,
    });
    const call = async (params) => (await tool.execute("probe", params, new AbortController().signal, undefined, testCtx)).content[0].text;
    const checks = {};
    const running = run();
    subagentRunStore.update(running.id, { status: "running", abort: () => {} });
    checks.running = /still running/.test(await call({ continueFrom: running.id, task: "follow up" }));
    const stopping = run();
    subagentRunStore.update(stopping.id, { status: "running", abort: () => subagentRunStore.update(stopping.id, { status: "aborted" }) });
    subagentRunStore.abort(stopping.id);
    const beforeStop = subagentRunStore.getSnapshot().length;
    checks.stopImmediate = /has not fully closed/.test(await call({ continueFrom: stopping.id, task: "follow up" })) && subagentRunStore.getSnapshot().length === beforeStop;
    const noSession = run({ status: "completed", endedAt: Date.now(), sessionFile: undefined });
    checks.noSession = /no persisted session/.test(await call({ continueFrom: noSession.id, task: "follow up" }));
    const noLeaf = run({ status: "completed", endedAt: Date.now(), leafId: undefined });
    checks.noLeaf = /leaf is missing/.test(await call({ continueFrom: noLeaf.id, task: "follow up" }));
    const mismatch = run({ status: "completed", endedAt: Date.now() });
    checks.cwdMismatch = /cwd must match source cwd/.test(await call({ continueFrom: mismatch.id, task: "follow up", cwd: ".." }));
    const closed = run({ status: "completed", endedAt: Date.now() });
    const beforeUnknown = subagentRunStore.getSnapshot().length;
    checks.unknownOverride = /Unknown agent: "missing-agent"/.test(await call({ continueFrom: closed.id, agent: "missing-agent", task: "follow up" })) && subagentRunStore.getSnapshot().length === beforeUnknown;
    const inherited = run({ agent: "project-agent", agentSource: "project", agentScope: "project", status: "completed", endedAt: Date.now() });
    checks.inheritedScope = /not approved/.test(await call({ continueFrom: inherited.id, task: "follow up" }));
    const override = run({ status: "completed", endedAt: Date.now() });
    checks.overrideScope = /not approved/.test(await call({ continueFrom: override.id, agent: "project-agent", agentScope: "project", task: "follow up" }));
    ctx.ui.notify(JSON.stringify(checks), Object.values(checks).every(Boolean) ? "info" : "error");
    ctx.shutdown();
  }});
}
`);
	t.after(() => rm(probeDir, { recursive: true, force: true }));

	const result = spawnSync("pi", ["--mode", "rpc", "--no-session", "--no-extensions", "-e", probe, "--no-skills", "--no-themes", "--no-context-files", "--offline", "--approve"], {
		cwd: probeDir,
		env: { ...process.env, PI_CODING_AGENT_DIR: path.join(probeDir, "agent"), PI_OFFLINE: "1" },
		input: `${JSON.stringify({ id: "probe", type: "prompt", message: "/probe-continuations" })}\n`,
		encoding: "utf8",
		timeout: 15000,
	});
	assert.ifError(result.error);
	assert.equal(result.status, 0, result.stderr || result.stdout);
	const notify = events(result.stdout).find((event) => event.type === "extension_ui_request" && event.method === "notify" && event.message?.startsWith("{"));
	assert.ok(notify, result.stdout);
	assert.deepEqual(JSON.parse(notify.message), {
		running: true, stopImmediate: true, noSession: true, noLeaf: true, cwdMismatch: true,
		unknownOverride: true, inheritedScope: true, overrideScope: true,
	});
});
