import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Cron } from "croner";
import { type AgentScope, discoverAgents } from "./agents.ts";
import { MAX_DATE_MS, MAX_TIMER_DELAY_MS } from "./constants.ts";
import { chooseBackgroundAgent, confirmProjectAgentIfNeeded, normalizeAgentRef, type SubagentManager } from "./manager.ts";
import { formatShortRunId } from "./run-refs.ts";
import type { SubagentScheduleJob, SubagentScheduleParamsInput } from "./types.ts";

function compactPreview(text: string | undefined, maxLength: number): string {
	const normalized = (text ?? "").replace(/\s+/g, " ").trim();
	if (!normalized) return "...";
	return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized;
}

type ParsedSchedule = Pick<SubagentScheduleJob, "kind" | "intervalMs" | "nextRunAt">;

function parseDurationMs(raw: string): number | undefined {
	const match = raw.trim().match(/^(\d+)([smhd])$/i);
	if (!match) return undefined;
	const value = Number(match[1]);
	if (!Number.isFinite(value) || value <= 0) return undefined;
	const unit = match[2].toLowerCase();
	const multiplier = unit === "s" ? 1000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
	return value * multiplier;
}

function getCronNextRun(spec: string): number | undefined {
	let cron: Cron | undefined;
	try {
		cron = new Cron(spec, { mode: "6-part", paused: true, unref: true });
		return cron.nextRun()?.getTime();
	} catch {
		return undefined;
	} finally {
		cron?.stop();
	}
}

function parseSubagentSchedule(spec: string): { ok: true; parsed: ParsedSchedule } | { ok: false; message: string } {
	const trimmed = spec.trim();
	if (!trimmed) return { ok: false, message: "schedule is required." };
	const futureTime = (durationMs: number) => {
		const next = Date.now() + durationMs;
		return next <= MAX_DATE_MS ? next : undefined;
	};

	if (trimmed.startsWith("+")) {
		const intervalMs = parseDurationMs(trimmed.slice(1));
		const nextRunAt = intervalMs ? futureTime(intervalMs) : undefined;
		return nextRunAt
			? { ok: true, parsed: { kind: "once", nextRunAt } }
			: { ok: false, message: "Relative schedules must look like +10m, +30s, +1h, or +2d." };
	}

	const intervalMs = parseDurationMs(trimmed);
	if (intervalMs) {
		const nextRunAt = futureTime(intervalMs);
		return nextRunAt
			? { ok: true, parsed: { kind: "interval", intervalMs, nextRunAt } }
			: { ok: false, message: "Schedule duration is too large." };
	}

	if (trimmed.split(/\s+/).length === 6) {
		const nextRunAt = getCronNextRun(trimmed);
		return nextRunAt
			? { ok: true, parsed: { kind: "cron", nextRunAt } }
			: { ok: false, message: "Invalid 6-field cron schedule." };
	}

	const timestamp = new Date(trimmed).getTime();
	if (Number.isFinite(timestamp)) {
		if (timestamp <= Date.now()) return { ok: false, message: "ISO timestamp must be in the future." };
		return { ok: true, parsed: { kind: "once", nextRunAt: timestamp } };
	}

	return { ok: false, message: "Schedule must be 30s/5m/1h/2d, +10m, an ISO timestamp, or a 6-field cron." };
}

const GENERATED_SCHEDULE_ID_RE = /^schedule-([a-z0-9]+-[a-z0-9]{4})$/i;

export function formatScheduleId(id: string): string {
	const match = id.match(GENERATED_SCHEDULE_ID_RE);
	return match ? match[1].slice(0, 13) : id;
}

export function formatRelativeTime(timestamp: number | undefined): string {
	if (!timestamp) return "unscheduled";
	const diff = timestamp - Date.now();
	if (Math.abs(diff) < 1000) return "now";
	const suffix = diff >= 0 ? "from now" : "ago";
	let seconds = Math.max(1, Math.round(Math.abs(diff) / 1000));
	const days = Math.floor(seconds / 86_400);
	seconds -= days * 86_400;
	const hours = Math.floor(seconds / 3600);
	seconds -= hours * 3600;
	const minutes = Math.floor(seconds / 60);
	seconds -= minutes * 60;
	const parts: string[] = [];
	if (days) parts.push(`${days}d`);
	if (hours) parts.push(`${hours}h`);
	if (minutes && parts.length < 2) parts.push(`${minutes}m`);
	if (!parts.length) parts.push(`${seconds}s`);
	return `${parts.join(" ")} ${suffix}`;
}

function findScheduleByRef(ref: string | undefined, jobs: readonly SubagentScheduleJob[]): SubagentScheduleJob | undefined {
	const wanted = ref?.trim();
	if (!wanted) return undefined;
	const exact = jobs.find((job) => job.id === wanted || formatScheduleId(job.id) === wanted);
	if (exact) return exact;
	return jobs.find((job) => GENERATED_SCHEDULE_ID_RE.test(job.id) && (job.id.includes(wanted) || formatScheduleId(job.id).includes(wanted)));
}

export function formatScheduleList(jobs: readonly SubagentScheduleJob[]): string {
	if (jobs.length === 0) return "No subagent schedules.";
	return jobs
		.map((job) => {
			const next = job.nextRunAt && job.nextRunAt <= MAX_DATE_MS ? `${new Date(job.nextRunAt).toISOString()} (${formatRelativeTime(job.nextRunAt)})` : "unscheduled";
			const last = job.lastRunAt ? `\n  last: ${new Date(job.lastRunAt).toISOString()}${job.lastRunId ? ` ${formatShortRunId(job.lastRunId)}` : ""}` : "";
			return `${formatScheduleId(job.id)} ${job.kind} ${job.schedule}\n  agent: ${job.agent ?? "explorer"} [${job.agentScope}]\n  next: ${next}\n  prompt: ${compactPreview(job.prompt, 160)}${last}`;
		})
		.join("\n\n");
}

function getScheduleStoragePath(ctx: ExtensionContext): string | undefined {
	let sessionId = "";
	let sessionFile = "";
	try {
		sessionId = ctx.sessionManager.getSessionId()?.trim() ?? "";
	} catch {
		sessionId = "";
	}
	try {
		sessionFile = ctx.sessionManager.getSessionFile()?.trim() ?? "";
	} catch {
		sessionFile = "";
	}
	if (!sessionId && !sessionFile) return undefined;
	const key = sessionId ? sessionId.replace(/[^\w.-]+/g, "_") : `file-${createHash("sha1").update(sessionFile).digest("hex").slice(0, 16)}`;
	return path.join(ctx.cwd, ".pi", "subagent-schedules", `${key}.json`);
}

export class SubagentSchedulerController {
	private manager: SubagentManager | null = null;
	private ctx: ExtensionContext | null = null;
	private filePath: string | undefined;
	private startPromise: Promise<boolean> | null = null;
	private generation = 0;
	private readonly jobs = new Map<string, SubagentScheduleJob>();
	private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

	async start(manager: SubagentManager, ctx: ExtensionContext): Promise<boolean> {
		this.stop();
		const filePath = getScheduleStoragePath(ctx);
		if (!filePath) return false;
		const generation = ++this.generation;
		this.manager = manager;
		this.ctx = ctx;
		this.filePath = filePath;
		this.startPromise = (async () => {
			const jobs = await this.load(filePath);
			if (this.generation !== generation) return false;
			this.jobs.clear();
			for (const [id, job] of jobs) this.jobs.set(id, job);
			for (const job of this.jobs.values()) this.arm(job);
			return true;
		})();
		try {
			return await this.startPromise;
		} finally {
			if (this.generation === generation) this.startPromise = null;
		}
	}

	stop(): void {
		this.generation++;
		for (const timer of this.timers.values()) clearTimeout(timer);
		this.timers.clear();
		this.jobs.clear();
		this.manager = null;
		this.ctx = null;
		this.filePath = undefined;
		this.startPromise = null;
	}

	async ensure(manager: SubagentManager, ctx: ExtensionContext): Promise<boolean> {
		if (this.startPromise) return this.startPromise;
		return this.filePath ? true : this.start(manager, ctx);
	}

	list(): SubagentScheduleJob[] {
		return Array.from(this.jobs.values(), (job) => ({ ...job }));
	}

	async add(params: SubagentScheduleParamsInput): Promise<{ ok: true; job: SubagentScheduleJob } | { ok: false; message: string }> {
		const schedule = params.schedule?.trim();
		const prompt = params.prompt?.trim();
		const name = params.name?.trim();
		if (!schedule) return { ok: false, message: "action=add requires schedule." };
		if (!prompt) return { ok: false, message: "action=add requires prompt." };
		if (name && /[\r\n]/.test(name)) return { ok: false, message: "Schedule name cannot contain newlines." };
		if (name && this.list().some((job) => job.id === name || formatScheduleId(job.id) === name)) return { ok: false, message: `Schedule id already exists: ${name}.` };
		const parsed = parseSubagentSchedule(schedule);
		if (parsed.ok === false) return { ok: false, message: parsed.message };
		const approved = await this.confirmProjectAgent(params);
		if (approved !== true) return { ok: false, message: approved };

		const job: SubagentScheduleJob = {
			id: name || `schedule-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
			schedule,
			kind: parsed.parsed.kind,
			prompt,
			agent: normalizeAgentRef(params.agent),
			agentScope: params.agentScope ?? "user",
			cwd: params.cwd,
			createdAt: Date.now(),
			intervalMs: parsed.parsed.intervalMs,
			nextRunAt: parsed.parsed.nextRunAt,
		};
		this.jobs.set(job.id, job);
		try {
			await this.save();
		} catch (error) {
			this.jobs.delete(job.id);
			return { ok: false, message: `Failed to save schedule: ${error instanceof Error ? error.message : String(error)}` };
		}
		this.arm(job);
		return { ok: true, job: { ...job } };
	}

	private async confirmProjectAgent(params: SubagentScheduleParamsInput): Promise<true | string> {
		const ctx = this.ctx;
		const scope: AgentScope = params.agentScope ?? "user";
		if (!ctx || scope === "user") return true;
		const discovery = discoverAgents(ctx.cwd, scope);
		const agentName = chooseBackgroundAgent(discovery.agents, params.agent);
		if (!agentName) return "No subagents available for scheduled run.";
		const agent = discovery.agents.find((candidate) => candidate.name === agentName);
		if (!agent) return `Unknown agent: "${agentName}".`;
		if (agent.source !== "project") return true;
		if (!ctx.hasUI) return "Scheduling project-local agents requires interactive approval.";
		return (await confirmProjectAgentIfNeeded(ctx, discovery, agent, true)) || "Canceled: project-local agent not approved.";
	}

	async delete(ref: string | undefined): Promise<boolean> {
		const job = findScheduleByRef(ref, this.list());
		if (!job) return false;
		this.clearTimer(job.id);
		const deleted = this.jobs.delete(job.id);
		if (deleted) await this.save();
		return deleted;
	}

	private clearTimer(id: string): void {
		const timer = this.timers.get(id);
		if (timer) clearTimeout(timer);
		this.timers.delete(id);
	}

	private arm(job: SubagentScheduleJob): void {
		this.clearTimer(job.id);
		const nextRunAt = this.nextRunAt(job);
		if (!nextRunAt) {
			this.jobs.delete(job.id);
			void this.save().catch((error) => this.reportError("Failed to save schedules", error));
			return;
		}
		job.nextRunAt = nextRunAt;
		const delay = Math.max(0, Math.min(MAX_TIMER_DELAY_MS, nextRunAt - Date.now()));
		const generation = this.generation;
		const timer = setTimeout(() => {
			void this.fire(job.id, generation).catch((error) => this.reportError("Scheduled subagent failed", error));
		}, delay);
		(timer as { unref?: () => void }).unref?.();
		this.timers.set(job.id, timer);
	}

	private nextRunAt(job: SubagentScheduleJob): number | undefined {
		if (job.kind === "cron") return getCronNextRun(job.schedule);
		if (job.kind === "interval") return job.nextRunAt && job.nextRunAt > Date.now() ? job.nextRunAt : Date.now() + (job.intervalMs ?? 0);
		return job.nextRunAt;
	}

	private async fire(id: string, generation: number): Promise<void> {
		const job = this.jobs.get(id);
		const ctx = this.ctx;
		const manager = this.manager;
		if (!job || !ctx || !manager || this.generation !== generation) return;
		if ((job.nextRunAt ?? 0) - Date.now() > 1000) return this.arm(job);

		job.lastRunAt = Date.now();
		const result = await manager.startAgent(ctx, {
			task: job.prompt,
			agent: job.agent,
			agentScope: job.agentScope,
			confirmProjectAgents: false,
			cwd: job.cwd,
		});
		if (this.generation !== generation || this.jobs.get(id) !== job || this.ctx !== ctx || this.manager !== manager) return;
		if (result.ok === true) {
			job.lastRunId = result.run.id;
			ctx.ui.notify(`Schedule ${formatScheduleId(job.id)} started ${formatShortRunId(result.run.id)}.`, "info");
		} else {
			ctx.ui.notify(`Schedule ${formatScheduleId(job.id)} failed: ${result.message}`, "error");
		}

		if (job.kind === "once") {
			this.clearTimer(job.id);
			this.jobs.delete(job.id);
		} else {
			job.nextRunAt = job.kind === "interval" ? Date.now() + (job.intervalMs ?? 0) : undefined;
			this.arm(job);
		}
		await this.save();
	}

	private async load(filePath: string): Promise<Map<string, SubagentScheduleJob>> {
		const loaded = new Map<string, SubagentScheduleJob>();
		try {
			const content = await fs.promises.readFile(filePath, "utf-8");
			const data = JSON.parse(content) as { jobs?: unknown };
			const jobs = Array.isArray(data.jobs) ? data.jobs : [];
			for (const entry of jobs) {
				const job = entry as Partial<SubagentScheduleJob>;
				if (!job.id || !job.schedule || !job.prompt) continue;
				if (job.kind !== "interval" && job.kind !== "once" && job.kind !== "cron") continue;
				if (job.kind === "interval" && (!job.intervalMs || job.intervalMs <= 0)) continue;
				if (job.kind === "once" && !job.nextRunAt) continue;
				const agentScope: AgentScope = job.agentScope === "project" || job.agentScope === "both" ? job.agentScope : "user";
				loaded.set(job.id, {
					id: job.id,
					schedule: job.schedule,
					kind: job.kind,
					prompt: job.prompt,
					agent: job.agent,
					agentScope,
					cwd: job.cwd,
					createdAt: job.createdAt ?? Date.now(),
					intervalMs: job.intervalMs,
					nextRunAt: job.nextRunAt,
					lastRunAt: job.lastRunAt,
					lastRunId: job.lastRunId,
				});
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.ctx?.ui.notify(`Failed to load subagent schedules: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
		return loaded;
	}

	private async save(): Promise<void> {
		const filePath = this.filePath;
		if (!filePath) return;
		const generation = this.generation;
		const jobs = Array.from(this.jobs.values()).sort((a, b) => (a.nextRunAt ?? 0) - (b.nextRunAt ?? 0));
		const content = `${JSON.stringify({ version: 1, jobs }, null, 2)}\n`;
		await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
		if (this.generation !== generation || this.filePath !== filePath) return;
		await withFileMutationQueue(filePath, async () => {
			if (this.generation !== generation || this.filePath !== filePath) return;
			await fs.promises.writeFile(filePath, content, { encoding: "utf-8", mode: 0o600 });
		});
	}

	private reportError(prefix: string, error: unknown): void {
		this.ctx?.ui.notify(`${prefix}: ${error instanceof Error ? error.message : String(error)}`, "error");
	}
}

