import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentScope, AgentSource } from "./agents.ts";
import { makeEmptyUsage, type SubagentRunStore } from "./store.ts";
import type { RunStatus, SubagentRun } from "./types.ts";

export const RUN_POINTER_ENTRY_TYPE = "pi-subagent.run";
export const RUN_TOMBSTONE_ENTRY_TYPE = "pi-subagent.run-tombstone";
const POINTER_VERSION = 1;

/** Deliberately only a child-session pointer, never a child transcript or result. */
export interface RunPointer {
	version: 1;
	runId: string;
	agent: string;
	agentSource: AgentSource | "unknown";
	agentScope?: AgentScope;
	task: string;
	status: RunStatus;
	cwd?: string;
	sessionId?: string;
	sessionDir?: string;
	sessionFile?: string;
	leafId?: string;
	continuedFromRunId?: string;
	startedAt: number;
	endedAt?: number;
}

export interface RunTombstone { version: 1; runId: string; }
type EntryLike = { type?: unknown; customType?: unknown; data?: unknown };

export function toRunPointer(run: SubagentRun): RunPointer {
	return {
		version: POINTER_VERSION, runId: run.id, agent: run.agent, agentSource: run.agentSource,
		agentScope: run.agentScope, task: run.task, status: run.status, cwd: run.cwd,
		sessionId: run.sessionId, sessionDir: run.sessionDir, sessionFile: run.sessionFile,
		leafId: run.leafId, continuedFromRunId: run.continuedFromRunId,
		startedAt: run.startedAt, endedAt: run.endedAt,
	};
}

function isStatus(value: unknown): value is RunStatus {
	return value === "queued" || value === "running" || value === "completed" || value === "failed" || value === "aborted";
}

function asPointer(data: unknown): RunPointer | undefined {
	if (!data || typeof data !== "object") return undefined;
	const value = data as Record<string, unknown>;
	const validSource = value.agentSource === "package" || value.agentSource === "user" || value.agentSource === "project" || value.agentSource === "unknown";
	const validScope = value.agentScope === undefined || value.agentScope === "user" || value.agentScope === "project" || value.agentScope === "both";
	if (value.version !== POINTER_VERSION || typeof value.runId !== "string" || typeof value.agent !== "string" || typeof value.task !== "string" || !validSource || !validScope || !isStatus(value.status) || typeof value.startedAt !== "number") return undefined;
	return value as unknown as RunPointer;
}

/** Latest pointer wins; tombstones win even when their pointer was written earlier. */
export function restoreRunPointers(entries: readonly EntryLike[], ownerSessionId: string): { runs: SubagentRun[]; maxRunNumber: number } {
	const pointers = new Map<string, RunPointer>();
	const tombstones = new Set<string>();
	let maxRunNumber = 0;
	for (const entry of entries) {
		if (entry.type !== "custom" || typeof entry.customType !== "string") continue;
		if (entry.customType === RUN_POINTER_ENTRY_TYPE) {
			const pointer = asPointer(entry.data);
			if (!pointer) continue;
			pointers.set(pointer.runId, pointer);
			const match = /^subagent-(\d+)$/.exec(pointer.runId);
			if (match) maxRunNumber = Math.max(maxRunNumber, Number(match[1]));
		} else if (entry.customType === RUN_TOMBSTONE_ENTRY_TYPE) {
			const data = entry.data as Partial<RunTombstone> | undefined;
			if (!data || data.version !== POINTER_VERSION || typeof data.runId !== "string") continue;
			tombstones.add(data.runId);
			const match = /^subagent-(\d+)$/.exec(data.runId);
			if (match) maxRunNumber = Math.max(maxRunNumber, Number(match[1]));
		}
	}
	const runs = Array.from(pointers.values())
		.filter((pointer) => !tombstones.has(pointer.runId))
		.map((pointer): SubagentRun => ({
			id: pointer.runId, ownerSessionId, mode: "single", agent: pointer.agent,
			agentSource: pointer.agentSource, agentScope: pointer.agentScope, task: pointer.task,
			status: pointer.status, cwd: pointer.cwd, sessionId: pointer.sessionId, sessionDir: pointer.sessionDir,
			sessionFile: pointer.sessionFile, leafId: pointer.leafId, continuedFromRunId: pointer.continuedFromRunId,
			startedAt: pointer.startedAt, endedAt: pointer.endedAt, messages: [], usage: makeEmptyUsage(),
		}));
	return { runs, maxRunNumber };
}

/**
 * Appends only while the same main session generation remains active. Pi's API
 * can append only to its current session, so an old background completion is
 * intentionally skipped after a session switch/shutdown rather than corrupting
 * the newly active main session.
 */
export class RunPointerPersistence {
	private activeOwner?: string;
	private generation = 0;
	private readonly fingerprints = new Map<string, string>();
	/** Generation that created a run's pointer; never let it cross a session switch. */
	private readonly runGenerations = new Map<string, number>();
	private readonly pi: Pick<ExtensionAPI, "appendEntry">;

	constructor(pi: Pick<ExtensionAPI, "appendEntry">) { this.pi = pi; }

	activate(ownerSessionId: string, entries: readonly EntryLike[], store: SubagentRunStore): void {
		this.generation++;
		const generation = this.generation;
		this.activeOwner = ownerSessionId;
		const restored = restoreRunPointers(entries, ownerSessionId);
		store.hydrate(ownerSessionId, restored.runs, restored.maxRunNumber);
		this.fingerprints.clear();

		// A queued/running pointer belongs to an earlier extension runtime. There
		// is no runner to resume after activation, so close it rather than showing
		// a permanently live run. Append the corrected, still-minimal pointer
		// directly: retaining runGenerations preserves the guard against a late
		// completion from an older generation.
		const endedAt = Date.now();
		for (const run of restored.runs) {
			if (run.status !== "queued" && run.status !== "running") continue;
			const reconciled = { ...run, status: "aborted" as const, endedAt };
			// Set the fingerprint before update() notifies normal persistence.
			this.persistReconciled(reconciled, generation);
			store.update(run.id, { status: reconciled.status, endedAt: reconciled.endedAt }, ownerSessionId);
		}
	}

	deactivate(): void { this.generation++; this.activeOwner = undefined; this.fingerprints.clear(); }

	record(run: SubagentRun): void {
		const generation = this.generation;
		if (this.activeOwner !== run.ownerSessionId) return;
		const pointer = toRunPointer(run);
		const fingerprint = JSON.stringify(pointer);
		const key = `${run.ownerSessionId}\u0000${run.id}`;
		const runGeneration = this.runGenerations.get(key);
		if (runGeneration !== undefined && runGeneration !== generation) return;
		if (this.fingerprints.get(key) === fingerprint) return;
		// Kept explicit so future async callers cannot append after a generation change.
		if (generation !== this.generation || this.activeOwner !== run.ownerSessionId) return;
		this.pi.appendEntry(RUN_POINTER_ENTRY_TYPE, pointer);
		this.runGenerations.set(key, generation);
		this.fingerprints.set(key, fingerprint);
	}

	/** Persist activation-time closure without granting an old run a new generation. */
	private persistReconciled(run: SubagentRun, generation: number): void {
		if (generation !== this.generation || this.activeOwner !== run.ownerSessionId) return;
		const pointer = toRunPointer(run);
		const key = `${run.ownerSessionId}\u0000${run.id}`;
		this.pi.appendEntry(RUN_POINTER_ENTRY_TYPE, pointer);
		this.fingerprints.set(key, JSON.stringify(pointer));
	}

	tombstone(ownerSessionId: string, runId: string): void {
		const generation = this.generation;
		if (this.activeOwner !== ownerSessionId || generation !== this.generation) return;
		this.pi.appendEntry(RUN_TOMBSTONE_ENTRY_TYPE, { version: POINTER_VERSION, runId } satisfies RunTombstone);
		const key = `${ownerSessionId}\u0000${runId}`;
		this.fingerprints.delete(key);
		this.runGenerations.delete(key);
	}
}
