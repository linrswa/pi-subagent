import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fuzzyFilter, getKeybindings, Input, truncateToWidth, visibleWidth, type Component, type Focusable, type TUI } from "@earendil-works/pi-tui";
import type { AgentConfig, AgentSettingsScope } from "./agents.ts";

export type AgentModelDefaults = Record<string, string>;
type Theme = ExtensionContext["ui"]["theme"];
type SelectedModel = NonNullable<ExtensionContext["model"]>;
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
type Mode = "agents" | "models" | "thinking";

type ModelChoice = { kind: "clear" } | { kind: "model"; model: SelectedModel; ref: string; search: string };

export interface SubagentSettingsOptions {
	tui: TUI;
	theme: Theme;
	agents: AgentConfig[];
	scopes: AgentSettingsScope[];
	initialDefaults: AgentModelDefaults;
	save(agentScope: AgentSettingsScope, agentName: string, modelRef: string): Promise<string>;
	refreshDefaults(): AgentModelDefaults;
	onDone(): void;
	modelRegistry: ExtensionContext["modelRegistry"];
}

const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

function getSupportedThinkingLevels(model: SelectedModel): ThinkingLevel[] {
	if (!model.reasoning) return ["off"];
	return THINKING_LEVELS.filter((level) => {
		const mapped = (model.thinkingLevelMap as Partial<Record<ThinkingLevel, string | null>> | undefined)?.[level];
		if (mapped === null) return false;
		return level === "xhigh" ? mapped !== undefined : true;
	});
}

function modelRef(model: SelectedModel): string {
	return `${model.provider}/${model.id}`;
}

export class SubagentSettingsComponent implements Component, Focusable {
	focused = false;
	private mode: Mode = "agents";
	private scopeIndex = 0;
	private selectedIndex = 0;
	private readonly searchInput = new Input();
	private defaults: AgentModelDefaults;
	private filteredAgents: AgentConfig[];
	private modelChoices: ModelChoice[] = [{ kind: "clear" }];
	private filteredModels: ModelChoice[] = this.modelChoices;
	private selectedAgent: AgentConfig | undefined;
	private selectedModel: SelectedModel | undefined;
	private thinkingLevels: ("default" | ThinkingLevel)[] = [];
	private status = "Enter selects; Esc exits; Tab toggles scope.";
	private saving = false;

	constructor(private readonly options: SubagentSettingsOptions) {
		this.defaults = { ...options.initialDefaults };
		this.filteredAgents = options.agents;
		this.searchInput.focused = true;
		void this.loadModels();
	}

	invalidate(): void {
		this.searchInput.invalidate();
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (this.saving) return;

		if (kb.matches(data, "tui.select.cancel")) {
			if (this.mode === "agents") this.options.onDone();
			else this.showAgents("Canceled.");
			return;
		}

		if (this.mode === "agents" && kb.matches(data, "tui.input.tab") && this.options.scopes.length > 1) {
			this.scopeIndex = (this.scopeIndex + 1) % this.options.scopes.length;
			this.status = `Scope: ${this.scope}.`;
			this.options.tui.requestRender();
			return;
		}

		if (kb.matches(data, "tui.select.up")) return this.move(-1);
		if (kb.matches(data, "tui.select.down")) return this.move(1);
		if (kb.matches(data, "tui.select.pageUp")) return this.move(-10);
		if (kb.matches(data, "tui.select.pageDown")) return this.move(10);
		if (kb.matches(data, "tui.select.confirm") || data === "\n") return void this.selectCurrent();

		if (this.mode === "agents" || this.mode === "models") {
			this.searchInput.handleInput(data);
			this.mode === "agents" ? this.filterAgents() : this.filterModels();
			this.options.tui.requestRender();
		}
	}

	render(width: number): string[] {
		this.searchInput.focused = this.focused && this.mode !== "thinking";
		const w = Math.max(48, width);
		const inner = Math.max(20, w - 4);
		const lines: string[] = [];
		const t = this.options.theme;
		const title = ` Subagent settings [${this.scope}] `;
		lines.push(t.fg("muted", `╭─${title}${"─".repeat(Math.max(0, inner - title.length))}─╮`));
		lines.push(this.row(`Mode: ${this.mode}${this.selectedAgent ? ` · ${this.selectedAgent.name}` : ""}`, inner));
		lines.push(this.row(this.status, inner, "dim"));
		lines.push(this.row(this.mode === "agents" ? "Search agents:" : this.mode === "models" ? "Search models:" : "Reasoning level:", inner, "muted"));
		if (this.mode !== "thinking") lines.push(this.row(this.searchInput.render(inner)[0] ?? "", inner));
		else lines.push(this.row("", inner));
		lines.push(this.row("", inner));

		if (this.mode === "agents") this.renderAgents(lines, inner);
		else if (this.mode === "models") this.renderModels(lines, inner);
		else this.renderThinking(lines, inner);

		lines.push(this.row("", inner));
		lines.push(this.row(this.footerText(), inner, "muted"));
		lines.push(t.fg("muted", `╰${"─".repeat(inner + 2)}╯`));
		return lines;
	}

	private get scope(): AgentSettingsScope {
		return this.options.scopes[this.scopeIndex] ?? "global";
	}

	private row(text: string, width: number, color?: "muted" | "dim"): string {
		const t = this.options.theme;
		const content = truncateToWidth(color ? t.fg(color, text) : text, width, "…");
		return t.fg("muted", "│ ") + content + " ".repeat(Math.max(0, width - visibleWidth(content))) + t.fg("muted", " │");
	}

	private renderAgents(lines: string[], width: number): void {
		const visible = this.visibleSlice(this.filteredAgents);
		if (this.filteredAgents.length === 0) {
			lines.push(this.row("No matching agents", width, "dim"));
			return;
		}
		for (const { item: agent, index } of visible) {
			const model = this.defaults[agent.name] ?? agent.model ?? "inherits session model";
			this.item(lines, width, index, `${agent.name}  ${this.options.theme.fg("dim", model)}`);
		}
	}

	private renderModels(lines: string[], width: number): void {
		const visible = this.visibleSlice(this.filteredModels);
		if (this.filteredModels.length === 0) {
			lines.push(this.row("No matching models", width, "dim"));
			return;
		}
		for (const { item, index } of visible) {
			if (item.kind === "clear") this.item(lines, width, index, "Clear model (inherit session/frontmatter)");
			else this.item(lines, width, index, `${item.ref}  ${this.options.theme.fg("dim", item.model.name ?? "")}`);
		}
	}

	private renderThinking(lines: string[], width: number): void {
		for (let i = 0; i < this.thinkingLevels.length; i++) this.item(lines, width, i, this.thinkingLevels[i]);
	}

	private item(lines: string[], width: number, index: number, text: string): void {
		const selected = index === this.selectedIndex;
		const prefix = selected ? this.options.theme.fg("accent", "→ ") : "  ";
		lines.push(this.row(prefix + (selected ? this.options.theme.fg("accent", text) : text), width));
	}

	private visibleSlice<T>(items: T[]): Array<{ item: T; index: number }> {
		const max = 10;
		const start = Math.max(0, Math.min(this.selectedIndex - Math.floor(max / 2), items.length - max));
		return items.slice(start, start + max).map((item, offset) => ({ item, index: start + offset }));
	}

	private footerText(): string {
		if (this.mode === "agents") return "↑↓ move · type fuzzy search · Enter configure · Tab scope · Esc done";
		if (this.mode === "models") return "↑↓ move · type fuzzy search · Enter select · Esc back";
		return "↑↓ move · Enter save · Esc back";
	}

	private move(delta: number): void {
		const count = this.mode === "agents" ? this.filteredAgents.length : this.mode === "models" ? this.filteredModels.length : this.thinkingLevels.length;
		if (count === 0) return;
		this.selectedIndex = (this.selectedIndex + delta + count) % count;
		this.options.tui.requestRender();
	}

	private async selectCurrent(): Promise<void> {
		if (this.mode === "agents") {
			const agent = this.filteredAgents[this.selectedIndex];
			if (!agent) return;
			this.selectedAgent = agent;
			this.mode = "models";
			this.searchInput.setValue("");
			this.selectedIndex = 0;
			this.filterModels();
			this.status = `Configuring ${agent.name}.`;
			this.options.tui.requestRender();
			return;
		}

		if (this.mode === "models") {
			const choice = this.filteredModels[this.selectedIndex];
			if (!choice) return;
			if (choice.kind === "clear") return this.save("");
			const levels = getSupportedThinkingLevels(choice.model);
			if (levels.length <= 1) return this.save(choice.ref);
			this.selectedModel = choice.model;
			this.thinkingLevels = ["default", ...levels];
			this.selectedIndex = 0;
			this.mode = "thinking";
			this.status = `Model: ${choice.ref}.`;
			this.options.tui.requestRender();
			return;
		}

		const level = this.thinkingLevels[this.selectedIndex];
		if (!level || !this.selectedModel) return;
		const ref = modelRef(this.selectedModel);
		await this.save(level === "default" ? ref : `${ref}:${level}`);
	}

	private async save(modelRef: string): Promise<void> {
		const agent = this.selectedAgent;
		if (!agent) return;
		this.saving = true;
		this.status = "Saving...";
		this.options.tui.requestRender();
		try {
			const filePath = await this.options.save(this.scope, agent.name, modelRef);
			this.defaults = { ...this.options.refreshDefaults() };
			this.showAgents(`${modelRef ? "Saved" : "Cleared"} ${agent.name}${modelRef ? `: ${modelRef}` : ""} (${filePath})`);
		} catch (error) {
			this.status = `Save failed: ${error instanceof Error ? error.message : String(error)}`;
		} finally {
			this.saving = false;
			this.options.tui.requestRender();
		}
	}

	private showAgents(status: string): void {
		this.mode = "agents";
		this.selectedAgent = undefined;
		this.selectedModel = undefined;
		this.searchInput.setValue("");
		this.selectedIndex = 0;
		this.filterAgents();
		this.status = status;
		this.options.tui.requestRender();
	}

	private filterAgents(): void {
		const query = this.searchInput.getValue();
		this.filteredAgents = query ? fuzzyFilter(this.options.agents, query, (agent) => `${agent.name} ${agent.description}`) : this.options.agents;
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredAgents.length - 1));
	}

	private filterModels(): void {
		const query = this.searchInput.getValue();
		this.filteredModels = query ? fuzzyFilter(this.modelChoices, query, (choice) => (choice.kind === "clear" ? "clear inherit none" : choice.search)) : this.modelChoices;
		if (this.mode === "models") this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredModels.length - 1));
	}

	private async loadModels(): Promise<void> {
		try {
			this.options.modelRegistry.refresh();
			const models = (await this.options.modelRegistry.getAvailable()) as SelectedModel[];
			this.modelChoices = [...models.map((model) => ({ kind: "model" as const, model, ref: modelRef(model), search: `${modelRef(model)} ${model.name ?? ""}` })), { kind: "clear" }];
			this.filterModels();
		} catch (error) {
			this.status = `Failed to load models: ${error instanceof Error ? error.message : String(error)}`;
		}
		this.options.tui.requestRender();
	}
}
