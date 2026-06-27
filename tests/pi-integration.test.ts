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

test("pi loads this package and registers subagent resources", async (t) => {
	const version = spawnSync("pi", ["--version"], { encoding: "utf-8", timeout: 5000 });
	if ((version.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
		t.skip("pi CLI is not installed");
		return;
	}
	assert.ifError(version.error);
	assert.equal(version.status, 0, version.stderr || version.stdout);

	const tmp = await mkdtemp(path.join(tmpdir(), "pi-subagent-integration-"));
	try {
		const probePath = path.join(tmp, "probe.ts");
		await writeFile(
			probePath,
			`export default function (pi) {
	pi.registerCommand("probe-subagent-integration", {
		description: "Probe subagent extension registration",
		handler: async (_args, ctx) => {
			const expectedTools = ["subagent_control", "bg_agent", "subagent_schedule", "subagent"];
			const expectedCommands = ["subagent-view", "subagent-schedules", "subagent-setting", "bg", "subagents"];
			const expectedPrompts = ["explorer-and-plan", "implement-and-review", "implement"];
			const tools = pi.getAllTools().map((tool) => tool.name).sort();
			const commands = pi.getCommands().map((command) => command.name).sort();
			const payload = {
				missingTools: expectedTools.filter((name) => !tools.includes(name)),
				missingCommands: expectedCommands.filter((name) => !commands.includes(name)),
				missingPrompts: expectedPrompts.filter((name) => !commands.includes(name)),
			};
			ctx.ui.notify(JSON.stringify(payload), payload.missingTools.length || payload.missingCommands.length || payload.missingPrompts.length ? "error" : "info");
			ctx.shutdown();
		},
	});
}
`,
		);

		const result = spawnSync(
			"pi",
			[
				"--mode",
				"rpc",
				"--no-session",
				"--no-extensions",
				"-e",
				repoRoot,
				"-e",
				probePath,
				"--no-skills",
				"--no-themes",
				"--no-context-files",
				"--offline",
				"--approve",
			],
			{
				cwd: repoRoot,
				env: { ...process.env, PI_CODING_AGENT_DIR: path.join(tmp, "agent"), PI_OFFLINE: "1" },
				input: `${JSON.stringify({ id: "probe", type: "prompt", message: "/probe-subagent-integration" })}\n`,
				encoding: "utf-8",
				timeout: 15000,
			},
		);

		assert.ifError(result.error);
		assert.equal(result.status, 0, result.stderr || result.stdout);

		const events = parseJsonLines(result.stdout);
		assert.deepEqual(events.filter((event) => event.type === "extension_error"), []);

		const notify = events.find((event) => event.type === "extension_ui_request" && event.method === "notify" && event.message?.includes("missingTools"));
		assert.ok(notify, result.stdout);
		assert.deepEqual(JSON.parse(notify.message), { missingTools: [], missingCommands: [], missingPrompts: [] });

		const response = events.find((event) => event.id === "probe");
		assert.equal(response?.success, true, result.stdout);
	} finally {
		await rm(tmp, { recursive: true, force: true });
	}
});
