import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, type Component, type OverlayHandle, type OverlayOptions, type TUI } from "@earendil-works/pi-tui";
import { findRunByRef, formatShortRunId } from "./run-refs.ts";
import { subagentRunStore } from "./store.ts";
import type { RunStatus, SubagentRun } from "./types.ts";
import { openSubagentRunViewer } from "./viewer.ts";

type SubagentPanelTheme = ExtensionContext["ui"]["theme"];

// ponytail: overlay render gets width only; maxHeight slices this into a tmux-like full-height column.
const SUBAGENT_PANEL_FILL_ROWS = 500;

const SUBAGENT_PANEL_OVERLAY_OPTIONS: OverlayOptions = {
	anchor: "top-right",
	width: "25%",
	minWidth: 32,
	maxHeight: "100%",
	visible: (termWidth) => termWidth >= 100,
	nonCapturing: true,
};

function resolveSubagentPanelWidth(termWidth: number): number {
	const rawWidth = SUBAGENT_PANEL_OVERLAY_OPTIONS.width;
	const percent = typeof rawWidth === "string" ? rawWidth.match(/^(\d+(?:\.\d+)?)%$/)?.[1] : undefined;
	let width = typeof rawWidth === "number" ? rawWidth : Math.floor((termWidth * Number(percent ?? 25)) / 100);
	width = Math.max(width, SUBAGENT_PANEL_OVERLAY_OPTIONS.minWidth ?? 1);
	return Math.max(1, Math.min(width, termWidth - 1));
}

const SUBAGENT_PANEL_SHORTCUTS = ["ctrl+0", "ctrl+="] as const;
const SUBAGENT_PANEL_COMMAND = "subagent-panel";
const SUBAGENT_PANEL_SHORTCUT_LABEL = `Ctrl+0/Ctrl+= or /${SUBAGENT_PANEL_COMMAND}`;

function matchesSubagentPanelShortcut(data: string): boolean {
	return SUBAGENT_PANEL_SHORTCUTS.some((shortcut) => matchesKey(data, shortcut));
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

function runStatusIcon(status: RunStatus, theme: SubagentPanelTheme): string {
	switch (status) {
		case "queued": return theme.fg("dim", "○");
		case "running": return theme.fg("warning", "●");
		case "completed": return theme.fg("success", "✓");
		case "failed": return theme.fg("error", "✗");
		case "aborted": return theme.fg("muted", "⊘");
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

class SubagentPanelComponent implements Component {
	focused = false;

	private runs: SubagentRun[] = [];
	private selectedIndex = 0;
	private handle: OverlayHandle | null = null;
	private disposed = false;
	private readonly unsubscribe: () => void;

	constructor(
		private readonly tui: TUI,
		private readonly theme: SubagentPanelTheme,
		private readonly releaseFocus: () => void,
		private readonly attachRun: (runId: string) => void,
		private readonly deleteRun: (runId: string) => void,
		private readonly stopRun: (runId: string) => void,
	) {
		this.unsubscribe = subagentRunStore.subscribe((runs) => {
			this.runs = [...runs];
			this.clampSelection();
			this.invalidate();
			if (!this.disposed) this.tui.requestRender();
		});
	}

	setHandle(handle: OverlayHandle): void {
		this.handle = handle;
	}

	requestRender(): void {
		if (!this.disposed) this.tui.requestRender();
	}

	handleInput(data: string): void {
		if (matchesKey(data, "j") || matchesKey(data, "down")) {
			this.moveSelection(1);
			return;
		}

		if (matchesKey(data, "k") || matchesKey(data, "up")) {
			this.moveSelection(-1);
			return;
		}

		const run = this.selectedRun();
		if ((matchesKey(data, "space") || matchesKey(data, "enter") || matchesKey(data, "o")) && run) return this.attachRun(run.id);
		if (matchesKey(data, "d") && run) return this.deleteRun(run.id);
		if (matchesKey(data, "s") && run) return this.stopRun(run.id);

		if (matchesKey(data, "q") || matchesKey(data, "escape") || matchesSubagentPanelShortcut(data)) {
			this.releaseFocus();
		}
	}

	render(width: number): string[] {
		const innerW = Math.max(1, width - 2);
		const lines: string[] = [];

		lines.push(this.topBorder(innerW));
		if (this.runs.length === 0) {
			lines.push(this.row(this.theme.fg("dim", "No subagents yet"), innerW));
			lines.push(this.row("", innerW));
		} else {
			for (let i = 0; i < this.runs.length; i++) {
				const run = this.runs[i];
				const isSelected = i === this.selectedIndex;
				lines.push(this.runHeaderRow(run, innerW, isSelected));
				lines.push(this.row(`  ${this.theme.fg("dim", panelTaskPreview(run.task))}`, innerW, isSelected));
				if (run.currentTool) {
					lines.push(
						this.row(`${this.theme.fg("muted", "  → ")}${this.theme.fg("toolOutput", run.currentTool)}`, innerW, isSelected),
					);
				}
				if (i < this.runs.length - 1) lines.push(this.row("", innerW));
			}
		}

		lines.push(this.separator(innerW));
		const footer = this.focused
			? "j/k move • Space/Enter/o view • s stop • d del • q/Esc"
			: `${SUBAGENT_PANEL_SHORTCUT_LABEL} focus panel`;
		lines.push(this.row(this.theme.fg("dim", footer), innerW));
		while (lines.length < SUBAGENT_PANEL_FILL_ROWS) lines.push(this.row("", innerW));
		return lines;
	}

	invalidate(): void {}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.unsubscribe();
		this.handle = null;
	}

	private moveSelection(delta: number): void {
		if (this.runs.length === 0) return;
		this.selectedIndex = Math.max(0, Math.min(this.runs.length - 1, this.selectedIndex + delta));
		this.tui.requestRender();
	}

	private clampSelection(): void {
		if (this.runs.length === 0) {
			this.selectedIndex = 0;
			return;
		}
		this.selectedIndex = Math.max(0, Math.min(this.runs.length - 1, this.selectedIndex));
	}

	private selectedRun(): SubagentRun | undefined {
		return this.runs[this.selectedIndex];
	}

	private runHeaderRow(run: SubagentRun, width: number, selected: boolean): string {
		const selector = selected && this.focused ? this.theme.fg("accent", "›") : " ";
		const left = [
			selector,
			runStatusIcon(run.status, this.theme),
			this.theme.fg("muted", formatShortRunId(run.id)),
			this.theme.fg("accent", run.agent),
			this.theme.fg("dim", run.status),
		]
			.filter(Boolean)
			.join(" ");
		return this.row(splitPanelRow(left, this.theme.fg("dim", formatRunTime(run)), width), width, selected);
	}

	private row(content: string, width: number, selected = false): string {
		let inner = truncateToWidth(content, width, "…", true);
		if (selected && this.focused) inner = this.theme.bg("selectedBg", inner);
		return `${this.border("│")}${inner}${this.border("│")}`;
	}

	private topBorder(width: number): string {
		const titleText = this.focused ? " Subagents • focus " : " Subagents ";
		const title = truncateToWidth(titleText, width, "");
		const titleWidth = visibleWidth(title);
		const left = Math.floor(Math.max(0, width - titleWidth) / 2);
		const right = Math.max(0, width - titleWidth - left);
		return `${this.border(`╭${"─".repeat(left)}`)}${this.theme.fg("accent", title)}${this.border(`${"─".repeat(right)}╮`)}`;
	}

	private separator(width: number): string {
		return this.border(`├${"─".repeat(width)}┤`);
	}

	private border(text: string): string {
		return this.theme.fg(this.focused ? "borderAccent" : "borderMuted", text);
	}
}

export class SubagentPanelController {
	private handle: OverlayHandle | null = null;
	private component: SubagentPanelComponent | null = null;
	private terminalInputUnsubscribe: (() => void) | null = null;
	private tui: TUI | null = null;
	private originalTuiRender: TUI["render"] | null = null;
	private returnFocusTarget: Component | null = null;
	private generation = 0;
	private lastToggleAt = 0;

	start(ctx: ExtensionContext): void {
		if (ctx.mode !== "tui") return;
		this.stop();

		const generation = ++this.generation;
		let component: SubagentPanelComponent | null = null;
		const panelPromise = ctx.ui.custom<void>(
			(tui, theme) => {
				component = new SubagentPanelComponent(
					tui,
					theme,
					() => this.releasePanelFocus(),
					(runId) => this.attachRun(ctx, runId),
					(runId) => this.deleteRun(ctx, runId),
					(runId) => this.stopRun(ctx, runId),
				);
				if (this.generation === generation) {
					this.component = component;
					this.reservePanelWidth(tui);
				} else component.dispose();
				return component;
			},
			{
				overlay: true,
				overlayOptions: SUBAGENT_PANEL_OVERLAY_OPTIONS,
				onHandle: (handle) => {
					if (this.generation !== generation) {
						handle.hide();
						component?.dispose();
						return;
					}
					this.handle = handle;
					handle.setHidden(true);
					component?.setHandle(handle);
				},
			},
		);

		this.terminalInputUnsubscribe = ctx.ui.onTerminalInput((data) => {
			if (!matchesSubagentPanelShortcut(data)) return;
			this.toggleFocus(ctx);
			return { consume: true };
		});

		void panelPromise.catch(() => {
			if (this.generation !== generation) return;
			component?.dispose();
			this.component = null;
			this.handle = null;
		});
	}

	stop(): void {
		this.generation++;
		const component = this.component;
		const handle = this.handle;
		const terminalInputUnsubscribe = this.terminalInputUnsubscribe;
		this.component = null;
		this.handle = null;
		this.terminalInputUnsubscribe = null;
		this.returnFocusTarget = null;
		terminalInputUnsubscribe?.();
		this.restorePanelWidth();
		component?.dispose();
		handle?.hide();
	}

	private reservePanelWidth(tui: TUI): void {
		if (this.originalTuiRender) return;
		this.tui = tui;
		const originalRender = tui.render;
		this.originalTuiRender = originalRender;
		// ponytail: Pi overlays float; shrink the root render while this panel is visible instead of adding a split-layout API.
		tui.render = (width: number) => originalRender.call(tui, Math.max(1, width - this.reservedColumns(width)));
	}

	private restorePanelWidth(): void {
		if (!this.tui || !this.originalTuiRender) return;
		this.tui.render = this.originalTuiRender;
		this.tui = null;
		this.originalTuiRender = null;
	}

	private reservedColumns(termWidth: number): number {
		if (!this.handle || this.handle.isHidden()) return 0;
		const visible = SUBAGENT_PANEL_OVERLAY_OPTIONS.visible?.(termWidth, this.tui?.terminal.rows ?? 1) ?? true;
		return visible ? resolveSubagentPanelWidth(termWidth) : 0;
	}

	private captureReturnFocusTarget(): void {
		if (!this.tui) return;
		// ponytail: pi-tui has no focus getter; remove when OverlayHandle.focus() refreshes preFocus.
		const focused = (this.tui as unknown as { focusedComponent?: Component | null }).focusedComponent ?? null;
		if (focused && focused !== this.component) this.returnFocusTarget = focused;
	}

	private focusPanel(handle: OverlayHandle): void {
		this.captureReturnFocusTarget();
		handle.focus();
	}

	private releasePanelFocus(): void {
		const handle = this.handle;
		if (!handle) return;
		if (this.returnFocusTarget) handle.unfocus({ target: this.returnFocusTarget });
		else handle.unfocus();
		handle.setHidden(true);
		this.component?.requestRender();
	}

	private attachRun(ctx: ExtensionContext, runId: string): void {
		openSubagentRunViewer(ctx, runId);
	}

	private deleteRun(ctx: ExtensionContext, runId: string): void {
		if (subagentRunStore.remove(runId)) ctx.ui.notify(`Deleted ${formatShortRunId(runId)}.`, "info");
	}

	private stopRun(ctx: ExtensionContext, runId: string): void {
		if (!subagentRunStore.abort(runId)) ctx.ui.notify(`${formatShortRunId(runId)} is not running.`, "warning");
	}

	toggleFocus(ctx: ExtensionContext): void {
		if (ctx.mode !== "tui") return;
		// ponytail: registerShortcut and raw terminal input may both see one keypress.
		const now = Date.now();
		if (now - this.lastToggleAt < 80) return;
		this.lastToggleAt = now;

		if (!this.handle) this.start(ctx);
		const handle = this.handle;
		if (!handle) return;
		if (handle.isHidden()) {
			handle.setHidden(false);
			this.focusPanel(handle);
		} else {
			this.releasePanelFocus();
		}
		this.component?.requestRender();
	}
}

