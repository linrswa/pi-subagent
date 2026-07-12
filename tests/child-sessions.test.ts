import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";
import {
	assertValidChildSessionId,
	branchChildSession,
	cleanupChildSession,
	createFreshChildSession,
	ensureChildSessionDir,
	findChildSession,
	getChildSessionsRoot,
} from "../child-sessions.ts";

async function makePersistedSession(ownerSessionId: string) {
	const cwd = process.cwd();
	const sessionDir = await ensureChildSessionDir(ownerSessionId);
	const sessionId = randomUUID();
	const manager = SessionManager.create(cwd, sessionDir, { id: sessionId });
	manager.appendMessage({ role: "user", content: "source question", timestamp: Date.now() } as any);
	const leafId = manager.appendMessage({
		role: "assistant",
		content: "source answer",
		provider: "test",
		model: "test-model",
		timestamp: Date.now(),
		usage: { input: 1, output: 1, totalTokens: 2 },
		stopReason: "stop",
	} as any);
	const sessionFile = manager.getSessionFile();
	assert.ok(sessionFile);
	return { cwd, sessionId, sessionDir, sessionFile, leafId };
}

function ownerId(): string {
	return `subagent-test-${randomUUID()}`;
}

async function withIsolatedAgentDir(action: (agentDir: string) => Promise<void>): Promise<void> {
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-subagent-agent-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		await action(agentDir);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(agentDir, { recursive: true, force: true });
	}
}

test("fresh child sessions are uniquely identified under the agent directory", async () => {
	const owner = ownerId();
	try {
		const first = await createFreshChildSession(owner);
		const second = await createFreshChildSession(owner);
		assert.notEqual(first.sessionId, second.sessionId);
		assert.doesNotThrow(() => assertValidChildSessionId(first.sessionId));
		assert.equal(first.sessionDir, path.join(getAgentDir(), "subagent-sessions", owner));
		assert.equal(getChildSessionsRoot(), path.join(getAgentDir(), "subagent-sessions"));
	} finally {
		await rm(path.join(getChildSessionsRoot(), owner), { recursive: true, force: true });
	}
});

test("locates a persisted child session and its leaf", async () => {
	const owner = ownerId();
	try {
		const source = await makePersistedSession(owner);
		const found = await findChildSession(source.sessionId, source.cwd, source.sessionDir);
		assert.deepEqual(found, {
			sessionId: source.sessionId,
			sessionDir: source.sessionDir,
			sessionFile: source.sessionFile,
			leafId: source.leafId,
		});
	} finally {
		await rm(path.join(getChildSessionsRoot(), owner), { recursive: true, force: true });
	}
});

test("sibling branches preserve the source and contain its active path", async () => {
	const owner = ownerId();
	try {
		const source = await makePersistedSession(owner);
		const before = await readFile(source.sessionFile, "utf8");
		const first = await branchChildSession(source);
		const second = await branchChildSession(source);

		assert.ok(first.sessionFile);
		assert.ok(second.sessionFile);
		assert.notEqual(first.sessionFile, second.sessionFile);
		assert.equal(await readFile(source.sessionFile, "utf8"), before);

		const context = SessionManager.open(first.sessionFile).buildSessionContext();
		assert.deepEqual(
			context.messages.map((message) => (typeof message.content === "string" ? message.content : "")),
			["source question", "source answer"],
		);
	} finally {
		await rm(path.join(getChildSessionsRoot(), owner), { recursive: true, force: true });
	}
});

test("branching a user-only leaf rejects instead of opening Pi's deferred branch file", async () => {
	const owner = ownerId();
	try {
		const cwd = process.cwd();
		const sessionDir = await ensureChildSessionDir(owner);
		const manager = SessionManager.create(cwd, sessionDir, { id: randomUUID() });
		const rootUser = manager.appendMessage({ role: "user", content: "root question", timestamp: Date.now() } as any);
		manager.appendMessage({
			role: "assistant",
			content: "sibling answer",
			provider: "test",
			model: "test-model",
			timestamp: Date.now(),
			usage: { input: 1, output: 1, totalTokens: 2 },
			stopReason: "stop",
		} as any);
		manager.branch(rootUser);
		const userOnlyLeaf = manager.appendMessage({ role: "user", content: "branch question", timestamp: Date.now() } as any);
		const sessionFile = manager.getSessionFile();
		assert.ok(sessionFile);

		await assert.rejects(
			branchChildSession({ sessionFile, leafId: userOnlyLeaf }),
			/no assistant message/,
		);
	} finally {
		await rm(path.join(getChildSessionsRoot(), owner), { recursive: true, force: true });
	}
});

test("managed owner symlinks cannot escape the child-session root", async () => {
	const owner = ownerId();
	const managedLink = path.join(getChildSessionsRoot(), owner);
	const outside = await mkdtemp(path.join(os.tmpdir(), "pi-subagent-escape-"));
	try {
		await mkdir(getChildSessionsRoot(), { recursive: true });
		await symlink(outside, managedLink, "dir");
		await assert.rejects(ensureChildSessionDir(owner), /resolves outside the managed directory/);
	} finally {
		await rm(managedLink, { recursive: true, force: true });
		await rm(outside, { recursive: true, force: true });
	}
});

test("a child-session root symlink outside the agent directory cannot be used for creation", async () => {
	const outside = await mkdtemp(path.join(os.tmpdir(), "pi-subagent-root-escape-"));
	try {
		await withIsolatedAgentDir(async (agentDir) => {
			await symlink(outside, path.join(agentDir, "subagent-sessions"), "dir");
			await assert.rejects(ensureChildSessionDir(ownerId()), /root resolves outside the managed directory/);
		});
	} finally {
		await rm(outside, { recursive: true, force: true });
	}
});

test("cleanup refuses a file reached through a child-session root symlink", async () => {
	const outside = await mkdtemp(path.join(os.tmpdir(), "pi-subagent-root-cleanup-"));
	const outsideFile = path.join(outside, "must-survive.jsonl");
	try {
		await writeFile(outsideFile, "must survive");
		await withIsolatedAgentDir(async (agentDir) => {
			const root = path.join(agentDir, "subagent-sessions");
			await symlink(outside, root, "dir");
			await assert.rejects(cleanupChildSession(path.join(root, "must-survive.jsonl")), /root resolves outside the managed directory/);
		});
		assert.equal(await readFile(outsideFile, "utf8"), "must survive");
	} finally {
		await rm(outside, { recursive: true, force: true });
	}
});

test("cleanup refuses files outside the managed child-session directory", async () => {
	const outside = path.join(process.cwd(), `child-session-outside-${randomUUID()}.jsonl`);
	try {
		await assert.rejects(cleanupChildSession(outside), /outside the managed directory/);
	} finally {
		await rm(outside, { force: true });
	}
});

test("cleanup verifies the file belongs to the run session before removing it", async () => {
	const owner = ownerId();
	try {
		const source = await makePersistedSession(owner);
		await assert.rejects(cleanupChildSession(source.sessionFile, randomUUID()), /does not belong to session/);
		assert.equal(typeof await readFile(source.sessionFile, "utf8"), "string");
	} finally {
		await rm(path.join(getChildSessionsRoot(), owner), { recursive: true, force: true });
	}
});
