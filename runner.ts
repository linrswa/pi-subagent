import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { AgentConfig, AgentScope } from "./agents.ts";
import { ChildRpcChannel } from "./child-rpc.ts";
import { branchChildSession, cleanupChildSession, createFreshChildSession, findChildSession, getChildSessionOwnerId } from "./child-sessions.ts";
import { childProcessPool, type ReleaseProcessSlot } from "./process-pool.ts";
import { getAssistantText, getFinalOutput, getLastToolCallName, getTerminalRunStatus } from "./results.ts";
import { makeEmptyUsage, subagentRunStore } from "./store.ts";
import type { AgentMessage, ContinuationSource, OnUpdateCallback, RunStatus, SingleResult, SubagentDetails, SubagentInputDelivery, SubagentMode, SubagentPendingInput, SubagentRun, SubagentRunPatch } from "./types.ts";

const LIVE_TEXT_CAP = 12_000;

function capLiveText(text: string): string {
	return text.length > LIVE_TEXT_CAP ? `...[truncated ${text.length - LIVE_TEXT_CAP} chars]\n${text.slice(-LIVE_TEXT_CAP)}` : text;
}

function normalizeAgentMessage(message: AgentMessage): AgentMessage {
	const content = typeof message.content === "string"
		? [{ type: "text" as const, text: message.content }]
		: Array.isArray(message.content) ? message.content : [];
	return { ...message, content };
}

function textFromRpcResult(value: unknown): string | undefined {
	if (!value || typeof value !== "object") return undefined;
	const content = (value as { content?: unknown }).content;
	if (!Array.isArray(content)) return undefined;
	const text = content
		.filter((part): part is { type: "text"; text: string } => Boolean(part && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string"))
		.map((part) => part.text)
		.join("\n");
	return text || undefined;
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
	/** Synthetic chain run which owns this child step. */
	parentRunId?: string;
	completionNotification?: SubagentRun["completionNotification"];
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
	parentRunId,
	completionNotification,
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
	let releaseProcessSlot: ReleaseProcessSlot | undefined;
	let rpcChannel: ChildRpcChannel | undefined;
	let promptAccepted = false;
	let flushingInputs = false;
	const pendingInputs: SubagentPendingInput[] = [];
	let remotePendingInputs: SubagentPendingInput[] = [];
	const queuedAbortController = new AbortController();
	// Create synchronously, before child-session setup. A shutdown can therefore
	// abort a queued run instead of racing an untracked async setup operation.
	const run = subagentRunStore.create({
		mode, ownerSessionId: runOwnerSessionId, agent: agentName,
		agentSource: agent?.source ?? "unknown", task, step, parentRunId, completionNotification, cwd: runCwd,
		model: selectedModel, agentScope, sessionId: suppliedSessionId,
		sessionDir: suppliedSessionDir, sessionFile: suppliedSessionFile, leafId: suppliedLeafId,
		continuedFromRunId, continuedFromLeafId,
	});
	const publishPendingInputs = () => {
		const combined = [...pendingInputs, ...remotePendingInputs];
		subagentRunStore.update(run.id, { pendingInputs: combined.length ? combined : undefined }, runOwnerSessionId);
	};
	const flushPendingInputs = async () => {
		if (!promptAccepted || !rpcChannel || flushingInputs) return;
		flushingInputs = true;
		try {
			while (pendingInputs.length > 0) {
				const input = pendingInputs.shift()!;
				publishPendingInputs();
				await rpcChannel.sendInput(input.message, input.delivery);
			}
		} finally {
			flushingInputs = false;
		}
	};
	const sendInput = async (message: string, delivery: SubagentInputDelivery): Promise<"queued" | "sent"> => {
		const trimmed = message.trim();
		if (!trimmed) throw new Error("Subagent instruction cannot be empty");
		if (wasAborted || queuedTerminal) throw new Error("Subagent is no longer accepting instructions");
		if (!promptAccepted || !rpcChannel || flushingInputs) {
			pendingInputs.push({ message: trimmed, delivery });
			publishPendingInputs();
			return "queued";
		}
		await rpcChannel.sendInput(trimmed, delivery);
		return "sent";
	};
	const terminalizeQueued = (status: "aborted" | "failed", errorMessage: string) => {
		if (queuedTerminal) return;
		queuedTerminal = true;
		subagentRunStore.update(run.id, {
			status, endedAt: Date.now(), currentTool: undefined,
			abort: undefined, sendInput: undefined, pendingInputs: undefined, errorMessage,
		}, runOwnerSessionId);
	};
	const abortQueued = () => {
		if (wasAborted) return;
		wasAborted = true;
		queuedAbortController.abort();
		// Session branching/setup or process-pool waiting may still be awaiting.
		// That continuation owns cleanup and publication of this terminal state.
		if (!queuedSetupPending) terminalizeQueued("aborted", "Subagent was aborted");
	};
	subagentRunStore.update(run.id, { abort: abortQueued, sendInput }, runOwnerSessionId);
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
			sendInput: undefined,
			pendingInputs: undefined,
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
		// Reserve the process slot before asynchronous session setup so FIFO order
		// follows run submission order rather than setup completion speed.
		releaseProcessSlot = await childProcessPool.acquire(queuedAbortController.signal);
		if (wasAborted) throw new Error("Subagent was aborted");
		branchedSession = continueFrom ? await branchChildSession(continueFrom) : undefined;
		freshSession = !branchedSession && !(suppliedSessionId && suppliedSessionDir)
			? await createFreshChildSession(runOwnerSessionId)
			: undefined;
	} catch (error) {
		queuedSetupPending = false;
		removeQueuedAbortListener();
		releaseProcessSlot?.();
		releaseProcessSlot = undefined;
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
		releaseProcessSlot?.();
		releaseProcessSlot = undefined;
		await cleanupBranchedSession();
		terminalizeQueued("aborted", "Subagent was aborted");
		throw new Error("Subagent was aborted");
	}

	const args: string[] = ["--mode", "rpc"];
	if (branchedSession?.sessionFile) {
		args.push("--session", branchedSession.sessionFile);
	} else {
		args.push("--session-id", sessionId, "--session-dir", sessionDir);
	}
	args.push("--exclude-tools", "subagent,subagent_schedule");
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
			currentToolArgs: undefined,
			liveMessage: undefined,
			liveToolOutput: undefined,
			pendingInputs: undefined,
			sendInput: undefined,
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
		const initialPrompt = branchedSession ? task : `Task: ${task}`;

		let exitCode: number;
		try {
			exitCode = await new Promise<number>((resolve) => {
				// From here spawn is synchronous and installs its own abort listener.
				queuedSetupPending = false;
				removeQueuedAbortListener();
				const invocation = getPiInvocation(args);
				let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
				let abortKillTimer: ReturnType<typeof setTimeout> | undefined;
				let agentSettled = false;
				let closingProcess = false;
				let closed = false;

				const proc = spawn(invocation.command, invocation.args, {
					cwd: runCwd,
					shell: false,
					stdio: ["pipe", "pipe", "pipe"],
				});

				const stopProcess = () => {
					if (closingProcess || closed) return;
					closingProcess = true;
					proc.kill("SIGTERM");
					forceKillTimer = setTimeout(() => proc.kill("SIGKILL"), 1_000);
				};

				const processMessage = (rawMessage: AgentMessage) => {
					const message = normalizeAgentMessage(rawMessage);
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
					emitUpdate({
						currentTool: lastToolName,
						liveMessage: undefined,
						...(message.role === "toolResult" ? { liveToolOutput: undefined } : {}),
					});
				};

				const processEvent = (rawEvent: Record<string, unknown>) => {
					const event = rawEvent as {
						type?: string;
						message?: AgentMessage;
						toolName?: string;
						args?: Record<string, unknown>;
						partialResult?: unknown;
						result?: unknown;
						steering?: string[];
						followUp?: string[];
					};

					if (event.type === "message_update" && event.message?.role === "assistant") {
						const message = normalizeAgentMessage(event.message);
						const lastToolName = getLastToolCallName(message);
						if (message.model) currentResult.model = message.model;
						const liveMessage = getAssistantText(message);
						syncRun({
							...(lastToolName ? { currentTool: lastToolName } : {}),
							liveMessage: liveMessage ? capLiveText(liveMessage) : undefined,
						});
					}

					if (event.type === "message_end" && event.message) processMessage(event.message);

					if (event.type === "tool_execution_start" && event.toolName) {
						syncRun({ currentTool: event.toolName, currentToolArgs: event.args, liveToolOutput: undefined });
					}
					if (event.type === "tool_execution_update" && event.toolName) {
						const output = textFromRpcResult(event.partialResult);
						syncRun({ currentTool: event.toolName, currentToolArgs: event.args, liveToolOutput: output ? capLiveText(output) : undefined });
					}
					if (event.type === "tool_execution_end" && event.toolName) {
						const output = textFromRpcResult(event.result);
						syncRun({ currentTool: undefined, currentToolArgs: undefined, ...(output ? { liveToolOutput: capLiveText(output) } : {}) });
					}
					if (event.type === "queue_update") {
						remotePendingInputs = [
							...(event.steering ?? []).map((message) => ({ message, delivery: "steer" as const })),
							...(event.followUp ?? []).map((message) => ({ message, delivery: "followUp" as const })),
						];
						publishPendingInputs();
					}
					if (event.type === "agent_settled") {
						agentSettled = true;
						stopProcess();
					}
				};

				rpcChannel = new ChildRpcChannel(proc.stdin, processEvent);

				const requestAbort = () => {
					if (wasAborted) return;
					wasAborted = true;
					currentResult.stopReason = "aborted";
					currentResult.errorMessage ??= "Subagent was aborted";
					syncRun({
						status: "aborted", currentTool: undefined, currentToolArgs: undefined,
						liveMessage: undefined, liveToolOutput: undefined, abort: undefined,
						sendInput: undefined, pendingInputs: undefined, errorMessage: currentResult.errorMessage,
					});
					void rpcChannel?.send({ type: "abort" }).catch(() => {});
					abortKillTimer = setTimeout(stopProcess, 500);
				};

				syncRun({ status: "running", abort: requestAbort, sendInput });

				proc.stdout.on("data", (data) => rpcChannel?.receive(data));
				proc.stderr.on("data", (data) => { currentResult.stderr += data.toString(); });

				const cleanupAbortListener = (() => {
					if (!signal) return () => {};
					if (signal.aborted) requestAbort();
					else signal.addEventListener("abort", requestAbort, { once: true });
					return () => signal.removeEventListener("abort", requestAbort);
				})();

				proc.on("close", (code, closeSignal) => {
					if (closed) return;
					closed = true;
					cleanupAbortListener();
					if (forceKillTimer) clearTimeout(forceKillTimer);
					if (abortKillTimer) clearTimeout(abortKillTimer);
					rpcChannel?.finish();
					const exitError = new Error(`Subagent RPC process exited (code=${code} signal=${closeSignal})`);
					rpcChannel?.close(exitError);
					if (!wasAborted && !agentSettled && !currentResult.errorMessage) {
						currentResult.errorMessage = exitError.message;
						currentResult.stderr += `${exitError.message}\n`;
					}
					resolve(wasAborted ? 130 : currentResult.errorMessage ? 1 : 0);
				});

				proc.on("error", (error) => {
					const message = error instanceof Error ? error.message : String(error);
					currentResult.stderr += `${message}\n`;
					currentResult.errorMessage ??= message;
					rpcChannel?.close(new Error(message));
					syncRun({ errorMessage: currentResult.errorMessage, currentTool: undefined, currentToolArgs: undefined, abort: undefined, sendInput: undefined });
					stopProcess();
				});

				void rpcChannel.send({ type: "prompt", message: initialPrompt })
					.then(async () => {
						promptAccepted = true;
						await flushPendingInputs();
					})
					.catch((error) => {
						if (wasAborted) return;
						const message = error instanceof Error ? error.message : String(error);
						currentResult.errorMessage ??= message;
						currentResult.stderr += `${message}\n`;
						syncRun({ errorMessage: currentResult.errorMessage, sendInput: undefined, pendingInputs: undefined });
						stopProcess();
					});
			});
		} finally {
			rpcChannel = undefined;
			releaseProcessSlot?.();
			releaseProcessSlot = undefined;
		}

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
		releaseProcessSlot?.();
		if (tmpPromptDir) await fs.promises.rm(tmpPromptDir, { recursive: true, force: true }).catch(() => {});
	}
}

