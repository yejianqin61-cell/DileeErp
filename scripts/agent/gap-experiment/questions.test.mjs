import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const { TOOL_CAPABILITIES } = require("../../../apps/api/dist/modules/business-query-agent/tools/tool-registry.js");
const FILE = new URL("../../../apps/api/test/agent-golden/gap-cases/gap-questions.json", import.meta.url);
const load = () => JSON.parse(readFileSync(FILE, "utf8"));
const byClass = (questions, name) => questions.filter((item) => item.class === name);
const MISSING = ["group_by", "filter", "metric", "time_series", "object"];

test("题集共 30 题，四类 10/10/5/5，id 不重复", () => {
  const { questions } = load();
  assert.equal(questions.length, 30);
  assert.deepEqual(["gap", "decoy", "nodata", "unstructured"].map((name) => byClass(questions, name).length), [10, 10, 5, 5]);
  assert.equal(new Set(questions.map((item) => item.id)).size, 30);
});

test("每题的 nearest 都在能力表里", () => {
  assert.equal(TOOL_CAPABILITIES.length, 35);
  const operations = new Set(TOOL_CAPABILITIES.map((item) => item.operation));
  assert.deepEqual(load().questions.filter((item) => !operations.has(item.nearest)).map((item) => item.id), []);
});

test("expect、missing、stub 与类别对应", () => {
  const { questions } = load();
  for (const item of byClass(questions, "gap")) {
    assert.equal(item.expect, "gap", item.id);
    assert.ok(MISSING.includes(item.missing), item.id);
  }
  for (const item of questions.filter((entry) => entry.class !== "gap")) {
    assert.equal(item.expect, "no_gap", item.id);
    assert.equal(item.missing, null, item.id);
  }
  assert.deepEqual(questions.filter((item) => item.stub === "empty"), byClass(questions, "nodata"));
  assert.ok(questions.every((item) => item.stub === "empty" || item.stub === "rows"));
});

test("审阅状态要么两项都空，要么两项都填", () => {
  const file = load();
  assert.ok("reviewedBy" in file && "reviewedAt" in file);
  const filled = [file.reviewedBy, file.reviewedAt].map((value) => typeof value === "string" && value.trim().length > 0);
  assert.ok(filled.every(Boolean) || (file.reviewedBy === null && file.reviewedAt === null));
});

test("题面逐字与种子表一致", () => {
  const { questions } = load();
  const text = (id) => questions.find((item) => item.id === id)?.question;
  assert.equal(text("gap-04"), "本月所有订单的应收账款总额是多少");
  assert.equal(text("unstructured-05"), "MOCK-ORD-001 和 MOCK-ORD-002 哪个更急");
});
