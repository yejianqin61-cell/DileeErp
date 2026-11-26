import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { CaseError, loadCases, parseCase } from "./golden-cases.mjs";

const casesDir = fileURLToPath(new URL("../../apps/api/test/agent-golden/cases/", import.meta.url));
const questions = JSON.parse(readFileSync(new URL("../../apps/api/test/agent-golden/gap-cases/gap-questions.json", import.meta.url), "utf8")).questions;

const gapCase = { id: "gap-01", group: "gap", question: "按供应商汇总本月采购金额", gap: { class: "gap", nearest: "get_payables" }, expect: { terminal: "completed" } };
const isCaseError = (error) => error instanceof CaseError && /gap/.test(error.message);

test("gap 组缺 gap 字段、类别不对、别的组带 gap 都抛错", () => {
  const { gap: _gap, ...without } = gapCase;
  assert.throws(() => parseCase(without), isCaseError);
  assert.throws(() => parseCase({ ...gapCase, gap: { class: "nodata", nearest: "get_payables" } }), isCaseError);
  assert.throws(() => parseCase({ ...gapCase, gap: { class: "gap", nearest: "" } }), isCaseError);
  assert.throws(() => parseCase({ ...gapCase, gap: { class: "gap", nearest: "get_payables", extra: 1 } }), isCaseError);
  assert.throws(() => parseCase({ ...gapCase, group: "entry" }), isCaseError);
});

test("合法缺口用例保留 gap", () => {
  assert.deepEqual(parseCase(gapCase).gap, { class: "gap", nearest: "get_payables" });
});

test("全部用例 91 条，缺口组 20 条两类各 10", () => {
  const cases = loadCases(casesDir);
  assert.equal(cases.length, 91);
  const gaps = cases.filter((item) => item.group === "gap");
  assert.equal(gaps.length, 20);
  assert.equal(gaps.filter((item) => item.gap.class === "gap").length, 10);
  assert.equal(gaps.filter((item) => item.gap.class === "decoy").length, 10);
});

test("缺口用例与题集逐条一致", () => {
  const byId = new Map(loadCases(casesDir).filter((item) => item.group === "gap").map((item) => [item.id, item]));
  const expected = questions.filter((item) => item.class === "gap" || item.class === "decoy");
  assert.equal(byId.size, expected.length);
  for (const question of expected) {
    const found = byId.get(question.id);
    assert.ok(found, question.id);
    assert.equal(found.question, question.question, question.id);
    assert.deepEqual(found.gap, { class: question.class, nearest: question.nearest }, question.id);
  }
});

test("目录问法用例要求走列表入口", () => {
  const found = loadCases(casesDir).find((item) => item.id === "entry-catalog-list");
  assert.equal(found.question, "最近有哪些已确认的销售订单");
  assert.deepEqual(found.expect.opsInclude, ["list_documents"]);
});
