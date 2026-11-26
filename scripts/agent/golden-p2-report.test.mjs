import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { evaluate, renderP2 } from "./golden-p2-report.mjs";

const p1 = JSON.parse(readFileSync(new URL("../../docs/review/agent-golden-p1-2026-11-23.snapshot.json", import.meta.url), "utf8"));

const ids = Array.from({ length: 70 }, (_, index) => `c${index}`);
const baseline = { judged: ids.map((id) => ({ id, group: "entry", verdict: "pass", failureCodes: [], modelSteps: 3 })) };

function entry(id, rep, { steps = 2, codes = [], terminal = "completed", gap } = {}) {
  const caseDef = { id, group: gap ? "gap" : "entry", expect: { terminal: "completed" }, ...(gap ? { gap } : {}) };
  return { caseDef, rep, missing: [], outcome: { terminal, failureCodes: codes, sources: [], ops: [], answer: "", toolCalls: 1, modelSteps: steps, gapDeclarations: [] } };
}

const full = (patch = () => ({})) => [1, 2, 3].flatMap((rep) => ids.map((id) => entry(id, rep, patch(id, rep))));
const criterion = (result, id) => result.criteria.find((item) => item.id === id);

test("P1 基线按组中位数与报告一致", () => {
  const { baseline: summary } = evaluate({ entries: [], baseline: p1 });
  assert.equal(summary.median, 3);
  assert.deepEqual(Object.fromEntries(summary.byGroup.map((row) => [row.group, row.median])), { entry: 3, finance_positive: 3, followup: 6, known_answer: 2, miss: 2, permission: 3, relation: 3 });
});

test("每条先取三轮中间值，缺失步数不参与并计数", () => {
  const two = { judged: baseline.judged.slice(0, 2) };
  const steps = { c0: [2, 5, 2], c1: [3, 0, 3] };
  const entries = [1, 2, 3].flatMap((rep) => ["c0", "c1"].map((id) => entry(id, rep, { steps: steps[id][rep - 1] })));
  const result = evaluate({ entries, baseline: two });
  assert.deepEqual(result.caseSteps, { c0: 2, c1: 3 });
  assert.equal(result.missingSteps, 1);
});

test("判据一只看基线内用例", () => {
  const entries = [...full(), ...[1, 2, 3].flatMap((rep) => Array.from({ length: 100 }, (_, index) => entry(`x${index}`, rep, { steps: 9 })))];
  const result = evaluate({ entries, baseline });
  assert.equal(result.median, 2);
  assert.equal(criterion(result, 1).met, true);
  assert.equal(criterion(evaluate({ entries: full(() => ({ steps: 3 })), baseline }), 1).met, false);
});

test("基线用例缺轮次时判据都不算达成", () => {
  const result = evaluate({ entries: full().slice(1), baseline });
  assert.deepEqual(result.criteria.map((item) => item.met), [false, false, false]);
});

test("失败码占比不超过七十分之一", () => {
  const withCodes = (count) => full((id, rep) => (rep === 1 && Number(id.slice(1)) < count ? { codes: ["X"] } : {}));
  assert.equal(criterion(evaluate({ entries: withCodes(3), baseline }), 3).met, true);
  assert.equal(criterion(evaluate({ entries: withCodes(4), baseline }), 3).met, false);
});

test("任一轮未通过则判据二未达成，报告点名用例与轮次", () => {
  const entries = full((id, rep) => (id === "c7" && rep === 2 ? { terminal: "failed" } : {}));
  const result = evaluate({ entries, baseline });
  assert.equal(criterion(result, 2).met, false);
  const text = renderP2(result, { runAt: "2026-11-26T00:00:00.000Z", model: "deepseek-chat" });
  assert.match(text, /\| c7 \| 2 \|/);
  assert.match(text, /判据二[^\n]*未达成/);
  assert.match(text, /判据一[^\n]*达成/);
});

test("报告写出漂移率与误报率的分子分母", () => {
  const gap = entry("gap-01", 1, { gap: { class: "gap", nearest: "get_payables" } });
  gap.outcome.gapDeclarations = [{ nearest_operation: "list_documents", missing: "filter" }];
  const text = renderP2(evaluate({ entries: [gap], baseline }), { analysis: "落在 gap-01。" });
  assert.match(text, /漂移率[^\n]*1 \/ 1/);
  assert.match(text, /误报率[^\n]*0 \/ 0/);
  assert.match(text, /落在 gap-01。/);
});

test("有权限题时报告写出其声明数，没有时不写这一行", () => {
  const declared = entry("gap-01", 1, { gap: { class: "permission", nearest: "get_payables" } });
  declared.outcome.gapDeclarations = [{ nearest_operation: "list_documents", missing: "filter" }];
  assert.match(renderP2(evaluate({ entries: [declared], baseline })), /权限题[^\n]*1 \/ 1/);
  assert.doesNotMatch(renderP2(evaluate({ entries: full(), baseline })), /权限题/);
});
