// 采购计划金额纯函数（node:test，纯函数按仓库约定走 node --test）。
//
// 用户 2026-09-30：「针对当前的采购计划，要求添加价格字段，单价，总价。不然财务没法付钱。」
//
// 两件必须钉住的事：
//   1. **与后端同一个数**：这一页的行总价与合计是前端即时算的（用户一边改单价一边要看钱），
//      而后端 `purchase-plans.domain.ts` 的 `planLineAmount` / `sumPlanAmounts` 用 Decimal 精确算。
//      两边**同一组向量**（本文件与 `apps/api/test/unit/purchase-plans-service.test.cjs`）
//      断言同一批数字：前端显示 17.50、后端存 17.5000 时，它们必须是同一个数。
//   2. **不走浮点**：`0.1 × 3` 在浮点下是 0.30000000000000004；金额是拿来对账的。
//      还有一处更隐蔽的分歧在"半进位"：`(2.225).toFixed(2)` 是 `"2.22"`（双精度表示略小于 2.225），
//      而后端 decimal.js 的 ROUND_HALF_UP 给 `"2.23"` —— 界面和后端各说一个数，谁也查不出为什么。
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_PLAN_CURRENCY, amountSummaryText, amountText, lineAmount, lineAmountText, sumPlanAmounts } from "./purchase-plan-amount.ts";

test("行总价 = 数量 × 单价，4 位小数（与后端 planLineAmount 同向量）", () => {
  assert.equal(lineAmount("5.0000", "3.5000"), "17.5000");
  assert.equal(lineAmount("2", "1.1111"), "2.2222");
  assert.equal(lineAmount("12.5", "0.88"), "11.0000");
});

test("行总价不走浮点：0.1 × 3 必须是精确的 0.3000", () => {
  // 浮点实现会给出 "0.30000000000000004"，落成 4 位小数只是"看起来对了" ——
  // 一旦它进了合计，误差就会累积到分位。
  assert.equal(lineAmount("0.1", "3"), "0.3000");
  assert.equal(lineAmount("0.07", "3"), "0.2100");
});

test("合计按币种分组，绝不跨币种相加（与后端 sumPlanAmounts 同一组向量）", () => {
  const rows = [
    { quantity: "5", unitPrice: "3.5000", currency: "USD" },
    { quantity: "2", unitPrice: "1.0000", currency: "CNY" },
    { quantity: "3", unitPrice: "2.0000", currency: "USD" },
  ];
  assert.deepEqual(sumPlanAmounts(rows), [
    { currency: "CNY", amount: "2.0000" },
    { currency: "USD", amount: "23.5000" },
  ], "美元那两行加起来是 23.5，不能与人民币的 2 合成 25.5");
  assert.deepEqual(sumPlanAmounts([{ quantity: "1", unitPrice: "9", currency: null }]), [{ currency: DEFAULT_PLAN_CURRENCY, amount: "9.0000" }], "币种缺省按人民币");
  assert.deepEqual(sumPlanAmounts([]), [], "空计划不返回一行假合计");
});

test("显示口径：4 位小数收成 2 位，且是**半进位**（不是 JS 浮点的 toFixed）", () => {
  assert.equal(amountText("17.5000"), "17.50");
  assert.equal(amountText("2.2222"), "2.22");
  assert.equal(amountText("0"), "0.00");
  // 这一条是浮点实现会失败的地方：`(2.225).toFixed(2)` === "2.22"。
  assert.equal(amountText("2.2250"), "2.23", "半值必须进位（后端 ROUND_HALF_UP 会给 2.23）");
  assert.equal(amountText("2.2249"), "2.22");
  assert.equal(amountText("1234.5678"), "1234.57");
});

test("半途输入与脏值不炸、不显示 NaN（界面不该为半个输入框报错）", () => {
  for (const value of ["", "   ", "-", ".", "abc", null, undefined, "1e999"]) {
    assert.equal(amountText(value), "0.00", `${String(value)} 要当 0`);
  }
  assert.equal(lineAmountText("3", ""), "0.00");
  assert.equal(lineAmountText("abc", "2"), "0.00");
});

test("行总价显示给界面用（2 位）", () => {
  assert.equal(lineAmountText("5", "3.5"), "17.50");
  assert.equal(lineAmountText("2", "1.1111"), "2.22");
});

test("合计文案把币种写在前面（一个没有币种的数看起来是对的，而它可能是错的）", () => {
  assert.equal(amountSummaryText([{ currency: "CNY", amount: "17.5000" }]), "CNY 17.50");
  assert.equal(amountSummaryText([{ currency: "CNY", amount: "17.5000" }, { currency: "USD", amount: "2.0000" }]), "CNY 17.50 · USD 2.00");
  assert.equal(amountSummaryText([]), "");
});
