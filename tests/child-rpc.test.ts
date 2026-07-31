import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { ChildRpcChannel } from "../child-rpc.ts";

test("child RPC channel correlates responses and preserves fragmented UTF-8 events", async () => {
	const stdin = new PassThrough();
	let written = "";
	stdin.on("data", (chunk) => { written += chunk.toString(); });
	const events: Record<string, unknown>[] = [];
	const channel = new ChildRpcChannel(stdin, (event) => events.push(event));

	const pending = channel.send({ type: "steer", message: "調整方向" });
	const command = JSON.parse(written.trim()) as { id: string };
	channel.receive(`${JSON.stringify({ id: command.id, type: "response", command: "steer", success: true })}\n`);
	await pending;

	const event = Buffer.from(`${JSON.stringify({ type: "queue_update", steering: ["中文🧭"] })}\n`);
	const emoji = event.indexOf(Buffer.from("🧭"));
	channel.receive(event.subarray(0, emoji + 1));
	channel.receive(event.subarray(emoji + 1));
	assert.deepEqual(events, [{ type: "queue_update", steering: ["中文🧭"] }]);

	written = "";
	const failed = channel.send({ type: "follow_up", message: "later" });
	const failedCommand = JSON.parse(written.trim()) as { id: string };
	channel.receive(`${JSON.stringify({ id: failedCommand.id, type: "response", command: "follow_up", success: false, error: "not running" })}\n`);
	await assert.rejects(failed, /not running/);
});
