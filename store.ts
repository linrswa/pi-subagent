import { getChildSessionOwnerId } from "./child-sessions.ts";
import type { CreateSubagentRunInput, SubagentRun, SubagentRunPatch, SubagentRunSubscriber, UsageStats } from "./types.ts";

export function makeEmptyUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

export function cloneUsageStats(usage: UsageStats): UsageStats {
	return { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, cost: usage.cost, contextTokens: usage.contextTokens, turns: usage.turns };
}

/** In-memory runs, partitioned by the owning main Pi session. */
export class SubagentRunStore {
	private activeOwnerSessionId = getChildSessionOwnerId(undefined);
	private readonly nextRunNumbers = new Map<string, number>();
	private readonly runs = new Map<string, SubagentRun>();
	private readonly subscribers = new Map<SubagentRunSubscriber, string>();
	private readonly changeSubscribers = new Set<(run: SubagentRun) => void>();

	setActiveOwner(ownerSessionId: string): void {
		this.activeOwnerSessionId = ownerSessionId;
		this.notify();
	}

	getActiveOwner(): string {
		return this.activeOwnerSessionId;
	}

	create(input: CreateSubagentRunInput): SubagentRun {
		const ownerSessionId = input.ownerSessionId ?? this.activeOwnerSessionId;
		const number = this.nextRunNumbers.get(ownerSessionId) ?? 1;
		this.nextRunNumbers.set(ownerSessionId, number + 1);
		const run: SubagentRun = {
			id: `subagent-${number}`,
			status: "queued",
			startedAt: Date.now(),
			messages: [],
			usage: makeEmptyUsage(),
			...input,
			ownerSessionId,
		};
		this.runs.set(this.key(ownerSessionId, run.id), this.cloneRun(run));
		this.notifyChange(run);
		this.notify();
		return this.cloneRun(run);
	}

	/** ownerSessionId is captured by runners so async completions never follow a later active scope. */
	update(id: string, patch: SubagentRunPatch, ownerSessionId = this.activeOwnerSessionId): SubagentRun | undefined {
		const key = this.key(ownerSessionId, id);
		const existing = this.runs.get(key);
		if (!existing) return undefined;
		const next: SubagentRun = { ...existing, ...patch, ownerSessionId: existing.ownerSessionId, messages: patch.messages ? [...patch.messages] : existing.messages, usage: patch.usage ? cloneUsageStats(patch.usage) : existing.usage };
		this.runs.set(key, next);
		this.notifyChange(next);
		this.notify();
		return this.cloneRun(next);
	}

	get(id: string, ownerSessionId = this.activeOwnerSessionId): SubagentRun | undefined {
		const run = this.runs.get(this.key(ownerSessionId, id));
		return run ? this.cloneRun(run) : undefined;
	}

	getSnapshot(ownerSessionId = this.activeOwnerSessionId): SubagentRun[] {
		return Array.from(this.runs.values()).filter((run) => run.ownerSessionId === ownerSessionId).map((run) => this.cloneRun(run));
	}

	/** Observe creates/updates across scopes; persistence must still enforce its session guard. */
	subscribeChanges(subscriber: (run: SubagentRun) => void): () => void {
		this.changeSubscribers.add(subscriber);
		return () => this.changeSubscribers.delete(subscriber);
	}

	/** Replace one owner scope with durable pointer records without re-persisting them. */
	hydrate(ownerSessionId: string, runs: readonly SubagentRun[], maxRunNumber: number): void {
		for (const [key, run] of this.runs) if (run.ownerSessionId === ownerSessionId) this.runs.delete(key);
		for (const run of runs) this.runs.set(this.key(ownerSessionId, run.id), this.cloneRun({ ...run, ownerSessionId }));
		this.nextRunNumbers.set(ownerSessionId, Math.max(1, maxRunNumber + 1));
		this.notify();
	}

	subscribe(subscriber: SubagentRunSubscriber, ownerSessionId = this.activeOwnerSessionId): () => void {
		this.subscribers.set(subscriber, ownerSessionId);
		subscriber(this.getSnapshot(ownerSessionId));
		return () => this.subscribers.delete(subscriber);
	}

	abort(id: string, ownerSessionId = this.activeOwnerSessionId): boolean {
		const run = this.runs.get(this.key(ownerSessionId, id));
		if (!run?.abort) return false;
		run.abort();
		return true;
	}

	remove(id: string, ownerSessionId = this.activeOwnerSessionId): boolean {
		const key = this.key(ownerSessionId, id);
		const run = this.runs.get(key);
		if (!run) return false;
		run.abort?.();
		const deleted = this.runs.delete(key);
		if (deleted) this.notify();
		return deleted;
	}

	private notifyChange(run: SubagentRun): void {
		const snapshot = this.cloneRun(run);
		for (const subscriber of this.changeSubscribers) {
			try { subscriber(snapshot); } catch { /* isolate observers */ }
		}
	}
	private key(ownerSessionId: string, id: string): string { return `${ownerSessionId}\u0000${id}`; }
	private cloneRun(run: SubagentRun): SubagentRun { return { ...run, messages: [...run.messages], usage: cloneUsageStats(run.usage) }; }
	private notify(): void {
		for (const [subscriber, ownerSessionId] of this.subscribers) {
			try { subscriber(this.getSnapshot(ownerSessionId)); } catch { /* isolate subscribers */ }
		}
	}
}

export const subagentRunStore = new SubagentRunStore();
