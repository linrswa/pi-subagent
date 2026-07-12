import assert from "node:assert/strict";
import test from "node:test";
import registerExtension from "../index.ts";
import { subagentRunStore } from "../store.ts";

/**
 * This is deliberately an extension harness rather than a store test: it
 * drives index.ts' registered session_start, input, tools, and autocomplete
 * provider while retaining the session entries that Pi would persist.
 */
test("extension public run visibility follows the active persisted Pi session", async () => {
	const handlers = new Map<string, Function>();
	const tools = new Map<string, any>();
	const entries = new Map<string, any[]>();
	const autocompleteProviders: any[] = [];
	let activeSessionId = "";
	const suffix = `${process.pid}-${Date.now()}`;
	const sessionA = `main-A-${suffix}`;
	const sessionB = `main-B-${suffix}`;

	const pi = {
		on(name: string, handler: Function) { handlers.set(name, handler); },
		registerTool(tool: any) { tools.set(tool.name, tool); },
		registerCommand() {},
		appendEntry(customType: string, data: unknown) {
			entries.get(activeSessionId)!.push({ type: "custom", customType, data });
		},
		getThinkingLevel() { return undefined; },
	};
	registerExtension(pi as any);

	const contextFor = (sessionId: string) => ({
		cwd: process.cwd(),
		mode: "tui",
		hasUI: false,
		ui: {
			addAutocompleteProvider(provider: unknown) { autocompleteProviders.push(provider); },
		},
		sessionManager: {
			getSessionId: () => sessionId,
			getEntries: () => entries.get(sessionId) ?? [],
			getSessionFile: () => undefined,
		},
	});
	const activate = (sessionId: string) => {
		activeSessionId = sessionId;
		entries.set(sessionId, entries.get(sessionId) ?? []);
		handlers.get("session_start")!({}, contextFor(sessionId));
	};
	const complete = (task: string) => {
		const run = subagentRunStore.create({
			mode: "single", agent: "explorer", agentSource: "user", task,
			status: "completed", endedAt: Date.now(), cwd: process.cwd(),
			sessionFile: `/managed/${task}.jsonl`, leafId: `${task}-leaf`,
		});
		return run;
	};
	const control = tools.get("subagent_control");
	const subagent = tools.get("subagent");
	const text = async (result: Promise<any>) => (await result).content[0].text as string;

	activate(sessionA);
	const a = complete("A-only work");
	assert.equal(a.id, "subagent-1");
	assert.match(await text(control.execute("list", { action: "list" }, undefined, undefined, contextFor(sessionA))), /A-only work/);
	assert.match(await text(control.execute("status", { action: "status", runId: "&1" }, undefined, undefined, contextFor(sessionA))), /A-only work/);
	assert.match(handlers.get("input")!({ source: "user", text: "inspect &1" }).text, /Subagent run refs/);

	activate(sessionB);
	const b = complete("B-only work");
	const bOnly = complete("B-private continuation source");
	assert.equal(b.id, "subagent-1", "short ids restart in a distinct persisted main-session scope");
	assert.equal(bOnly.id, "subagent-2");
	const bList = await text(control.execute("list", { action: "list" }, undefined, undefined, contextFor(sessionB)));
	assert.match(bList, /B-only work/);
	assert.doesNotMatch(bList, /A-only work/);
	assert.match(handlers.get("input")!({ source: "user", text: "inspect &1" }).text, /Subagent run refs/);
	assert.match(handlers.get("input")!({ source: "user", text: "inspect &2" }).text, /continueFrom: "&2"/);

	const provider = autocompleteProviders.at(-1)(({
		getSuggestions: async () => null,
		applyCompletion: () => undefined,
		shouldTriggerFileCompletion: () => true,
	}));
	const suggestions = await provider.getSuggestions(["inspect &"], 0, 9, { signal: new AbortController().signal });
	assert.deepEqual(suggestions.items.map((item: any) => item.value), ["&1", "&2"]);
	assert.match(suggestions.items[0].description, /B-only work/);
	assert.doesNotMatch(suggestions.items[0].description, /A-only work/);

	// B's &2 is not visible to A. This exits before agent discovery/model work.
	activate(sessionA);
	assert.equal(handlers.get("input")!({ source: "user", text: "inspect &2" }).action, "continue", "B-only refs are absent after restoring A");
	const rejected = await text(subagent.execute("continue", { continueFrom: "&2", task: "cross-session follow-up" }, undefined, undefined, contextFor(sessionA)));
	assert.equal(rejected, "Unknown subagent run to continue: &2");
	const restored = await text(control.execute("list", { action: "list" }, undefined, undefined, contextFor(sessionA)));
	assert.match(restored, /A-only work/);
	assert.doesNotMatch(restored, /B-only work|B-private continuation source/);
	assert.match(await text(control.execute("status", { action: "status", runId: "&1" }, undefined, undefined, contextFor(sessionA))), /A-only work/);

	const pending = subagentRunStore.create({
		mode: "single", agent: "explorer", agentSource: "user", task: "pending completion",
		status: "completed", endedAt: Date.now(), finalOutput: "durable result",
		completionNotification: "pending", cwd: process.cwd(),
	});
	assert.equal(handlers.get("input")!({ source: "user", text: "steer", streamingBehavior: "steer" }).action, "continue");
	assert.equal(handlers.get("input")!({ source: "user", text: "/implement something" }).action, "continue");
	assert.equal(subagentRunStore.get(pending.id, sessionA)?.completionNotification, "pending");
	const ordinary = handlers.get("input")!({ source: "user", text: "what finished?" });
	assert.match(ordinary.text, /Background subagent completion update/);
	assert.match(ordinary.text, /durable result/);
	assert.equal(subagentRunStore.get(pending.id, sessionA)?.completionNotification, "pending", "input staging is not acknowledgement");
	handlers.get("agent_start")!({}, contextFor(sessionA));
	assert.equal(subagentRunStore.get(pending.id, sessionA)?.completionNotification, "delivered");
});
