import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";

/** A pointer to a child session managed exclusively by this extension. */
export interface ChildSessionRef {
	sessionId: string;
	sessionDir: string;
	sessionFile?: string;
	leafId?: string;
}

// Ephemeral main sessions have no durable SessionManager id. Keep one runtime
// owner stable for this extension process rather than putting child sessions in
// the project tree or allocating a new owner directory per run.
const runtimeOwnerSessionId = `runtime-${randomUUID()}`;

/** Use the main session id when available, otherwise a process-local owner id. */
export function getChildSessionOwnerId(mainSessionId: string | undefined): string {
	const candidate = mainSessionId?.trim();
	if (candidate) {
		assertValidChildSessionId(candidate);
		return candidate;
	}
	return runtimeOwnerSessionId;
}

/** The directory which is deliberately outside the project working tree. */
export function getChildSessionsRoot(): string {
	return path.resolve(getAgentDir(), "subagent-sessions");
}

// Kept in sync with Pi's SessionManager session-id validation. The validator is
// not exported by all supported Pi runtime versions.
export function assertValidChildSessionId(id: string): void {
	if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(id)) {
		throw new Error("Session id must contain only alphanumeric characters, '-', '_', and '.', and start and end with an alphanumeric character");
	}
}

function isWithin(parent: string, candidate: string): boolean {
	const relative = path.relative(parent, candidate);
	return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

function isWithinOrEqual(parent: string, candidate: string): boolean {
	return path.resolve(parent) === path.resolve(candidate) || isWithin(parent, candidate);
}

/** Resolve the closest existing ancestor so symlinks in a new path are checked too. */
async function realExistingAncestor(candidate: string): Promise<string | undefined> {
	let ancestor = candidate;
	while (true) {
		try {
			return await fs.realpath(ancestor);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			const parent = path.dirname(ancestor);
			if (parent === ancestor) return undefined;
			ancestor = parent;
		}
	}
}

/**
 * Verify that the root resolves to the extension-owned directory below the
 * canonical agent directory. In particular, do not trust a symlink placed at
 * `<getAgentDir()>/subagent-sessions` to define a new managed root.
 */
async function getVerifiedCanonicalChildSessionsRoot(lexicalRoot: string): Promise<string> {
	const canonicalRoot = await fs.realpath(lexicalRoot).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return undefined;
		throw error;
	});
	const canonicalAgentDir = await fs.realpath(getAgentDir()).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return undefined;
		throw error;
	});
	const expectedRoot = canonicalAgentDir && path.join(canonicalAgentDir, "subagent-sessions");
	if (canonicalRoot && canonicalRoot !== expectedRoot) {
		throw new Error(`Child session root resolves outside the managed directory: ${lexicalRoot}`);
	}
	return canonicalRoot ?? expectedRoot ?? lexicalRoot;
}

/**
 * Creates the per-main-session directory used for child Pi sessions.
 * ownerSessionId is also used as a directory name, so require Pi's session-id
 * syntax instead of accepting a path fragment.
 */
export async function ensureChildSessionDir(ownerSessionId: string): Promise<string> {
	assertValidChildSessionId(ownerSessionId);
	const root = path.resolve(getChildSessionsRoot());
	const sessionDir = path.join(root, ownerSessionId);
	if (!isWithin(root, sessionDir)) {
		throw new Error(`Child session directory is outside the managed directory: ${sessionDir}`);
	}

	await fs.mkdir(root, { recursive: true });
	const canonicalRoot = await getVerifiedCanonicalChildSessionsRoot(root);
	await fs.mkdir(sessionDir, { recursive: true });
	const canonicalSessionDir = await fs.realpath(sessionDir);
	if (!isWithin(canonicalRoot, canonicalSessionDir)) {
		throw new Error(`Child session directory resolves outside the managed directory: ${sessionDir}`);
	}
	return sessionDir;
}

/** Allocate the id and managed directory needed by a fresh child invocation. */
export async function createFreshChildSession(ownerSessionId: string): Promise<ChildSessionRef> {
	const sessionId = randomUUID();
	assertValidChildSessionId(sessionId);
	return { sessionId, sessionDir: await ensureChildSessionDir(ownerSessionId) };
}

/** Reject paths which are not under the extension-owned child-session root. */
export async function assertManagedChildSessionPath(sessionFile: string): Promise<string> {
	const lexicalRoot = path.resolve(getChildSessionsRoot());
	const resolvedFile = path.resolve(sessionFile);
	if (!isWithin(lexicalRoot, resolvedFile)) {
		throw new Error(`Child session path is outside the managed directory: ${sessionFile}`);
	}

	const canonicalRoot = await getVerifiedCanonicalChildSessionsRoot(lexicalRoot);
	// Check an existing ancestor too: a new file below a symlinked owner
	// directory must not be treated as safe merely because the file is absent.
	const canonicalAncestor = await realExistingAncestor(resolvedFile);
	if (canonicalAncestor && !isWithinOrEqual(canonicalRoot, canonicalAncestor)) {
		throw new Error(`Child session path resolves outside the managed directory: ${sessionFile}`);
	}
	return resolvedFile;
}

/**
 * Find a persisted child session by the id passed to Pi's --session-id option.
 * SessionManager performs the header/cwd validation rather than this helper
 * parsing JSONL itself.
 */
export async function findChildSession(sessionId: string, cwd: string, sessionDir: string): Promise<ChildSessionRef | undefined> {
	assertValidChildSessionId(sessionId);
	const resolvedDir = path.resolve(sessionDir);
	await assertManagedChildSessionDir(resolvedDir);
	const session = (await SessionManager.list(cwd, resolvedDir)).find((candidate) => candidate.id === sessionId);
	if (!session) return undefined;
	const sessionFile = await assertManagedChildSessionPath(session.path);
	const manager = SessionManager.open(sessionFile, resolvedDir);
	return {
		sessionId,
		sessionDir: resolvedDir,
		sessionFile,
		leafId: manager.getLeafId() ?? undefined,
	};
}

async function assertManagedChildSessionDir(sessionDir: string): Promise<void> {
	const lexicalRoot = path.resolve(getChildSessionsRoot());
	const resolvedDir = path.resolve(sessionDir);
	if (!isWithin(lexicalRoot, resolvedDir)) {
		throw new Error(`Child session directory is outside the managed directory: ${sessionDir}`);
	}

	const canonicalRoot = await getVerifiedCanonicalChildSessionsRoot(lexicalRoot);
	const canonicalDir = await realExistingAncestor(resolvedDir);
	if (!canonicalDir || !isWithin(canonicalRoot, canonicalDir)) {
		throw new Error(`Child session directory resolves outside the managed directory: ${sessionDir}`);
	}
}

/**
 * Copy the active path ending at leafId into an independent session file.
 * SessionManager writes a branch immediately only when its path includes an
 * assistant message. A user-only path is deferred until a later assistant
 * response, which this helper cannot safely resume, so it is rejected.
 */
export async function branchChildSession(source: Required<Pick<ChildSessionRef, "sessionFile" | "leafId">> & Partial<ChildSessionRef>): Promise<ChildSessionRef> {
	const sessionFile = await assertManagedChildSessionPath(source.sessionFile);
	const sessionDir = path.dirname(sessionFile);
	await assertManagedChildSessionDir(sessionDir);
	const manager = SessionManager.open(sessionFile, sessionDir);
	const branchedFile = manager.createBranchedSession(source.leafId);
	if (!branchedFile) throw new Error("Unable to create a persisted child session branch");
	const managedBranchedFile = await assertManagedChildSessionPath(branchedFile);
	try {
		await fs.access(managedBranchedFile);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			throw new Error("Unable to create a persisted child session branch: the selected path has no assistant message");
		}
		throw error;
	}
	const branched = SessionManager.open(managedBranchedFile, sessionDir);
	return {
		sessionId: branched.getSessionId(),
		sessionDir,
		sessionFile: managedBranchedFile,
		leafId: branched.getLeafId() ?? undefined,
	};
}

/** Delete one managed child-session file, never an arbitrary user-supplied path. */
export async function cleanupChildSession(sessionFile: string): Promise<void> {
	const managedFile = await assertManagedChildSessionPath(sessionFile);
	await fs.rm(managedFile, { force: true });
}
