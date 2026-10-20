import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test, { type TestContext } from "node:test";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { SubagentSchedulerController } from "../scheduler.ts";

function isSaveTarget(candidate: unknown, file: string): boolean {
	const target = String(candidate);
	return target === file || (target.startsWith(`${file}.`) && target.endsWith(".tmp"));
}

function deferred<T = void>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

async function fixture(t: TestContext) {
	const cwd = await fs.mkdtemp(path.join(tmpdir(), "pi-subagent-scheduler-race-"));
	const controller = new SubagentSchedulerController();
	t.after(async () => {
		controller.stop();
		await fs.rm(cwd, { recursive: true, force: true });
	});
	const ctx = (id: string, confirm = async () => true) => ({
		cwd, hasUI: true,
		sessionManager: { getSessionId: () => id, getSessionFile: () => "" },
		ui: { confirm, notify: () => {} },
	}) as any;
	const file = (id: string) => path.join(cwd, ".pi", "subagent-schedules", `${id}.json`);
	const projectAgent = async () => {
		const directory = path.join(cwd, ".pi", "agents");
		await fs.mkdir(directory, { recursive: true });
		await fs.writeFile(path.join(directory, "project.md"), "---\nname: project\ndescription: test\n---\nproject prompt\n");
	};
	return { cwd, controller, ctx, file, projectAgent };
}

test("approval cannot add an old-session schedule after a session switch or stop", async (t) => {
	const f = await fixture(t);
	await f.projectAgent();
	for (const stop of [false, true]) {
		const approval = deferred<boolean>();
		await f.controller.start({} as any, f.ctx("old", () => approval.promise));
		const pending = f.controller.add({ name: "old-job", schedule: "+1h", prompt: "old prompt", agent: "project", agentScope: "project" });
		if (stop) f.controller.stop();
		else await f.controller.start({} as any, f.ctx("new"));
		approval.resolve(true);
		const result = await pending;
		assert.equal(result.ok, false);
		if (result.ok === false) assert.match(result.message, /session changed/);
		assert.deepEqual(f.controller.list(), []);
		assert.equal((f.controller as any).timers.size, 0);
		await assert.rejects(fs.readFile(f.file("new")), { code: "ENOENT" });
	}
});

test("concurrent approvals recheck schedule id uniqueness when committing", async (t) => {
	const f = await fixture(t);
	await f.projectAgent();
	const approval = deferred<boolean>();
	let confirmations = 0;
	await f.controller.start({} as any, f.ctx("owner", () => { confirmations++; return approval.promise; }));
	const params = { name: "same", schedule: "+1h", prompt: "first", agent: "project", agentScope: "project" as const };
	const first = f.controller.add(params);
	const second = f.controller.add({ ...params, prompt: "second" });
	assert.equal(confirmations, 2);
	approval.resolve(true);
	const results = await Promise.all([first, second]);
	assert.equal(results.filter((result) => result.ok).length, 1);
	const failed = results.find((result) => !result.ok)!;
	if (failed.ok === false) assert.match(failed.message, /already exists/);
	assert.equal(f.controller.list().length, 1);
	const saved = JSON.parse(await fs.readFile(f.file("owner"), "utf8"));
	assert.deepEqual(saved.jobs.map((job: any) => job.prompt), ["first"]);
});

test("queued saves snapshot current jobs inside the serialized mutation", async (t) => {
	const f = await fixture(t);
	await f.controller.start({} as any, f.ctx("owner"));
	const gate = deferred();
	const entered = deferred();
	const held = withFileMutationQueue(f.file("owner"), async () => { entered.resolve(); await gate.promise; });
	await entered.promise;
	const adding = f.controller.add({ name: "removed", schedule: "+1h", prompt: "must not be saved" });
	// Let add register a cancellable proposal behind our barrier, without publishing it.
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(f.controller.list().length, 1);
	const deleting = f.controller.delete("removed");
	const written: any[] = [];
	const writeFile = fs.writeFile.bind(fs);
	t.mock.method(fs, "writeFile", async (...args: Parameters<typeof fs.writeFile>) => {
		if (isSaveTarget(args[0], f.file("owner"))) written.push(JSON.parse(String(args[1])));
		return writeFile(...args);
	});
	gate.resolve();
	await Promise.all([held, adding, deleting]);
	assert.ok(written.length > 0);
	assert.ok(written.every((value) => value.jobs.length === 0), "not even an intermediate write may use a pre-queue snapshot");
	assert.equal((f.controller as any).timers.size, 0);
});

test("a delayed mkdir/save cannot resurrect a deleted job or arm its timer", async (t) => {
	const f = await fixture(t);
	await f.controller.start({} as any, f.ctx("owner"));
	const entered = deferred();
	const gate = deferred();
	const mkdir = fs.mkdir.bind(fs);
	let first = true;
	t.mock.method(fs, "mkdir", async (...args: Parameters<typeof fs.mkdir>) => {
		if (first && String(args[0]) === path.dirname(f.file("owner"))) {
			first = false;
			entered.resolve();
			await gate.promise;
		}
		return mkdir(...args);
	});
	const adding = f.controller.add({ name: "removed", schedule: "+1h", prompt: "gone" });
	await entered.promise;
	const deleting = f.controller.delete("removed");
	// On the old implementation delete overtakes the first save's mkdir. With
	// serialized mkdir it waits; either way release the first save afterwards.
	await Promise.race([deleting, new Promise((resolve) => setTimeout(resolve, 30))]);
	gate.resolve();
	const [added, deleted] = await Promise.all([adding, deleting]);
	assert.equal(deleted, true);
	assert.equal(added.ok, false);
	assert.deepEqual(f.controller.list(), []);
	assert.equal((f.controller as any).timers.size, 0);
	const saved = JSON.parse(await fs.readFile(f.file("owner"), "utf8"));
	assert.deepEqual(saved.jobs, []);
});

for (const fail of [false, true]) {
	test(`session switch during ${fail ? "failed" : "successful"} save cannot delete or re-arm the new session's job`, async (t) => {
		const f = await fixture(t);
		await f.controller.start({} as any, f.ctx("old"));
		const entered = deferred();
		const gate = deferred();
		const writeFile = fs.writeFile.bind(fs);
		t.mock.method(fs, "writeFile", async (...args: Parameters<typeof fs.writeFile>) => {
			if (isSaveTarget(args[0], f.file("old"))) {
				entered.resolve();
				await gate.promise;
				if (fail) throw new Error("old session write failed");
			}
			return writeFile(...args);
		});
		const oldAdd = f.controller.add({ name: "same", schedule: "+2h", prompt: "old session" });
		await entered.promise;
		await f.controller.start({} as any, f.ctx("new"));
		const newAdd = await f.controller.add({ name: "same", schedule: "+1h", prompt: "new session" });
		assert.equal(newAdd.ok, true);
		const newTimer = (f.controller as any).timers.get("same");
		gate.resolve();
		const stale = await oldAdd;
		assert.equal(stale.ok, false);
		assert.deepEqual(f.controller.list().map((job) => job.prompt), ["new session"]);
		assert.equal((f.controller as any).timers.get("same"), newTimer);
		const saved = JSON.parse(await fs.readFile(f.file("new"), "utf8"));
		assert.deepEqual(saved.jobs.map((job: any) => job.prompt), ["new session"]);
	});
}

test("ensure switches scheduler ownership when the session changes", async (t) => {
	const f = await fixture(t);
	const manager = {} as any;
	await f.controller.ensure(manager, f.ctx("first"));
	assert.equal((await f.controller.add({ name: "first", schedule: "+1h", prompt: "first" })).ok, true);
	await f.controller.ensure(manager, f.ctx("second"));
	assert.deepEqual(f.controller.list(), []);
	assert.equal((await f.controller.add({ name: "second", schedule: "+1h", prompt: "second" })).ok, true);
	assert.deepEqual(JSON.parse(await fs.readFile(f.file("first"), "utf8")).jobs.map((job: any) => job.id), ["first"]);
	assert.deepEqual(JSON.parse(await fs.readFile(f.file("second"), "utf8")).jobs.map((job: any) => job.id), ["second"]);
});

test("live session-manager identity changes invalidate approvals and timer launches", async (t) => {
	const f = await fixture(t);
	await f.projectAgent();
	let sessionId = "old";
	const approval = deferred<boolean>();
	const ctx = f.ctx("old", () => approval.promise);
	ctx.sessionManager.getSessionId = () => sessionId;
	let launches = 0;
	const manager = { startAgent: async () => { launches++; return { ok: false, message: "unexpected" }; } } as any;
	await f.controller.start(manager, ctx);
	await f.controller.add({ name: "existing", schedule: "1h", prompt: "old work" });
	const pending = f.controller.add({ name: "pending", schedule: "+1h", prompt: "old approval", agent: "project", agentScope: "project" });
	sessionId = "new"; // The host context can change before its session-switch callback runs.
	approval.resolve(true);
	assert.equal((await pending).ok, false);
	const internal = f.controller as any;
	internal.jobs.get("existing").nextRunAt = Date.now();
	await internal.fire("existing", internal.generation);
	assert.equal(launches, 0);
	await f.controller.ensure(manager, ctx);
	assert.deepEqual(f.controller.list(), []);
});

test("deleting an in-flight repeating job prevents completion from resurrecting it", async (t) => {
	const f = await fixture(t);
	const started = deferred();
	const gate = deferred();
	const manager = { startAgent: async () => { started.resolve(); await gate.promise; return { ok: true, run: { id: "subagent-1" } }; } } as any;
	await f.controller.start(manager, f.ctx("owner"));
	await f.controller.add({ name: "repeat", schedule: "1h", prompt: "work" });
	const internal = f.controller as any;
	internal.jobs.get("repeat").nextRunAt = Date.now();
	const firing = internal.fire("repeat", internal.generation);
	await started.promise;
	assert.equal(await f.controller.delete("repeat"), true);
	gate.resolve();
	await firing;
	assert.deepEqual(f.controller.list(), []);
	assert.equal(internal.timers.size, 0);
	assert.deepEqual(JSON.parse(await fs.readFile(f.file("owner"), "utf8")).jobs, []);
});

test("a failed concurrent addition never enters another add's durable snapshot", { timeout: 5000 }, async (t) => {
	const f = await fixture(t);
	const manager = {} as any;
	await f.controller.start(manager, f.ctx("owner"));
	const entered = deferred();
	const release = deferred();
	t.after(() => release.resolve());
	const writeFile = fs.writeFile.bind(fs);
	let writes = 0;
	const snapshots: any[] = [];
	t.mock.method(fs, "writeFile", async (...args: Parameters<typeof fs.writeFile>) => {
		if (isSaveTarget(args[0], f.file("owner"))) {
			snapshots.push(JSON.parse(String(args[1])));
			if (++writes === 1) { entered.resolve(); await release.promise; }
			else throw new Error("second addition cannot be saved");
		}
		return writeFile(...args);
	});
	const first = f.controller.add({ name: "committed", schedule: "+1h", prompt: "first" });
	await entered.promise;
	const second = f.controller.add({ name: "failed", schedule: "+1h", prompt: "must never execute" });
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(f.controller.list().length, 2, "uncommitted proposals remain inspectable");
	release.resolve();
	const [a, b] = await Promise.all([first, second]);
	assert.equal(a.ok, true);
	assert.equal(b.ok, false);
	if (!b.ok) assert.match(b.message, /second addition cannot be saved/);
	assert.deepEqual(snapshots[0].jobs.map((job: any) => job.id), ["committed"]);
	assert.deepEqual(JSON.parse(await fs.readFile(f.file("owner"), "utf8")).jobs.map((job: any) => job.id), ["committed"]);
	assert.deepEqual(f.controller.list().map((job) => job.id), ["committed"]);
	await f.controller.start(manager, f.ctx("owner"));
	assert.deepEqual(f.controller.list().map((job) => job.id), ["committed"], "failed work must not revive on reload");
	assert.deepEqual([...((f.controller as any).timers.keys())], ["committed"]);
});

test("failed atomic deletion preserves committed state and restores its timer", { timeout: 5000 }, async (t) => {
	const f = await fixture(t);
	await f.controller.start({} as any, f.ctx("owner"));
	assert.equal((await f.controller.add({ name: "keep", schedule: "+1h", prompt: "existing" })).ok, true);
	const rename = fs.rename.bind(fs);
	t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
		if (String(args[1]) === f.file("owner")) throw new Error("atomic rename failed");
		return rename(...args);
	});
	await assert.rejects(f.controller.delete("keep"), /atomic rename failed/);
	assert.deepEqual(f.controller.list().map((job) => job.id), ["keep"]);
	assert.deepEqual(JSON.parse(await fs.readFile(f.file("owner"), "utf8")).jobs.map((job: any) => job.id), ["keep"]);
	assert.equal((f.controller as any).timers.has("keep"), true);
	assert.deepEqual(await fs.readdir(path.dirname(f.file("owner"))), ["owner.json"], "failed temporary writes must be cleaned up");
});
