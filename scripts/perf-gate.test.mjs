import test from "node:test";
import assert from "node:assert/strict";
import { percentile } from "./perf-gate.mjs";

test("percentile uses exact nearest-rank values", () => {
  assert.equal(percentile([40, 10, 30, 20], 0.5), 20);
  assert.equal(percentile([40, 10, 30, 20], 0.95), 40);
});

test("empty performance sample is zero", () => {
  assert.equal(percentile([], 0.95), 0);
});
