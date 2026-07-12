import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatShortRunId } from "./run-refs.ts";
import { subagentRunStore } from "./store.ts";
import type { SingleResult, SubagentRun } from "./types.ts";

const NOTIFICATION_DEBOUNCE_MS = 100;
const OUTPUT_PREVIEW_LENGTH = 500;

type PendingCompletion = { runId: string; ownerSessionId: string };

function preview(text: string | undefined, maxLength = OUTPUT_PREVIEW_LENGTH): string {
	const normalized = (text ?? "").trim();
	if (!normalized) return "(no output)";
	return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized;
}

function completionText(runs: readonly SubagentRun[]): string {
	return [
		"Background subagent completion update:",
		...runs.map((run) => `- ${formatShortRunId(run.id)} ${run.status} ${run.agent}: ${preview(run.finalOutput || run.errorMessage)}`),
		"Use subagent_control with a run id for full status, stop, or deletion.",
	].join("\n");
}

/** Session-generation-safe UI notification and durable next-input delivery. */
export class CompletionNotifier {
	private activeOwner?: string;
	private generation = 0;
	private ctx?: ExtensionContext;
	private timer?: ReturnType<typeof setTimeout>;
	private readonly pending = new Map<string, PendingCompletion>();
	private readonly notified = new Set<string>();
	private readonly staged = new Map<string, Set<string>>();

	activate(ownerSessionId: string, ctx: ExtensionContext): void {
		this.clearPending();
		this.generation++;
		this.notified.clear();
		this.activeOwner = ownerSessionId;
		this.ctx = ctx;
	}

	deactivate(ownerSessionId?: string): void {
		if (ownerSessionId && ownerSessionId !== this.activeOwner) return;
		this.clearPending();
		this.generation++;
		this.activeOwner = undefined;
		this.ctx = undefined;
	}

	/** Requeue terminal UI notifications which survived a reload before delivery. */
	resume(runs: readonly SubagentRun[]): void {
		const generation = this.generation;
		for (const run of runs) {
			if (run.completionNotification !== "pending") continue;
			if (run.status === "queued" || run.status === "running") continue;
			this.enqueue(run.ownerSessionId, run.id, generation);
		}
	}

	watch(run: SubagentRun, completion: Promise<SingleResult | unknown>): void {
		const generation = this.generation;
		void completion.then(
			() => this.enqueue(run.ownerSessionId, run.id, generation),
			() => this.enqueue(run.ownerSessionId, run.id, generation),
		);
	}

	/** Stage durable terminal results for the next input without acknowledging them yet. */
	stageForNextInput(ownerSessionId: string): { content?: string; runs: SubagentRun[] } {
		if (ownerSessionId !== this.activeOwner) return { runs: [] };
		const terminal = subagentRunStore.getSnapshot(ownerSessionId).filter((run) =>
			run.completionNotification === "pending" && run.status !== "queued" && run.status !== "running" && run.endedAt !== undefined && !run.abort,
		);
		if (terminal.length === 0) return { runs: [] };
		this.staged.set(ownerSessionId, new Set(terminal.map((run) => run.id)));
		return { content: completionText(terminal), runs: terminal };
	}

	/** Mark staged summaries delivered only after Pi accepts the prompt and starts the agent. */
	acknowledgeStaged(ownerSessionId: string): SubagentRun[] {
		if (ownerSessionId !== this.activeOwner) return [];
		const ids = this.staged.get(ownerSessionId);
		if (!ids) return [];
		this.staged.delete(ownerSessionId);
		const updated: SubagentRun[] = [];
		for (const id of ids) {
			const run = subagentRunStore.get(id, ownerSessionId);
			if (!run || run.completionNotification !== "pending" || run.endedAt === undefined || run.abort) continue;
			const next = subagentRunStore.update(id, { completionNotification: "delivered" }, ownerSessionId);
			if (next) updated.push(next);
			for (const [key, item] of this.pending) if (item.ownerSessionId === ownerSessionId && item.runId === id) this.pending.delete(key);
		}
		if (this.pending.size === 0 && this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		return updated;
	}

	private enqueue(ownerSessionId: string, runId: string, generation: number): void {
		if (generation !== this.generation || ownerSessionId !== this.activeOwner) return;
		const run = subagentRunStore.get(runId, ownerSessionId);
		if (!run || run.completionNotification !== "pending" || run.status === "queued" || run.status === "running" || run.endedAt === undefined || run.abort) return;
		const key = `${ownerSessionId}\u0000${runId}\u0000${run.endedAt ?? 0}`;
		if (this.notified.has(key)) return;
		this.notified.add(key);
		this.pending.set(key, { ownerSessionId, runId });
		if (this.timer) return;
		this.timer = setTimeout(() => this.flush(generation), NOTIFICATION_DEBOUNCE_MS);
		(this.timer as { unref?: () => void }).unref?.();
	}

	private flush(generation: number): void {
		this.timer = undefined;
		if (generation !== this.generation || !this.activeOwner || !this.ctx) return this.pending.clear();
		const ownerSessionId = this.activeOwner;
		const runs = Array.from(this.pending.values())
			.filter((item) => item.ownerSessionId === ownerSessionId)
			.map((item) => subagentRunStore.get(item.runId, ownerSessionId))
			.filter((run): run is SubagentRun => Boolean(run && run.completionNotification === "pending"));
		this.pending.clear();
		if (runs.length === 0 || !this.ctx.hasUI) return;
		const succeeded = runs.filter((run) => run.status === "completed").length;
		const failed = runs.length - succeeded;
		const title = runs.length === 1
			? `${formatShortRunId(runs[0].id)} ${runs[0].status}`
			: `${runs.length} subagents finished (${succeeded} completed${failed ? `, ${failed} failed` : ""})`;
		this.ctx.ui.notify(title, failed ? "warning" : "info");
	}

	private clearPending(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		this.pending.clear();
		this.staged.clear();
	}
}
