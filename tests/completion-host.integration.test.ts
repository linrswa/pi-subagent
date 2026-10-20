import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createAgentSession, createEventBus, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import registerExtension from "../index.ts";
import { COMPLETION_MESSAGE_TYPE } from "../completion-notifier.ts";
import { subagentRunStore } from "../store.ts";

// Real Pi session/lifecycle and persistence. Only the provider is synthetic;
// no credentials, network calls, or child/model processes are needed.
test("actual Pi host wakes idle parent and queues busy completions without new user input", { timeout: 15_000 }, async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "pi-completion-host-"));
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	try {
		const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
		const runtime = await ModelRuntime.create({ authPath: path.join(dir, "auth.json"), modelsPath: path.join(dir, "models.json") });
		await runtime.setRuntimeApiKey("openai", "not-a-real-key");
		const factories = [registerExtension];
		if (process.env.PI_PLAN_EXTENSION_PATH) factories.unshift((await import(pathToFileURL(process.env.PI_PLAN_EXTENSION_PATH).href)).default);
		const bus = createEventBus();
		const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, eventBus: bus, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, extensionFactories: factories });
		await loader.reload();
		assert.deepEqual(loader.getExtensions().errors, []);
		assert.equal(loader.getExtensions().extensions.length, factories.length);
		const model = { id: "test", name: "test", api: "openai-completions", provider: "openai", baseUrl: "http://127.0.0.1:1", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1024 } as any;
		const manager = SessionManager.inMemory(dir);
		({ session } = await createAgentSession({ cwd: dir, model, modelRuntime: runtime, resourceLoader: loader, sessionManager: manager, settingsManager: settings, tools: process.env.PI_PLAN_EXTENSION_PATH ? ["todo_write"] : [] }));
		let calls = 0;
		let releaseBusy: (() => void) | undefined;
		let blockNext = false;
		const requests: any[] = [];
		session.agent.streamFunction = (_model, context, options) => {
			calls++;
			requests.push(context);
			const stream = createAssistantMessageEventStream();
			let finished = false;
			const onAbort = () => finish(true);
			const finish = (aborted = false) => {
				if (finished) return;
				finished = true;
				options?.signal?.removeEventListener("abort", onAbort);
				const message = { role: "assistant", content: [{ type: "text", text: aborted ? "Stopped." : "Reviewed background result." }], api: "openai-completions", provider: "openai", model: "test", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: aborted ? "aborted" : "stop", timestamp: Date.now() } as any;
				if (aborted) stream.push({ type: "error", reason: "aborted", error: message });
				else stream.push({ type: "done", reason: "stop", message });
				stream.end(message);
			};
			options?.signal?.addEventListener("abort", onAbort, { once: true });
			if (blockNext) { blockNext = false; releaseBusy = () => finish(); }
			else setTimeout(finish, 5);
			return stream;
		};
		const errors: string[] = [];
		await session.bindExtensions({ mode: "rpc", onError: (event) => errors.push(event.error) });
		const owner = manager.getSessionId();
		assert.equal(subagentRunStore.getActiveOwner(), owner);
		const complete = (text: string) => {
			const run = subagentRunStore.create({ ownerSessionId: owner, mode: "single", agent: "worker", agentSource: "package", task: text, completionNotification: "pending" });
			return subagentRunStore.update(run.id, { status: "completed", endedAt: Date.now(), finalOutput: text }, owner)!;
		};
		const waitUntil = async (predicate: () => boolean) => {
			for (let i = 0; i < 300; i++) {
				if (predicate()) return;
				if (errors.length) throw new Error(errors.join("\n"));
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			throw new Error(`Host condition timed out (calls=${calls}, streaming=${session?.isStreaming}, errors=${errors.join(",")}, entries=${JSON.stringify(manager.getEntries())})`);
		};
		const idleRun = complete("idle-result");
		const siblingRun = complete("simultaneous-result");
		await waitUntil(() => calls === 1 && !session!.isStreaming);
		assert.equal(subagentRunStore.get(idleRun.id, owner)?.completionNotification, "delivered");
		assert.equal(subagentRunStore.get(siblingRun.id, owner)?.completionNotification, "delivered");
		assert.match(JSON.stringify(requests[0]), /simultaneous-result/);
		assert.ok(manager.getEntries().some((entry) => entry.type === "custom_message" && entry.customType === COMPLETION_MESSAGE_TYPE));
		assert.match(JSON.stringify(requests[0]), /idle-result/);

		let linkedTaskId: string | undefined;
		if (process.env.PI_PLAN_EXTENSION_PATH) {
			const todo = session.agent.state.tools.find((tool) => tool.name === "todo_write")!;
			assert.ok(todo);
			const result = await todo.execute("nested-test", { todos: [{ text: "Inspect result", status: "in_progress" }] }, undefined);
			linkedTaskId = (result.details as any).todos[0].id;
			assert.ok(linkedTaskId);
			let response: any;
			bus.emit("pi-plan:context-request", { ownerSessionId: owner, respond: (value: unknown) => { response = value; } });
			assert.equal(response.taskId, linkedTaskId);
		}
		blockNext = true;
		const working = session.prompt("Do the main work first");
		await waitUntil(() => !!releaseBusy);
		const busyRun = complete("busy-result");
		if (linkedTaskId) subagentRunStore.update(busyRun.id, { taskId: linkedTaskId }, owner);
		await new Promise((resolve) => setTimeout(resolve, 180));
		assert.equal(calls, 2, "completion must not interrupt or run a concurrent provider request");
		assert.equal(subagentRunStore.get(busyRun.id, owner)?.completionNotification, "pending", "queued message is not yet persisted");
		releaseBusy!();
		await working;
		await waitUntil(() => calls === 3 && !session!.isStreaming);
		assert.equal(subagentRunStore.get(busyRun.id, owner)?.completionNotification, "delivered");
		assert.match(JSON.stringify(requests[2]), /busy-result/);
		if (linkedTaskId) {
			assert.match(JSON.stringify(requests[2]), /finished; review/);
			const state = manager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "plan-mode").at(-1) as any;
			assert.equal(state.data.todos[0].status, "in_progress", "worker completion must not complete the todo");
			const todo = session.agent.state.tools.find((tool) => tool.name === "todo_write")!;
			await todo.execute("reviewed", { todos: [{ id: linkedTaskId, text: "Inspect result", status: "completed" }] }, undefined);
			const latest = manager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "plan-mode").at(-1) as any;
			assert.equal(latest.data.todos[0].status, "completed");
			await session.prompt("/plan");
			assert.equal(session.getActiveToolNames().includes("bash"), false);
			const count = subagentRunStore.getSnapshot(owner).length;
			await session.prompt("/bg worker This launch must be rejected in plan mode");
			assert.equal(subagentRunStore.getSnapshot(owner).length, count, "/bg cannot bypass enforced plan mode");
			await todo.execute("next-plan", { todos: [
				{ id: linkedTaskId, text: "Inspect result", status: "completed" },
				{ text: "Execute explicitly approved follow-up", status: "pending" },
			] }, undefined);
			await session.prompt("/plan execute");
			await waitUntil(() => calls === 4 && !session!.isStreaming);
			assert.match(JSON.stringify(requests[3]), /Execute the approved plan/);
			assert.deepEqual(session.getActiveToolNames(), ["todo_write"], "original deliberately restricted loadout restored");
			const approved = manager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "plan-mode").at(-1) as any;
			assert.equal(approved.data.enabled, false);
			assert.equal(approved.data.executing, true);
			assert.equal(approved.data.todos[0].status, "completed", "approval retains the completed checklist history");
		}
		// Actual host cancellation must settle and pause subsequent idle wake-ups.
		const beforeAbort = calls;
		blockNext = true;
		releaseBusy = undefined;
		const interrupted = session.prompt("Work until I cancel");
		await waitUntil(() => !!releaseBusy);
		await session.abort();
		await interrupted;
		const afterAbort = complete("completed-after-parent-abort");
		await new Promise((resolve) => setTimeout(resolve, 180));
		assert.equal(calls, beforeAbort + 1, "late completion cannot undo user cancellation");
		assert.equal(subagentRunStore.get(afterAbort.id, owner)?.completionNotification, "pending");
		await session.prompt("Resume reviewing the outstanding result");
		await waitUntil(() => calls === beforeAbort + 3 && !session!.isStreaming);
		assert.equal(subagentRunStore.get(afterAbort.id, owner)?.completionNotification, "delivered");
		assert.deepEqual(errors, []);
	} finally {
		session?.dispose();
		await rm(dir, { recursive: true, force: true });
	}
});
