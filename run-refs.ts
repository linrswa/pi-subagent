import { subagentRunStore } from "./store.ts";
import type { SubagentRun } from "./types.ts";

export function formatShortRunId(id: string): string {
	const numeric = id.match(/(\d+)$/)?.[1];
	return numeric ? `&${numeric}` : `&${id.slice(-6)}`;
}

export function findRunByRef(runId: string | undefined, runs = subagentRunStore.getSnapshot()): SubagentRun | undefined {
	if (!runId) return undefined;
	const ref = runId.trim();
	const numeric = ref.match(/^[#&＆]?(\d+)$/)?.[1];
	const wanted = new Set([ref, ref.replace(/^[#&＆]/, "")]);
	if (numeric) wanted.add(`subagent-${numeric}`);
	return runs.find((run) => wanted.has(run.id) || wanted.has(formatShortRunId(run.id)) || wanted.has(formatShortRunId(run.id).slice(1)));
}
