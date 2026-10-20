import { createHash, randomUUID } from "node:crypto";
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
	/** Only successfully persisted jobs may enter this map or be launched. */
	private readonly jobs = new Map<string, SubagentScheduleJob>();
	private readonly pendingAdds = new Map<string, { job: SubagentScheduleJob; cancelled: boolean }>();
	private readonly pendingDeletes = new Map<string, object>();
	private readonly firing = new Map<string, SubagentScheduleJob>();
	private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly deadlines = new Map<string, number>();

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
			if (!this.isCurrentSession(generation, filePath)) return false;
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
		this.deadlines.clear();
		this.jobs.clear();
		this.pendingAdds.clear();
		this.pendingDeletes.clear();
		this.firing.clear();
		this.manager = null;
		this.ctx = null;
		this.filePath = undefined;
		this.startPromise = null;
	}

	async ensure(manager: SubagentManager, ctx: ExtensionContext): Promise<boolean> {
		if (this.filePath === getScheduleStoragePath(ctx) && this.manager === manager) return this.startPromise ?? true;
		return this.start(manager, ctx);
	}

	private isCurrentSession(generation: number, filePath = this.filePath): boolean {
		return this.generation === generation && this.filePath === filePath && Boolean(this.ctx && filePath && getScheduleStoragePath(this.ctx) === filePath);
	}

	list(): SubagentScheduleJob[] {
		// Pending additions stay visible/cancellable, but never enter another
		// operation's persisted snapshot or acquire a timer before commit.
		const jobs = new Map(this.jobs);
		for (const { job, cancelled } of this.pendingAdds.values()) if (!cancelled && !jobs.has(job.id)) jobs.set(job.id, job);
		return Array.from(jobs.values(), (job) => ({ ...job, nextRunAt: this.deadlines.get(job.id) ?? job.nextRunAt }));
	}

	async add(params: SubagentScheduleParamsInput): Promise<{ ok: true; job: SubagentScheduleJob } | { ok: false; message: string }> {
		const generation = this.generation;
		const ctx = this.ctx;
		const filePath = this.filePath;
		const isCurrent = () => this.ctx === ctx && this.isCurrentSession(generation, filePath);
		const changed = { ok: false as const, message: "Schedule session changed before the add completed." };
		if (!ctx || !filePath) return { ok: false, message: "Subagent scheduler is not started." };
		if (this.startPromise) await this.startPromise;
		if (!isCurrent()) return changed;
		const schedule = params.schedule?.trim();
		const prompt = params.prompt?.trim();
		const name = params.name?.trim();
		if (!schedule) return { ok: false, message: "action=add requires schedule." };
		if (!prompt) return { ok: false, message: "action=add requires prompt." };
		if (name && /[\r\n]/.test(name)) return { ok: false, message: "Schedule name cannot contain newlines." };
		if (name && this.list().some((job) => job.id === name || formatScheduleId(job.id) === name)) return { ok: false, message: `Schedule id already exists: ${name}.` };
		const parsed = parseSubagentSchedule(schedule);
		if (parsed.ok === false) return { ok: false, message: parsed.message };
		const approved = await this.confirmProjectAgent(params, ctx);
		if (!isCurrent()) return changed;
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
		// Approval can yield, allowing another add to claim the same id.
		if (this.pendingDeletes.has(job.id) || this.list().some((existing) => existing.id === job.id || formatScheduleId(existing.id) === formatScheduleId(job.id))) {
			return { ok: false, message: `Schedule id already exists: ${job.id}.` };
		}
		const pending = { job, cancelled: false };
		this.pendingAdds.set(job.id, pending);
		try {
			const committed = await this.mutate(generation, filePath, (jobs) => {
				if (pending.cancelled) return undefined;
				if ([...jobs.values()].some((existing) => formatScheduleId(existing.id) === formatScheduleId(job.id))) {
					throw new Error(`Schedule id already exists: ${job.id}.`);
				}
				jobs.set(job.id, job);
				return jobs;
			}, () => !pending.cancelled, () => this.arm(job));
			// Once rename commits, report success even if a later delete or
			// session switch wins the race with this promise's continuation.
			if (committed) return { ok: true, job: { ...job, nextRunAt: this.deadlines.get(job.id) ?? job.nextRunAt } };
			if (!isCurrent()) return changed;
			return { ok: false, message: "Schedule was removed before the add completed." };
		} catch (error) {
			if (!isCurrent()) return changed;
			return { ok: false, message: `Failed to save schedule: ${error instanceof Error ? error.message : String(error)}` };
		} finally {
			if (this.pendingAdds.get(job.id) === pending) this.pendingAdds.delete(job.id);
		}
	}

	private async confirmProjectAgent(params: SubagentScheduleParamsInput, ctx: ExtensionContext): Promise<true | string> {
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
		const generation = this.generation;
		const filePath = this.filePath;
		const job = findScheduleByRef(ref, this.list());
		if (!job || !filePath || !this.isCurrentSession(generation, filePath) || this.pendingDeletes.has(job.id)) return false;
		const pending = this.pendingAdds.get(job.id);
		if (pending) pending.cancelled = true;
		const deletion = {};
		this.pendingDeletes.set(job.id, deletion);
		this.clearTimer(job.id);
		let committed = false;
		try {
			committed = await this.mutate(generation, filePath, (jobs) => {
				jobs.delete(job.id);
				return jobs;
			});
			return committed;
		} finally {
			if (this.pendingDeletes.get(job.id) === deletion) {
				this.pendingDeletes.delete(job.id);
				// A failed deletion leaves the durable job intact. Restore its
				// timer rather than pretending it was deleted until the next reload.
				const retained = this.jobs.get(job.id);
				if (!committed && retained && !this.firing.has(job.id) && this.isCurrentSession(generation, filePath)) this.arm(retained);
			}
		}
	}

	private clearTimer(id: string): void {
		const timer = this.timers.get(id);
		if (timer) clearTimeout(timer);
		this.timers.delete(id);
		this.deadlines.delete(id);
	}

	private arm(job: SubagentScheduleJob): void {
		if (!this.isCurrentSession(this.generation) || this.jobs.get(job.id) !== job || this.pendingDeletes.has(job.id)) return;
		this.clearTimer(job.id);
		const nextRunAt = this.nextRunAt(job);
		if (!nextRunAt) {
			void this.delete(job.id).catch((error) => this.reportError("Failed to save schedules", error));
			return;
		}
		const delay = Math.max(0, Math.min(MAX_TIMER_DELAY_MS, nextRunAt - Date.now()));
		const generation = this.generation;
		const timer = setTimeout(() => {
			void this.fire(job.id, generation, nextRunAt).catch((error) => this.reportError("Scheduled subagent failed", error));
		}, delay);
		(timer as { unref?: () => void }).unref?.();
		this.timers.set(job.id, timer);
		this.deadlines.set(job.id, nextRunAt);
	}

	private nextRunAt(job: SubagentScheduleJob): number | undefined {
		if (job.kind === "cron") return getCronNextRun(job.schedule);
		if (job.kind === "interval") return job.nextRunAt && job.nextRunAt > Date.now() ? job.nextRunAt : Date.now() + (job.intervalMs ?? 0);
		return job.nextRunAt;
	}

	private async fire(id: string, generation: number, scheduledAt?: number): Promise<void> {
		const job = this.jobs.get(id);
		const ctx = this.ctx;
		const manager = this.manager;
		const filePath = this.filePath;
		if (!job || !ctx || !manager || !filePath || !this.isCurrentSession(generation) || this.pendingDeletes.has(id) || this.firing.has(id)) return;
		if ((scheduledAt ?? job.nextRunAt ?? 0) - Date.now() > 1000) return this.arm(job);

		this.clearTimer(id);
		this.firing.set(id, job);
		const lastRunAt = Date.now();
		try {
			const result = await manager.startAgent(ctx, {
				task: job.prompt,
				agent: job.agent,
				agentScope: job.agentScope,
				confirmProjectAgents: false,
				cwd: job.cwd,
			});
			const isCurrent = () => this.isCurrentSession(generation, filePath) && this.jobs.get(id) === job && this.ctx === ctx && this.manager === manager;
			if (!isCurrent()) return;
			if (result.ok === true) {
				ctx.ui.notify(`Schedule ${formatScheduleId(job.id)} started ${formatShortRunId(result.run.id)}.`, "info");
			} else {
				ctx.ui.notify(`Schedule ${formatScheduleId(job.id)} failed: ${result.message}`, "error");
			}
			const next: SubagentScheduleJob = {
				...job, lastRunAt, lastRunId: result.ok === true ? result.run.id : job.lastRunId,
				nextRunAt: job.kind === "interval" ? Date.now() + (job.intervalMs ?? 0) : getCronNextRun(job.schedule),
			};
			const committed = await this.mutate(generation, filePath, (jobs) => {
				if (!isCurrent() || this.pendingDeletes.has(id)) return undefined;
				if (job.kind === "once" || !next.nextRunAt) jobs.delete(id);
				else jobs.set(id, next);
				return jobs;
			}, () => !this.pendingDeletes.has(id), () => {
				if (this.jobs.get(id) === next) this.arm(next);
			});
			// A queued delete may have failed while this firing was awaiting its
			// turn. Only re-arm an unchanged committed job, never a deleted one.
			if (!committed && isCurrent() && !this.pendingDeletes.has(id)) this.arm(job);
		} finally {
			if (this.firing.get(id) === job) this.firing.delete(id);
		}
	}

	private async load(filePath: string): Promise<Map<string, SubagentScheduleJob>> {
		const loaded = new Map<string, SubagentScheduleJob>();
		try {
			const content = await withFileMutationQueue(filePath, () => fs.promises.readFile(filePath, "utf-8"));
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

	/** Propose from committed state, persist atomically, then publish in memory. */
	private async mutate(
		generation: number,
		filePath: string,
		propose: (jobs: Map<string, SubagentScheduleJob>) => Map<string, SubagentScheduleJob> | undefined,
		canCommit: () => boolean = () => true,
		afterCommit: () => void = () => {},
	): Promise<boolean> {
		return withFileMutationQueue(filePath, async () => {
			if (!this.isCurrentSession(generation, filePath)) return false;
			await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
			if (!this.isCurrentSession(generation, filePath)) return false;
			const next = propose(new Map(this.jobs));
			if (!next) return false;
			const jobs = [...next.values()].sort((a, b) => (a.nextRunAt ?? 0) - (b.nextRunAt ?? 0));
			const content = `${JSON.stringify({ version: 1, jobs }, null, 2)}\n`;
			const temporary = `${filePath}.${randomUUID()}.tmp`;
			try {
				await fs.promises.writeFile(temporary, content, { encoding: "utf-8", mode: 0o600 });
				if (!this.isCurrentSession(generation, filePath) || !canCommit()) return false;
				await fs.promises.rename(temporary, filePath);
				if (this.isCurrentSession(generation, filePath)) {
					this.jobs.clear();
					for (const [id, job] of next) this.jobs.set(id, job);
					afterCommit();
				}
				return true;
			} finally {
				await fs.promises.rm(temporary, { force: true }).catch(() => {});
			}
		});
	}

	private reportError(prefix: string, error: unknown): void {
		this.ctx?.ui.notify(`${prefix}: ${error instanceof Error ? error.message : String(error)}`, "error");
	}
}

