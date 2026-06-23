import type { CreateSubagentRunInput, SubagentRun, SubagentRunPatch, SubagentRunSubscriber, UsageStats } from "./types.ts";

export function makeEmptyUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

export function cloneUsageStats(usage: UsageStats): UsageStats {
	return {
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		cost: usage.cost,
		contextTokens: usage.contextTokens,
		turns: usage.turns,
	};
}

export class SubagentRunStore {
	private nextRunNumber = 1;
	private readonly runs = new Map<string, SubagentRun>();
	private readonly subscribers = new Set<SubagentRunSubscriber>();

	create(input: CreateSubagentRunInput): SubagentRun {
		const run: SubagentRun = {
			id: `subagent-${this.nextRunNumber++}`,
			status: "queued",
			startedAt: Date.now(),
			messages: [],
			usage: makeEmptyUsage(),
			...input,
		};
		this.runs.set(run.id, this.cloneRun(run));
		this.notify();
		return this.cloneRun(run);
	}

	update(id: string, patch: SubagentRunPatch): SubagentRun | undefined {
		const existing = this.runs.get(id);
		if (!existing) return undefined;

		const next: SubagentRun = {
			...existing,
			...patch,
			messages: patch.messages ? [...patch.messages] : existing.messages,
			usage: patch.usage ? cloneUsageStats(patch.usage) : existing.usage,
		};
		this.runs.set(id, next);
		this.notify();
		return this.cloneRun(next);
	}

	get(id: string): SubagentRun | undefined {
		const run = this.runs.get(id);
		return run ? this.cloneRun(run) : undefined;
	}

	getSnapshot(): SubagentRun[] {
		return Array.from(this.runs.values(), (run) => this.cloneRun(run));
	}

	subscribe(subscriber: SubagentRunSubscriber): () => void {
		this.subscribers.add(subscriber);
		subscriber(this.getSnapshot());
		return () => this.subscribers.delete(subscriber);
	}

	abort(id: string): boolean {
		const run = this.runs.get(id);
		if (!run?.abort) return false;
		run.abort();
		return true;
	}

	remove(id: string): boolean {
		const run = this.runs.get(id);
		if (!run) return false;
		run.abort?.();
		const deleted = this.runs.delete(id);
		if (deleted) this.notify();
		return deleted;
	}

	private cloneRun(run: SubagentRun): SubagentRun {
		return {
			...run,
			messages: [...run.messages],
			usage: cloneUsageStats(run.usage),
		};
	}

	private notify(): void {
		if (this.subscribers.size === 0) return;
		const snapshot = this.getSnapshot();
		for (const subscriber of this.subscribers) {
			try {
				subscriber(snapshot);
			} catch {
				// Keep store updates isolated from panel/render subscriber failures.
			}
		}
	}
}

export const subagentRunStore = new SubagentRunStore();
