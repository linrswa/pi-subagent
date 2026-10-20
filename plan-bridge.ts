import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SubagentRun } from "./types.ts";

export interface RunSummary {
	id: string;
	task: string;
	taskId?: string;
	status: SubagentRun["status"];
	completionNotification?: string;
}
export interface RunSnapshot { version: 1; ownerSessionId: string; runs: RunSummary[]; }

/** Optional event-bus integration, not a dependency on the plan package's store. */
export class SubagentPlanBridge {
	private owner?: string;
	private readonly summaries = new Map<string, RunSummary>();
	private unsubscribe?: () => void;
	private readonly pi: Pick<ExtensionAPI, "events">;

	constructor(pi: Pick<ExtensionAPI, "events">) { this.pi = pi; }

	activate(ownerSessionId: string, runs: readonly SubagentRun[]): void {
		this.deactivate();
		this.owner = ownerSessionId;
		for (const run of runs) this.summaries.set(run.id, this.summary(run));
		this.unsubscribe = this.pi.events?.on("pi-subagent:snapshot-request", (event: unknown) => {
			const request = event as { ownerSessionId?: string; respond?: (snapshot: RunSnapshot) => void };
			if (request?.ownerSessionId === this.owner && typeof request.respond === "function") request.respond(this.snapshot());
		});
		this.publish();
	}

	deactivate(): void {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.owner = undefined;
		this.summaries.clear();
	}

	currentTaskId(ownerSessionId: string): string | undefined {
		let taskId: string | undefined;
		this.pi.events?.emit("pi-plan:context-request", { ownerSessionId, respond: (context: { taskId?: unknown }) => {
			if (typeof context?.taskId === "string") taskId = context.taskId;
		} });
		return taskId;
	}

	record(run: SubagentRun): void {
		if (run.ownerSessionId !== this.owner) return;
		const next = this.summary(run);
		if (JSON.stringify(next) === JSON.stringify(this.summaries.get(run.id))) return;
		this.summaries.set(run.id, next);
		this.publish();
	}

	remove(run: SubagentRun): void {
		if (run.ownerSessionId !== this.owner) return;
		this.summaries.delete(run.id);
		this.publish();
	}

	private summary(run: SubagentRun): RunSummary {
		return { id: run.id, task: run.task, taskId: run.taskId, status: run.status, completionNotification: run.completionNotification };
	}
	private snapshot(): RunSnapshot {
		return { version: 1, ownerSessionId: this.owner!, runs: Array.from(this.summaries.values(), (run) => ({ ...run })) };
	}
	private publish(): void {
		if (this.owner) this.pi.events?.emit("pi-subagent:state", this.snapshot());
	}
}
