const TaskItemSchema = {
	type: "object",
	required: ["agent", "task"],
	properties: {
		agent: { type: "string", description: "Name of the agent to invoke" },
		task: { type: "string", description: "Task to delegate to the agent" },
		cwd: { type: "string", description: "Working directory for the agent process" },
	},
} as const;

const ChainItemSchema = {
	type: "object",
	required: ["agent", "task"],
	properties: {
		agent: { type: "string", description: "Name of the agent to invoke" },
		task: { type: "string", description: "Task with optional {previous} placeholder for prior output" },
		cwd: { type: "string", description: "Working directory for the agent process" },
	},
} as const;

export const SubagentParamsSchema = {
	type: "object",
	properties: {
		agent: { type: "string", description: "Name of the agent to invoke (for single mode)" },
		task: { type: "string", description: "Task to delegate (for single mode)" },
		tasks: {
			type: "array",
			description: "Array of {agent, task} for parallel execution",
			items: TaskItemSchema,
		},
		chain: {
			type: "array",
			description: "Array of {agent, task} for sequential execution",
			items: ChainItemSchema,
		},
		agentScope: {
			type: "string",
			enum: ["user", "project", "both"],
			default: "user",
			description:
				'Which agent directories to use. Default: "user" (bundled + ~/.pi/agent/agents). Use "both" to include project-local .pi/agents.',
		},
		confirmProjectAgents: {
			type: "boolean",
			default: true,
			description: "Prompt before running project-local agents. Default: true.",
		},
		cwd: { type: "string", description: "Working directory for the agent process (single mode)" },
	},
} as const;

export const SubagentControlParamsSchema = {
	type: "object",
	properties: {
		action: {
			type: "string",
			enum: ["list", "status", "ask", "stop", "delete"],
			default: "list",
			description: "Control action. list/status inspect runs; ask starts a follow-up subagent; stop aborts; delete removes.",
		},
		runId: { type: "string", description: "Run id to target, e.g. subagent-3, &3, or 3." },
		question: { type: "string", description: "Question/instruction for action=ask." },
		context: { type: "string", description: "Optional main-agent context to send with action=ask." },
		agent: { type: "string", description: "Optional follow-up agent for action=ask. Defaults to the original run's agent." },
		agentScope: {
			type: "string",
			enum: ["user", "project", "both"],
			description: "Agent discovery scope for action=ask. Defaults to user, or both for project-origin runs.",
		},
		cwd: { type: "string", description: "Optional cwd for action=ask. Defaults to the original run cwd." },
	},
} as const;

export const BgAgentParamsSchema = {
	type: "object",
	required: ["prompt"],
	properties: {
		prompt: { type: "string", description: "Prompt/task for the background agent." },
		agent: { type: "string", description: "Agent name. Defaults to explorer when available, otherwise the first available agent." },
		agentScope: {
			type: "string",
			enum: ["user", "project", "both"],
			default: "user",
			description: "Agent discovery scope. Default: user.",
		},
		confirmProjectAgents: {
			type: "boolean",
			default: true,
			description: "Prompt before running project-local agents. Default: true.",
		},
		cwd: { type: "string", description: "Working directory for the background agent process." },
	},
} as const;

export const SubagentScheduleParamsSchema = {
	type: "object",
	properties: {
		action: {
			type: "string",
			enum: ["add", "list", "delete"],
			default: "list",
			description: "Schedule action. add creates a job, list shows jobs, delete removes one.",
		},
		id: { type: "string", description: "Schedule id for delete." },
		schedule: { type: "string", description: "30s/5m/1h/2d interval, +10m one-shot, ISO timestamp, or 6-field cron." },
		prompt: { type: "string", description: "Prompt/task to run when the schedule fires." },
		agent: { type: "string", description: "Agent name. Defaults to explorer when available." },
		agentScope: { type: "string", enum: ["user", "project", "both"], default: "user" },
		cwd: { type: "string", description: "Working directory for scheduled background runs." },
	},
} as const;
