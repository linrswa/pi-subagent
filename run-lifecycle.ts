import { subagentRunStore, type SubagentRunStore } from "./store.ts";
import type { SubagentRun } from "./types.ts";

const SHUTDOWN_TIMEOUT_MS = 7_000;

/** Owns child work started by one extension runtime/session. */
export class OwnerRunLifecycle {
	private readonly owners = new Map<string, { controller: AbortController; runIds: Set<string> }>();
	private readonly store: SubagentRunStore;

	constructor(store: SubagentRunStore = subagentRunStore) { this.store = store; }

	activate(ownerSessionId: string): void {
		// Session-start can be delivered more than once. Retain the existing
		// controller and tracked runs instead of orphaning the earlier ownership.
		if (!this.owners.has(ownerSessionId)) this.create(ownerSessionId);
	}

	signalFor(ownerSessionId: string, signal?: AbortSignal): AbortSignal {
		const state = this.owners.get(ownerSessionId) ?? this.create(ownerSessionId);
		if (!signal) return state.controller.signal;
		return AbortSignal.any([signal, state.controller.signal]);
	}

	track(run: SubagentRun): void {
		(this.owners.get(run.ownerSessionId) ?? this.create(run.ownerSessionId)).runIds.add(run.id);
	}

	/** True only for work started by this extension runtime, never hydrated pointers. */
	owns(ownerSessionId: string, runId: string): boolean {
		return this.owners.get(ownerSessionId)?.runIds.has(runId) ?? false;
	}

	/** Abort this runtime's runs and leave persistence active until they settle. */
	async shutdown(ownerSessionId: string, timeoutMs = SHUTDOWN_TIMEOUT_MS): Promise<boolean> {
		const state = this.owners.get(ownerSessionId);
		if (!state) return true;
		state.controller.abort();
		const deadline = Date.now() + timeoutMs;
		while (true) {
			const live = Array.from(state.runIds, (id) => this.store.get(id, ownerSessionId)).filter((run): run is SubagentRun => Boolean(run && run.endedAt === undefined));
			if (live.length === 0) {
				this.owners.delete(ownerSessionId);
				return true;
			}
			for (const run of live) this.store.abort(run.id, ownerSessionId);
			if (Date.now() >= deadline) return false;
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
	}

	private create(ownerSessionId: string): { controller: AbortController; runIds: Set<string> } {
		const state = { controller: new AbortController(), runIds: new Set<string>() };
		this.owners.set(ownerSessionId, state);
		return state;
	}
}
