import type { AgentConfig, AgentScope } from "./agents.ts";
import { getFinalOutput, getResultOutput, isFailedResult, toParentResult } from "./results.ts";
import { runSingleAgent } from "./runner.ts";
import { makeEmptyUsage, subagentRunStore } from "./store.ts";
import type { OnUpdateCallback, SingleResult, SubagentDetails, SubagentRun, TaskItem, UsageStats } from "./types.ts";

export interface ChainExecutionResult {
	run: SubagentRun;
	results: SingleResult[];
	status: "completed" | "failed" | "aborted";
	finalOutput: string;
	errorMessage?: string;
}

export interface ChainRunHandle {
	run: SubagentRun;
	completion: Promise<ChainExecutionResult>;
}

export interface StartChainOptions {
	defaultCwd: string;
	agents: AgentConfig[];
	steps: TaskItem[];
	fallbackModel?: string;
	fallbackThinkingLevel?: string;
	agentScope: AgentScope;
	ownerSessionId: string;
	completionNotification: SubagentRun["completionNotification"];
	signal?: AbortSignal;
	onUpdate?: OnUpdateCallback;
	makeDetails: (results: SingleResult[]) => SubagentDetails;
	onParentCreated?: (run: SubagentRun) => void;
	onChildCreated?: (run: SubagentRun) => void;
}

function aggregateUsage(results: SingleResult[]): UsageStats {
	const usage = makeEmptyUsage();
	for (const result of results) {
		usage.input += result.usage.input;
		usage.output += result.usage.output;
		usage.cacheRead += result.usage.cacheRead;
		usage.cacheWrite += result.usage.cacheWrite;
		usage.cost += result.usage.cost;
		usage.contextTokens = Math.max(usage.contextTokens, result.usage.contextTokens);
		usage.turns += result.usage.turns;
	}
	return usage;
}

/** Start a synthetic chain parent immediately; child steps remain normal managed runs. */
export function startChain(options: StartChainOptions): ChainRunHandle {
	const controller = new AbortController();
	const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
	const summary = `${options.steps.length} steps: ${options.steps.map((step) => step.agent).join(" → ")}`;
	const parent = subagentRunStore.create({
		mode: "chain",
		ownerSessionId: options.ownerSessionId,
		agent: "chain",
		agentSource: "unknown",
		agentScope: options.agentScope,
		task: summary,
		cwd: options.defaultCwd,
		childRunIds: [],
		completionNotification: options.completionNotification,
	});
	const abort = () => controller.abort();
	subagentRunStore.update(parent.id, { status: "running", abort, currentTool: "starting chain" }, options.ownerSessionId);
	const trackedParent = subagentRunStore.get(parent.id, options.ownerSessionId) ?? parent;
	options.onParentCreated?.(trackedParent);

	const completion = (async (): Promise<ChainExecutionResult> => {
		const results: SingleResult[] = [];
		let previousOutput = "";
		let finalOutput = "";
		let terminalStatus: ChainExecutionResult["status"] = "completed";
		let errorMessage: string | undefined;

		try {
			for (let index = 0; index < options.steps.length; index++) {
				if (signal.aborted) throw new Error("Subagent was aborted");
				const step = options.steps[index];
				const task = step.task.replace(/\{previous\}/g, previousOutput);
				subagentRunStore.update(parent.id, { currentTool: `step ${index + 1}/${options.steps.length}: ${step.agent}` }, options.ownerSessionId);
				const result = await runSingleAgent({
					mode: "chain",
					defaultCwd: options.defaultCwd,
					agents: options.agents,
					agentName: step.agent,
					fallbackModel: options.fallbackModel,
					fallbackThinkingLevel: options.fallbackThinkingLevel,
					task,
					cwd: step.cwd,
					step: index + 1,
					parentRunId: parent.id,
					completionNotification: "suppressed",
					agentScope: options.agentScope,
					ownerSessionId: options.ownerSessionId,
					signal,
					onRunCreated: (run) => {
						const current = subagentRunStore.get(parent.id, options.ownerSessionId);
						subagentRunStore.update(parent.id, { childRunIds: [...(current?.childRunIds ?? []), run.id] }, options.ownerSessionId);
						options.onChildCreated?.(run);
					},
					onUpdate: options.onUpdate
						? (partial) => {
							const current = partial.details?.results[0];
							if (current) options.onUpdate?.({ content: partial.content, details: { ...options.makeDetails(results), results: [...results.map(toParentResult), current] } });
						}
						: undefined,
					makeDetails: options.makeDetails,
				});
				results.push(result);
				if (isFailedResult(result)) {
					terminalStatus = result.stopReason === "aborted" || signal.aborted ? "aborted" : "failed";
					errorMessage = `Chain stopped at step ${index + 1} (${step.agent}): ${getResultOutput(result)}`;
					finalOutput = errorMessage;
					break;
				}
				previousOutput = getFinalOutput(result.messages);
				finalOutput = previousOutput || "(no output)";
			}
		} catch (error) {
			const currentParent = subagentRunStore.get(parent.id, options.ownerSessionId);
			const activeChildId = currentParent?.childRunIds?.at(-1);
			const activeChild = activeChildId ? subagentRunStore.get(activeChildId, options.ownerSessionId) : undefined;
			const message = error instanceof Error ? error.message : String(error);
			const childAborted = activeChild?.status === "aborted" || (error instanceof Error && error.name === "AbortError") || /Subagent was aborted/i.test(message);
			terminalStatus = signal.aborted || childAborted ? "aborted" : "failed";
			errorMessage = message;
			finalOutput = errorMessage;
		}

		const usage = aggregateUsage(results);
		const endedAt = Date.now();
		subagentRunStore.update(parent.id, {
			status: terminalStatus,
			endedAt,
			abort: undefined,
			currentTool: undefined,
			usage,
			finalOutput: finalOutput || undefined,
			errorMessage: terminalStatus === "completed" ? undefined : errorMessage,
		}, options.ownerSessionId);
		return {
			run: subagentRunStore.get(parent.id, options.ownerSessionId) ?? { ...trackedParent, status: terminalStatus, endedAt },
			results,
			status: terminalStatus,
			finalOutput: finalOutput || "(no output)",
			errorMessage,
		};
	})();

	return { run: trackedParent, completion };
}
