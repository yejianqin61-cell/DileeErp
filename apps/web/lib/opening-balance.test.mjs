// 建账期初余额面板纯逻辑的测试（node:test，与 apps/web/lib/*.test.mjs 同一套）。
//
// 用户 2026-09-24：「1,3,4 都要」的第 ③ 件 —— 科目期初余额表。
// 四件事：
//   ① 后端行 → 编辑器行（科目快照兜底显示、方向归一）；
//   ② 借贷合计按「分」精确相加，差额与平衡判定与后端同一口径；
//   ③ 保存的请求体是**整批**（这张表就是「我现在的期初」），并且丢掉整行空白的行；
//   ④ 缺科目/缺金额拦在保存前并指名第几行，而**借贷不平不拦**（财务可能分批录）。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  emptyOpeningRow,
  nextOpeningRowKey,
  openingBlockers,
  openingPayload,
  openingRowsFromApi,
  openingTotals,
  subjectKeyOf,
} from "./opening-balance.ts";

const row = (extra = {}) => ({ ...emptyOpeningRow(nextOpeningRowKey()), ...extra });

test("opening-balance：科目键与后端同一口径（分类/名称）", () => {
  assert.equal(subjectKeyOf({ category: "资产类", name: "银行存款 农业银行" }), "资产类/银行存款 农业银行");
  assert.equal(emptyOpeningRow("k").direction, "debit", "新建一行默认借方");
  assert.equal(emptyOpeningRow("k").amount, "");
});

test("opening-balance：后端行 → 编辑器行（方向归一、科目名快照兜底）", () => {
  const rows = openingRowsFromApi([
    { subject_key: "资产类/银行存款", subject_label: "银行存款", direction: "debit", amount: "1000", remark: "建账" },
    { subject_key: "负债类/应付账款", subject_label: "", direction: "credit", amount: "1000", remark: null },
    { subject_key: "所有者权益类/实收资本", subject_label: "实收资本", direction: "两边都算", amount: "0" },
  ]);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].amount, "1000");
  assert.equal(rows[0].remark, "建账");
  assert.equal(rows[1].subjectLabel, "负债类/应付账款", "没有快照名时退回科目键（宁可显示键，也不要空格子）");
  assert.equal(rows[2].direction, "debit", "方向只认 credit，其余按借处理（后端也不接受第三个值）");
  assert.notEqual(rows[0].key, rows[1].key, "每行各有 key，增删行不会串行");
});

test("opening-balance：借贷合计与差额（按分精确相加），非法金额单独标出来", () => {
  const totals = openingTotals([
    row({ subjectKey: "资产类/银行存款", direction: "debit", amount: "0.1" }),
    row({ subjectKey: "资产类/库存现金", direction: "debit", amount: "0.2" }),
    row({ subjectKey: "所有者权益类/实收资本", direction: "credit", amount: "0.3" }),
  ]);
  assert.equal(totals.debit, "0.3", "0.1 + 0.2 必须是 0.3");
  assert.equal(totals.credit, "0.3");
  assert.equal(totals.balanced, true);

  const unbalanced = openingTotals([row({ direction: "debit", amount: "100" }), row({ direction: "credit", amount: "60" })]);
  assert.equal(unbalanced.balanced, false);
  assert.equal(unbalanced.difference, "40");

  const bad = openingTotals([row({ direction: "debit", amount: "-5" }), row({ direction: "debit", amount: "abc" })]);
  assert.equal(bad.invalid, true, "非法金额要与「还没填」分开");
  assert.equal(bad.balanced, false);

  assert.equal(openingTotals([emptyOpeningRow("a"), emptyOpeningRow("b")]).balanced, true, "整张空表算平（借/贷都是 0）");
});

test("opening-balance：请求体是整批，整行空白丢掉（空行不挡保存）", () => {
  const payload = openingPayload(" 2026-09-01 ", "cny", [
    row({ subjectKey: "资产类/银行存款", subjectLabel: "银行存款", direction: "debit", amount: " 1000 ", remark: " 建账 " }),
    emptyOpeningRow("blank"),
    row({ subjectKey: "所有者权益类/实收资本", direction: "credit", amount: "1000" }),
  ]);
  assert.equal(payload.as_of_date, "2026-09-01");
  assert.equal(payload.currency, "CNY", "币种统一大写");
  assert.equal(payload.rows.length, 2, "整行空白的那行不进请求体");
  assert.deepEqual(payload.rows[0], { subject_key: "资产类/银行存款", subject_label: "银行存款", direction: "debit", amount: "1000", remark: "建账" });
  assert.equal(payload.rows[1].remark, undefined, "空备注不写空串（JSON 里直接没有这个键）");
});

test("opening-balance：缺科目/缺金额一次说完并指名行号；借贷不平**不拦**", () => {
  assert.deepEqual(openingBlockers([row({ amount: "500" })], "2026-09-01"), ["第 1 行请选择会计科目"]);
  assert.deepEqual(openingBlockers([row({ subjectKey: "资产类/银行存款" })], "2026-09-01"), ["第 1 行请填写期初金额"]);
  assert.deepEqual(openingBlockers([row({ subjectKey: "资产类/银行存款", amount: "abc" })], "2026-09-01"), ["第 1 行金额必须是大于零的数字（最多 4 位小数）"]);
  assert.deepEqual(openingBlockers([row({ subjectKey: "资产类/银行存款", amount: "100" })], "2026/09/01"), ["请选择建账日期"]);
  // 借贷不平不是「拦」，是财务的决策依据（可能分批录）：blockers 里不该出现它。
  const unbalanced = openingBlockers([
    row({ subjectKey: "资产类/银行存款", direction: "debit", amount: "100" }),
    row({ subjectKey: "所有者权益类/实收资本", direction: "credit", amount: "60" }),
  ], "2026-09-01");
  assert.deepEqual(unbalanced, []);
  assert.equal(openingTotals([
    row({ direction: "debit", amount: "100" }),
    row({ direction: "credit", amount: "60" }),
  ]).balanced, false);
});
