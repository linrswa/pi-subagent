import type { AgentScope, AgentSource } from "./agents.ts";

export type SubagentMode = "single" | "parallel" | "chain";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "aborted";

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
	messages: AgentMessage[];
	finalOutput?: string;
	errorMessage?: string;
	usage: UsageStats;
	model?: string;
	abort?: () => void;
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
}

export interface SubagentDetails {
	mode: SubagentMode;
	agentScope: AgentScope;
	packageAgentsDir: string;
	userAgentsDir: string;
	projectAgentsDir: string | null;
	results: SingleResult[];
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
	task?: string;
	tasks?: TaskItem[];
	chain?: TaskItem[];
	agentScope?: AgentScope;
	confirmProjectAgents?: boolean;
	cwd?: string;
};

export type SubagentControlAction = "list" | "status" | "ask" | "stop" | "delete";

export type SubagentControlParamsInput = {
	action?: SubagentControlAction;
	runId?: string;
	question?: string;
	context?: string;
	agent?: string;
	agentScope?: AgentScope;
	cwd?: string;
};

export type BgAgentParamsInput = {
	prompt?: string;
	agent?: string;
	agentScope?: AgentScope;
	confirmProjectAgents?: boolean;
	cwd?: string;
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

export type StartBackgroundAgentResult = { ok: true; run: SubagentRun; agentScope: AgentScope } | { ok: false; message: string };

export type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, unknown> };

export type SubagentRunSubscriber = (runs: readonly SubagentRun[]) => void;
export type CreateSubagentRunInput = Pick<SubagentRun, "mode" | "agent" | "agentSource" | "task"> &
	Partial<Pick<SubagentRun, "step" | "cwd" | "model">>;
export type SubagentRunPatch = Partial<Omit<SubagentRun, "id">>;
