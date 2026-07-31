import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { formatShortRunId } from "./run-refs.ts";
import { subagentRunStore, type SubagentRunStore } from "./store.ts";
import type { SubagentRun } from "./types.ts";

export const SUBAGENT_WIDGET_KEY = "subagent-agents";
export const SUBAGENT_STATUS_KEY = "subagent-agents";

const CLOCK_INTERVAL_MS = 1_000;
const RENDER_THROTTLE_MS = 80;
export const MAX_VISIBLE_ACTIVE_RUNS = 6;

type AgentsWidgetTheme = ExtensionContext["ui"]["theme"];
type ActiveCountCallback = (count: number) => void;

export function isActiveRun(run: SubagentRun): boolean {
	return run.status === "queued" || run.status === "running";
}

export function getActiveRuns(runs: readonly SubagentRun[]): SubagentRun[] {
	return runs
		.filter(isActiveRun)
		.sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
}

export function formatActiveRunDuration(startedAt: number, now = Date.now()): string {
	const totalSeconds = Math.max(0, Math.floor((now - startedAt) / 1_000));
	const seconds = totalSeconds % 60;
	const minutes = Math.floor(totalSeconds / 60) % 60;
	const hours = Math.floor(totalSeconds / 3_600);
	if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
	return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function cleanInline(text: string | undefined): string {
	return (text ?? "")
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function shortenPath(value: string): string {
	const home = process.env.HOME ?? "";
	return home && value.startsWith(home) ? `~${value.slice(home.length)}` : value;
}

function toolDetail(run: SubagentRun): string | undefined {
	const args = run.currentToolArgs;
	if (!args) return undefined;
	for (const key of ["path", "file_path", "command", "pattern", "query"] as const) {
		const value = args[key];
		if (typeof value !== "string") continue;
		const cleaned = cleanInline(value);
		if (!cleaned) continue;
		return key === "path" || key === "file_path" ? shortenPath(cleaned) : cleaned;
	}
	return undefined;
}

export function formatActiveRunActivity(run: SubagentRun): string {
	if (run.currentTool) {
		const detail = toolDetail(run);
		return cleanInline(detail ? `${run.currentTool} ${detail}` : run.currentTool);
	}
	return cleanInline(run.liveMessage) || cleanInline(run.task) || "waiting";
}

export function renderAgentsWidget(
	runs: readonly SubagentRun[],
	theme: AgentsWidgetTheme,
	width: number,
	now = Date.now(),
): string[] {
	if (width < 1) return [];
	const active = getActiveRuns(runs);
	if (active.length === 0) return [];

	const lines = [
		truncateToWidth(
			`${theme.fg("accent", theme.bold("Agents"))} ${theme.fg("muted", `· ${active.length} active`)}`,
			width,
		),
	];

	for (const run of active.slice(0, MAX_VISIBLE_ACTIVE_RUNS)) {
		const indent = run.parentRunId ? "  ↳ " : "";
		const icon = run.status === "running" ? theme.fg("warning", "●") : theme.fg("dim", "○");
		const ref = theme.fg("accent", formatShortRunId(run.id));
		const agent = theme.fg("text", cleanInline(run.agent) || "agent");
		const status = theme.fg("muted", `${run.status} ${formatActiveRunDuration(run.startedAt, now)}`);
		const activity = theme.fg("dim", `· ${formatActiveRunActivity(run)}`);
		lines.push(truncateToWidth(`${indent}${icon} ${ref} ${agent}  ${status}  ${activity}`, width));
	}
	if (active.length > MAX_VISIBLE_ACTIVE_RUNS) {
		lines.push(truncateToWidth(theme.fg("muted", `… ${active.length - MAX_VISIBLE_ACTIVE_RUNS} more active`), width));
	}

	return lines;
}

/** Persistent above-editor widget scoped to one owning main Pi session. */
export class SubagentStatusWidget implements Component {
	private readonly activeRuns = new Map<string, SubagentRun>();
	private activeCount = 0;
	private disposed = false;
	private renderTimer?: ReturnType<typeof setTimeout>;
	private readonly tui: TUI;
	private readonly theme: AgentsWidgetTheme;
	private readonly ownerSessionId: string;
	private readonly onActiveCount?: ActiveCountCallback;
	private readonly clock: ReturnType<typeof setInterval>;
	private readonly unsubscribe: () => void;

	constructor(
		tui: TUI,
		theme: AgentsWidgetTheme,
		ownerSessionId: string,
		store: SubagentRunStore = subagentRunStore,
		onActiveCount?: ActiveCountCallback,
	) {
		this.tui = tui;
		this.theme = theme;
		this.ownerSessionId = ownerSessionId;
		this.onActiveCount = onActiveCount;
		for (const run of store.getSnapshot(ownerSessionId)) this.updateRun(run);
		this.syncActiveCount();
		// Incremental updates avoid cloning every historical run on each streamed token.
		this.unsubscribe = store.subscribeChanges((run) => {
			if (run.ownerSessionId !== this.ownerSessionId) return;
			this.updateRun(run);
			this.syncActiveCount();
			this.scheduleRender();
		});
		this.clock = setInterval(() => {
			if (this.activeCount > 0) this.scheduleRender();
		}, CLOCK_INTERVAL_MS);
		(this.clock as { unref?: () => void }).unref?.();
	}

	render(width: number): string[] {
		return renderAgentsWidget(Array.from(this.activeRuns.values()), this.theme, width);
	}

	invalidate(): void {
		this.onActiveCount?.(this.activeCount);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.unsubscribe();
		clearInterval(this.clock);
		if (this.renderTimer) clearTimeout(this.renderTimer);
		this.renderTimer = undefined;
	}

	private updateRun(run: SubagentRun): void {
		if (isActiveRun(run)) this.activeRuns.set(run.id, run);
		else this.activeRuns.delete(run.id);
	}

	private syncActiveCount(): void {
		const count = this.activeRuns.size;
		if (count === this.activeCount) return;
		this.activeCount = count;
		this.onActiveCount?.(count);
	}

	private scheduleRender(): void {
		if (this.disposed || this.renderTimer) return;
		this.renderTimer = setTimeout(() => {
			this.renderTimer = undefined;
			if (!this.disposed) this.tui.requestRender();
		}, RENDER_THROTTLE_MS);
		(this.renderTimer as { unref?: () => void }).unref?.();
	}
}
