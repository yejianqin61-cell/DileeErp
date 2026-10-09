// 采购计划「填单价」的纯函数口径（node:test）。
//
// 用户 2026-10-09：「我还是希望在采购计划中前端也能允许填写价格。也可以选择导入BOM的对应的物料的价格。」
// 追问导入范围后他选的是：**只填还没填（0 价）的未下单行**。
//
// 这里钉住的四件事，每一件对应一次真实的踩坑方式：
//   ① 手填过的价**不许**被 BOM 的参考价覆盖（那是采购员跟供应商谈定的数）；
//   ② 已下单的行**不许**被导入碰（它那一格已经是采购单上的价）；
//   ③ BOM 上没参考价的行要保持空白、而且要在结果文案里报出来（否则用户以为「导过了」）；
//   ④ 数字的显示形式：`10.0000 → 10`，但**不许**把 `"10"` 剥成 `"1"`（上一版那个写法的 bug）。
import assert from "node:assert/strict";
import { test } from "node:test";
import { importBomPrices, mergeBomReferences, pendingPriceIndexes, priceImportSummary, trimPlanNumber } from "./purchase-plan-price-entry.ts";

const row = (overrides = {}) => ({ unitPrice: "0", ordered: false, bomReferenceUnitPrice: null, bomReferenceUnitCurrency: null, ...overrides });

test("只填还没填（0 价）的未下单行，并带上 BOM 上那个价与币种", () => {
  const outcome = importBomPrices([
    row({ bomReferenceUnitPrice: "12.5000", bomReferenceUnitCurrency: "USD" }),
    row({ bomReferenceUnitPrice: "7.0000" }),
  ]);

  assert.deepEqual(outcome.patches, [
    { index: 0, unitPrice: "12.5", currency: "USD" },
    { index: 1, unitPrice: "7", currency: null },
  ], "参考价剥掉多余的 0（给人看/给人改的形式）；BOM 没写币种就给 null，由调用方沿用这一行原来的币种");
  assert.equal(outcome.filled, 2);
  assert.equal(outcome.noReference, 0);
});

test("手填过的价一律不动：导入是「补空」，不是「覆盖」", () => {
  const outcome = importBomPrices([
    row({ unitPrice: "9.9000", bomReferenceUnitPrice: "12.5000" }),
    row({ unitPrice: "0", bomReferenceUnitPrice: "12.5000" }),
  ]);

  assert.deepEqual(outcome.patches, [{ index: 1, unitPrice: "12.5", currency: null }]);
  assert.equal(outcome.hasPrice, 1, "谈过价的那一行只计数、不产生任何 patch");
  assert.equal(outcome.filled, 1);
});

test("已下单的行不动：它那一格已经是采购单上的价", () => {
  const outcome = importBomPrices([
    row({ ordered: true, bomReferenceUnitPrice: "12.5000" }),
    row({ ordered: true, unitPrice: "3.0000", bomReferenceUnitPrice: "12.5000" }),
  ]);

  assert.deepEqual(outcome.patches, []);
  assert.equal(outcome.ordered, 2);
  assert.equal(outcome.filled, 0);
});

test("BOM 上也没有参考价的行：保持空白，并报出条数（不能让人以为都导过了）", () => {
  const outcome = importBomPrices([
    row({ bomReferenceUnitPrice: null }),
    row({ bomReferenceUnitPrice: "0.0000" }),
    row({ bomReferenceUnitPrice: "5.0000" }),
  ]);

  assert.equal(outcome.noReference, 2, "参考价为 0 等于「还没谈价」，与 null 一视同仁");
  assert.equal(outcome.filled, 1);
  const text = priceImportSummary(outcome);
  assert.match(text, /填了 1 行/);
  assert.match(text, /2 行 BOM 上也没有参考价/);
});

test("结果文案把「没动的」也说清楚，否则会被当成「怎么没导全」", () => {
  const text = priceImportSummary(importBomPrices([
    row({ bomReferenceUnitPrice: "1.0000" }),
    row({ unitPrice: "2.0000", bomReferenceUnitPrice: "1.0000" }),
    row({ ordered: true }),
    row({ bomReferenceUnitPrice: null }),
  ]));
  assert.match(text, /填了 1 行/);
  assert.match(text, /1 行 BOM 上也没有参考价/);
  assert.match(text, /1 行已经填过价（不动）/);
  assert.match(text, /1 行已下单（不动）/);

  assert.equal(priceImportSummary(importBomPrices([row({ unitPrice: "2.0000" })])), "没有需要导入的行：这些行的单价都已经填好了");
});

test("待填行号：0 与空串都算「还没填」，供「还有 N 行」与下单确认用", () => {
  assert.deepEqual(pendingPriceIndexes([row({ unitPrice: "3.0000" }), row({ unitPrice: "0" }), row({ unitPrice: "" })]), [1, 2]);
  assert.deepEqual(pendingPriceIndexes([]), []);
});

test("数字的显示形式：只在**小数点之后**剥零", () => {
  assert.equal(trimPlanNumber("10.0000"), "10");
  assert.equal(trimPlanNumber("12.5000"), "12.5");
  assert.equal(trimPlanNumber("0.0000"), "0");
  assert.equal(trimPlanNumber("0.5000"), "0.5");
  // 这一条是上一版写法的 bug：`"10".replace(/0+$/, "")` 会得到 `"1"`。
  assert.equal(trimPlanNumber("10"), "10");
  assert.equal(trimPlanNumber("100"), "100");
  // 半截输入与空值原样返回（界面不该为半个输入框报错）
  assert.equal(trimPlanNumber(""), "");
  assert.equal(trimPlanNumber("-"), "-");
  assert.equal(trimPlanNumber(null), "");
  assert.equal(trimPlanNumber(undefined), "");
});

test("把刚取回来的参考价并到草稿行上：只并参考单价，用户改过的数量/单价一律不动", () => {
  const rows = [
    { id: "i-1", unitPrice: "0", quantity: "5", supplierId: "s-1", bomReferenceUnitPrice: null, bomReferenceUnitCurrency: null },
    { id: "i-2", unitPrice: "9.9", quantity: "2", supplierId: null, bomReferenceUnitPrice: "1.0000", bomReferenceUnitCurrency: "CNY" },
  ];
  const merged = mergeBomReferences(rows, [
    { id: "i-1", bomReferenceUnitPrice: "12.5000", bomReferenceUnitCurrency: "USD" },
    // i-2 在这次返回里没有（行 ID 变了 / BOM 上删掉了）→ 参考价清成 null，而不是留着旧值骗人
  ]);

  assert.deepEqual(merged[0], { id: "i-1", unitPrice: "0", quantity: "5", supplierId: "s-1", bomReferenceUnitPrice: "12.5000", bomReferenceUnitCurrency: "USD" });
  assert.equal(merged[1].bomReferenceUnitPrice, null, "这次没返回的行不再假装有参考价");
  assert.equal(merged[1].unitPrice, "9.9", "用户填过的单价一个字都没动");
  assert.equal(merged[1].supplierId, null, "供应商也不动");
  // 合并 + 导入是一条链：并完新参考价之后，只有空格子会被填上
  assert.deepEqual(importBomPrices(merged).patches, [{ index: 0, unitPrice: "12.5", currency: "USD" }]);
});

test("新建的行（还没有 id）不会被参考价误伤", () => {
  const merged = mergeBomReferences([{ id: null, unitPrice: "0" }], [{ id: "i-1", bomReferenceUnitPrice: "12.5000" }]);
  assert.equal(merged[0].bomReferenceUnitPrice, null);
  assert.deepEqual(importBomPrices(merged).patches, []);
});
