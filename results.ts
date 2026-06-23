import { PER_TASK_OUTPUT_CAP } from "./constants.ts";
import type { AgentMessage, SingleResult, TextContent, ToolCallContent } from "./types.ts";

export function getAssistantText(message: AgentMessage): string {
	return message.content
		.filter((part): part is TextContent => part.type === "text" && typeof (part as TextContent).text === "string")
		.map((part) => part.text)
		.join("");
}

export function getFinalOutput(messages: AgentMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role === "assistant") {
			const text = getAssistantText(message).trim();
			if (text) return text;
		}
	}
	return "";
}

export function isFailedResult(result: SingleResult): boolean {
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

export function getResultOutput(result: SingleResult): string {
	if (isFailedResult(result)) {
		return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
	}
	return getFinalOutput(result.messages) || "(no output)";
}

export function truncateForParent(output: string): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= PER_TASK_OUTPUT_CAP) return output;

	let truncated = output.slice(0, PER_TASK_OUTPUT_CAP);
	while (Buffer.byteLength(truncated, "utf8") > PER_TASK_OUTPUT_CAP) truncated = truncated.slice(0, -1);
	return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted. Full output preserved in tool details.]`;
}

export function getLastToolCallName(message: AgentMessage): string | undefined {
	for (let i = message.content.length - 1; i >= 0; i--) {
		const part = message.content[i];
		if (part.type === "toolCall" && typeof (part as ToolCallContent).name === "string") return (part as ToolCallContent).name;
	}
	return undefined;
}

export function getTerminalRunStatus(result: SingleResult): "completed" | "failed" | "aborted" {
	if (result.stopReason === "aborted") return "aborted";
	return isFailedResult(result) ? "failed" : "completed";
}
