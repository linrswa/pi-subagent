import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { formatShortRunId } from "./run-refs.ts";
import { subagentRunStore } from "./store.ts";
import type { RunStatus, SubagentRun } from "./types.ts";

type SubagentPanelTheme = ExtensionContext["ui"]["theme"];

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

function runStatusIcon(status: RunStatus, theme: SubagentPanelTheme): string {
	switch (status) {
		case "queued":
			return theme.fg("dim", "○");
		case "running":
			return theme.fg("warning", "●");
		case "completed":
			return theme.fg("success", "✓");
		case "failed":
			return theme.fg("error", "✗");
		case "aborted":
			return theme.fg("muted", "⊘");
	}
}

function splitPanelRow(left: string, right: string, width: number): string {
	const rightWidth = visibleWidth(right);
	if (rightWidth >= width) return truncateToWidth(right, width, "…", true);

	const leftWidth = Math.max(0, width - rightWidth - 1);
	const safeLeft = leftWidth > 0 ? truncateToWidth(left, leftWidth, "…") : "";
	const gap = " ".repeat(Math.max(1, width - visibleWidth(safeLeft) - rightWidth));
	return `${safeLeft}${gap}${right}`;
}

function panelTaskPreview(text: string | undefined): string {
	const normalized = (text ?? "").replace(/\s+/g, " ").trim();
	return normalized || "...";
}

const SUBAGENT_WIDGET_KEY = "subagent-runs";
const SUBAGENT_WIDGET_MAX_ROWS = 7;
const SUBAGENT_WIDGET_DONE_LINGER_MS = 20_000;
const SUBAGENT_WIDGET_ERROR_LINGER_MS = 45_000;
const SUBAGENT_WIDGET_SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function isWidgetVisibleRun(run: SubagentRun): boolean {
	if (run.status === "queued" || run.status === "running") return true;
	const endedAt = run.endedAt;
	if (!endedAt) return false;
	const linger = run.status === "completed" ? SUBAGENT_WIDGET_DONE_LINGER_MS : SUBAGENT_WIDGET_ERROR_LINGER_MS;
	return Date.now() - endedAt < linger;
}

function summarizeWidgetRuns(runs: readonly SubagentRun[]): string | undefined {
	const active = runs.filter((run) => run.status === "queued" || run.status === "running");
	if (active.length === 0) return undefined;
	const running = active.filter((run) => run.status === "running").length;
	const queued = active.length - running;
	const parts: string[] = [];
	if (running > 0) parts.push(`${running} running`);
	if (queued > 0) parts.push(`${queued} queued`);
	return `subagents: ${parts.join(", ")}`;
}

class SubagentWidgetComponent implements Component {
	constructor(
		private readonly getRuns: () => SubagentRun[],
		private readonly getFrame: () => number,
		private readonly theme: SubagentPanelTheme,
	) {}

	render(width: number): string[] {
		const runs = this.getRuns().filter(isWidgetVisibleRun);
		if (runs.length === 0) return [];

		const active = runs.some((run) => run.status === "queued" || run.status === "running");
		const titleIcon = active ? this.theme.fg("accent", "●") : this.theme.fg("dim", "○");
		const lines = [truncateToWidth(`${titleIcon} ${this.theme.fg(active ? "accent" : "dim", "Subagents")}`, width, "…", true)];
		const visibleRuns = runs.slice(0, SUBAGENT_WIDGET_MAX_ROWS - 1);

		for (let i = 0; i < visibleRuns.length; i++) {
			const run = visibleRuns[i];
			const connector = i === visibleRuns.length - 1 && runs.length === visibleRuns.length ? "└─" : "├─";
			lines.push(truncateToWidth(`${this.theme.fg("dim", connector)} ${this.renderRun(run, Math.max(1, width - 3))}`, width, "…", true));
		}

		if (runs.length > visibleRuns.length) {
			lines.push(truncateToWidth(`${this.theme.fg("dim", "└─")} ${this.theme.fg("dim", `+${runs.length - visibleRuns.length} more`)}`, width, "…", true));
		}

		return lines;
	}

	invalidate(): void {}

	private renderRun(run: SubagentRun, width: number): string {
		const icon = run.status === "running"
			? this.theme.fg("warning", SUBAGENT_WIDGET_SPINNER[this.getFrame() % SUBAGENT_WIDGET_SPINNER.length] ?? "⠋")
			: runStatusIcon(run.status, this.theme);
		const tool = run.currentTool ? ` ${this.theme.fg("muted", "→")} ${this.theme.fg("toolOutput", run.currentTool)}` : "";
		const left = `${icon} ${this.theme.fg("muted", formatShortRunId(run.id))} ${this.theme.fg("accent", run.agent)} ${this.theme.fg("dim", panelTaskPreview(run.task))}${tool}`;
		return splitPanelRow(left, this.theme.fg("dim", formatRunTime(run)), width);
	}
}

export class SubagentWidgetController {
	private ctx: ExtensionContext | null = null;
	private runs: SubagentRun[] = [];
	private unsubscribe: (() => void) | null = null;
	private timer: ReturnType<typeof setInterval> | null = null;
	private tui: TUI | null = null;
	private registered = false;
	private frame = 0;
	private lastStatus: string | undefined;

	start(ctx: ExtensionContext): void {
		if (ctx.mode !== "tui") return;
		this.stop();
		this.ctx = ctx;
		this.unsubscribe = subagentRunStore.subscribe((runs) => {
			this.runs = [...runs];
			this.update();
		});
	}

	stop(): void {
		this.unsubscribe?.();
		this.unsubscribe = null;
		this.stopTimer();
		if (this.ctx?.mode === "tui") {
			this.ctx.ui.setWidget(SUBAGENT_WIDGET_KEY, undefined);
			this.ctx.ui.setStatus("subagents", undefined);
		}
		this.ctx = null;
		this.tui = null;
		this.registered = false;
		this.lastStatus = undefined;
	}

	private update(): void {
		const ctx = this.ctx;
		if (!ctx) return;

		const visibleRuns = this.runs.filter(isWidgetVisibleRun);
		if (visibleRuns.length === 0) {
			if (this.registered) ctx.ui.setWidget(SUBAGENT_WIDGET_KEY, undefined);
			this.registered = false;
			this.tui = null;
			this.stopTimer();
			this.setStatus(undefined);
			return;
		}

		this.ensureTimer();
		this.setStatus(summarizeWidgetRuns(this.runs));
		if (!this.registered) {
			ctx.ui.setWidget(
				SUBAGENT_WIDGET_KEY,
				(tui, theme) => {
					this.tui = tui;
					return new SubagentWidgetComponent(() => this.runs, () => this.frame, theme);
				},
				{ placement: "aboveEditor" },
			);
			this.registered = true;
		} else {
			this.tui?.requestRender();
		}
	}

	private setStatus(text: string | undefined): void {
		if (text === this.lastStatus) return;
		this.ctx?.ui.setStatus("subagents", text);
		this.lastStatus = text;
	}

	private ensureTimer(): void {
		if (this.timer) return;
		this.timer = setInterval(() => {
			this.frame++;
			this.update();
		}, 250);
	}

	private stopTimer(): void {
		if (!this.timer) return;
		clearInterval(this.timer);
		this.timer = null;
	}
}

