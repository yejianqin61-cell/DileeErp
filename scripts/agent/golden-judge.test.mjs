import { test } from "node:test";
import assert from "node:assert/strict";

import { judge } from "./golden-judge.mjs";

function outcomeOf(overrides = {}) {
  return {
    terminal: "completed",
    errorCode: null,
    ops: [],
    failureCodes: [],
    sources: [],
    answer: "",
    toolCalls: 0,
    answerChunks: 1,
    ...overrides,
  };
}

const caseOf = (expect, id = "c-1", group = "entry") => ({ id, group, expect });

test("终态不符记 fail 并同时报出期望与实际", () => {
  const result = judge({ caseDef: caseOf({ terminal: "completed" }), outcome: outcomeOf({ terminal: "failed" }) });
  assert.equal(result.verdict, "fail");
  assert.match(result.reasons[0], /completed/);
  assert.match(result.reasons[0], /failed/);
});

test("来源缺失记 fail", () => {
  const result = judge({ caseDef: caseOf({ sourcesInclude: ["MOCK-ORD-001"] }), outcome: outcomeOf({ sources: [] }) });
  assert.equal(result.verdict, "fail");
  assert.match(result.reasons[0], /MOCK-ORD-001/);
});

test("来源含被排除类型记 fail", () => {
  const result = judge({
    caseDef: caseOf({ sourcesExcludeTypes: ["finance"] }),
    outcome: outcomeOf({ sources: [{ business_type: "finance", business_no: "X" }] }),
  });
  assert.equal(result.verdict, "fail");
});

test("未调用期望的 operation 记 fail", () => {
  const result = judge({ caseDef: caseOf({ opsInclude: ["search_documents"] }), outcome: outcomeOf({ ops: [] }) });
  assert.equal(result.verdict, "fail");
  assert.match(result.reasons[0], /search_documents/);
});

test("出现被禁用的失败码记 fail", () => {
  const result = judge({
    caseDef: caseOf({ failureCodesExclude: ["ORDER_NOT_FOUND"] }),
    outcome: outcomeOf({ failureCodes: ["ORDER_NOT_FOUND"] }),
  });
  assert.equal(result.verdict, "fail");
});

test("工具次数超过上限记 fail", () => {
  const result = judge({ caseDef: caseOf({ maxToolCalls: 6 }), outcome: outcomeOf({ toolCalls: 7 }) });
  assert.equal(result.verdict, "fail");
  assert.match(result.reasons[0], /7/);
});

test("答案含被排除文本记 fail", () => {
  const result = judge({ caseDef: caseOf({ answerExclude: ["逾期"] }), outcome: outcomeOf({ answer: "该单已逾期三天" }) });
  assert.equal(result.verdict, "fail");
  assert.match(result.reasons[0], /逾期/);
});

test("基线缺失时判 baseline_missing 而非 fail", () => {
  const result = judge({
    caseDef: caseOf({ terminal: "completed" }),
    outcome: outcomeOf({ terminal: "failed" }),
    missingBaseline: ["MOCK-ORD-002"],
  });
  assert.equal(result.verdict, "baseline_missing");
  assert.match(result.reasons[0], /MOCK-ORD-002/);
});

test("全部期望满足时 pass 且 reasons 为空", () => {
  const result = judge({
    caseDef: caseOf({ terminal: "completed", sourcesInclude: ["MOCK-ORD-001"], opsInclude: ["search_documents"], maxToolCalls: 8 }),
    outcome: outcomeOf({ sources: [{ business_type: "sales_order", business_no: "MOCK-ORD-001" }], ops: ["search_documents"], toolCalls: 3 }),
  });
  assert.equal(result.verdict, "pass");
  assert.deepEqual(result.reasons, []);
});

test("同时踩多个原因时全部列出", () => {
  const result = judge({
    caseDef: caseOf({ terminal: "completed", sourcesInclude: ["MOCK-ORD-001"], maxToolCalls: 4 }),
    outcome: outcomeOf({ terminal: "failed", toolCalls: 9 }),
  });
  assert.equal(result.verdict, "fail");
  assert.equal(result.reasons.length, 3);
});