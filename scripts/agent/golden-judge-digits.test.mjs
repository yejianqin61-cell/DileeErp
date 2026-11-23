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

const caseOf = (expect, id = "k-1", group = "known_answer") => ({ id, group, expect });

test("答案含期望数字时通过", () => {
  const result = judge({ caseDef: caseOf({ answerIncludesDigits: ["1000"] }), outcome: outcomeOf({ answer: "该单共 1000 个" }) });
  assert.equal(result.verdict, "pass");
});

test("10000 不能被 1000 越界命中", () => {
  const result = judge({ caseDef: caseOf({ answerIncludesDigits: ["1000"] }), outcome: outcomeOf({ answer: "该单共 10000 个" }) });
  assert.equal(result.verdict, "fail");
});

test("单号里的数字片段不算命中：先剥掉单号再匹配", () => {
  const result = judge({
    caseDef: caseOf({ answerIncludesDigits: ["1000"] }),
    outcome: outcomeOf({ answer: "单号 MOCK-ORD-1000 已确认", sources: [{ business_type: "sales_order", business_no: "MOCK-ORD-1000" }] }),
  });
  assert.equal(result.verdict, "fail");
});

test("剥掉单号之后数量仍然能命中", () => {
  const result = judge({
    caseDef: caseOf({ answerIncludesDigits: ["1000"] }),
    outcome: outcomeOf({ answer: "MOCK-ORD-001 共 1000 个", sources: [{ business_type: "sales_order", business_no: "MOCK-ORD-001" }] }),
  });
  assert.equal(result.verdict, "pass");
});

test("中文数字不算命中", () => {
  const result = judge({ caseDef: caseOf({ answerIncludesDigits: ["1000"] }), outcome: outcomeOf({ answer: "该单一千个" }) });
  assert.equal(result.verdict, "fail");
});

test("多个期望数字全部出现才通过", () => {
  const pass = judge({ caseDef: caseOf({ answerIncludesDigits: ["1000", "600"] }), outcome: outcomeOf({ answer: "1000 个与 600 个" }) });
  assert.equal(pass.verdict, "pass");
  const half = judge({ caseDef: caseOf({ answerIncludesDigits: ["1000", "600"] }), outcome: outcomeOf({ answer: "1000 个" }) });
  assert.equal(half.verdict, "fail");
  assert.match(half.reasons[0], /600/);
});

test("数字出现在串首或串尾也算命中", () => {
  const atStart = judge({ caseDef: caseOf({ answerIncludesDigits: ["1000"] }), outcome: outcomeOf({ answer: "1000 个" }) });
  assert.equal(atStart.verdict, "pass");
  const atEnd = judge({ caseDef: caseOf({ answerIncludesDigits: ["600"] }), outcome: outcomeOf({ answer: "合计 600" }) });
  assert.equal(atEnd.verdict, "pass");
});