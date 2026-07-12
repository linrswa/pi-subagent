import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function parseJsonLines(output: string): any[] {
	return output
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

function requirePi(t: test.TestContext): boolean {
	const version = spawnSync("pi", ["--version"], { encoding: "utf-8", timeout: 5000 });
	if ((version.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
		t.skip("pi CLI is not installed");
		return false;
	}
	assert.ifError(version.error);
	assert.equal(version.status, 0, version.stderr || version.stdout);
	return true;
}

function runProbe(args: string[], cwd: string, env: NodeJS.ProcessEnv, input: string) {
	return spawnSync("pi", args, { cwd, env, input, encoding: "utf-8", timeout: 15000 });
}

test("pi loads this package and registers the public tools, commands, and schemas", async (t) => {
	if (!requirePi(t)) return;
	const tmp = await mkdtemp(path.join(tmpdir(), "pi-subagent-integration-"));
	try {
		const probePath = path.join(tmp, "probe.ts");
		await writeFile(probePath, `export default function (pi) {
	pi.registerCommand("probe-subagent-integration", {
		description: "Probe subagent extension registration",
		handler: async (_args, ctx) => {
			const expectedTools = ["subagent_control", "subagent_schedule", "subagent"];
			const expectedCommands = ["subagent-view", "subagent-schedules", "subagent-setting", "bg", "subagents"];
			const expectedPrompts = ["explorer-and-plan", "implement-and-review", "implement"];
			const tools = pi.getAllTools().map((tool) => tool.name).sort();
			const commands = pi.getCommands().map((command) => command.name).sort();
			const subagentSchema = JSON.stringify(pi.getAllTools().find((tool) => tool.name === "subagent")?.parameters ?? {});
			const controlSchema = JSON.stringify(pi.getAllTools().find((tool) => tool.name === "subagent_control")?.parameters ?? {});
			const payload = {
				missingTools: expectedTools.filter((name) => !tools.includes(name)),
				missingCommands: expectedCommands.filter((name) => !commands.includes(name)),
				missingPrompts: expectedPrompts.filter((name) => !commands.includes(name)),
				continueFrom: subagentSchema.includes("continueFrom"),
				wait: subagentSchema.includes("wait"),
				removedBgTool: !tools.includes("bg_agent"),
				removedTasks: !subagentSchema.includes('"tasks"'),
				controlHasAsk: controlSchema.includes("ask"),
				legacyModePresent: [subagentSchema, controlSchema, ...pi.getAllTools().map((tool) => JSON.stringify(tool.parameters ?? {}))].some((schema) => schema.toLowerCase().includes("pony" + "tailmode")),
			};
			const valid = payload.missingTools.length === 0 && payload.missingCommands.length === 0 && payload.missingPrompts.length === 0 && payload.continueFrom && payload.wait && payload.removedBgTool && payload.removedTasks && !payload.controlHasAsk && !payload.legacyModePresent;
			ctx.ui.notify(JSON.stringify(payload), valid ? "info" : "error");
			ctx.shutdown();
		},
	});
}
`);

		const result = runProbe(
			["--mode", "rpc", "--no-session", "--no-extensions", "-e", repoRoot, "-e", probePath, "--no-skills", "--no-themes", "--no-context-files", "--offline", "--approve"],
			repoRoot,
			{ ...process.env, PI_CODING_AGENT_DIR: path.join(tmp, "agent"), PI_OFFLINE: "1" },
			`${JSON.stringify({ id: "probe", type: "prompt", message: "/probe-subagent-integration" })}\n`,
		);

		assert.ifError(result.error);
		assert.equal(result.status, 0, result.stderr || result.stdout);
		const events = parseJsonLines(result.stdout);
		assert.deepEqual(events.filter((event) => event.type === "extension_error"), []);
		const notify = events.find((event) => event.type === "extension_ui_request" && event.method === "notify" && event.message?.includes("missingTools"));
		assert.ok(notify, result.stdout);
		assert.deepEqual(JSON.parse(notify.message), {
			missingTools: [], missingCommands: [], missingPrompts: [], continueFrom: true, wait: true, removedBgTool: true, removedTasks: true, controlHasAsk: false, legacyModePresent: false,
		});
		assert.equal(events.find((event) => event.id === "probe")?.success, true, result.stdout);
	} finally {
		await rm(tmp, { recursive: true, force: true });
	}
});
