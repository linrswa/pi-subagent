import assert from "node:assert/strict";
import test from "node:test";
import { ChildProcessPool } from "../process-pool.ts";

test("child process pool enforces capacity and promotes waiters FIFO", async () => {
	const pool = new ChildProcessPool(2);
	const first = await pool.acquire();
	const second = await pool.acquire();
	assert.equal(pool.activeCount, 2);

	const order: number[] = [];
	const third = pool.acquire().then((release) => { order.push(3); return release; });
	const fourth = pool.acquire().then((release) => { order.push(4); return release; });
	await Promise.resolve();
	assert.equal(pool.queuedCount, 2);

	first();
	const releaseThird = await third;
	assert.deepEqual(order, [3]);
	assert.equal(pool.activeCount, 2);
	releaseThird();
	const releaseFourth = await fourth;
	assert.deepEqual(order, [3, 4]);

	releaseFourth();
	second();
	assert.equal(pool.activeCount, 0);
});

test("an aborted queued process slot never consumes capacity", async () => {
	const pool = new ChildProcessPool(1);
	const release = await pool.acquire();
	const controller = new AbortController();
	const queued = pool.acquire(controller.signal);
	controller.abort();
	await assert.rejects(queued, /aborted while waiting/);
	assert.equal(pool.queuedCount, 0);
	assert.equal(pool.activeCount, 1);
	release();
	assert.equal(pool.activeCount, 0);
});
