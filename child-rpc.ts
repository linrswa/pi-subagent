import type { Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import type { SubagentInputDelivery } from "./types.ts";

export type ChildRpcCommand =
	| { type: "prompt"; message: string }
	| { type: "steer"; message: string }
	| { type: "follow_up"; message: string }
	| { type: "clear_queue" }
	| { type: "abort" };

export type ChildRpcResponse = {
	id?: string;
	type: "response";
	command: string;
	success: boolean;
	error?: string;
	data?: { disposition?: "started" | "queued" | "handled" };
};

type PendingRequest = {
	command: ChildRpcCommand["type"];
	resolve: (response: ChildRpcResponse) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
};

const RPC_RESPONSE_TIMEOUT_MS = 30_000;

/** Strict JSONL command/event channel for one `pi --mode rpc` child process. */
export class ChildRpcChannel {
	private readonly stdin: Writable;
	private readonly onEvent: (event: Record<string, unknown>) => void;
	private readonly onTransportError: (error: Error) => void;
	private readonly decoder = new StringDecoder("utf8");
	private buffer = "";
	private requestNumber = 0;
	private readonly pending = new Map<string, PendingRequest>();
	private closedError: Error | undefined;

	constructor(
		stdin: Writable,
		onEvent: (event: Record<string, unknown>) => void,
		onTransportError: (error: Error) => void = () => {},
	) {
		this.stdin = stdin;
		this.onEvent = onEvent;
		this.onTransportError = onTransportError;
		// A failed write invokes its callback AND emits an error. Keep the error
		// listener until stream close, even if the channel has already closed.
		stdin.on("error", this.handleInputError);
		stdin.once("close", () => {
			this.fail(new Error("Subagent RPC input closed"));
			stdin.off("error", this.handleInputError);
		});
	}

	private readonly handleInputError = (error: Error): void => { this.fail(error); };

	private fail(error: Error): void {
		if (this.closedError) return;
		this.close(error);
		this.onTransportError(error);
	}

	send(command: ChildRpcCommand): Promise<ChildRpcResponse> {
		if (this.closedError) return Promise.reject(this.closedError);
		if (this.stdin.destroyed || !this.stdin.writable) {
			const error = new Error("Subagent RPC input is not writable");
			this.fail(error);
			return Promise.reject(error);
		}
		const id = `subagent_rpc_${++this.requestNumber}`;
		return new Promise<ChildRpcResponse>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`Timed out waiting for subagent RPC ${command.type} response`));
			}, RPC_RESPONSE_TIMEOUT_MS);
			this.pending.set(id, { command: command.type, resolve, reject, timer });
			try {
				this.stdin.write(`${JSON.stringify({ ...command, id })}\n`, (error) => {
					if (error) this.fail(error);
				});
			} catch (error) {
				this.fail(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	async sendInput(message: string, delivery: SubagentInputDelivery): Promise<void> {
		await this.send({ type: delivery === "followUp" ? "follow_up" : "steer", message });
	}

	receive(chunk: Buffer | string): void {
		this.buffer += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
		this.drainLines();
	}

	finish(): void {
		this.buffer += this.decoder.end();
		if (this.buffer) this.processLine(this.buffer.endsWith("\r") ? this.buffer.slice(0, -1) : this.buffer);
		this.buffer = "";
	}

	close(error: Error): void {
		if (this.closedError) return;
		this.closedError = error;
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pending.clear();
	}

	private drainLines(): void {
		while (true) {
			const newline = this.buffer.indexOf("\n");
			if (newline === -1) return;
			let line = this.buffer.slice(0, newline);
			this.buffer = this.buffer.slice(newline + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			this.processLine(line);
		}
	}

	private processLine(line: string): void {
		if (!line.trim()) return;
		let event: Record<string, unknown>;
		try {
			event = JSON.parse(line) as Record<string, unknown>;
		} catch {
			return;
		}
		if (!event || typeof event !== "object") return;
		if (event.type === "response" && typeof event.id === "string") {
			const pending = this.pending.get(event.id);
			if (pending) {
				clearTimeout(pending.timer);
				this.pending.delete(event.id);
				const response = event as ChildRpcResponse;
				if (response.success) pending.resolve(response);
				else pending.reject(new Error(response.error || `Subagent RPC ${pending.command} failed`));
				return;
			}
		}
		this.onEvent(event);
	}
}
