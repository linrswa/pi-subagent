import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { AgentConfig, AgentScope } from "./agents.ts";
import { branchChildSession, cleanupChildSession, createFreshChildSession, findChildSession, getChildSessionOwnerId } from "./child-sessions.ts";
import { getFinalOutput, getLastToolCallName, getTerminalRunStatus } from "./results.ts";
import { makeEmptyUsage, subagentRunStore } from "./store.ts";
import type { AgentMessage, ContinuationSource, OnUpdateCallback, RunStatus, SingleResult, SubagentDetails, SubagentMode, SubagentRun, SubagentRunPatch } from "./types.ts";

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

export interface RunSingleAgentOptions {
	mode: SubagentMode;
	defaultCwd: string;
	agents: AgentConfig[];
	agentName: string;
	fallbackModel?: string;
	fallbackThinkingLevel?: string;
	task: string;
	cwd?: string;
	step?: number;
	/** Child-session pointer metadata only; never child-session history. */
	agentScope?: AgentScope;
	/** Main-session id, or a process-local runtime owner for ephemeral parents. */
	ownerSessionId?: string;
	sessionId?: string;
	sessionDir?: string;
	sessionFile?: string;
	leafId?: string;
	/** Fork this completed child-session checkpoint instead of starting fresh. */
	continueFrom?: ContinuationSource;
	/** @deprecated Internal metadata retained for existing callers. Use continueFrom. */
	continuedFromRunId?: string;
	/** @deprecated Internal metadata retained for existing callers. Use continueFrom. */
	continuedFromLeafId?: string;
	signal?: AbortSignal;
	onUpdate?: OnUpdateCallback;
	makeDetails: (results: SingleResult[]) => SubagentDetails;
	onRunCreated?: (run: SubagentRun) => void;
}

export async function runSingleAgent({
	mode,
	defaultCwd,
	agents,
	agentName,
	fallbackModel,
	fallbackThinkingLevel,
	task,
	cwd,
	step,
	agentScope,
	ownerSessionId,
	sessionId: suppliedSessionId,
	sessionDir: suppliedSessionDir,
	sessionFile: suppliedSessionFile,
	leafId: suppliedLeafId,
	continueFrom,
	continuedFromRunId: suppliedContinuedFromRunId,
	continuedFromLeafId: suppliedContinuedFromLeafId,
	signal,
	onUpdate,
	makeDetails,
	onRunCreated,
}: RunSingleAgentOptions): Promise<SingleResult> {
	const runCwd = resolveChildCwd(defaultCwd, cwd);
	// Capture this before any await: later session switches must not redirect updates.
	const runOwnerSessionId = getChildSessionOwnerId(ownerSessionId ?? subagentRunStore.getActiveOwner());
	const continuedFromRunId = continueFrom?.runId ?? suppliedContinuedFromRunId;
	const continuedFromLeafId = continueFrom?.leafId ?? suppliedContinuedFromLeafId;
	const agent = agents.find((candidate) => candidate.name === agentName);
	const selectedModel = agent?.model ?? fallbackModel;
	let wasAborted = false;
	let queuedSetupPending = false;
	let queuedTerminal = false;
	// Create synchronously, before child-session setup. A shutdown can therefore
	// abort a queued run instead of racing an untracked async setup operation.
	const run = subagentRunStore.create({
		mode, ownerSessionId: runOwnerSessionId, agent: agentName,
		agentSource: agent?.source ?? "unknown", task, step, cwd: runCwd,
		model: selectedModel, agentScope, sessionId: suppliedSessionId,
		sessionDir: suppliedSessionDir, sessionFile: suppliedSessionFile, leafId: suppliedLeafId,
		continuedFromRunId, continuedFromLeafId,
	});
	const terminalizeQueued = (status: "aborted" | "failed", errorMessage: string) => {
		if (queuedTerminal) return;
		queuedTerminal = true;
		subagentRunStore.update(run.id, {
			status, endedAt: Date.now(), currentTool: undefined,
			abort: undefined, errorMessage,
		}, runOwnerSessionId);
	};
	const abortQueued = () => {
		if (wasAborted) return;
		wasAborted = true;
		// Session branching/setup may still be awaiting. It can create a file, so
		// its continuation owns cleanup and publication of this terminal state.
		if (!queuedSetupPending) terminalizeQueued("aborted", "Subagent was aborted");
	};
	subagentRunStore.update(run.id, { abort: abortQueued }, runOwnerSessionId);
	onRunCreated?.(subagentRunStore.get(run.id, runOwnerSessionId) ?? run);
	const removeQueuedAbortListener = (() => {
		if (!signal) return () => {};
		if (signal.aborted) abortQueued();
		else signal.addEventListener("abort", abortQueued, { once: true });
		return () => signal.removeEventListener("abort", abortQueued);
	})();

	if (!agent) {
		removeQueuedAbortListener();
		if (wasAborted) throw new Error("Subagent was aborted");
		const sessionId = suppliedSessionId;
		const sessionDir = suppliedSessionDir;
		const sessionFile = suppliedSessionFile;
		const leafId = suppliedLeafId;
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
			errorMessage,
			step,
			agentScope,
			sessionId,
			sessionDir,
			sessionFile,
			leafId,
			continuedFromRunId,
			continuedFromLeafId,
		};
		subagentRunStore.update(run.id, {
			status: "failed",
			endedAt: Date.now(),
			errorMessage,
			abort: undefined,
			messages: failedResult.messages,
			usage: failedResult.usage,
		}, runOwnerSessionId);
		return failedResult;
	}

	if (wasAborted) {
		removeQueuedAbortListener();
		throw new Error("Subagent was aborted");
	}
	// A continuation forks before spawning: the source file is never opened by
	// the child process, so concurrent sibling continuations cannot write it.
	let branchedSession: Awaited<ReturnType<typeof branchChildSession>> | undefined;
	let freshSession: Awaited<ReturnType<typeof createFreshChildSession>> | undefined;
	const cleanupBranchedSession = async () => {
		if (!branchedSession?.sessionFile) return;
		// The managed-path and exact-session-id checks ensure this can never remove
		// the continuation source (or another run's branch).
		await cleanupChildSession(branchedSession.sessionFile, branchedSession.sessionId).catch(() => {});
		// Do not leave a terminal run pointing at a branch which was deliberately
		// removed. The continuation source metadata remains intact.
		subagentRunStore.update(run.id, { sessionFile: undefined, leafId: undefined }, runOwnerSessionId);
	};
	queuedSetupPending = true;
	try {
		branchedSession = continueFrom ? await branchChildSession(continueFrom) : undefined;
		freshSession = !branchedSession && !(suppliedSessionId && suppliedSessionDir)
			? await createFreshChildSession(runOwnerSessionId)
			: undefined;
	} catch (error) {
		queuedSetupPending = false;
		removeQueuedAbortListener();
		await cleanupBranchedSession();
		terminalizeQueued(wasAborted ? "aborted" : "failed", wasAborted ? "Subagent was aborted" : error instanceof Error ? error.message : String(error));
		throw error;
	}
	const sessionId = branchedSession?.sessionId ?? suppliedSessionId ?? freshSession!.sessionId;
	const sessionDir = branchedSession?.sessionDir ?? suppliedSessionDir ?? freshSession!.sessionDir;
	const sessionFile = branchedSession?.sessionFile ?? suppliedSessionFile;
	const leafId = branchedSession?.leafId ?? suppliedLeafId;
	subagentRunStore.update(run.id, { sessionId, sessionDir, sessionFile, leafId }, runOwnerSessionId);
	if (wasAborted) {
		queuedSetupPending = false;
		removeQueuedAbortListener();
		await cleanupBranchedSession();
		terminalizeQueued("aborted", "Subagent was aborted");
		throw new Error("Subagent was aborted");
	}

	const args: string[] = ["--mode", "json", "-p"];
	if (branchedSession?.sessionFile) {
		args.push("--session", branchedSession.sessionFile);
	} else {
		args.push("--session-id", sessionId, "--session-dir", sessionDir);
	}
	args.push("--exclude-tools", "subagent,bg_agent,subagent_schedule");
	if (selectedModel) args.push("--model", selectedModel);
	if (!agent.model && fallbackThinkingLevel) args.push("--thinking", fallbackThinkingLevel);
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

	let tmpPromptDir: string | undefined;
	let tmpPromptPath: string | undefined;
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
		step,
		agentScope,
		sessionId,
		sessionDir,
		sessionFile,
		leafId,
		continuedFromRunId,
		continuedFromLeafId,
	};

	const syncRun = (patch: SubagentRunPatch = {}) => {
		if (patch.status) runStatus = patch.status;
		const finalOutput = getFinalOutput(currentResult.messages);
		subagentRunStore.update(run.id, {
			status: runStatus,
			messages: currentResult.messages,
			usage: currentResult.usage,
			model: currentResult.model,
			finalOutput: finalOutput || undefined,
			errorMessage: currentResult.errorMessage || undefined,
			...patch,
		}, runOwnerSessionId);
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
		if (wasAborted) {
			queuedSetupPending = false;
			removeQueuedAbortListener();
			await cleanupBranchedSession();
			terminalizeQueued("aborted", "Subagent was aborted");
			throw new Error("Subagent was aborted");
		}

		// A branched Pi session already supplies conversation context. Its prompt
		// must be only the newly requested task, never reconstructed history.
		args.push(branchedSession ? task : `Task: ${task}`);

		const exitCode = await new Promise<number>((resolve) => {
			// From here spawn is synchronous and installs its own abort listener.
			queuedSetupPending = false;
			removeQueuedAbortListener();
			const invocation = getPiInvocation(args);
			let buffer = "";
			let forceKillTimer: ReturnType<typeof setTimeout> | undefined;

			const proc = spawn(invocation.command, invocation.args, {
				cwd: runCwd,
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

		// Pi owns the JSONL format. Resolve its persisted checkpoint only after
		// the child exits; no child transcript is read into this process.
		const persisted = await findChildSession(sessionId, runCwd, sessionDir);
		if (persisted) {
			currentResult.sessionFile = persisted.sessionFile;
			currentResult.leafId = persisted.leafId;
			syncRun({ sessionFile: persisted.sessionFile, leafId: persisted.leafId });
		}

		if (wasAborted) throw new Error("Subagent was aborted");
		if (getTerminalRunStatus(currentResult) === "completed" && (!currentResult.sessionFile || !currentResult.leafId)) {
			currentResult.exitCode = 1;
			currentResult.errorMessage = "Child completed without a persisted session checkpoint";
		}
		markTerminal(getTerminalRunStatus(currentResult));
		return currentResult;
	} catch (error) {
		if (queuedTerminal) throw error;
		if (queuedSetupPending) {
			queuedSetupPending = false;
			removeQueuedAbortListener();
			await cleanupBranchedSession();
			terminalizeQueued(wasAborted ? "aborted" : "failed", wasAborted ? "Subagent was aborted" : error instanceof Error ? error.message : String(error));
			throw error;
		}
		const message = error instanceof Error ? error.message : String(error);
		const aborted = wasAborted || currentResult.stopReason === "aborted";
		// Once spawned, an aborted continuation remains a valid persisted checkpoint
		// and must stay available for status, continuation, and explicit retention cleanup.
		currentResult.errorMessage ??= message;
		if (currentResult.exitCode === 0 || currentResult.exitCode === -1) currentResult.exitCode = wasAborted ? 130 : 1;
		markTerminal(aborted ? "aborted" : "failed");
		throw error;
	} finally {
		if (tmpPromptDir) await fs.promises.rm(tmpPromptDir, { recursive: true, force: true }).catch(() => {});
	}
}

