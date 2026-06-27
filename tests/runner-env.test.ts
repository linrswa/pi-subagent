import assert from "node:assert/strict";
import test from "node:test";
import { getChildEnv } from "../runner.ts";

test("undefined ponytail mode leaves child env inherited by spawn", () => {
	assert.equal(getChildEnv(undefined), undefined);
});

test("ponytail mode overrides only the child env", () => {
	const previous = process.env.PI_SUBAGENT_ENV_TEST;
	process.env.PI_SUBAGENT_ENV_TEST = "kept";
	try {
		const env = getChildEnv("ultra");
		assert.equal(env?.PONYTAIL_DEFAULT_MODE, "ultra");
		assert.equal(env?.PI_SUBAGENT_ENV_TEST, "kept");
	} finally {
		if (previous === undefined) delete process.env.PI_SUBAGENT_ENV_TEST;
		else process.env.PI_SUBAGENT_ENV_TEST = previous;
	}
});
