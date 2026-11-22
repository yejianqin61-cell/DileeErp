import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CaseError, GROUPS, loadCases, parseCase, selectCases, turnsOf } from "./golden-cases.mjs";

const single = {
  id: "entry-sales-exact",
  group: "entry",
  question: "MOCK-ORD-001 现在什么状态",
  baselineDocs: ["MOCK-ORD-001"],
  expect: { terminal: "completed", sourcesInclude: ["MOCK-ORD-001"], opsInclude: ["search_documents"] },
};

const multi = {
  id: "followup-two-rounds",
  group: "followup",
  turns: ["MOCK-ORD-001 什么状态", "那它的采购单到货了吗", "生产进度呢"],
  expect: { terminal: "completed" },
};

test("合法单轮用例原样通过，产出 question 且无 turns", () => {
  const parsed = parseCase(single);
  assert.equal(parsed.id, "entry-sales-exact");
  assert.equal(parsed.group, "entry");
  assert.equal(parsed.question, "MOCK-ORD-001 现在什么状态");
  assert.equal(parsed.turns, undefined);
  assert.deepEqual(parsed.baselineDocs, ["MOCK-ORD-001"]);
  assert.equal(parsed.expect.terminal, "completed");
  assert.deepEqual(turnsOf(parsed), ["MOCK-ORD-001 现在什么状态"]);
});

test("合法多轮用例保留三轮", () => {
  const parsed = parseCase(multi);
  assert.equal(parsed.question, undefined);
  assert.equal(parsed.turns.length, 3);
  assert.deepEqual(turnsOf(parsed), multi.turns);
});

test("缺 id 抛错并点名 id", () => {
  assert.throws(() => parseCase({ ...single, id: undefined }), (error) => error instanceof CaseError && /id/.test(error.message));
});

test("未知 group 抛错并列出允许的组", () => {
  assert.throws(
    () => parseCase({ ...single, group: "bogus" }),
    (error) => error instanceof CaseError && error.message.includes("bogus") && error.message.includes(GROUPS[0]),
  );
});

test("question 与 turns 同时给抛错", () => {
  assert.throws(() => parseCase({ ...single, turns: ["a", "b"] }), (error) => error instanceof CaseError && /question/.test(error.message));
});

test("expect 出现未知键抛错并点名该键", () => {
  assert.throws(
    () => parseCase({ ...single, expect: { ...single.expect, fooBar: ["x"] } }),
    (error) => error instanceof CaseError && error.message.includes("fooBar"),
  );
});

test("turns 只有一条时抛错", () => {
  assert.throws(() => parseCase({ ...multi, turns: ["只看这一条"] }), (error) => error instanceof CaseError && /至少两轮/.test(error.message));
});

test("maxToolCalls 非正整数时抛错", () => {
  assert.throws(() => parseCase({ ...single, expect: { maxToolCalls: 0 } }), (error) => error instanceof CaseError && /maxToolCalls/.test(error.message));
});

test("loadCases 读到重复 id 时抛错并点名该 id", () => {
  const dir = mkdtempSync(join(tmpdir(), "golden-cases-"));
  writeFileSync(join(dir, "a.json"), JSON.stringify([single]), "utf8");
  writeFileSync(join(dir, "b.json"), JSON.stringify([{ ...single, question: "另一句" }]), "utf8");
  assert.throws(() => loadCases(dir), (error) => error instanceof CaseError && error.message.includes("entry-sales-exact"));
});

test("selectCases 按组过滤，未知组抛错", () => {
  const cases = [parseCase(single), parseCase(multi)];
  assert.equal(selectCases(cases, []).length, 2);
  assert.equal(selectCases(cases, ["entry"]).length, 1);
  assert.throws(() => selectCases(cases, ["nope"]), (error) => error instanceof CaseError && /nope/.test(error.message));
});