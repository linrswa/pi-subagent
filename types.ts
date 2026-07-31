import type { AgentScope, AgentSource } from "./agents.ts";

export type SubagentMode = "single" | "chain";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "aborted";
export type CompletionNotificationState = "pending" | "delivered" | "suppressed";
export type SubagentInputDelivery = "steer" | "followUp";
export type SubagentPendingInput = { message: string; delivery: SubagentInputDelivery };

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export type TextContent = { type: "text"; text: string };
export type ToolCallContent = { type: "toolCall"; name: string; arguments: Record<string, unknown> };
export type MessageContent = TextContent | ToolCallContent | { type: string; [key: string]: unknown };

export interface AgentMessage {
	role: string;
	content: MessageContent[];
	usage?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		cost?: { total?: number };
		totalTokens?: number;
	};
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	[key: string]: unknown;
}

export interface SubagentRun {
	id: string;
	/** Main Pi session which owns this run's in-memory scope. */
	ownerSessionId: string;
	mode: SubagentMode;
	agent: string;
	agentSource: AgentSource | "unknown";
	task: string;
	status: RunStatus;
	startedAt: number;
	endedAt?: number;
	step?: number;
	cwd?: string;
	currentTool?: string;
	currentToolArgs?: Record<string, unknown>;
	/** Bounded, ephemeral streaming state used only by the live viewer. */
	liveMessage?: string;
	liveToolOutput?: string;
	pendingInputs?: SubagentPendingInput[];
	messages: AgentMessage[];
	finalOutput?: string;
	errorMessage?: string;
	usage: UsageStats;
	model?: string;
	/** Discovery scope used to select this run's agent. */
	agentScope?: AgentScope;
	/** Pointer metadata for the child session; never child-session history. */
	sessionId?: string;
	sessionDir?: string;
	sessionFile?: string;
	leafId?: string;
	continuedFromRunId?: string;
	continuedFromLeafId?: string;
	/** Synthetic chain parent for child steps, or child runs for a chain parent. */
	parentRunId?: string;
	childRunIds?: string[];
	/** Durable background completion-delivery state; absent on legacy runs. */
	completionNotification?: CompletionNotificationState;
	/** Ephemeral input channel owned by the live child process; never persisted. */
	sendInput?: (message: string, delivery: SubagentInputDelivery) => Promise<"queued" | "sent">;
	abort?: () => void;
}

/** The completed child-session checkpoint from which a runner continuation forks. */
export interface ContinuationSource {
	runId: string;
	sessionFile: string;
	leafId: string;
}

export interface SingleResult {
	runId?: string;
	agent: string;
	agentSource: AgentSource | "unknown";
	task: string;
	exitCode: number;
	messages: AgentMessage[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
	/** Pointer metadata for the child session; never child-session history. */
	agentScope?: AgentScope;
	sessionId?: string;
	sessionDir?: string;
	sessionFile?: string;
	leafId?: string;
	continuedFromRunId?: string;
	continuedFromLeafId?: string;
}

/**
 * The intentionally small child-run record stored in the parent tool result.
 * Child transcripts stay in the run store while live and in the child session
 * after completion; never put `messages` here.
 */
export interface ParentResult {
	runId?: string;
	agent: string;
	status: RunStatus;
	finalOutput: string;
	usage: UsageStats;
	model?: string;
	sessionId?: string;
	continuedFromRunId?: string;
}

export interface SubagentDetails {
	mode: SubagentMode;
	agentScope: AgentScope;
	packageAgentsDir: string;
	userAgentsDir: string;
	projectAgentsDir: string | null;
	/** Present when results contains a synthetic background chain parent. */
	chainStepCount?: number;
	results: ParentResult[];
}

export type ToolTextResult = {
	content: TextContent[];
	details?: SubagentDetails;
};

export type OnUpdateCallback = (partial: ToolTextResult) => void;

export type TaskItem = {
	agent: string;
	task: string;
	cwd?: string;
};

export type SubagentParamsInput = {
	agent?: string;
	/** Completed source run reference: subagent-3, &3, or 3. */
	continueFrom?: string;
	task?: string;
	chain?: TaskItem[];
	/** Wait for completion and return the final output. Defaults to false. */
	wait?: boolean;
	agentScope?: AgentScope;
	confirmProjectAgents?: boolean;
	cwd?: string;
};

export type SubagentControlAction = "list" | "status" | "send" | "stop" | "delete";

export type SubagentControlParamsInput = {
	action?: SubagentControlAction;
	runId?: string;
	/** Instruction for action=send. */
	message?: string;
	/** steer is delivered at the next safe turn boundary; followUp runs after current work. */
	delivery?: SubagentInputDelivery;
};

export type SubagentScheduleAction = "add" | "list" | "delete";
export type SubagentScheduleKind = "interval" | "once" | "cron";

export type SubagentScheduleParamsInput = {
	action?: SubagentScheduleAction;
	id?: string;
	name?: string;
	schedule?: string;
	prompt?: string;
	agent?: string;
	agentScope?: AgentScope;
	cwd?: string;
};

export interface SubagentScheduleJob {
	id: string;
	schedule: string;
	kind: SubagentScheduleKind;
	prompt: string;
	agent?: string;
	agentScope: AgentScope;
	cwd?: string;
	createdAt: number;
	intervalMs?: number;
	nextRunAt?: number;
	lastRunAt?: number;
	lastRunId?: string;
}

export type StartedAgentRun = { ok: true; run: SubagentRun; completion: Promise<SingleResult>; agentScope: AgentScope } | { ok: false; message: string };

export type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, unknown> };

export type SubagentRunSubscriber = (runs: readonly SubagentRun[]) => void;
export type CreateSubagentRunInput = Pick<SubagentRun, "mode" | "agent" | "agentSource" | "task"> &
	/** Omitted only for legacy/runtime callers; store assigns its active runtime owner. */
	Partial<Pick<SubagentRun, "ownerSessionId" | "step" | "cwd" | "model" | "agentScope" | "sessionId" | "sessionDir" | "sessionFile" | "leafId" | "continuedFromRunId" | "continuedFromLeafId" | "parentRunId" | "childRunIds" | "completionNotification">>;
export type SubagentRunPatch = Partial<Omit<SubagentRun, "id">>;
