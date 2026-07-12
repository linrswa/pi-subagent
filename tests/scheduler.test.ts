import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { formatScheduleId, formatScheduleList, SubagentSchedulerController } from "../scheduler.ts";

async function tempDir(): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), "pi-subagent-schedule-"));
}

test("named schedules use the name as id", async (t) => {
	const cwd = await tempDir();
	const controller = new SubagentSchedulerController();
	t.after(async () => {
		controller.stop();
		await fs.rm(cwd, { recursive: true, force: true });
	});

	await controller.start({} as any, {
		cwd,
		sessionManager: { getSessionId: () => "test-session", getSessionFile: () => "" },
		ui: { notify: () => undefined },
	} as any);

	const added = await controller.add({ name: "daily-tests", schedule: "+1h", prompt: "run tests" });
	assert.equal(added.ok, true);
	if (added.ok) assert.equal(added.job.id, "daily-tests");
	assert.match(formatScheduleList(controller.list()), /^daily-tests once \+1h/);

	const duplicate = await controller.add({ name: "daily-tests", schedule: "+1h", prompt: "run tests" });
	assert.equal(duplicate.ok, false);
	assert.equal(await controller.delete("daily-tests"), true);
});

test("scheduled firing records the background run id", async (t) => {
	const cwd = await tempDir();
	const controller = new SubagentSchedulerController();
	const started: unknown[] = [];
	t.after(async () => {
		controller.stop();
		await fs.rm(cwd, { recursive: true, force: true });
	});

	const manager = {
		startBackground: async (_ctx: unknown, params: unknown) => {
			started.push(params);
			return { ok: true as const, run: { id: "subagent-scheduled-run" }, agentScope: "user" as const };
		},
	};
	const ctx = {
		cwd,
		sessionManager: { getSessionId: () => "test-session", getSessionFile: () => "" },
		ui: { notify: () => undefined },
	} as any;
	await controller.start(manager as any, ctx);
	const added = await controller.add({ name: "repeat", schedule: "30s", prompt: "run scheduled work" });
	assert.equal(added.ok, true);
	if (!added.ok) return;
	const job = (controller as any).jobs.get(added.job.id);
	job.nextRunAt = Date.now();
	await (controller as any).fire(job.id, (controller as any).generation);

	assert.equal(started.length, 1);
	assert.deepEqual(started[0], {
		prompt: "run scheduled work",
		agent: undefined,
		agentScope: "user",
		confirmProjectAgents: false,
		cwd: undefined,
	});
	assert.equal(controller.list()[0]?.lastRunId, "subagent-scheduled-run");
	assert.ok(controller.list()[0]?.lastRunAt);
});

test("generated schedule ids still display short", () => {
	assert.equal(formatScheduleId("schedule-mabc1234-zzzz"), "mabc1234-zzzz");
	assert.equal(formatScheduleId("schedule-daily-tests"), "schedule-daily-tests");
});

test("legacy schedule fields are discarded when schedules are saved", async (t) => {
	const cwd = await tempDir();
	const controller = new SubagentSchedulerController();
	t.after(async () => {
		controller.stop();
		await fs.rm(cwd, { recursive: true, force: true });
	});

	const storageDir = path.join(cwd, ".pi", "subagent-schedules");
	const obsoleteKey = ["pony", "tailMode"].join("");
	await fs.mkdir(storageDir, { recursive: true });
	await fs.writeFile(
		path.join(storageDir, "test-session.json"),
		JSON.stringify({
			version: 1,
			jobs: [
				{
					id: "legacy",
					schedule: "1h",
					kind: "interval",
					prompt: "run tests",
					agentScope: "user",
					createdAt: Date.now(),
					intervalMs: 3_600_000,
					nextRunAt: Date.now() + 3_600_000,
					[obsoleteKey]: "ultra",
				},
			],
		}),
	);

	await controller.start({} as any, {
		cwd,
		sessionManager: { getSessionId: () => "test-session", getSessionFile: () => "" },
		ui: { notify: () => undefined },
	} as any);
	assert.equal((controller.list()[0] as Record<string, unknown>)[obsoleteKey], undefined);

	const added = await controller.add({ name: "new", schedule: "+1h", prompt: "new job" });
	assert.equal(added.ok, true);
	const saved = JSON.parse(await fs.readFile(path.join(storageDir, "test-session.json"), "utf-8"));
	assert.equal(saved.jobs.some((job: Record<string, unknown>) => obsoleteKey in job), false);
});
