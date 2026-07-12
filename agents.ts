/**
 * Subagent agent discovery and configuration.
 *
 * Agent definitions are markdown files with YAML frontmatter. Bundled agents are
 * loaded from this extension's ./agents directory; user agents can override them
 * from ~/.pi/agent/agents; project agents can override both from .pi/agents when
 * agentScope is "both" or "project".
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter, SettingsManager, withFileMutationQueue } from "@earendil-works/pi-coding-agent";

export type AgentScope = "user" | "project" | "both";
export type AgentSource = "package" | "user" | "project";
export type AgentSettingsScope = "global" | "project";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
	source: AgentSource;
	filePath: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	packageAgentsDir: string;
	userAgentsDir: string;
	projectAgentsDir: string | null;
}

export type AgentModelDefaults = Record<string, string>;

const extensionDir = path.dirname(fileURLToPath(import.meta.url));
const packageAgentsDir = path.join(extensionDir, "agents");

function stringField(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function parseTools(value: unknown): string[] | undefined {
	if (Array.isArray(value)) {
		const tools = value.map((tool) => stringField(tool)).filter((tool): tool is string => Boolean(tool));
		return tools.length > 0 ? tools : undefined;
	}

	if (typeof value === "string") {
		const tools = value
			.split(",")
			.map((tool) => tool.trim())
			.filter(Boolean);
		return tools.length > 0 ? tools : undefined;
	}

	return undefined;
}

function agentModelDefaultsFrom(settings: unknown): AgentModelDefaults {
	const subagent = (settings as { subagent?: unknown }).subagent;
	if (!subagent || typeof subagent !== "object" || Array.isArray(subagent)) return {};

	const agentModels = (subagent as { agentModels?: unknown }).agentModels;
	if (!agentModels || typeof agentModels !== "object" || Array.isArray(agentModels)) return {};

	const defaults: AgentModelDefaults = {};
	for (const [agentName, model] of Object.entries(agentModels)) {
		const modelName = stringField(model);
		if (agentName && modelName) defaults[agentName] = modelName;
	}
	return defaults;
}

export function getAgentModelDefaults(cwd: string, projectTrusted = true): AgentModelDefaults {
	const settings = SettingsManager.create(cwd, undefined, { projectTrusted });
	return {
		...agentModelDefaultsFrom(settings.getGlobalSettings()),
		...agentModelDefaultsFrom(settings.getProjectSettings()),
	};
}

function applyAgentModelDefaults(agents: AgentConfig[], defaults: AgentModelDefaults): AgentConfig[] {
	return agents.map((agent) => {
		const model = defaults[agent.name];
		return model ? { ...agent, model } : agent;
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function getAgentSettingsPath(cwd: string, scope: AgentSettingsScope): string {
	return scope === "global"
		? path.join(getAgentDir(), "settings.json")
		: path.join(path.resolve(cwd), CONFIG_DIR_NAME, "settings.json");
}

async function readSettingsJson(filePath: string): Promise<Record<string, unknown>> {
	try {
		const data = JSON.parse(await fs.promises.readFile(filePath, "utf-8"));
		return isRecord(data) ? data : {};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw error;
	}
}

export async function setAgentModelDefault(cwd: string, scope: AgentSettingsScope, agentName: string, model: string): Promise<string> {
	const filePath = getAgentSettingsPath(cwd, scope);
	await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
	await withFileMutationQueue(filePath, async () => {
		const settings = await readSettingsJson(filePath);
		const subagent = isRecord(settings.subagent) ? settings.subagent : {};
		const agentModels = isRecord(subagent.agentModels) ? subagent.agentModels : {};
		const trimmed = model.trim();
		if (trimmed) agentModels[agentName] = trimmed;
		else delete agentModels[agentName];
		settings.subagent = { ...subagent, agentModels };
		await fs.promises.writeFile(filePath, `${JSON.stringify(settings, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
	});
	return filePath;
}

function loadAgentsFromDir(dir: string, source: AgentSource): AgentConfig[] {
	if (!fs.existsSync(dir)) return [];

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}

	const agents: AgentConfig[] = [];
	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content);
		const name = stringField(frontmatter.name);
		const description = stringField(frontmatter.description);
		if (!name || !description) continue;

		agents.push({
			name,
			description,
			tools: parseTools(frontmatter.tools),
			model: stringField(frontmatter.model),
			systemPrompt: body.trim(),
			source,
			filePath,
		});
	}

	return agents;
}

function isDirectory(candidate: string): boolean {
	try {
		return fs.statSync(candidate).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = path.resolve(cwd);
	while (true) {
		const candidate = path.join(currentDir, ".pi", "agents");
		if (isDirectory(candidate)) return candidate;

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
	const userAgentsDir = path.join(getAgentDir(), "agents");
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);

	const packageAgents = scope === "project" ? [] : loadAgentsFromDir(packageAgentsDir, "package");
	const userAgents = scope === "project" ? [] : loadAgentsFromDir(userAgentsDir, "user");
	const projectAgents = scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project");

	const agentMap = new Map<string, AgentConfig>();
	for (const agent of packageAgents) agentMap.set(agent.name, agent);
	for (const agent of userAgents) agentMap.set(agent.name, agent);
	for (const agent of projectAgents) agentMap.set(agent.name, agent);

	return {
		agents: Array.from(agentMap.values()),
		packageAgentsDir,
		userAgentsDir,
		projectAgentsDir,
	};
}

export function discoverAgentsWithSettings(cwd: string, scope: AgentScope, projectTrusted = true): AgentDiscoveryResult {
	const discovery = discoverAgents(cwd, scope);
	return { ...discovery, agents: applyAgentModelDefaults(discovery.agents, getAgentModelDefaults(cwd, projectTrusted)) };
}

export function formatAgentList(agents: AgentConfig[], maxItems = 20): { text: string; remaining: number } {
	if (agents.length === 0) return { text: "none", remaining: 0 };
	const listed = agents.slice(0, maxItems);
	const remaining = agents.length - listed.length;
	return {
		text: listed.map((agent) => `${agent.name} (${agent.source}): ${agent.description}`).join("\n"),
		remaining,
	};
}
