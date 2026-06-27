import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import { discoverAgentsWithSettings, setAgentModelDefault } from "../agents.ts";

test("project agent frontmatter can set ponytail mode", async () => {
	const cwd = await mkdtemp(path.join(tmpdir(), "pi-subagent-test-"));
	try {
		const agentsDir = path.join(cwd, ".pi", "agents");
		await mkdir(agentsDir, { recursive: true });
		await writeFile(
			path.join(agentsDir, "pony.md"),
			`---
name: pony
description: ponytail test
tools: read
ponytailMode: Ultra
---

Test agent.
`,
		);

		const discovery = discoverAgentsWithSettings(cwd, "project", true);
		assert.equal(discovery.agents.find((agent) => agent.name === "pony")?.ponytailMode, "ultra");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("project agent model defaults override and clear", async () => {
	const cwd = await mkdtemp(path.join(tmpdir(), "pi-subagent-test-"));
	try {
		await setAgentModelDefault(cwd, "project", "explorer", "test/model:high");
		const settingsPath = path.join(cwd, ".pi", "settings.json");
		const settings = JSON.parse(await readFile(settingsPath, "utf-8"));
		assert.equal(settings.subagent.agentModels.explorer, "test/model:high");

		const discovery = discoverAgentsWithSettings(cwd, "user", true);
		assert.equal(discovery.agents.find((agent) => agent.name === "explorer")?.model, "test/model:high");

		await setAgentModelDefault(cwd, "project", "explorer", "");
		const cleared = JSON.parse(await readFile(settingsPath, "utf-8"));
		assert.equal(cleared.subagent.agentModels.explorer, undefined);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});
