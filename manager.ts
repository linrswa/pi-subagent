import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions } from "@earendil-works/pi-tui";
import { type AgentConfig, type AgentScope, discoverAgents, discoverAgentsWithSettings, formatAgentList } from "./agents.ts";
import { MAX_AGENT_SUGGESTIONS } from "./constants.ts";
import { getResultOutput, isFailedResult } from "./results.ts";
import { runSingleAgent } from "./runner.ts";
import { subagentRunStore } from "./store.ts";
import { findRunByRef, formatShortRunId } from "./run-refs.ts";
import type { BgAgentParamsInput, SingleResult, StartBackgroundAgentResult, SubagentDetails, SubagentMode, SubagentParamsInput, SubagentRun } from "./types.ts";

function compactPreview(text: string | undefined, maxLength: number): string {
	const normalized = (text ?? "").replace(/\s+/g, " ").trim();
	if (!normalized) return "...";
	return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized;
}

export function getMode(params: SubagentParamsInput): SubagentMode | undefined {
	const hasChain = (params.chain?.length ?? 0) > 0;
	const hasTasks = (params.tasks?.length ?? 0) > 0;
	const hasSingle = Boolean(params.agent && params.task);
	const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);
	if (modeCount !== 1) return undefined;
	if (hasChain) return "chain";
	if (hasTasks) return "parallel";
	return "single";
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

export function getBgAgentCompletions(cwd: string, prefix: string): AutocompleteItem[] | null {
	if (/\s/.test(prefix.trim())) return null;
	const items = getAgentCompletions(cwd, prefix);
	return items.length > 0 ? items : null;
}

export function getRunRefCompletions(token: string): AutocompleteItem[] {
	const query = token.trim().toLowerCase();
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
			description: `${run.status} ${run.agent}: ${compactPreview(run.task, 80)}`,
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

export function buildRunRefContext(text: string): string | undefined {
	const refs = Array.from(new Set(Array.from(text.matchAll(/[&＆](\d+)/g), (match) => match[1])));
	const lines = refs
		.map((ref) => findRunByRef(ref))
		.filter((run): run is SubagentRun => Boolean(run))
		.map((run) => `- &${formatShortRunId(run.id).slice(1)} = ${run.id} (${run.status} ${run.agent}); use subagent_control runId ${formatShortRunId(run.id)} for status/ask/stop/delete.`);
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

export async function startBackgroundAgent(pi: ExtensionAPI, ctx: ExtensionContext, params: BgAgentParamsInput): Promise<StartBackgroundAgentResult> {
	const task = params.prompt?.trim();
	if (!task) return { ok: false, message: "bg_agent requires prompt." };

	const agentScope: AgentScope = params.agentScope ?? "user";
	const discovery = discoverAgentsWithSettings(ctx.cwd, agentScope, ctx.isProjectTrusted());
	const agentName = chooseBackgroundAgent(discovery.agents, params.agent);
	if (!agentName) return { ok: false, message: "No subagents available." };

	const agent = discovery.agents.find((candidate) => candidate.name === agentName);
	if (!agent) {
		const list = formatAgentList(discovery.agents);
		return { ok: false, message: `Unknown agent: "${agentName}". Available agents:\n${list.text}${list.remaining ? `\n... and ${list.remaining} more` : ""}` };
	}

	const ok = await confirmProjectAgentIfNeeded(ctx, discovery, agent, params.confirmProjectAgents ?? true);
	if (!ok) return { ok: false, message: "Canceled: project-local agent not approved." };

	const fallbackModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
	let fallbackThinkingLevel: string | undefined;
	try {
		fallbackThinkingLevel = pi.getThinkingLevel();
	} catch {
		fallbackThinkingLevel = undefined;
	}

	const makeDetails = (results: SingleResult[]): SubagentDetails => ({
		mode: "single",
		agentScope,
		packageAgentsDir: discovery.packageAgentsDir,
		userAgentsDir: discovery.userAgentsDir,
		projectAgentsDir: discovery.projectAgentsDir,
		results,
	});
	let createdRun: SubagentRun | undefined;
	const promise = runSingleAgent(
		"single",
		ctx.cwd,
		discovery.agents,
		agentName,
		fallbackModel,
		fallbackThinkingLevel,
		task,
		params.cwd,
		undefined,
		undefined,
		undefined,
		makeDetails,
		(run) => {
			createdRun = run;
		},
	);

	void promise
		.then((result) => {
			if (isFailedResult(result) && result.stopReason !== "aborted") {
				const runLabel = result.runId ? formatShortRunId(result.runId) : agentName;
				ctx.ui.notify(`Background ${runLabel} failed: ${compactPreview(getResultOutput(result), 160)}`, "error");
			}
		})
		.catch((error) => {
			const message = error instanceof Error ? error.message : String(error);
			if (message !== "Subagent was aborted") ctx.ui.notify(`Background ${agentName} failed: ${message}`, "error");
		});

	if (!createdRun) return { ok: false, message: "Failed to start background subagent." };
	return { ok: true, run: createdRun, agentScope };
}

export class SubagentManager {
	private readonly pi: ExtensionAPI;

	constructor(pi: ExtensionAPI) {
		this.pi = pi;
	}

	listRuns(): SubagentRun[] {
		return subagentRunStore.getSnapshot();
	}

	findRun(runId: string | undefined, runs = this.listRuns()): SubagentRun | undefined {
		return findRunByRef(runId, runs);
	}

	stopRun(runId: string): boolean {
		return subagentRunStore.abort(runId);
	}

	deleteRun(runId: string): boolean {
		return subagentRunStore.remove(runId);
	}

	startBackground(ctx: ExtensionContext, params: BgAgentParamsInput): Promise<StartBackgroundAgentResult> {
		return startBackgroundAgent(this.pi, ctx, params);
	}
}

