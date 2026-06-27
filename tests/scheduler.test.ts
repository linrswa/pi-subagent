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

test("generated schedule ids still display short", () => {
	assert.equal(formatScheduleId("schedule-mabc1234-zzzz"), "mabc1234-zzzz");
	assert.equal(formatScheduleId("schedule-daily-tests"), "schedule-daily-tests");
});
