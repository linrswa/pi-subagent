/**
 * Subagent Tool - delegate tasks to specialized pi agents with isolated context.
 *
 * Each invocation spawns one or more separate persisted `pi --mode json -p`
 * sessions. This keeps child context windows isolated while streaming progress
 * back into the parent tool result.
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
import {
	COLLAPSED_ITEM_COUNT,
	MAX_CONCURRENCY,
	MAX_PARALLEL_TASKS,
} from "./constants.ts";
import { getFinalOutput, getResultOutput, isFailedResult, truncateForParent } from "./results.ts";
import {
	SubagentManager,
	buildRunRefContext,
	formatRunDetails,
	createRunRefAutocompleteProvider,
	getBgAgentCompletions,
	getMainSessionOwnerId,
	getMode,
	getContinuationCallDisplay,
	getRunRefCompletions,
	normalizeAgentRef,
} from "./manager.ts";
import { formatShortRunId } from "./run-refs.ts";
import { runSingleAgent, mapWithConcurrencyLimit } from "./runner.ts";
import {
	SubagentSchedulerController,
	formatRelativeTime,
	formatScheduleId,
	formatScheduleList,
} from "./scheduler.ts";
import { makeEmptyUsage } from "./store.ts";
import { SubagentSettingsComponent } from "./settings-ui.ts";
import { openSubagentRunViewer } from "./viewer.ts";
import {
	BgAgentParamsSchema,
	SubagentControlParamsSchema,
	SubagentParamsSchema,
	SubagentScheduleParamsSchema,
} from "./schemas.ts";
import type {
	AgentMessage,
	BgAgentParamsInput,
	DisplayItem,
	OnUpdateCallback,
	SingleResult,
	SubagentControlParamsInput,
	SubagentDetails,
	SubagentMode,
	SubagentParamsInput,
	SubagentRun,
	SubagentScheduleParamsInput,
	TextContent,
	ToolCallContent,
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

function formatToolCall(toolName: string, args: Record<string, unknown>, theme: ExtensionContext["ui"]["theme"]): string {
	switch (toolName) {
		case "bash": {
			const command = typeof args.command === "string" ? args.command : "...";
			const preview = command.length > 72 ? `${command.slice(0, 72)}...` : command;
			return theme.fg("muted", "$ ") + theme.fg("toolOutput", preview);
		}
		case "read": {
			const rawPath = String(args.path ?? args.file_path ?? "...");
			const offset = typeof args.offset === "number" ? args.offset : undefined;
			const limit = typeof args.limit === "number" ? args.limit : undefined;
			let text = theme.fg("accent", shortenPath(rawPath));
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += theme.fg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return theme.fg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = String(args.path ?? args.file_path ?? "...");
			const content = typeof args.content === "string" ? args.content : "";
			const lines = content ? content.split("\n").length : 0;
			return theme.fg("muted", "write ") + theme.fg("accent", shortenPath(rawPath)) + (lines ? theme.fg("dim", ` (${lines} lines)`) : "");
		}
		case "edit":
			return theme.fg("muted", "edit ") + theme.fg("accent", shortenPath(String(args.path ?? args.file_path ?? "...")));
		case "ls":
			return theme.fg("muted", "ls ") + theme.fg("accent", shortenPath(String(args.path ?? ".")));
		case "find":
			return (
				theme.fg("muted", "find ") +
				theme.fg("accent", String(args.pattern ?? "*")) +
				theme.fg("dim", ` in ${shortenPath(String(args.path ?? "."))}`)
			);
		case "grep":
			return (
				theme.fg("muted", "grep ") +
				theme.fg("accent", `/${String(args.pattern ?? "")}/`) +
				theme.fg("dim", ` in ${shortenPath(String(args.path ?? "."))}`)
			);
		default: {
			const argsText = JSON.stringify(args);
			const preview = argsText.length > 60 ? `${argsText.slice(0, 60)}...` : argsText;
			return theme.fg("accent", toolName) + theme.fg("dim", ` ${preview}`);
		}
	}
}

function getDisplayItems(messages: AgentMessage[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const part of message.content) {
			if (part.type === "text" && typeof (part as TextContent).text === "string") {
				const text = (part as TextContent).text.trim();
				if (text) items.push({ type: "text", text });
			} else if (part.type === "toolCall") {
				const toolCall = part as ToolCallContent;
				items.push({ type: "toolCall", name: toolCall.name, args: toolCall.arguments ?? {} });
			}
		}
	}
	return items;
}

function aggregateUsage(results: SingleResult[]): Omit<UsageStats, "contextTokens"> {
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

function renderDisplayItems(
	items: DisplayItem[],
	limit: number | undefined,
	expanded: boolean,
	theme: ExtensionContext["ui"]["theme"],
): string {
	const toShow = limit ? items.slice(-limit) : items;
	const skipped = limit && items.length > limit ? items.length - limit : 0;
	let text = skipped > 0 ? theme.fg("muted", `... ${skipped} earlier items\n`) : "";
	for (const item of toShow) {
		if (item.type === "toolCall") {
			text += `${theme.fg("muted", "→ ")}${formatToolCall(item.name, item.args, theme)}\n`;
		} else {
			const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
			text += `${theme.fg("toolOutput", preview)}\n`;
		}
	}
	return text.trimEnd();
}

function resultIcon(result: SingleResult, theme: ExtensionContext["ui"]["theme"]): string {
	if (result.exitCode === -1) return theme.fg("warning", "⏳");
	return isFailedResult(result) ? theme.fg("error", "✗") : theme.fg("success", "✓");
}

function compactPreview(text: string | undefined, maxLength: number): string {
	const normalized = (text ?? "").replace(/\s+/g, " ").trim();
	if (!normalized) return "...";
	return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized;
}

function formatContinuedFrom(runId: string | undefined): string {
	return runId ? `continued from ${formatShortRunId(runId)}` : "";
}

function resultStatusLabel(result: SingleResult): "running" | "completed" | "failed" | "aborted" {
	if (result.exitCode === -1) return "running";
	if (result.stopReason === "aborted") return "aborted";
	return isFailedResult(result) ? "failed" : "completed";
}

function renderCompactResult(details: SubagentDetails, theme: ExtensionContext["ui"]["theme"]): Container {
	const container = new Container();
	const running = details.results.filter((entry) => entry.exitCode === -1).length;
	const failed = details.results.filter((entry) => entry.exitCode !== -1 && isFailedResult(entry)).length;
	const succeeded = details.results.filter((entry) => entry.exitCode !== -1 && !isFailedResult(entry)).length;
	const topIcon = running > 0 ? theme.fg("warning", "⏳") : failed > 0 ? theme.fg("warning", "◐") : theme.fg("success", "✓");
	const scope = theme.fg("muted", ` [${details.agentScope}]`);
	let line: string;

	if (details.mode === "single") {
		const entry = details.results[0];
		const continuation = formatContinuedFrom(entry.continuedFromRunId);
		line = `${resultIcon(entry, theme)} ${theme.fg("accent", entry.agent)} ${theme.fg("muted", resultStatusLabel(entry))}: ${theme.fg("dim", compactPreview(entry.task, 72))}${continuation ? theme.fg("muted", ` ${continuation}`) : ""}${scope}`;
	} else if (details.mode === "parallel") {
		const done = succeeded + failed;
		const summary = running > 0 ? `${running} running, ${done} done` : `${succeeded}/${details.results.length} succeeded${failed ? `, ${failed} failed` : ""}`;
		line = `${topIcon} ${theme.fg("accent", "subagents")}: ${theme.fg("dim", summary)}${scope}`;
	} else {
		const runningIndex = details.results.findIndex((entry) => entry.exitCode === -1);
		const failedIndex = details.results.findIndex((entry) => entry.exitCode !== -1 && isFailedResult(entry));
		const activeIndex = runningIndex !== -1 ? runningIndex : failedIndex !== -1 ? failedIndex : details.results.length - 1;
		const entry = details.results[activeIndex];
		const step = entry.step ?? activeIndex + 1;
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
			return `${formatShortRunId(run.id)} ${run.status} ${run.agent} (${formatRunTime(run)})\n  task: ${compactPreview(run.task, 180)}${parent}${tool}${preview}`;
		})
		.join("\n\n");
}


const subagentSchedulerController = new SubagentSchedulerController();

export default function (pi: ExtensionAPI) {
	let sessionCwd = process.cwd();
	const subagentManager = new SubagentManager(pi);

	pi.on("session_start", (_event, ctx) => {
		sessionCwd = ctx.cwd;
		void subagentSchedulerController.start(subagentManager, ctx);
		if (ctx.mode === "tui") ctx.ui.addAutocompleteProvider((current) => createRunRefAutocompleteProvider(current));
	});

	pi.on("input", (event) => {
		if (event.source === "extension" || event.text.trimStart().startsWith("/")) return { action: "continue" };
		const context = buildRunRefContext(event.text);
		if (!context) return { action: "continue" };
		return { action: "transform", text: `${event.text}\n\n${context}` };
	});

	pi.on("session_shutdown", () => {
		subagentSchedulerController.stop();
	});

	pi.registerCommand("subagent-view", {
		description: "Open a live subagent run viewer: /subagent-view <runId>",
		getArgumentCompletions: (prefix) => getRunRefCompletions(prefix.replace(/^[&＆]/, "")),
		handler: async (args, ctx) => {
			const run = subagentManager.findRun(args.trim());
			if (!run) return ctx.ui.notify(`Unknown subagent run: ${args.trim() || "(missing)"}`, "warning");
			openSubagentRunViewer(ctx, run.id);
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
		description: "Inspect and control existing subagent runs: list, status, stop, or delete.",
		promptSnippet: "Use subagent_control to list/status subagent runs, stop runs, or delete runs. Use subagent continueFrom for follow-up work.",
		promptGuidelines: [
			"Use action=list before referring to subagents if the run id is unclear.",
			"runId accepts subagent-3, &3, or 3 and is required for status, stop, and delete.",
			"Use subagent with continueFrom and task to continue a completed run; control actions never start agents.",
		],
		parameters: SubagentControlParamsSchema as never,

		async execute(_toolCallId, rawParams, _signal, _onUpdate, _ctx) {
			const params = rawParams as SubagentControlParamsInput;
			const action = params.action ?? "list";
			if (!["list", "status", "stop", "delete"].includes(action)) {
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

			if (action === "stop") {
				const stopped = subagentManager.stopRun(run.id);
				return { content: [{ type: "text", text: stopped ? `Stopping ${formatShortRunId(run.id)}.` : `${formatShortRunId(run.id)} is not running.` }], details: { action, runId: run.id } };
			}

			subagentManager.deleteRun(run.id);
			return { content: [{ type: "text", text: `Deleted ${formatShortRunId(run.id)}.` }], details: { action, runId: run.id } };
		},

		renderCall(args: SubagentControlParamsInput, theme) {
			const action = args.action ?? "list";
			const target = args.runId ? ` ${args.runId}` : "";
			return new Text(`${theme.fg("toolTitle", theme.bold("subagent_control "))}${theme.fg("accent", action)}${theme.fg("dim", target)}`, 0, 0);
		},

		renderResult(result, _options, theme) {
			const first = result.content?.[0];
			const text = first?.type === "text" ? first.text : "(no output)";
			return new Text(theme.fg("toolOutput", text), 0, 0);
		},
	});

	pi.registerTool({
		name: "bg_agent",
		label: "Background Agent",
		description: "Start a subagent in the background and return immediately with a run id.",
		promptSnippet: "Start a background subagent for work that should not block the main agent; returns a run id for subagent_control.",
		promptGuidelines: [
			"Use bg_agent when the user asks to run work in the background or when the main answer does not need the result before continuing.",
			"Use subagent instead of bg_agent when the main agent must wait for the subagent result.",
			"After bg_agent starts a run, use subagent_control list/status/stop/delete to inspect or control it, or subagent continueFrom for follow-up work.",
		],
		parameters: BgAgentParamsSchema as never,

		async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
			const result = await subagentManager.startBackground(ctx, rawParams as BgAgentParamsInput);
			if (result.ok === false) return { content: [{ type: "text", text: result.message }], details: { ok: false } };
			const id = formatShortRunId(result.run.id);
			return {
				content: [{ type: "text", text: `Started ${result.run.agent} ${id} in background. Use subagent_control with runId ${id} to inspect it.` }],
				details: { ok: true, runId: result.run.id, agent: result.run.agent, agentScope: result.agentScope },
			};
		},

		renderCall(args: BgAgentParamsInput, theme) {
			const agentName = args.agent || "explorer";
			return new Text(
				`${theme.fg("warning", "⏳")} ${theme.fg("toolTitle", theme.bold("bg_agent "))}${theme.fg("accent", agentName)}: ${theme.fg("dim", compactPreview(args.prompt, 72))}`,
				0,
				0,
			);
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
			"Scheduled runs use bg_agent/startBackgroundAgent with confirmProjectAgents=false.",
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
			"Delegate tasks to specialized subagents with isolated context windows.",
			"Modes: single (agent + task), continuation (continueFrom + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
			'Default agent scope is "user" (bundled agents + ~/.pi/agent/agents).',
			'To enable repo-local .pi/agents, set agentScope: "both" or "project".',
		].join(" "),
		promptSnippet: "Delegate focused work to specialized subagents with isolated context; supports single, continuation from a completed run, parallel, and chained tasks.",
		promptGuidelines: [
			"Use subagent for focused codebase reconnaissance, implementation planning, or independent code review when isolation helps.",
			"Use subagent parallel mode for read-only research/review tasks; avoid parallel subagents that edit the same files.",
			"Use subagent chain mode with {previous} to pass explorer findings to planner or reviewer output to worker.",
			"Continue a completed run with {continueFrom: \"&1\", task: \"...\"}; omit agent to reuse it, or provide agent to switch. Continuations retain the source cwd.",
		],
		parameters: SubagentParamsSchema as never,

		async execute(_toolCallId, rawParams, signal, onUpdate, ctx) {
			const params = rawParams as SubagentParamsInput;
			const mode = getMode(params);
			const sourceRun = params.continueFrom ? subagentManager.findRun(params.continueFrom) : undefined;

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

			const makeDetails =
				(selectedMode: SubagentMode) =>
				(results: SingleResult[]): SubagentDetails => ({
					mode: selectedMode,
					agentScope,
					packageAgentsDir: discovery.packageAgentsDir,
					userAgentsDir: discovery.userAgentsDir,
					projectAgentsDir: discovery.projectAgentsDir,
					results,
				});

			if (!mode) {
				const list = formatAgentList(agents);
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. Provide exactly one mode: {agent, task}, {continueFrom, task}, {tasks}, or {chain}.\n\nAvailable agents:\n${list.text}${list.remaining ? `\n... and ${list.remaining} more` : ""}`,
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

			if ((agentScope === "project" || agentScope === "both") && confirmProjectAgents && ctx.hasUI) {
				const requestedAgentNames = new Set<string>();
				if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
				if (params.tasks) for (const task of params.tasks) requestedAgentNames.add(task.agent);
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
				const results: SingleResult[] = [];
				let previousOutput = "";

				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);
					const chainUpdate: OnUpdateCallback | undefined = onUpdate
						? (partial) => {
								const currentResult = partial.details?.results[0];
								if (!currentResult) return;
								onUpdate({ content: partial.content, details: makeDetails("chain")([...results, currentResult]) });
							}
						: undefined;

					const result = await runSingleAgent({
						mode: "chain",
						defaultCwd: ctx.cwd,
						agents,
						agentName: step.agent,
						fallbackModel,
						fallbackThinkingLevel,
						task: taskWithContext,
						cwd: step.cwd,
						step: i + 1,
						agentScope,
						ownerSessionId: getMainSessionOwnerId(ctx),
						signal,
						onUpdate: chainUpdate,
						makeDetails: makeDetails("chain"),
					});
					results.push(result);

					if (isFailedResult(result)) {
						return {
							content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${getResultOutput(result)}` }],
							details: makeDetails("chain")(results),
						};
					}

					previousOutput = getFinalOutput(result.messages);
				}

				return {
					content: [{ type: "text", text: getFinalOutput(results[results.length - 1].messages) || "(no output)" }],
					details: makeDetails("chain")(results),
				};
			}

			if (mode === "parallel" && params.tasks) {
				if (params.tasks.length > MAX_PARALLEL_TASKS) {
					return {
						content: [{ type: "text", text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.` }],
						details: makeDetails("parallel")([]),
					};
				}

				const allResults: SingleResult[] = params.tasks.map((task) => ({
					agent: task.agent,
					agentSource: "unknown",
					task: task.task,
					exitCode: -1,
					messages: [],
					stderr: "",
					usage: makeEmptyUsage(),
				}));

				const emitParallelUpdate = () => {
					const running = allResults.filter((result) => result.exitCode === -1).length;
					const done = allResults.length - running;
					onUpdate?.({
						content: [{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` }],
						details: makeDetails("parallel")([...allResults]),
					});
				};

				const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (task, index) => {
					const result = await runSingleAgent({
						mode: "parallel",
						defaultCwd: ctx.cwd,
						agents,
						agentName: task.agent,
						fallbackModel,
						fallbackThinkingLevel,
						task: task.task,
						cwd: task.cwd,
						agentScope,
						ownerSessionId: getMainSessionOwnerId(ctx),
						signal,
						onUpdate: (partial) => {
							if (partial.details?.results[0]) {
								allResults[index] = partial.details.results[0];
								emitParallelUpdate();
							}
						},
						makeDetails: makeDetails("parallel"),
					});
					allResults[index] = result;
					emitParallelUpdate();
					return result;
				});

				const successCount = results.filter((result) => !isFailedResult(result)).length;
				const summaries = results.map((result) => {
					const status = isFailedResult(result)
						? `failed${result.stopReason && result.stopReason !== "end" ? ` (${result.stopReason})` : ""}`
						: "completed";
					return `### [${result.agent}] ${status}\n\n${truncateForParent(getResultOutput(result))}`;
				});

				return {
					content: [{ type: "text", text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}` }],
					details: makeDetails("parallel")(results),
				};
			}

			if (mode === "single" && params.task && (params.agent || sourceRun)) {
				try {
					const result = await runSingleAgent({
						mode: "single",
						defaultCwd: ctx.cwd,
						agents,
						agentName: params.agent ?? sourceRun!.agent,
						fallbackModel,
						fallbackThinkingLevel,
						task: params.task,
						cwd: sourceRun?.cwd ?? params.cwd,
						agentScope,
						ownerSessionId: getMainSessionOwnerId(ctx),
						continueFrom: sourceRun ? { runId: sourceRun.id, sessionFile: sourceRun.sessionFile!, leafId: sourceRun.leafId! } : undefined,
						signal,
						onUpdate: onUpdate as OnUpdateCallback | undefined,
						makeDetails: makeDetails("single"),
					});

					return {
						content: [{ type: "text", text: isFailedResult(result) ? `Agent failed: ${getResultOutput(result)}` : getResultOutput(result) }],
						details: makeDetails("single")([result]),
					};
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					return { content: [{ type: "text", text: `Cannot continue ${sourceRun ? formatShortRunId(sourceRun.id) : "subagent"}: ${message}` }], details: makeDetails("single")([]) };
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

				if (args.tasks && args.tasks.length > 0) {
					return new Text(
						`${theme.fg("warning", "⏳")} ${theme.fg("accent", "subagents")}: ${theme.fg("dim", `${args.tasks.length} tasks`)}${scopeSuffix}`,
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

			if (args.tasks && args.tasks.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
					theme.fg("muted", ` [${callDisplay.agentScope}]`);
				for (const task of args.tasks.slice(0, 3)) {
					const preview = task.task.length > 48 ? `${task.task.slice(0, 48)}...` : task.task;
					text += `\n  ${theme.fg("accent", task.agent)}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
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
			const running = details.results.filter((entry) => entry.exitCode === -1).length;
			const failed = details.results.filter((entry) => entry.exitCode !== -1 && isFailedResult(entry)).length;
			const succeeded = details.results.filter((entry) => entry.exitCode !== -1 && !isFailedResult(entry)).length;
			const topIcon = running > 0 ? theme.fg("warning", "⏳") : failed > 0 ? theme.fg("warning", "◐") : theme.fg("success", "✓");
			const continuation = details.mode === "single" ? formatContinuedFrom(details.results[0]?.continuedFromRunId) : "";
			const topStatus =
				details.mode === "single"
					? `${modeLabel ?? "subagent"}${continuation ? ` (${continuation})` : ""}`
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
				const source = entry.agentSource !== "unknown" ? theme.fg("muted", ` (${entry.agentSource})`) : "";
				const label = entry.step ? `Step ${entry.step}: ${entry.agent}` : entry.agent;
				const continuedFrom = formatContinuedFrom(entry.continuedFromRunId);
				const displayItems = getDisplayItems(entry.messages);
				const finalOutput = getFinalOutput(entry.messages);

				container.addChild(new Spacer(1));
				container.addChild(new Text(`${theme.fg("muted", "─── ")}${theme.fg("accent", label)}${source} ${icon}${continuedFrom ? theme.fg("muted", ` (${continuedFrom})`) : ""}`, 0, 0));
				if (expanded) {
					container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", entry.task), 0, 0));
				}

				if (displayItems.length === 0) {
					container.addChild(new Text(theme.fg("muted", entry.exitCode === -1 ? "(running...)" : "(no output)"), 0, 0));
				} else if (expanded) {
					for (const item of displayItems) {
						if (item.type === "toolCall") {
							container.addChild(new Text(`${theme.fg("muted", "→ ")}${formatToolCall(item.name, item.args, theme)}`, 0, 0));
						}
					}
					if (finalOutput) {
						container.addChild(new Spacer(1));
						container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
					}
				} else {
					container.addChild(new Text(renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT, false, theme), 0, 0));
				}

				if (entry.errorMessage) container.addChild(new Text(theme.fg("error", `Error: ${entry.errorMessage}`), 0, 0));
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
		getArgumentCompletions: (prefix) => getBgAgentCompletions(sessionCwd, prefix),
		handler: async (args, ctx) => {
			let text = args.trim();
			if (!text && ctx.hasUI) text = (await ctx.ui.input("Background agent", "Prompt"))?.trim() ?? "";
			if (!text) return ctx.ui.notify("Usage: /bg [agent] <prompt>", "warning");

			const discovery = discoverAgents(ctx.cwd, "user");
			const [firstWord, ...restWords] = text.split(/\s+/);
			const firstAgent = normalizeAgentRef(firstWord);
			const agent = firstAgent && restWords.length > 0 && discovery.agents.some((candidate) => candidate.name === firstAgent) ? firstAgent : undefined;
			const prompt = agent ? restWords.join(" ") : text;
			const result = await subagentManager.startBackground(ctx, { prompt, agent });
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
