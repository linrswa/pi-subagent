import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
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
	channel.close(new Error("test complete"));
	stdin.destroy();
});

test("stdin EPIPE closes every pending request and handles the emitted stream error", async () => {
	let failWrite!: (error: Error) => void;
	const stdin = new Writable({ write(_chunk, _encoding, callback) { failWrite = callback; } });
	const failures: Error[] = [];
	const channel = new ChildRpcChannel(stdin, () => {}, (error) => failures.push(error));
	const prompt = assert.rejects(channel.send({ type: "prompt", message: "start" }), /EPIPE/);
	const steer = assert.rejects(channel.sendInput("also", "steer"), /EPIPE/);
	const error = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
	failWrite(error);
	await Promise.all([prompt, steer]);
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(failures, [error]);
	assert.equal(stdin.listenerCount("error"), 0, "listener cleaned up after stream close");
	assert.equal((channel as any).pending.size, 0);
	await assert.rejects(channel.send({ type: "abort" }), /EPIPE/);
});

test("late stdin errors after logical close are consumed until stream close", async () => {
	const stdin = new PassThrough();
	const channel = new ChildRpcChannel(stdin, () => {});
	const rejected = assert.rejects(channel.send({ type: "prompt", message: "start" }), /process exited/);
	channel.close(new Error("process exited"));
	stdin.destroy(new Error("late EPIPE"));
	await rejected;
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(stdin.listenerCount("error"), 0);
});

test("synchronous write failures and stream closure reject pending requests", async () => {
	const stdin = new PassThrough();
	stdin.write = () => { throw new Error("synchronous write failure"); };
	const channel = new ChildRpcChannel(stdin, () => {});
	await assert.rejects(channel.send({ type: "prompt", message: "start" }), /synchronous write failure/);
	assert.equal((channel as any).pending.size, 0);
	stdin.destroy();

	const otherInput = new PassThrough();
	const other = new ChildRpcChannel(otherInput, () => {});
	const pending = assert.rejects(other.send({ type: "abort" }), /input closed/);
	otherInput.destroy();
	await pending;
});

test("prompt responses preserve Pi 1.3 disposition data", async () => {
	const stdin = new PassThrough();
	const channel = new ChildRpcChannel(stdin, () => {});
	const pending = channel.send({ type: "prompt", message: "handled by input hook" });
	const command = JSON.parse(stdin.read().toString());
	channel.receive(`${JSON.stringify({ id: command.id, type: "response", command: "prompt", success: true, data: { disposition: "handled" } })}\n`);
	assert.equal((await pending).data?.disposition, "handled");
	channel.close(new Error("test complete"));
	stdin.destroy();
});
