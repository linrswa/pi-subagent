import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, type Component, type OverlayOptions, type TUI } from "@earendil-works/pi-tui";
import { readChildSessionMessages } from "./child-sessions.ts";
import { getFinalOutput } from "./results.ts";
import { findRunByRef, formatShortRunId } from "./run-refs.ts";
import { subagentRunStore } from "./store.ts";
import type { RunStatus, SubagentRun, TextContent, ToolCallContent, UsageStats } from "./types.ts";

type RunViewerTheme = ExtensionContext["ui"]["theme"];

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

function runStatusIcon(status: RunStatus, theme: RunViewerTheme): string {
	switch (status) {
		case "queued": return theme.fg("dim", "○");
		case "running": return theme.fg("warning", "●");
		case "completed": return theme.fg("success", "✓");
		case "failed": return theme.fg("error", "✗");
		case "aborted": return theme.fg("muted", "⊘");
	}
}

function taskPreview(text: string | undefined): string {
	const normalized = (text ?? "").replace(/\s+/g, " ").trim();
	return normalized || "...";
}

function capText(text: string, max = 12_000): string {
	return text.length > max ? `${text.slice(0, max)}\n...[truncated ${text.length - max} chars]` : text;
}

function compactPreview(text: string | undefined, maxLength: number): string {
	const normalized = (text ?? "").replace(/\s+/g, " ").trim();
	if (!normalized) return "...";
	return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized;
}

function formatParentRun(run: SubagentRun): string | undefined {
	return run.continuedFromRunId ? `continued from ${formatShortRunId(run.continuedFromRunId)} (${run.continuedFromRunId})` : undefined;
}

function formatRunList(runs: readonly SubagentRun[]): string {
	if (runs.length === 0) return "No subagents.";
	return runs
		.map((run) => {
			const output = run.finalOutput || getFinalOutput(run.messages) || run.errorMessage || "";
			const tool = run.currentTool ? `\n  current: ${run.currentTool}` : "";
			const preview = output ? `\n  output: ${compactPreview(output, 180)}` : "";
			const parent = formatParentRun(run);
			return `${formatShortRunId(run.id)} ${run.status} ${run.agent} (${formatRunTime(run)})\n  task: ${compactPreview(run.task, 180)}${parent ? `\n  ${parent}` : ""}${tool}${preview}`;
		})
		.join("\n\n");
}

function shortenPath(filePath: string): string {
	const home = process.env.HOME ?? "";
	return home && filePath.startsWith(home) ? `~${filePath.slice(home.length)}` : filePath;
}

function formatToolCall(toolName: string, args: Record<string, unknown>, theme: ExtensionContext["ui"]["theme"]): string {
	switch (toolName) {
		case "bash": {
			const command = typeof args.command === "string" ? args.command : "...";
			const preview = command.length > 72 ? `${command.slice(0, 72)}...` : command;
			return theme.fg("muted", "$ ") + theme.fg("toolOutput", preview);
		}
		case "read":
			return theme.fg("muted", "read ") + theme.fg("accent", shortenPath(String(args.path ?? args.file_path ?? "...")));
		default: {
			const argsText = JSON.stringify(args);
			const preview = argsText.length > 60 ? `${argsText.slice(0, 60)}...` : argsText;
			return theme.fg("accent", toolName) + theme.fg("dim", ` ${preview}`);
		}
	}
}

const SUBAGENT_VIEWER_OVERLAY_OPTIONS: OverlayOptions = { width: "75%", minWidth: 60, maxHeight: "90%" };

class SubagentRunViewerComponent implements Component {
	private run: SubagentRun | undefined;
	private scrollTop = 0;
	private followTail = true;
	private confirmStop = false;
	private lastBodyRows = 1;
	private lastBodyLineCount = 0;
	private persistedMessages: SubagentRun["messages"] | undefined;
	private loadedSessionFile: string | undefined;
	private readonly unsubscribe: () => void;
	private readonly tui: TUI;
	private readonly theme: RunViewerTheme;
	private readonly runId: string;
	private readonly ownerSessionId: string;
	private readonly done: () => void;
	private readonly stopRun: (runId: string) => void;

	constructor(tui: TUI, theme: RunViewerTheme, runId: string, ownerSessionId: string, done: () => void, stopRun: (runId: string) => void) {
		this.tui = tui;
		this.theme = theme;
		this.runId = runId;
		this.ownerSessionId = ownerSessionId;
		this.done = done;
		this.stopRun = stopRun;
		this.unsubscribe = subagentRunStore.subscribe((runs) => {
			this.run = runs.find((candidate) => candidate.id === runId && candidate.ownerSessionId === ownerSessionId);
			if (this.run && this.run.status !== "running" && this.run.status !== "queued" && this.run.sessionFile && this.loadedSessionFile !== this.run.sessionFile) {
				this.loadedSessionFile = this.run.sessionFile;
				void readChildSessionMessages(this.run.sessionFile, this.run.leafId)
					.then((messages) => {
						this.persistedMessages = messages;
						this.tui.requestRender();
					})
					.catch(() => {});
			}
			this.followTail ||= this.scrollTop >= this.maxScroll();
			this.tui.requestRender();
		}, ownerSessionId);
	}

	handleInput(data: string): void {
		if (matchesKey(data, "q") || matchesKey(data, "escape")) return this.done();
		if (matchesKey(data, "x")) {
			if (this.confirmStop && this.run) this.stopRun(this.run.id);
			this.confirmStop = !this.confirmStop;
			this.tui.requestRender();
			return;
		}
		this.confirmStop = false;
		if (matchesKey(data, "j") || matchesKey(data, "down")) return this.scroll(1);
		if (matchesKey(data, "k") || matchesKey(data, "up")) return this.scroll(-1);
		if (matchesKey(data, "pageDown")) return this.scroll(Math.max(1, this.lastBodyRows - 1));
		if (matchesKey(data, "pageUp")) return this.scroll(-Math.max(1, this.lastBodyRows - 1));
		if (matchesKey(data, "home")) return this.jumpTop();
		if (matchesKey(data, "end")) return this.jumpBottom();
	}

	render(width: number): string[] {
		const innerW = Math.max(1, width - 2);
		const maxRows = Math.max(10, Math.floor(this.tui.terminal.rows * 0.9));
		const lines = [this.border(`╭${"─".repeat(innerW)}╮`)];
		const run = this.run;
		if (!run) {
			lines.push(this.row(this.theme.fg("warning", `Subagent ${this.runId} was deleted`), innerW));
		} else {
			const usage = formatUsageStats(run.usage, run.model);
			lines.push(this.row(`${runStatusIcon(run.status, this.theme)} ${this.theme.fg("muted", `${formatShortRunId(run.id)} ${run.id}`)} ${this.theme.fg("accent", run.agent)} ${this.theme.fg("dim", run.status)} ${this.theme.fg("dim", formatRunTime(run))}`, innerW));
			lines.push(this.row(`${this.theme.fg("muted", "task: ")}${this.theme.fg("dim", taskPreview(run.task))}`, innerW));
			lines.push(this.row(`${this.theme.fg("muted", "session id: ")}${this.theme.fg("dim", run.sessionId ?? "(none)")}`, innerW));
			const parent = formatParentRun(run);
			if (parent) lines.push(this.row(`${this.theme.fg("muted", "parent run: ")}${this.theme.fg("dim", parent)}`, innerW));
			if (run.currentTool) lines.push(this.row(`${this.theme.fg("muted", "tool: ")}${this.theme.fg("toolOutput", run.currentTool)}`, innerW));
			if (usage) lines.push(this.row(`${this.theme.fg("muted", "usage: ")}${this.theme.fg("dim", usage)}`, innerW));
		}

		lines.push(this.border(`├${"─".repeat(innerW)}┤`));
		const body = this.bodyLines(run);
		const bodyRows = Math.max(1, maxRows - lines.length - 3);
		this.lastBodyRows = bodyRows;
		this.lastBodyLineCount = body.length;
		const maxScroll = Math.max(0, body.length - bodyRows);
		this.scrollTop = this.followTail ? maxScroll : Math.max(0, Math.min(maxScroll, this.scrollTop));
		for (const line of body.slice(this.scrollTop, this.scrollTop + bodyRows)) lines.push(this.row(line, innerW));
		while (lines.length < maxRows - 3) lines.push(this.row("", innerW));

		const end = Math.min(body.length, this.scrollTop + bodyRows);
		const position = body.length ? `${this.scrollTop + 1}-${end}/${body.length}` : "0/0";
		const footer = this.confirmStop
			? "press x again to stop run • q/Esc close"
			: `j/k/↑↓ scroll • PgUp/PgDn • Home/End • x x stop • q/Esc close • ${position}`;
		lines.push(this.border(`├${"─".repeat(innerW)}┤`));
		lines.push(this.row(this.theme.fg("dim", footer), innerW));
		lines.push(this.border(`╰${"─".repeat(innerW)}╯`));
		return lines;
	}

	invalidate(): void {}

	dispose(): void {
		this.unsubscribe();
	}

	private bodyLines(run: SubagentRun | undefined): string[] {
		if (!run) return [this.theme.fg("warning", `Subagent ${this.runId} was deleted`)];
		const lines: string[] = [];
		// Live runs use the in-memory store. Completed runs reload their active
		// branch from the child session, rather than relying on parent details.
		const messages = run.status === "running" || run.status === "queued" ? run.messages : (this.persistedMessages ?? run.messages);
		for (const message of messages) {
			const usage = message.usage
				? formatUsageStats(
					{
						input: message.usage.input ?? 0,
						output: message.usage.output ?? 0,
						cacheRead: message.usage.cacheRead ?? 0,
						cacheWrite: message.usage.cacheWrite ?? 0,
						cost: message.usage.cost?.total ?? 0,
						contextTokens: message.usage.totalTokens ?? 0,
						turns: 0,
					},
					message.model,
				)
				: "";
			lines.push(this.theme.fg("muted", `── ${message.role}${message.stopReason ? ` (${message.stopReason})` : ""}`));
			for (const part of message.content) {
				if (part.type === "text" && typeof (part as TextContent).text === "string") this.pushText(lines, (part as TextContent).text);
				else if (part.type === "toolCall") {
					const toolCall = part as ToolCallContent;
					lines.push(`${this.theme.fg("muted", "→ ")}${formatToolCall(toolCall.name, toolCall.arguments ?? {}, this.theme)}`);
				} else {
					lines.push(`${this.theme.fg("muted", `${part.type}: `)}${capText(JSON.stringify(part), 1000)}`);
				}
			}
			if (message.errorMessage) lines.push(this.theme.fg("error", `Error: ${message.errorMessage}`));
			if (usage) lines.push(this.theme.fg("dim", usage));
		}

		const finalOutput = run.finalOutput || getFinalOutput(messages);
		if (finalOutput) {
			lines.push("", this.theme.fg("muted", "── final output"));
			this.pushText(lines, finalOutput);
		}
		if (run.errorMessage) lines.push("", this.theme.fg("error", `Error: ${run.errorMessage}`));
		if (lines.length === 0) lines.push(this.theme.fg("muted", run.status === "running" || run.status === "queued" ? "(running...)" : "(no messages)"));
		return lines;
	}

	private pushText(lines: string[], text: string): void {
		for (const line of text.split("\n")) lines.push(line || " ");
	}

	private scroll(delta: number): void {
		this.followTail = false;
		this.scrollTop = Math.max(0, Math.min(this.maxScroll(), this.scrollTop + delta));
		if (this.scrollTop >= this.maxScroll()) this.followTail = true;
		this.tui.requestRender();
	}

	private jumpTop(): void {
		this.followTail = false;
		this.scrollTop = 0;
		this.tui.requestRender();
	}

	private jumpBottom(): void {
		this.followTail = true;
		this.scrollTop = this.maxScroll();
		this.tui.requestRender();
	}

	private maxScroll(): number {
		return Math.max(0, this.lastBodyLineCount - this.lastBodyRows);
	}

	private row(content: string, width: number): string {
		return `${this.border("│")}${truncateToWidth(content, width, "…", true)}${this.border("│")}`;
	}

	private border(text: string): string {
		return this.theme.fg("borderAccent", text);
	}
}

export function openSubagentRunViewer(ctx: ExtensionContext, runId: string, ownerSessionId = subagentRunStore.getActiveOwner()): void {
	if (ctx.mode !== "tui") {
		const run = findRunByRef(runId, subagentRunStore.getSnapshot(ownerSessionId));
		ctx.ui.notify(run ? formatRunList([run]) : `Unknown subagent run: ${runId}`, run ? "info" : "warning");
		return;
	}
	void ctx.ui
		.custom<void>(
			(tui, theme, _keybindings, done) =>
				new SubagentRunViewerComponent(tui, theme, runId, ownerSessionId, done, (targetRunId) => {
					if (!subagentRunStore.abort(targetRunId, ownerSessionId)) ctx.ui.notify(`${formatShortRunId(targetRunId)} is not running.`, "warning");
				}),
			{ overlay: true, overlayOptions: SUBAGENT_VIEWER_OVERLAY_OPTIONS },
		)
		.catch((error) => ctx.ui.notify(`Subagent view failed: ${error instanceof Error ? error.message : String(error)}`, "error"));
}

