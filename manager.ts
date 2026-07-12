import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions } from "@earendil-works/pi-tui";
import { type AgentConfig, type AgentScope, discoverAgents, discoverAgentsWithSettings, formatAgentList } from "./agents.ts";
import { MAX_AGENT_SUGGESTIONS } from "./constants.ts";
import { cleanupChildSession, getChildSessionOwnerId } from "./child-sessions.ts";
import { getFinalOutput, toParentResult } from "./results.ts";
import { runSingleAgent } from "./runner.ts";
import { OwnerRunLifecycle } from "./run-lifecycle.ts";
import { subagentRunStore, type SubagentRunStore } from "./store.ts";
import { findRunByRef, formatShortRunId } from "./run-refs.ts";
import type { OnUpdateCallback, SingleResult, StartedAgentRun, SubagentDetails, SubagentMode, SubagentParamsInput, SubagentRun } from "./types.ts";

/**
 * Persisted parents use their Pi session id; --no-session parents share a
 * process-local runtime owner. This is intentionally not a cwd-derived id.
 */
export function getMainSessionOwnerId(ctx: ExtensionContext): string {
	try {
		return getChildSessionOwnerId(ctx.sessionManager.getSessionId());
	} catch {
		return getChildSessionOwnerId(undefined);
	}
}

function compactPreview(text: string | undefined, maxLength: number): string {
	const normalized = (text ?? "").replace(/\s+/g, " ").trim();
	if (!normalized) return "...";
	return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized;
}

export function getMode(params: SubagentParamsInput): SubagentMode | undefined {
	// Reject removed batch calls explicitly when resuming an older stored tool call.
	if ("tasks" in params) return undefined;
	// Continuations are single-run operations and cannot be embedded in a chain,
	// including an explicitly supplied empty chain.
	if (params.continueFrom && params.chain !== undefined) return undefined;
	const hasChain = (params.chain?.length ?? 0) > 0;
	// Fresh single runs default to explorer; continuations inherit their agent.
	const hasSingle = Boolean(params.task);
	if (Number(hasChain) + Number(hasSingle) !== 1) return undefined;
	return hasChain ? "chain" : "single";
}

export function normalizeAgentRef(agent: string | undefined): string | undefined {
	const trimmed = agent?.trim();
	if (!trimmed) return undefined;
	return trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;
}

export function chooseBackgroundAgent(agents: AgentConfig[], requestedAgent: string | undefined): string | undefined {
	const requested = normalizeAgentRef(requestedAgent);
	if (requested) return requested;
	return agents.find((agent) => agent.name === "explorer")?.name ?? agents[0]?.name;
}

export function getAgentCompletions(cwd: string, token: string, scope: AgentScope = "user"): AutocompleteItem[] {
	const query = normalizeAgentRef(token)?.toLowerCase() ?? "";
	return discoverAgents(cwd, scope).agents
		.filter((agent) => {
			if (!query) return true;
			return agent.name.toLowerCase().includes(query) || agent.description.toLowerCase().includes(query);
		})
		.slice(0, MAX_AGENT_SUGGESTIONS)
		.map((agent) => ({ value: agent.name, label: agent.name, description: `${agent.source}: ${agent.description}` }));
}

export function getAgentCommandCompletions(cwd: string, prefix: string): AutocompleteItem[] | null {
	if (/\s/.test(prefix.trim())) return null;
	const items = getAgentCompletions(cwd, prefix);
	return items.length > 0 ? items : null;
}

export function getContinuationCallDisplay(
	params: SubagentParamsInput,
	sourceRun = params.continueFrom ? findRunByRef(params.continueFrom) : undefined,
): { agentName: string; agentScope: AgentScope | "unknown" } {
	if (!params.continueFrom) {
		return { agentName: params.agent ?? "explorer", agentScope: params.agentScope ?? "user" };
	}

	// Calls render before execution has resolved continuation metadata. Reuse
	// the visible source when available; otherwise do not imply user scope.
	const inheritedScope = sourceRun?.agentScope ?? (sourceRun?.agentSource === "project" ? "both" : sourceRun ? "user" : "unknown");
	return {
		agentName: params.agent ?? sourceRun?.agent ?? "unknown",
		agentScope: params.agentScope ?? inheritedScope,
	};
}

export function getRunRefCompletions(token: string): AutocompleteItem[] {
	const query = token.trim().replace(/^[&＆]/, "").toLowerCase();
	return subagentRunStore
		.getSnapshot()
		.filter((run) => {
			const shortId = formatShortRunId(run.id);
			if (!query) return true;
			return shortId.slice(1).startsWith(query) || run.id.toLowerCase().includes(query) || run.agent.toLowerCase().includes(query);
		})
		.slice(0, MAX_AGENT_SUGGESTIONS)
		.map((run) => ({
			value: `&${formatShortRunId(run.id).slice(1)}`,
			label: `&${formatShortRunId(run.id).slice(1)}`,
			description: `${run.status} ${run.agent}: ${compactPreview(run.task, 48)}`,
		}));
}

export function createRunRefAutocompleteProvider(current: AutocompleteProvider): AutocompleteProvider {
	return {
		async getSuggestions(lines, cursorLine, cursorCol, options): Promise<AutocompleteSuggestions | null> {
			const beforeCursor = (lines[cursorLine] ?? "").slice(0, cursorCol);
			const match = beforeCursor.match(/(?:^|[ \t])([&＆])([^\s&＆]*)$/);
			if (!match) return current.getSuggestions(lines, cursorLine, cursorCol, options);

			const items = getRunRefCompletions(match[2] ?? "");
			if (options.signal.aborted || items.length === 0) return current.getSuggestions(lines, cursorLine, cursorCol, options);
			return { prefix: `${match[1] ?? "&"}${match[2] ?? ""}`, items };
		},
		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		},
		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
		},
	};
}

export function formatRunDetails(run: SubagentRun): string {
	const output = run.finalOutput || getFinalOutput(run.messages);
	const usage = [
		run.usage.turns ? `${run.usage.turns} turn${run.usage.turns === 1 ? "" : "s"}` : "",
		run.usage.input ? `input ${run.usage.input}` : "",
		run.usage.output ? `output ${run.usage.output}` : "",
		run.usage.cost ? `cost $${run.usage.cost.toFixed(4)}` : "",
	].filter(Boolean).join(", ") || "(none)";
	return [
		`${formatShortRunId(run.id)} (${run.id})`,
		`status: ${run.status}`,
		`agent: ${run.agent}`,
		`source: ${run.agentSource}`,
		`task: ${run.task || "(none)"}`,
		`cwd: ${run.cwd ?? "(none)"}`,
		`current tool: ${run.currentTool ?? "(none)"}`,
		`model: ${run.model ?? "(none)"}`,
		`usage: ${usage}`,
		`final output: ${output ?? "(none)"}`,
		`error: ${run.errorMessage ?? "(none)"}`,
		`completion notification: ${run.completionNotification ?? "(legacy/none)"}`,
		`session id: ${run.sessionId ?? "(none)"}`,
		`session file: ${run.sessionFile ?? "(none)"}`,
		`session leaf: ${run.leafId ?? "(none)"}`,
		`continued from: ${run.continuedFromRunId ? `${formatShortRunId(run.continuedFromRunId)} (${run.continuedFromRunId})${run.continuedFromLeafId ? ` leaf ${run.continuedFromLeafId}` : ""}` : "(none)"}`,
		`parent run: ${run.parentRunId ? `${formatShortRunId(run.parentRunId)} (${run.parentRunId})` : "(none)"}`,
		`child runs: ${run.childRunIds?.length ? run.childRunIds.map((id) => `${formatShortRunId(id)} (${id})`).join(", ") : "(none)"}`,
	].join("\n");
}

export function buildRunRefContext(text: string): string | undefined {
	const refs = Array.from(new Set(Array.from(text.matchAll(/[&＆](\d+)/g), (match) => match[1])));
	const lines = refs
		.map((ref) => findRunByRef(ref))
		.filter((run): run is SubagentRun => Boolean(run))
		.map((run) => {
			const statusGuidance = `use subagent_control with runId ${formatShortRunId(run.id)} for status/stop/delete.`;
			const fullyClosed = ["completed", "failed", "aborted"].includes(run.status) && run.endedAt !== undefined && !run.abort;
			const continuationEligible = fullyClosed && Boolean(run.sessionFile && run.leafId && run.cwd);
			const followUp = continuationEligible
				? `For follow-up work, call subagent with { continueFrom: "${formatShortRunId(run.id)}", task: "..." }.`
				: run.abort || (run.status === "aborted" && run.endedAt === undefined)
					? "This run is stopping; wait for it to fully close, then check its status before continuing."
					: !fullyClosed
						? `This run is ${run.status}; wait for it to finish and check its status before continuing.`
						: "This run is closed but not eligible for continuation; check its status for details.";
			return `- ${formatShortRunId(run.id)} = ${run.id} (${run.status} ${run.agent}); ${statusGuidance} ${followUp}`;
		});
	return lines.length > 0 ? `Subagent run refs:\n${lines.join("\n")}` : undefined;
}

export async function confirmProjectAgentIfNeeded(
	ctx: ExtensionContext,
	discovery: ReturnType<typeof discoverAgents>,
	agent: AgentConfig,
	confirmProjectAgents: boolean,
): Promise<boolean> {
	if (agent.source !== "project" || !confirmProjectAgents || !ctx.hasUI) return true;
	const ok = await ctx.ui.confirm(
		"Run project-local agent?",
		`Agent: ${agent.name}\nSource: ${discovery.projectAgentsDir ?? "(unknown)"}\n\nProject agents are repo-controlled prompts. Only continue for trusted repositories.`,
	);
	return Boolean(ok);
}

export interface StartAgentParams {
	task?: string;
	agent?: string;
	agentScope?: AgentScope;
	confirmProjectAgents?: boolean;
	cwd?: string;
	sourceRun?: SubagentRun;
	signal?: AbortSignal;
	onUpdate?: OnUpdateCallback;
	parentRunId?: string;
	step?: number;
}

/** Start one managed child run and return its handle without awaiting completion. */
export async function startAgent(pi: ExtensionAPI, ctx: ExtensionContext, params: StartAgentParams, lifecycle?: OwnerRunLifecycle): Promise<StartedAgentRun> {
	const ownerSessionId = getMainSessionOwnerId(ctx);
	// Capture the runtime signal before any interactive confirmation can await.
	// A shutdown during confirmation must not recreate a fresh owner controller.
	const runSignal = lifecycle?.signalFor(ownerSessionId, params.signal) ?? params.signal;
	const task = params.task?.trim();
	if (!task) return { ok: false, message: "subagent requires a task." };

	const sourceRun = params.sourceRun;
	const agentScope: AgentScope = params.agentScope ?? sourceRun?.agentScope ?? (sourceRun?.agentSource === "project" ? "both" : "user");
	const discovery = discoverAgentsWithSettings(ctx.cwd, agentScope, ctx.isProjectTrusted());
	const agentName = sourceRun ? (params.agent ?? sourceRun.agent) : chooseBackgroundAgent(discovery.agents, params.agent);
	if (!agentName) return { ok: false, message: "No subagents available." };

	const agent = discovery.agents.find((candidate) => candidate.name === agentName);
	if (!agent) {
		const list = formatAgentList(discovery.agents);
		return { ok: false, message: `Unknown agent: "${agentName}". Available agents:\n${list.text}${list.remaining ? `\n... and ${list.remaining} more` : ""}` };
	}

	const ok = await confirmProjectAgentIfNeeded(ctx, discovery, agent, params.confirmProjectAgents ?? true);
	if (!ok) return { ok: false, message: "Canceled: project-local agent not approved." };
	if (runSignal?.aborted) return { ok: false, message: "Canceled: session is shutting down." };

	const fallbackModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
	let fallbackThinkingLevel: string | undefined;
	try { fallbackThinkingLevel = pi.getThinkingLevel(); } catch { fallbackThinkingLevel = undefined; }

	const makeDetails = (results: SingleResult[]): SubagentDetails => ({
		mode: "single",
		agentScope,
		packageAgentsDir: discovery.packageAgentsDir,
		userAgentsDir: discovery.userAgentsDir,
		projectAgentsDir: discovery.projectAgentsDir,
		results: results.map(toParentResult),
	});
	let createdRun: SubagentRun | undefined;
	const completion = runSingleAgent({
		mode: params.parentRunId ? "chain" : "single",
		defaultCwd: ctx.cwd,
		agents: discovery.agents,
		agentName,
		fallbackModel,
		fallbackThinkingLevel,
		task,
		cwd: sourceRun?.cwd ?? params.cwd,
		step: params.step,
		parentRunId: params.parentRunId,
		agentScope,
		ownerSessionId,
		continueFrom: sourceRun ? { runId: sourceRun.id, sessionFile: sourceRun.sessionFile!, leafId: sourceRun.leafId! } : undefined,
		signal: runSignal,
		onUpdate: params.onUpdate,
		makeDetails,
		onRunCreated: (run) => {
			createdRun = run;
			lifecycle?.track(run);
		},
	});

	if (!createdRun) return { ok: false, message: "Failed to start subagent." };
	return { ok: true, run: createdRun, completion, agentScope };
}

export interface DeleteRunResult {
	deleted: boolean;
	message?: string;
}

export class SubagentManager {
	private readonly pi: ExtensionAPI;
	private readonly onRunDeleted?: (run: SubagentRun) => void;
	private readonly lifecycle?: OwnerRunLifecycle;
	private readonly store: SubagentRunStore;
	private readonly onBackgroundRun?: (run: SubagentRun, completion: Promise<SingleResult>) => void;

	constructor(
		pi: ExtensionAPI,
		onRunDeleted?: (run: SubagentRun) => void,
		lifecycle?: OwnerRunLifecycle,
		store: SubagentRunStore = subagentRunStore,
		onBackgroundRun?: (run: SubagentRun, completion: Promise<SingleResult>) => void,
	) {
		this.pi = pi;
		this.onRunDeleted = onRunDeleted;
		this.lifecycle = lifecycle;
		this.store = store;
		this.onBackgroundRun = onBackgroundRun;
	}

	listRuns(): SubagentRun[] {
		return this.store.getSnapshot();
	}

	findRun(runId: string | undefined, runs = this.listRuns()): SubagentRun | undefined {
		return findRunByRef(runId, runs);
	}

	stopRun(runId: string): boolean {
		return this.store.abort(runId);
	}

	/**
	 * Stop a live process before unlinking its persisted session. Do not remove
	 * the run or write its tombstone until all cleanup checks succeed, so a
	 * retry remains possible after a filesystem or safety-check failure.
	 */
	async deleteRun(runId: string): Promise<DeleteRunResult> {
		const initialRun = this.store.get(runId);
		if (!initialRun) return { deleted: false, message: "Unknown subagent run." };

		const stopped = await this.stopForDeletion(initialRun.id, initialRun.ownerSessionId);
		if ("message" in stopped) return { deleted: false, message: stopped.message };
		// Completion can discover sessionFile/leafId while an abort is in flight.
		// Read the settled record so that file is retained neither accidentally nor
		// by deleting a stale pre-abort descriptor.
		const run = this.store.get(initialRun.id, initialRun.ownerSessionId);
		if (!run) return { deleted: false, message: "Run disappeared while stopping it for deletion." };

		if (run.sessionFile) {
			const sharedFile = this.store.getSnapshot(run.ownerSessionId).some((other) =>
				other.id !== run.id && other.sessionFile === run.sessionFile,
			);
			if (sharedFile) {
				return { deleted: false, message: "Refusing to delete a child session file referenced by another run." };
			}
			if (!run.sessionId) {
				return { deleted: false, message: "Refusing to delete a child session file without its session id." };
			}
			try {
				await cleanupChildSession(run.sessionFile, run.sessionId);
			} catch (error) {
				return { deleted: false, message: `Failed to clean up child session: ${error instanceof Error ? error.message : String(error)}` };
			}
		}

		const deleted = this.store.remove(run.id, run.ownerSessionId);
		if (!deleted) return { deleted: false, message: "Run disappeared before deletion could complete." };
		this.onRunDeleted?.(run);
		return { deleted: true };
	}

	private async stopForDeletion(runId: string, ownerSessionId: string): Promise<{ ok: true } | { ok: false; message: string }> {
		const initial = this.store.get(runId, ownerSessionId);
		if (!initial) return { ok: false, message: "Run disappeared while stopping it for deletion." };
		if (initial.endedAt !== undefined) return { ok: true };

		// Hydrated pointers can still say queued/running, but their original
		// extension runtime (and thus their abort handle) no longer exists. Do
		// not spend the live-run timeout on those stale records: close them
		// defensively before applying the normal managed-file safeguards.
		const runtimeOwned = this.lifecycle ? this.lifecycle.owns(ownerSessionId, runId) : Boolean(initial.abort);
		if (!runtimeOwned) {
			this.store.update(runId, { status: "aborted", endedAt: Date.now(), abort: undefined }, ownerSessionId);
			return { ok: true };
		}

		const deadline = Date.now() + 7_000;
		while (Date.now() < deadline) {
			const run = this.store.get(runId, ownerSessionId);
			if (!run) return { ok: false, message: "Run disappeared while stopping it for deletion." };
			if (run.endedAt !== undefined) return { ok: true };
			run.abort?.();
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		return { ok: false, message: "Timed out waiting for the running subagent to stop; its session was not deleted." };
	}

	async startAgent(ctx: ExtensionContext, params: StartAgentParams, notify = true): Promise<StartedAgentRun> {
		const result = await startAgent(this.pi, ctx, params, this.lifecycle);
		if (!result.ok) return result;
		const completionNotification = notify ? "pending" as const : "suppressed" as const;
		const run = this.store.update(result.run.id, { completionNotification }, result.run.ownerSessionId) ?? { ...result.run, completionNotification };
		if (notify) this.onBackgroundRun?.(run, result.completion);
		return { ...result, run };
	}
}

