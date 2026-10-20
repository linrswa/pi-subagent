import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatShortRunId } from "./run-refs.ts";
import { subagentRunStore } from "./store.ts";
import type { SingleResult, SubagentRun } from "./types.ts";

export const COMPLETION_MESSAGE_TYPE = "pi-subagent.completion";
export const DELIVERY_PAUSED_ENTRY_TYPE = "pi-subagent.delivery-paused";
const NOTIFICATION_DEBOUNCE_MS = 100;
const MAX_BATCH_SIZE = 16;
const OUTPUT_PREVIEW_LENGTH = 700;

type Receipt = { version: 1; ownerSessionId: string; runs: { id: string; endedAt: number }[] };
type EntryLike = { type?: string; customType?: string; data?: unknown; details?: unknown; message?: unknown };

function preview(text: string | undefined, limit: number): string {
	const normalized = (text ?? "").trim();
	return !normalized ? "(no output)" : normalized.length > limit ? `${normalized.slice(0, limit)}...` : normalized;
}

function completionText(runs: readonly SubagentRun[]): string {
	return [
		"Background subagent results are ready for parent review:",
		...runs.map((run) => [
			`- ${formatShortRunId(run.id)}: execution ${run.status}; agent ${run.agent}${run.taskId ? `; taskId ${run.taskId}` : ""}`,
			`  Assignment: ${preview(run.task, 240)}`,
			`  Result: ${preview(run.finalOutput || run.errorMessage, OUTPUT_PREVIEW_LENGTH)}`,
		].join("\n")),
		"Inspect full results with subagent_control status before relying on a truncated summary. Execution completed does NOT mean the requested outcome was achieved.",
		"Review evidence, update the relevant todo (including blocked/waiting when needed), and report the result. Continue only within the user's existing authorization and current objective. Do not restart aborted/cancelled work or revive an unrelated old plan.",
	].join("\n");
}

/** Durable outbox: send a custom follow-up, acknowledge only its persisted message. */
export class CompletionNotifier {
	private activeOwner?: string;
	private generation = 0;
	private ctx?: ExtensionContext;
	private timer?: ReturnType<typeof setTimeout>;
	private paused = false;
	// Attempt at most once per activation/user resumption. An unacknowledged send
	// stays durable/pending, but must not create an automatic retry/model loop.
	private readonly attempted = new Set<string>();
	private readonly pi: Pick<ExtensionAPI, "sendMessage" | "appendEntry">;

	constructor(pi: Pick<ExtensionAPI, "sendMessage" | "appendEntry">) { this.pi = pi; }

	activate(ownerSessionId: string, ctx: ExtensionContext, entries: readonly EntryLike[] = []): SubagentRun[] {
		this.deactivate();
		this.activeOwner = ownerSessionId;
		this.ctx = ctx;
		this.paused = false;
		const acknowledged: SubagentRun[] = [];
		for (const entry of entries) {
			if (entry.type === "custom" && entry.customType === DELIVERY_PAUSED_ENTRY_TYPE) {
				this.paused = (entry.data as { paused?: unknown } | undefined)?.paused === true;
			}
		}
		acknowledged.push(...this.acknowledgePersisted(entries));
		return acknowledged;
	}

	deactivate(ownerSessionId?: string): void {
		if (ownerSessionId && ownerSessionId !== this.activeOwner) return;
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		this.generation++;
		this.attempted.clear();
		this.activeOwner = undefined;
		this.ctx = undefined;
	}

	/** Escape pauses automatic wake-ups, including pending results across reload. */
	pause(): void {
		if (!this.activeOwner || this.paused) return;
		this.paused = true;
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		this.pi.appendEntry(DELIVERY_PAUSED_ENTRY_TYPE, { paused: true });
	}

	/** A deliberate user-started run permits delivery again; never mutates user text. */
	resumeAfterUserInput(): void {
		if (!this.activeOwner) return;
		if (this.paused) {
			this.paused = false;
			this.attempted.clear();
			this.pi.appendEntry(DELIVERY_PAUSED_ENTRY_TYPE, { paused: false });
		} else if (this.ctx?.hasPendingMessages?.() === false) {
			// Retry a lost/rejected enqueue only on deliberate user activity and
			// only when the host has no queued follow-up that could duplicate it.
			this.attempted.clear();
		}
		this.resume();
	}

	resume(_runs?: readonly SubagentRun[]): void {
		if (!this.activeOwner || !this.ctx || this.paused || this.timer) return;
		if (this.pendingRuns().length === 0) return;
		const generation = this.generation;
		this.timer = setTimeout(() => this.flush(generation), NOTIFICATION_DEBOUNCE_MS);
		(this.timer as { unref?: () => void }).unref?.();
	}

	watch(run: SubagentRun, completion: Promise<SingleResult | unknown>): void {
		const generation = this.generation;
		const done = () => {
			if (generation === this.generation && run.ownerSessionId === this.activeOwner) this.resume();
		};
		void completion.then(done, done);
	}

	/** Read only durable entries at a post-persistence boundary. Pi's extension
	 * message_end hook runs BEFORE persistence, so it must not acknowledge. */
	acknowledgePersisted(entries: readonly EntryLike[]): SubagentRun[] {
		const updated: SubagentRun[] = [];
		for (const entry of entries) {
			if (entry.type === "custom_message") updated.push(...this.acknowledgeMessage({ role: "custom", customType: entry.customType, details: entry.details }));
		}
		return updated;
	}

	/** A receipt is delivery, not semantic task success or parent verification. */
	acknowledgeMessage(message: unknown): SubagentRun[] {
		if (!message || typeof message !== "object") return [];
		const value = message as { role?: string; customType?: string; details?: Receipt };
		const receipt = value.details;
		if (value.role !== "custom" || value.customType !== COMPLETION_MESSAGE_TYPE || !receipt || receipt.version !== 1 || receipt.ownerSessionId !== this.activeOwner || !Array.isArray(receipt.runs)) return [];
		const updated: SubagentRun[] = [];
		for (const item of receipt.runs) {
			if (!item || typeof item.id !== "string" || typeof item.endedAt !== "number") continue;
			const run = subagentRunStore.get(item.id, receipt.ownerSessionId);
			if (!run || run.completionNotification !== "pending" || run.endedAt !== item.endedAt || run.abort) continue;
			const next = subagentRunStore.update(run.id, { completionNotification: "delivered" }, receipt.ownerSessionId);
			if (next) updated.push(next);
		}
		return updated;
	}

	private key(run: SubagentRun): string { return `${run.id}\u0000${run.endedAt}`; }

	private pendingRuns(): SubagentRun[] {
		if (!this.activeOwner) return [];
		return subagentRunStore.getSnapshot(this.activeOwner).filter((run) =>
			run.completionNotification === "pending" && run.status !== "queued" && run.status !== "running" && run.endedAt !== undefined && !run.abort && !this.attempted.has(this.key(run)),
		);
	}

	private flush(generation: number): void {
		this.timer = undefined;
		if (generation !== this.generation || !this.activeOwner || !this.ctx || this.paused) return;
		const runs = this.pendingRuns().slice(0, MAX_BATCH_SIZE);
		if (runs.length === 0) return;
		for (const run of runs) this.attempted.add(this.key(run));
		try {
			this.pi.sendMessage({
				customType: COMPLETION_MESSAGE_TYPE,
				content: completionText(runs),
				display: true,
				details: { version: 1, ownerSessionId: this.activeOwner, runs: runs.map((run) => ({ id: run.id, endedAt: run.endedAt! })) } satisfies Receipt,
			}, { deliverAs: "followUp", triggerTurn: true });
		} catch (error) {
			this.pause();
			this.ctx.ui.notify(`Subagent results remain pending: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
		this.resume();
	}
}
