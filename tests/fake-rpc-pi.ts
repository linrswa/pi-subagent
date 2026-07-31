export interface FakeRpcPiOptions {
	answerExpression?: string;
	delayMs?: number;
}

/** Source for a deterministic persisted Pi RPC child used by process-level tests. */
export function fakeRpcPiSource(sdkUrl: string, options: FakeRpcPiOptions = {}): string {
	const answerExpression = options.answerExpression ?? JSON.stringify("child answer");
	const delayMs = options.delayMs ?? 0;
	return `
import { SessionManager } from ${JSON.stringify(sdkUrl)};
const args = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1];
if (value("--mode") !== "rpc" || value("--exclude-tools") !== "subagent,subagent_schedule") process.exit(2);
const manager = args.includes("--session")
  ? SessionManager.open(value("--session"))
  : SessionManager.create(process.cwd(), value("--session-dir"), { id: value("--session-id") });
let buffer = "";
let aborted = false;
let timer;
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
const delay = (ms) => new Promise((resolve) => { timer = setTimeout(resolve, ms); });
async function handle(command) {
  if (command.type === "abort") {
    aborted = true;
    if (timer) clearTimeout(timer);
    emit({ id: command.id, type: "response", command: "abort", success: true });
    emit({ type: "agent_settled" });
    return;
  }
  if (command.type !== "prompt") {
    emit({ id: command.id, type: "response", command: command.type, success: true });
    return;
  }
  emit({ id: command.id, type: "response", command: "prompt", success: true });
  const task = command.message;
  const prior = manager.buildSessionContext().messages.map((message) => String(message.content));
  manager.appendMessage({ role: "user", content: task, timestamp: Date.now() });
  emit({ type: "message_end", message: { role: "user", content: [{ type: "text", text: task }] } });
  if (${delayMs} > 0) await delay(${delayMs});
  if (aborted) return;
  const answer = ${answerExpression};
  manager.appendMessage({ role: "assistant", content: answer, provider: "test", model: "test", timestamp: Date.now(), usage: { input: 1, output: 1, totalTokens: 2 }, stopReason: "stop" });
  emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: answer }], model: "test", usage: { input: 1, output: 1, totalTokens: 2 }, stopReason: "stop" } });
  emit({ type: "agent_settled" });
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) if (line.trim()) void handle(JSON.parse(line));
});
process.on("SIGTERM", () => process.exit(0));
`;
}
