import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { normalizePonytailMode, type AgentConfig, type PonytailMode } from "./agents.ts";
import { getFinalOutput, getLastToolCallName, getTerminalRunStatus } from "./results.ts";
import { makeEmptyUsage, subagentRunStore } from "./store.ts";
import type { AgentMessage, OnUpdateCallback, RunStatus, SingleResult, SubagentDetails, SubagentMode, SubagentRun, SubagentRunPatch } from "./types.ts";

export async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) return { command: process.execPath, args };

	return { command: "pi", args };
}

function resolveChildCwd(defaultCwd: string, cwd: string | undefined): string {
	return cwd ? path.resolve(defaultCwd, cwd) : defaultCwd;
}

export function getChildEnv(ponytailMode: PonytailMode | undefined): NodeJS.ProcessEnv | undefined {
	return ponytailMode ? { ...process.env, PONYTAIL_DEFAULT_MODE: ponytailMode } : undefined;
}

export async function runSingleAgent(
	mode: SubagentMode,
	defaultCwd: string,
	agents: AgentConfig[],
	agentName: string,
	fallbackModel: string | undefined,
	fallbackThinkingLevel: string | undefined,
	ponytailMode: PonytailMode | undefined,
	task: string,
	cwd: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	onRunCreated?: (run: SubagentRun) => void,
): Promise<SingleResult> {
	const runCwd = resolveChildCwd(defaultCwd, cwd);
	const agent = agents.find((candidate) => candidate.name === agentName);
	const selectedModel = agent?.model ?? fallbackModel;
	const selectedPonytailMode = normalizePonytailMode(ponytailMode) ?? agent?.ponytailMode;
	const run = subagentRunStore.create({
		mode,
		agent: agentName,
		agentSource: agent?.source ?? "unknown",
		task,
		step,
		cwd: runCwd,
		model: selectedModel,
		ponytailMode: selectedPonytailMode,
	});
	onRunCreated?.(run);

	if (!agent) {
		const available = agents.map((candidate) => `"${candidate.name}"`).join(", ") || "none";
		const errorMessage = `Unknown agent: "${agentName}". Available agents: ${available}.`;
		const failedResult: SingleResult = {
			runId: run.id,
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: errorMessage,
			usage: makeEmptyUsage(),
			ponytailMode: selectedPonytailMode,
			errorMessage,
			step,
		};
		subagentRunStore.update(run.id, {
			status: "failed",
			endedAt: Date.now(),
			errorMessage,
			messages: failedResult.messages,
			usage: failedResult.usage,
		});
		return failedResult;
	}

	const args: string[] = ["--mode", "json", "-p", "--no-session", "--exclude-tools", "subagent,bg_agent,subagent_schedule"];
	if (selectedModel) args.push("--model", selectedModel);
	if (!agent.model && fallbackThinkingLevel) args.push("--thinking", fallbackThinkingLevel);
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

	let tmpPromptDir: string | undefined;
	let tmpPromptPath: string | undefined;
	let wasAborted = false;
	let runStatus: RunStatus = "queued";

	const currentResult: SingleResult = {
		runId: run.id,
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: -1,
		messages: [],
		stderr: "",
		usage: makeEmptyUsage(),
		model: selectedModel,
		ponytailMode: selectedPonytailMode,
		step,
	};

	const syncRun = (patch: SubagentRunPatch = {}) => {
		if (patch.status) runStatus = patch.status;
		const finalOutput = getFinalOutput(currentResult.messages);
		subagentRunStore.update(run.id, {
			status: runStatus,
			messages: currentResult.messages,
			usage: currentResult.usage,
			model: currentResult.model,
			ponytailMode: currentResult.ponytailMode,
			finalOutput: finalOutput || undefined,
			errorMessage: currentResult.errorMessage || undefined,
			...patch,
		});
	};

	const emitUpdate = (patch: SubagentRunPatch = {}) => {
		syncRun(patch);
		onUpdate?.({
			content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
			details: makeDetails([currentResult]),
		});
	};

	const markTerminal = (status: "completed" | "failed" | "aborted") => {
		const errorMessage = status === "completed" ? currentResult.errorMessage : currentResult.errorMessage || currentResult.stderr.trim() || undefined;
		syncRun({
			status,
			endedAt: Date.now(),
			currentTool: undefined,
			abort: undefined,
			errorMessage,
		});
	};

	try {
		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		args.push(`Task: ${task}`);

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			let buffer = "";
			let forceKillTimer: ReturnType<typeof setTimeout> | undefined;

			const childEnv = getChildEnv(selectedPonytailMode);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: runCwd,
				...(childEnv ? { env: childEnv } : {}),
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});

			const requestAbort = () => {
				if (wasAborted) return;
				wasAborted = true;
				currentResult.stopReason = "aborted";
				currentResult.errorMessage ??= "Subagent was aborted";
				syncRun({ status: "aborted", currentTool: undefined, abort: undefined, errorMessage: currentResult.errorMessage });
				proc.kill("SIGTERM");
				forceKillTimer = setTimeout(() => proc.kill("SIGKILL"), 5000);
			};

			syncRun({ status: "running", abort: requestAbort });

			const processMessage = (message: AgentMessage) => {
				currentResult.messages.push(message);
				const lastToolName = getLastToolCallName(message);
				if (message.role === "assistant") {
					currentResult.usage.turns++;
					const usage = message.usage;
					if (usage) {
						currentResult.usage.input += usage.input ?? 0;
						currentResult.usage.output += usage.output ?? 0;
						currentResult.usage.cacheRead += usage.cacheRead ?? 0;
						currentResult.usage.cacheWrite += usage.cacheWrite ?? 0;
						currentResult.usage.cost += usage.cost?.total ?? 0;
						currentResult.usage.contextTokens = usage.totalTokens ?? currentResult.usage.contextTokens;
					}
					if (message.model) currentResult.model = message.model;
					if (message.stopReason) currentResult.stopReason = message.stopReason;
					if (message.errorMessage) currentResult.errorMessage = message.errorMessage;
				}
				emitUpdate({ currentTool: lastToolName });
			};

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: {
					type?: string;
					message?: AgentMessage;
					isError?: boolean;
					result?: unknown;
					toolName?: string;
					args?: unknown;
					partialResult?: unknown;
				};
				try {
					event = JSON.parse(line) as typeof event;
				} catch {
					return;
				}

				if (event.type === "message_update" && event.message?.role === "assistant") {
					const lastToolName = getLastToolCallName(event.message);
					if (event.message.model) currentResult.model = event.message.model;
					syncRun(lastToolName ? { currentTool: lastToolName } : {});
				}

				if (event.type === "message_end" && event.message) {
					if (event.message.role === "assistant") processMessage(event.message);
				}

				if ((event.type === "tool_execution_start" || event.type === "tool_execution_update") && event.toolName) {
					syncRun({ currentTool: event.toolName });
				}

				if (event.type === "tool_execution_end" && event.toolName) {
					syncRun({ currentTool: undefined });
				}

				// Some pi versions also emit tool_result_end. Keep these messages in details
				// for debugging, but they are not used for final-output extraction.
				if (event.type === "tool_result_end" && event.message) {
					currentResult.messages.push(event.message);
					emitUpdate({ currentTool: undefined });
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				currentResult.stderr += data.toString();
			});

			const cleanupAbortListener = (() => {
				if (!signal) return () => {};
				if (signal.aborted) requestAbort();
				else signal.addEventListener("abort", requestAbort, { once: true });
				return () => signal.removeEventListener("abort", requestAbort);
			})();

			proc.on("close", (code) => {
				cleanupAbortListener();
				if (forceKillTimer) clearTimeout(forceKillTimer);
				if (buffer.trim()) processLine(buffer);
				resolve(code ?? (wasAborted ? 130 : 0));
			});

			proc.on("error", (error) => {
				cleanupAbortListener();
				if (forceKillTimer) clearTimeout(forceKillTimer);
				const message = error instanceof Error ? error.message : String(error);
				currentResult.stderr += `${message}\n`;
				currentResult.errorMessage ??= message;
				syncRun({ errorMessage: currentResult.errorMessage, currentTool: undefined, abort: undefined });
				resolve(1);
			});
		});

		currentResult.exitCode = exitCode;
		if (wasAborted) throw new Error("Subagent was aborted");
		markTerminal(getTerminalRunStatus(currentResult));
		return currentResult;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		currentResult.errorMessage ??= message;
		if (currentResult.exitCode === 0 || currentResult.exitCode === -1) currentResult.exitCode = wasAborted ? 130 : 1;
		markTerminal(wasAborted || currentResult.stopReason === "aborted" ? "aborted" : "failed");
		throw error;
	} finally {
		if (tmpPromptDir) await fs.promises.rm(tmpPromptDir, { recursive: true, force: true }).catch(() => {});
	}
}

