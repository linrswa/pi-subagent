import { MAX_CHILD_PROCESSES } from "./constants.ts";

export type ReleaseProcessSlot = () => void;

type Waiter = {
	resolve: (release: ReleaseProcessSlot) => void;
	reject: (error: Error) => void;
	signal?: AbortSignal;
	onAbort?: () => void;
	settled: boolean;
};

function abortedError(): Error {
	const error = new Error("Subagent was aborted while waiting for a process slot");
	error.name = "AbortError";
	return error;
}

/** FIFO semaphore shared by every subagent launch in this Pi process. */
export class ChildProcessPool {
	readonly capacity: number;
	private active = 0;
	private readonly waiters: Waiter[] = [];

	constructor(capacity = MAX_CHILD_PROCESSES) {
		if (!Number.isInteger(capacity) || capacity < 1) throw new Error("Child process pool capacity must be a positive integer");
		this.capacity = capacity;
	}

	get activeCount(): number { return this.active; }
	get queuedCount(): number { return this.waiters.filter((waiter) => !waiter.settled).length; }

	acquire(signal?: AbortSignal): Promise<ReleaseProcessSlot> {
		if (signal?.aborted) return Promise.reject(abortedError());
		return new Promise<ReleaseProcessSlot>((resolve, reject) => {
			const waiter: Waiter = { resolve, reject, signal, settled: false };
			if (signal) {
				waiter.onAbort = () => {
					if (waiter.settled) return;
					waiter.settled = true;
					const index = this.waiters.indexOf(waiter);
					if (index !== -1) this.waiters.splice(index, 1);
					this.cleanup(waiter);
					reject(abortedError());
				};
				signal.addEventListener("abort", waiter.onAbort, { once: true });
			}
			this.waiters.push(waiter);
			this.drain();
		});
	}

	private drain(): void {
		while (this.active < this.capacity) {
			const waiter = this.waiters.shift();
			if (!waiter) return;
			if (waiter.settled || waiter.signal?.aborted) {
				this.cleanup(waiter);
				if (!waiter.settled) {
					waiter.settled = true;
					waiter.reject(abortedError());
				}
				continue;
			}

			waiter.settled = true;
			this.cleanup(waiter);
			this.active++;
			let released = false;
			waiter.resolve(() => {
				if (released) return;
				released = true;
				this.active--;
				this.drain();
			});
		}
	}

	private cleanup(waiter: Waiter): void {
		if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
	}
}

const POOL_SYMBOL = Symbol.for("pi-subagent.child-process-pool.v1");
const globals = globalThis as typeof globalThis & { [POOL_SYMBOL]?: ChildProcessPool };
export const childProcessPool = globals[POOL_SYMBOL] ??= new ChildProcessPool();
