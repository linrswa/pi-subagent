/**
 * Subagent Tool - delegate tasks to specialized pi agents with isolated context.
 *
 * Each invocation spawns one or more separate persisted `pi --mode json -p`
 * sessions. Child context stays isolated; background runs publish through the
 * run store/viewer, while wait=true can stream progress in the tool result.
 */

import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import {
	Container,
	Markdown,
	Spacer,
	Text,
} from "@earendil-works/pi-tui";
import { type AgentConfig, type AgentScope, discoverAgents, discoverAgentsWithSettings, formatAgentList, getAgentModelDefaults, setAgentModelDefault } from "./agents.ts";
import { startChain } from "./chain-runner.ts";
import { CompletionNotifier } from "./completion-notifier.ts";
import { getFinalOutput, getResultOutput, isFailedResult, toParentResult } from "./results.ts";
import {
	SubagentManager,
	buildRunRefContext,
	formatRunDetails,
	createRunRefAutocompleteProvider,
	getAgentCommandCompletions,
	getMainSessionOwnerId,
	getMode,
	getContinuationCallDisplay,
	getRunRefCompletions,
	normalizeAgentRef,
} from "./manager.ts";
import { formatShortRunId } from "./run-refs.ts";
import {
	SubagentSchedulerController,
	formatRelativeTime,
	formatScheduleId,
	formatScheduleList,
} from "./scheduler.ts";
import { subagentRunStore } from "./store.ts";
import { RunPointerPersistence } from "./run-pointers.ts";
import { OwnerRunLifecycle } from "./run-lifecycle.ts";
import { SubagentSettingsComponent } from "./settings-ui.ts";
import { openSubagentRunViewer } from "./viewer.ts";
import {
	SubagentControlParamsSchema,
	SubagentParamsSchema,
	SubagentScheduleParamsSchema,
} from "./schemas.ts";
import type {
	OnUpdateCallback,
	ParentResult,
	SingleResult,
	SubagentControlParamsInput,
	SubagentDetails,
	SubagentMode,
	SubagentParamsInput,
	SubagentRun,
	SubagentScheduleParamsInput,
	UsageStats,
} from "./types.ts";

export type {
	AgentMessage,
	MessageContent,
	RunStatus,
	SubagentMode,
	SubagentRun,
	SubagentRunSubscriber,
	TextContent,
	ToolCallContent,
	UsageStats,
} from "./types.ts";
export { SubagentRunStore, subagentRunStore } from "./store.ts";

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(usage: UsageStats | Omit<UsageStats, "contextTokens">, model?: string): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if ("contextTokens" in usage && usage.contextTokens > 0) parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	if (model) parts.push(model);
	return parts.join(" ");
}

function shortenPath(filePath: string): string {
	const home = os.homedir();
	return filePath.startsWith(home) ? `~${filePath.slice(home.length)}` : filePath;
}


function aggregateUsage(results: Array<Pick<SingleResult, "usage">>): Omit<UsageStats, "contextTokens"> {
	const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
	for (const result of results) {
		total.input += result.usage.input;
		total.output += result.usage.output;
		total.cacheRead += result.usage.cacheRead;
		total.cacheWrite += result.usage.cacheWrite;
		total.cost += result.usage.cost;
		total.turns += result.usage.turns;
	}
	return total;
}


function resultIcon(result: ParentResult, theme: ExtensionContext["ui"]["theme"]): string {
	if (result.status === "queued" || result.status === "running") return theme.fg("warning", "⏳");
	return result.status === "failed" || result.status === "aborted" ? theme.fg("error", "✗") : theme.fg("success", "✓");
}

function compactPreview(text: string | undefined, maxLength: number): string {
	const normalized = (text ?? "").replace(/\s+/g, " ").trim();
	if (!normalized) return "...";
	return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized;
}

function formatContinuedFrom(runId: string | undefined): string {
	return runId ? `continued from ${formatShortRunId(runId)}` : "";
}

function resultStatusLabel(result: ParentResult): ParentResult["status"] {
	return result.status;
}

function renderCompactResult(details: SubagentDetails, theme: ExtensionContext["ui"]["theme"]): Container {
	const container = new Container();
	const running = details.results.filter((entry) => entry.status === "queued" || entry.status === "running").length;
	const failed = details.results.filter((entry) => entry.status === "failed" || entry.status === "aborted").length;
	const topIcon = running > 0 ? theme.fg("warning", "⏳") : failed > 0 ? theme.fg("warning", "◐") : theme.fg("success", "✓");
	const scope = theme.fg("muted", ` [${details.agentScope}]`);
	let line: string;

	if (details.mode === "single") {
		const entry = details.results[0];
		const continuation = formatContinuedFrom(entry.continuedFromRunId);
		line = `${resultIcon(entry, theme)} ${theme.fg("accent", entry.agent)} ${theme.fg("muted", resultStatusLabel(entry))}${continuation ? theme.fg("muted", ` ${continuation}`) : ""}${scope}`;
	} else if (details.chainStepCount && details.results[0]?.agent === "chain") {
		const entry = details.results[0];
		line = `${resultIcon(entry, theme)} ${theme.fg("accent", `chain (${details.chainStepCount} steps)`)}: ${theme.fg("dim", resultStatusLabel(entry))}${scope}`;
	} else {
		const runningIndex = details.results.findIndex((entry) => entry.status === "queued" || entry.status === "running");
		const failedIndex = details.results.findIndex((entry) => entry.status === "failed" || entry.status === "aborted");
		const activeIndex = runningIndex !== -1 ? runningIndex : failedIndex !== -1 ? failedIndex : details.results.length - 1;
		const entry = details.results[activeIndex];
		const step = activeIndex + 1;
		line = `${topIcon} ${theme.fg("accent", `chain step ${step}/${details.results.length}`)}: ${theme.fg("dim", `${entry.agent} ${resultStatusLabel(entry)}`)}${scope}`;
	}

	container.addChild(new Text(line, 0, 0));
	return container;
}

function formatPanelDuration(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	const seconds = totalSeconds % 60;
	const minutes = Math.floor(totalSeconds / 60) % 60;
	const hours = Math.floor(totalSeconds / 3600);
	if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
	return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatRunTime(run: SubagentRun): string {
	if (run.status === "queued" || run.status === "running") return formatPanelDuration(Date.now() - run.startedAt);
	if (run.status === "completed") return "done";
	return run.status;
}

function formatRunList(runs: readonly SubagentRun[]): string {
	if (runs.length === 0) return "No subagents.";
	return runs
		.map((run) => {
			const output = run.finalOutput || getFinalOutput(run.messages) || run.errorMessage || "";
			const tool = run.currentTool ? `\n  current: ${run.currentTool}` : "";
			const preview = output ? `\n  output: ${compactPreview(output, 180)}` : "";
			const parent = run.continuedFromRunId ? `\n  ${formatContinuedFrom(run.continuedFromRunId)}` : "";
			const chainParent = run.parentRunId ? `\n  chain parent: ${formatShortRunId(run.parentRunId)}` : "";
			const children = run.childRunIds?.length ? `\n  child runs: ${run.childRunIds.map(formatShortRunId).join(", ")}` : "";
			return `${formatShortRunId(run.id)} ${run.status} ${run.agent} (${formatRunTime(run)})\n  task: ${compactPreview(run.task, 180)}${parent}${chainParent}${children}${tool}${preview}`;
		})
		.join("\n\n");
}


const subagentSchedulerController = new SubagentSchedulerController();

export default function (pi: ExtensionAPI) {
	let sessionCwd = process.cwd();
	const runPointers = new RunPointerPersistence(pi);
	const runLifecycle = new OwnerRunLifecycle();
	const completionNotifier = new CompletionNotifier();
	const subagentManager = new SubagentManager(
		pi,
		(run) => runPointers.tombstone(run.ownerSessionId, run.id),
		runLifecycle,
		subagentRunStore,
		(run, completion) => completionNotifier.watch(run, completion),
	);
	// One observer sees all scopes. RunPointerPersistence rejects completions from
	// background runs once their captured main-session generation is no longer active.
	subagentRunStore.subscribeChanges((run) => runPointers.record(run));

	pi.on("session_start", (_event, ctx) => {
		sessionCwd = ctx.cwd;
		const ownerSessionId = getMainSessionOwnerId(ctx);
		subagentRunStore.setActiveOwner(ownerSessionId);
		runLifecycle.activate(ownerSessionId);
		try {
			// Pointer/tombstone state is session-global: sibling branches can reserve IDs
			// or tombstone a run even when they are not on the active context path.
			runPointers.activate(ownerSessionId, ctx.sessionManager.getEntries(), subagentRunStore);
		} catch {
			// Ephemeral/no-session parents still retain their in-process run scope.
			runPointers.activate(ownerSessionId, [], subagentRunStore);
		}
		completionNotifier.activate(ownerSessionId, ctx);
		completionNotifier.resume(subagentRunStore.getSnapshot(ownerSessionId));
		void subagentSchedulerController.start(subagentManager, ctx);
		if (ctx.mode === "tui") ctx.ui.addAutocompleteProvider((current) => createRunRefAutocompleteProvider(current));
	});

	pi.on("input", (event) => {
		// Steering/follow-up messages do not start a new agent run, and slash
		// templates expand after this hook. Leave completions pending for the next
		// ordinary idle prompt instead of duplicating or corrupting template args.
		if (event.source === "extension" || event.streamingBehavior || event.text.trimStart().startsWith("/")) return { action: "continue" };
		const ownerSessionId = subagentRunStore.getActiveOwner();
		const completion = completionNotifier.stageForNextInput(ownerSessionId);
		const runRefContext = buildRunRefContext(event.text);
		const additions = [completion.content, runRefContext].filter((value): value is string => Boolean(value));
		if (additions.length === 0) return { action: "continue" };
		return { action: "transform", text: `${event.text}\n\n${additions.join("\n\n")}` };
	});

	pi.on("agent_start", (_event, ctx) => {
		const ownerSessionId = getMainSessionOwnerId(ctx);
		for (const run of completionNotifier.acknowledgeStaged(ownerSessionId)) runPointers.recordCurrent(run);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		const ownerSessionId = getMainSessionOwnerId(ctx);
		// Runtime-aborted work must not reappear as a user-facing completion after
		// reload. Already-terminal pending notifications remain resumable.
		for (const run of subagentRunStore.getSnapshot(ownerSessionId)) {
			if ((run.status === "queued" || run.status === "running") && run.completionNotification === "pending") {
				subagentRunStore.update(run.id, { completionNotification: "suppressed" }, ownerSessionId);
			}
		}
		completionNotifier.deactivate(ownerSessionId);
		// Stop timers first. Keep pointer persistence active while runtime-owned
		// children receive aborts and publish their terminal records.
		subagentSchedulerController.stop();
		await runLifecycle.shutdown(ownerSessionId);
		runPointers.deactivate();
	});

	pi.registerCommand("subagent-view", {
		description: "Open a live subagent run viewer: /subagent-view <runId>",
		getArgumentCompletions: (prefix) => getRunRefCompletions(prefix.replace(/^[&＆]/, "")),
		handler: async (args, ctx) => {
			const run = subagentManager.findRun(args.trim());
			if (!run) return ctx.ui.notify(`Unknown subagent run: ${args.trim() || "(missing)"}`, "warning");
			openSubagentRunViewer(ctx, run.id, run.ownerSessionId);
		},
	});

	pi.registerCommand("subagent-schedules", {
		description: "List/delete subagent schedules: /subagent-schedules [delete] <id>",
		getArgumentCompletions: (prefix) => {
			const jobs = subagentSchedulerController.list();
			const query = prefix.trim().replace(/^delete\s+/, "");
			const items = jobs
				.filter((job) => !query || job.id.includes(query) || formatScheduleId(job.id).includes(query))
				.map((job) => ({ value: formatScheduleId(job.id), label: formatScheduleId(job.id), description: `${job.schedule}: ${compactPreview(job.prompt, 80)}` }));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			const available = await subagentSchedulerController.ensure(subagentManager, ctx);
			if (!available) return ctx.ui.notify("Subagent schedules require a persisted session.", "warning");
			const trimmed = args.trim();
			if (trimmed) {
				const id = trimmed.replace(/^delete\s+/i, "");
				const deleted = await subagentSchedulerController.delete(id);
				return ctx.ui.notify(deleted ? `Deleted schedule ${id}.` : `Unknown schedule: ${id}`, deleted ? "info" : "warning");
			}
			ctx.ui.notify(formatScheduleList(subagentSchedulerController.list()), "info");
		},
	});

	pi.registerCommand("subagent-setting", {
		description: "Configure default models for subagents",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") return ctx.ui.notify("/subagent-setting requires TUI mode.", "warning");

			const agentScope: AgentScope = ctx.isProjectTrusted() ? "both" : "user";
			const discovery = discoverAgents(ctx.cwd, agentScope);
			if (discovery.agents.length === 0) return ctx.ui.notify("No subagents available.", "warning");

			const scopes = (ctx.isProjectTrusted() ? ["global", "project"] : ["global"]) as ("global" | "project")[];
			await ctx.ui.custom<void>(
				(tui, theme, _keybindings, done) =>
					new SubagentSettingsComponent({
						tui,
						theme,
						agents: discovery.agents,
						scopes,
						initialDefaults: getAgentModelDefaults(ctx.cwd, ctx.isProjectTrusted()),
						modelRegistry: ctx.modelRegistry,
						save: async (scope, agentName, modelRef) => shortenPath(await setAgentModelDefault(ctx.cwd, scope, agentName, modelRef)),
						refreshDefaults: () => getAgentModelDefaults(ctx.cwd, ctx.isProjectTrusted()),
						onDone: done,
					}),
				{ overlay: true, overlayOptions: { anchor: "center", width: "75%", minWidth: 70, maxHeight: "85%" } },
			);
		},
	});

	pi.registerTool({
		name: "subagent_control",
		label: "Subagent Control",
		description: "Inspect and control subagents: list, status, send guidance to a live run, stop, or delete.",
		promptSnippet: "Use subagent_control to inspect runs or send a simple instruction to a queued/running subagent; use subagent continueFrom only after a run closes.",
		promptGuidelines: [
			"Use action=list before referring to subagents if the run id is unclear.",
			"runId accepts subagent-3, &3, or 3 and is required for status, send, stop, and delete.",
			"Use subagent_control action=send with message to guide a queued/running run; omit delivery for the normal steer behavior.",
			"Use delivery=followUp only when the added instruction should wait until the subagent finishes its current work.",
			"Use subagent with continueFrom and task to continue a completed run; control actions never start agents.",
		],
		parameters: SubagentControlParamsSchema as never,

		async execute(_toolCallId, rawParams, _signal, _onUpdate, _ctx) {
			const params = rawParams as SubagentControlParamsInput;
			const action = params.action ?? "list";
			if (!["list", "status", "send", "stop", "delete"].includes(action)) {
				return { content: [{ type: "text", text: `Unsupported control action: ${String(action)}.` }], details: { action } };
			}
			const runs = subagentManager.listRuns();

			if (action === "list") {
				return { content: [{ type: "text", text: formatRunList(runs) }], details: { action } };
			}

			if (!params.runId?.trim()) {
				return { content: [{ type: "text", text: `action=${action} requires runId.` }], details: { action } };
			}

			const run = subagentManager.findRun(params.runId, runs);
			if (!run) {
				return { content: [{ type: "text", text: `Unknown subagent run: ${params.runId}` }], details: { action } };
			}

			if (action === "status") {
				return { content: [{ type: "text", text: formatRunDetails(run) }], details: { action, runId: run.id } };
			}

			if (action === "send") {
				const sent = await subagentManager.sendRunInput(run.id, params.message ?? "", params.delivery ?? "steer");
				if (!sent.accepted) {
					return { content: [{ type: "text", text: `Could not guide ${formatShortRunId(run.id)}: ${sent.message ?? "unknown error"}` }], details: { action, runId: run.id, accepted: false } };
				}
				const target = sent.targetRun && sent.targetRun.id !== run.id
					? `${formatShortRunId(sent.targetRun.id)} (active child of ${formatShortRunId(run.id)})`
					: formatShortRunId(run.id);
				return {
					content: [{ type: "text", text: `${sent.queued ? "Queued guidance for" : "Sent guidance to"} ${target}.` }],
					details: { action, runId: run.id, targetRunId: sent.targetRun?.id, accepted: true, queued: sent.queued },
				};
			}

			if (action === "stop") {
				const stopped = subagentManager.stopRun(run.id);
				return { content: [{ type: "text", text: stopped ? `Stopping ${formatShortRunId(run.id)}.` : `${formatShortRunId(run.id)} is not running.` }], details: { action, runId: run.id } };
			}

			const deletion = await subagentManager.deleteRun(run.id);
			return {
				content: [{ type: "text", text: deletion.deleted ? `Deleted ${formatShortRunId(run.id)}.` : `Could not delete ${formatShortRunId(run.id)}: ${deletion.message ?? "unknown error"}` }],
				details: { action, runId: run.id, deleted: deletion.deleted },
			};
		},

		renderCall(args: SubagentControlParamsInput, theme) {
			const action = args.action ?? "list";
			const target = args.runId ? ` ${args.runId}` : "";
			const message = action === "send" && args.message ? `: ${compactPreview(args.message, 60)}` : "";
			return new Text(`${theme.fg("toolTitle", theme.bold("subagent_control "))}${theme.fg("accent", action)}${theme.fg("dim", `${target}${message}`)}`, 0, 0);
		},

		renderResult(result, _options, theme) {
			const first = result.content?.[0];
			const text = first?.type === "text" ? first.text : "(no output)";
			return new Text(theme.fg("toolOutput", text), 0, 0);
		},
	});

	pi.registerTool({
		name: "subagent_schedule",
		label: "Subagent Schedule",
		description: "Session-scoped scheduled background subagents. Supports interval (30s/5m/1h/2d), relative one-shot (+10m), ISO timestamp, and 6-field cron.",
		promptSnippet: "Use subagent_schedule to add/list/delete scheduled background subagent runs for the current session.",
		promptGuidelines: [
			"Use action=add with schedule and prompt to start future background subagents.",
			"When the user names a schedule, set name; it becomes the schedule id.",
			"Scheduled runs start the subagent in background with project-agent confirmation disabled after schedule creation approval.",
			"Use action=list before delete if the schedule id is unclear.",
		],
		parameters: SubagentScheduleParamsSchema as never,

		async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
			const params = rawParams as SubagentScheduleParamsInput;
			const action = params.action ?? "list";
			const available = await subagentSchedulerController.ensure(subagentManager, ctx);
			if (!available) return { content: [{ type: "text", text: "Subagent schedules require a persisted session." }], details: { ok: false, action } };

			if (action === "list") {
				const jobs = subagentSchedulerController.list();
				return { content: [{ type: "text", text: formatScheduleList(jobs) }], details: { ok: true, action, jobs } };
			}

			if (action === "delete") {
				const deleted = await subagentSchedulerController.delete(params.id);
				return { content: [{ type: "text", text: deleted ? `Deleted schedule ${params.id}.` : `Unknown schedule: ${params.id ?? "(missing)"}` }], details: { ok: deleted, action, id: params.id } };
			}

			const result = await subagentSchedulerController.add(params);
			if (result.ok === false) return { content: [{ type: "text", text: result.message }], details: { ok: false, action } };
			return {
				content: [{ type: "text", text: `Scheduled ${formatScheduleId(result.job.id)} (${result.job.schedule}); next ${formatRelativeTime(result.job.nextRunAt)}.` }],
				details: { ok: true, action, job: result.job },
			};
		},

		renderCall(args: SubagentScheduleParamsInput, theme) {
			const action = args.action ?? "list";
			const name = args.name ? `${args.name} ` : "";
			const target = action === "add" ? `${name}${args.schedule ?? "?"}: ${compactPreview(args.prompt, 60)}` : (args.id ?? "");
			return new Text(`${theme.fg("toolTitle", theme.bold("subagent_schedule "))}${theme.fg("accent", action)} ${theme.fg("dim", target)}`, 0, 0);
		},

		renderResult(result, _options, theme) {
			const first = result.content?.[0];
			const text = first?.type === "text" ? first.text : "(no output)";
			return new Text(theme.fg("toolOutput", text), 0, 0);
		},
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Start specialized subagents with isolated context windows. Runs are background by default and return a run id immediately; set wait=true to return the final output.",
			"Modes: single (optional agent + task), continuation (continueFrom + task), and chain (sequential with {previous} placeholder).",
			'Default agent scope is "user" (bundled agents + ~/.pi/agent/agents).',
			'To enable repo-local .pi/agents, set agentScope: "both" or "project".',
		].join(" "),
		promptSnippet: "Start a focused child agent in background and return its run id; set wait=true only when the current turn needs the final result. Multiple sibling calls run concurrently.",
		promptGuidelines: [
			"Use subagent for focused codebase reconnaissance, implementation planning, or independent code review when isolation helps.",
			"Runs are background by default. Do not poll; completion is delivered to the main session. Set wait=true only when the current turn cannot continue without the result.",
			"For parallel work, emit multiple sibling subagent calls; Pi executes sibling tools concurrently. Avoid concurrent agents that edit the same files.",
			"Use subagent chain mode with {previous} to pass explorer findings to planner or reviewer output to worker.",
			"Continue a completed run with {continueFrom: \"&1\", task: \"...\"}; omit agent to reuse it, or provide agent to switch. Continuations retain the source cwd.",
		],
		parameters: SubagentParamsSchema as never,

		async execute(_toolCallId, rawParams, signal, onUpdate, ctx) {
			const params = rawParams as SubagentParamsInput;
			const mode = getMode(params);
			const sourceRun = params.continueFrom ? subagentManager.findRun(params.continueFrom) : undefined;
			// Capture before any project-agent confirmation can await. If the session
			// shuts down during confirmation, this signal remains aborted.
			const chainOwnerSessionId = mode === "chain" ? getMainSessionOwnerId(ctx) : undefined;
			const chainSignal = chainOwnerSessionId ? runLifecycle.signalFor(chainOwnerSessionId, params.wait ? signal : undefined) : undefined;

			if (mode && params.continueFrom && !sourceRun) {
				return { content: [{ type: "text", text: `Unknown subagent run to continue: ${params.continueFrom}` }], details: { mode: "single", results: [] } };
			}
			if (mode && sourceRun && !["completed", "failed", "aborted"].includes(sourceRun.status)) {
				return { content: [{ type: "text", text: `Cannot continue ${formatShortRunId(sourceRun.id)}: source run is still ${sourceRun.status}.` }], details: { mode: "single", results: [] } };
			}
			// abort() marks a run aborted before the child exits and its final
			// session checkpoint is resolved. Do not fork that still-live source.
			if (mode && sourceRun && (sourceRun.endedAt === undefined || sourceRun.abort)) {
				return { content: [{ type: "text", text: `Cannot continue ${formatShortRunId(sourceRun.id)}: source run has not fully closed; wait for it to stop.` }], details: { mode: "single", results: [] } };
			}
			if (mode && sourceRun && !sourceRun.sessionFile) {
				return { content: [{ type: "text", text: `Cannot continue ${formatShortRunId(sourceRun.id)}: source run has no persisted session.` }], details: { mode: "single", results: [] } };
			}
			if (mode && sourceRun && !sourceRun.leafId) {
				return { content: [{ type: "text", text: `Cannot continue ${formatShortRunId(sourceRun.id)}: source session leaf is missing.` }], details: { mode: "single", results: [] } };
			}
			if (mode && sourceRun && !sourceRun.cwd) {
				return { content: [{ type: "text", text: `Cannot continue ${formatShortRunId(sourceRun.id)}: source run has no working directory.` }], details: { mode: "single", results: [] } };
			}
			if (mode && sourceRun && params.cwd && path.resolve(ctx.cwd, params.cwd) !== sourceRun.cwd) {
				return { content: [{ type: "text", text: `Cannot continue ${formatShortRunId(sourceRun.id)}: continuation cwd must match source cwd (${sourceRun.cwd}).` }], details: { mode: "single", results: [] } };
			}

			const agentScope: AgentScope = params.agentScope ?? sourceRun?.agentScope ?? (sourceRun?.agentSource === "project" ? "both" : "user");
			const discovery = discoverAgentsWithSettings(ctx.cwd, agentScope, ctx.isProjectTrusted());
			const agents = discovery.agents;
			const confirmProjectAgents = params.confirmProjectAgents ?? true;

			const fallbackModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
			let fallbackThinkingLevel: string | undefined;
			try {
				fallbackThinkingLevel = pi.getThinkingLevel();
			} catch {
				fallbackThinkingLevel = undefined;
			}

			const makeDetailsFromParent =
				(selectedMode: SubagentMode) =>
				(results: ParentResult[]): SubagentDetails => ({
					mode: selectedMode,
					agentScope,
					packageAgentsDir: discovery.packageAgentsDir,
					userAgentsDir: discovery.userAgentsDir,
					projectAgentsDir: discovery.projectAgentsDir,
					results,
				});
			const makeDetails =
				(selectedMode: SubagentMode) =>
				(results: SingleResult[]): SubagentDetails => makeDetailsFromParent(selectedMode)(results.map(toParentResult));

			if (!mode) {
				const list = formatAgentList(agents);
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. Provide exactly one mode: {task, agent?}, {continueFrom, task}, or {chain}.\n\nAvailable agents:\n${list.text}${list.remaining ? `\n... and ${list.remaining} more` : ""}`,
						},
					],
					details: makeDetails("single")([]),
				};
			}

			// Resolve a continuation's inherited or overridden agent before
			// branchChildSession() can create a child-session file or run record.
			if (sourceRun) {
				const selectedAgentName = params.agent ?? sourceRun.agent;
				if (!agents.some((agent) => agent.name === selectedAgentName)) {
					const list = formatAgentList(agents);
					return {
						content: [{ type: "text", text: `Unknown agent: "${selectedAgentName}". Available agents:\n${list.text}${list.remaining ? `\n... and ${list.remaining} more` : ""}` }],
						details: makeDetails("single")([]),
					};
				}
			}

			if (mode === "chain" && params.chain) {
				const unknown = params.chain.find((step) => !agents.some((agent) => agent.name === step.agent));
				if (unknown) {
					const list = formatAgentList(agents);
					return { content: [{ type: "text", text: `Unknown agent: "${unknown.agent}". Available agents:\n${list.text}${list.remaining ? `\n... and ${list.remaining} more` : ""}` }], details: makeDetails("chain")([]) };
				}
			}

			if (mode === "chain" && (agentScope === "project" || agentScope === "both") && confirmProjectAgents && ctx.hasUI) {
				const requestedAgentNames = new Set<string>();
				if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
				if (params.agent) requestedAgentNames.add(params.agent);
				else if (sourceRun) requestedAgentNames.add(sourceRun.agent);

				const projectAgentsRequested = Array.from(requestedAgentNames)
					.map((name) => agents.find((agent) => agent.name === name))
					.filter((agent): agent is AgentConfig => agent?.source === "project");

				if (projectAgentsRequested.length > 0) {
					const names = projectAgentsRequested.map((agent) => agent.name).join(", ");
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled prompts. Only continue for trusted repositories.`,
					);
					if (!ok) {
						return {
							content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
							details: makeDetails(mode)([]),
						};
					}
				}
			}

			if (mode === "chain" && params.chain) {
				if (chainSignal?.aborted || !chainOwnerSessionId) return { content: [{ type: "text", text: "Canceled: session is shutting down." }], details: makeDetails("chain")([]) };
				const handle = startChain({
					defaultCwd: ctx.cwd,
					agents,
					steps: params.chain,
					fallbackModel,
					fallbackThinkingLevel,
					agentScope,
					ownerSessionId: chainOwnerSessionId,
					completionNotification: params.wait ? "suppressed" : "pending",
					signal: chainSignal,
					onUpdate: params.wait ? (onUpdate as OnUpdateCallback | undefined) : undefined,
					makeDetails: makeDetails("chain"),
					onParentCreated: (run) => runLifecycle.track(run),
					onChildCreated: (run) => runLifecycle.track(run),
				});

				if (!params.wait) {
					completionNotifier.watch(handle.run, handle.completion);
					const id = formatShortRunId(handle.run.id);
					return {
						content: [{ type: "text", text: `Started chain ${id} in background. Use subagent_control with runId ${id} to inspect or stop it.` }],
						details: { ...makeDetailsFromParent("chain")([{
							runId: handle.run.id,
							agent: handle.run.agent,
							status: handle.run.status,
							finalOutput: "",
							usage: handle.run.usage,
						}]), chainStepCount: params.chain.length },
					};
				}

				const completed = await handle.completion;
				return {
					content: [{ type: "text", text: completed.finalOutput }],
					details: makeDetails("chain")(completed.results),
				};
			}

			if (mode === "single" && params.task) {
				const started = await subagentManager.startAgent(ctx, {
					task: params.task,
					agent: params.agent,
					agentScope,
					confirmProjectAgents,
					cwd: params.cwd,
					sourceRun,
					signal: params.wait ? signal : undefined,
					onUpdate: params.wait ? (onUpdate as OnUpdateCallback | undefined) : undefined,
				}, !params.wait);
				if (started.ok === false) return { content: [{ type: "text", text: started.message }], details: makeDetails("single")([]) };

				if (!params.wait) {
					const id = formatShortRunId(started.run.id);
					return {
						content: [{ type: "text", text: `Started ${started.run.agent} ${id} in background. Use subagent_control with runId ${id} to inspect or stop it.` }],
						details: makeDetailsFromParent("single")([{
							runId: started.run.id,
							agent: started.run.agent,
							status: started.run.status,
							finalOutput: "",
							usage: started.run.usage,
							model: started.run.model,
							continuedFromRunId: started.run.continuedFromRunId,
						}]),
					};
				}

				try {
					const result = await started.completion;
					return {
						content: [{ type: "text", text: isFailedResult(result) ? `Agent failed: ${getResultOutput(result)}` : getResultOutput(result) }],
						details: makeDetails("single")([result]),
					};
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					return { content: [{ type: "text", text: `Subagent failed: ${message}` }], details: makeDetails("single")([]) };
				}
			}

			const list = formatAgentList(agents);
			return {
				content: [{ type: "text", text: `Invalid parameters. Available agents:\n${list.text}${list.remaining ? `\n... and ${list.remaining} more` : ""}` }],
				details: makeDetails("single")([]),
			};
		},

		renderCall(args: SubagentParamsInput, theme, context: { expanded?: boolean }) {
			const callDisplay = getContinuationCallDisplay(args);
			const scopeSuffix = theme.fg("muted", ` [${callDisplay.agentScope}]`);

			if (!context?.expanded) {
				if (args.chain && args.chain.length > 0) {
					const firstStep = args.chain[0];
					return new Text(
						`${theme.fg("warning", "⏳")} ${theme.fg("accent", `chain (${args.chain.length} steps)`)}: ${theme.fg("dim", firstStep.agent)}${scopeSuffix}`,
						0,
						0,
					);
				}

				const agentName = callDisplay.agentName;
				const continuation = formatContinuedFrom(args.continueFrom);
				return new Text(
					`${theme.fg("warning", "⏳")} ${theme.fg("accent", agentName)}: ${theme.fg("dim", compactPreview(args.task, 72))}${continuation ? theme.fg("muted", ` ${continuation}`) : ""}${scopeSuffix}`,
					0,
					0,
				);
			}

			if (args.chain && args.chain.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `chain (${args.chain.length} steps)`) +
					theme.fg("muted", ` [${callDisplay.agentScope}]`);
				for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
					const step = args.chain[i];
					const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
					const preview = cleanTask.length > 48 ? `${cleanTask.slice(0, 48)}...` : cleanTask;
					text += `\n  ${theme.fg("muted", `${i + 1}.`)} ${theme.fg("accent", step.agent)}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}

			const agentName = callDisplay.agentName;
			const preview = args.task ? (args.task.length > 72 ? `${args.task.slice(0, 72)}...` : args.task) : "...";
			const continuation = formatContinuedFrom(args.continueFrom);
			return new Text(
				theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", agentName) +
					theme.fg("muted", ` [${callDisplay.agentScope}]`) +
					(continuation ? `\n  ${theme.fg("muted", continuation)}` : "") +
					`\n  ${theme.fg("dim", preview)}`,
				0,
				0,
			);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) {
				const first = result.content?.[0];
				const text = first?.type === "text" ? first.text : "(no output)";
				if (expanded) return new Text(text, 0, 0);
				const container = new Container();
				container.addChild(new Text(text, 0, 0));
				return container;
			}

			if (!expanded) return renderCompactResult(details, theme);

			const mdTheme = getMarkdownTheme();
			const container = new Container();
			const modeLabel = details.mode === "single" ? details.results[0]?.agent : details.mode;
			const running = details.results.filter((entry) => entry.status === "queued" || entry.status === "running").length;
			const failed = details.results.filter((entry) => entry.status === "failed" || entry.status === "aborted").length;
			const succeeded = details.results.filter((entry) => entry.status === "completed").length;
			const topIcon = running > 0 ? theme.fg("warning", "⏳") : failed > 0 ? theme.fg("warning", "◐") : theme.fg("success", "✓");
			const continuation = details.mode === "single" ? formatContinuedFrom(details.results[0]?.continuedFromRunId) : "";
			const topStatus =
				details.mode === "single"
					? `${modeLabel ?? "subagent"}${continuation ? ` (${continuation})` : ""}`
					: details.chainStepCount
						? `chain (${details.chainStepCount} steps) ${details.results[0]?.status ?? "running"}`
						: running > 0
							? `${succeeded + failed}/${details.results.length} done, ${running} running`
							: `${succeeded}/${details.results.length} succeeded`;

			container.addChild(
				new Text(
					`${topIcon} ${theme.fg("toolTitle", theme.bold(details.mode === "single" ? "subagent " : `${details.mode} `))}${theme.fg("accent", topStatus)}${theme.fg("muted", ` [${details.agentScope}]`)}`,
					0,
					0,
				),
			);

			for (const entry of details.results) {
				const icon = resultIcon(entry, theme);
				const continuedFrom = formatContinuedFrom(entry.continuedFromRunId);

				container.addChild(new Spacer(1));
				container.addChild(new Text(`${theme.fg("muted", "─── ")}${theme.fg("accent", entry.agent)} ${icon}${continuedFrom ? theme.fg("muted", ` (${continuedFrom})`) : ""}`, 0, 0));
				if (entry.runId) container.addChild(new Text(theme.fg("muted", `Run: ${formatShortRunId(entry.runId)} (${entry.runId})`), 0, 0));
				if (entry.sessionId) container.addChild(new Text(theme.fg("muted", `Session: ${entry.sessionId}`), 0, 0));
				if (entry.finalOutput) {
					container.addChild(new Spacer(1));
					container.addChild(new Markdown(entry.finalOutput.trim(), 0, 0, mdTheme));
				} else {
					container.addChild(new Text(theme.fg("muted", entry.status === "queued" || entry.status === "running" ? "(running...)" : "(no output)"), 0, 0));
				}
				const usage = formatUsageStats(entry.usage, entry.model);
				if (usage) container.addChild(new Text(theme.fg("dim", usage), 0, 0));
			}

			if (details.results.length > 1) {
				const usage = formatUsageStats(aggregateUsage(details.results));
				if (usage) {
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("dim", `Total: ${usage}`), 0, 0));
				}
			}

			if (!expanded) container.addChild(new Text(theme.fg("muted", "(Ctrl+O to expand)"), 0, 0));
			return container;
		},
	});

	pi.registerCommand("bg", {
		description: "Start a background subagent: /bg [agent] <prompt>",
		getArgumentCompletions: (prefix) => getAgentCommandCompletions(sessionCwd, prefix),
		handler: async (args, ctx) => {
			let text = args.trim();
			if (!text && ctx.hasUI) text = (await ctx.ui.input("Background agent", "Prompt"))?.trim() ?? "";
			if (!text) return ctx.ui.notify("Usage: /bg [agent] <prompt>", "warning");

			const discovery = discoverAgents(ctx.cwd, "user");
			const [firstWord, ...restWords] = text.split(/\s+/);
			const firstAgent = normalizeAgentRef(firstWord);
			const agent = firstAgent && restWords.length > 0 && discovery.agents.some((candidate) => candidate.name === firstAgent) ? firstAgent : undefined;
			const prompt = agent ? restWords.join(" ") : text;
			const result = await subagentManager.startAgent(ctx, { task: prompt, agent });
			if (result.ok === false) return ctx.ui.notify(result.message, "warning");

			ctx.ui.notify(`Started ${result.run.agent} ${formatShortRunId(result.run.id)} in background.`, "info");
		},
	});

	pi.registerCommand("subagents", {
		description: "List available subagents for this project",
		handler: async (args, ctx) => {
			const scopeArg = args.trim() as AgentScope | "";
			const scope: AgentScope = scopeArg === "project" || scopeArg === "both" || scopeArg === "user" ? scopeArg : "user";
			const discovery = discoverAgents(ctx.cwd, scope);
			const list = formatAgentList(discovery.agents, 100);
			ctx.ui.notify(`Subagents [${scope}]:\n${list.text}${list.remaining ? `\n... and ${list.remaining} more` : ""}`, "info");
		},
	});
}
