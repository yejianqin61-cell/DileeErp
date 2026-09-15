const test = require("node:test");
const assert = require("node:assert/strict");
const { payableOutstanding, paymentAllocationRemaining, payableAllocationRemaining, payableStatus, sourceType, payableInReconciliationScope, coveringPayableReconciliation } = require("../../dist/modules/finance/supplier-payable.domain.js");

test("C6 calculates payable outstanding with exact decimal arithmetic", () => {
  assert.equal(payableOutstanding("100.1250", "30.1250"), "70");
  assert.equal(payableStatus("100", "0"), "confirmed");
  assert.equal(payableStatus("100", "20"), "partially_paid");
  assert.equal(payableStatus("100", "100"), "paid");
});

test("C6 blocks allocation beyond either payment or payable balance", () => {
  assert.equal(paymentAllocationRemaining("100", "20", "30"), "50");
  assert.equal(payableAllocationRemaining("100", "20", "30"), "50");
  assert.throws(() => paymentAllocationRemaining("100", "90", "11"), /payment allocation/);
  assert.throws(() => payableAllocationRemaining("100", "90", "11"), /payable allocation/);
});

test("C6 accepts all supported payable source types", () => {
  assert.equal(sourceType("raw_material_inbound"), "raw_material_inbound");
  assert.equal(sourceType("purchase_receipt"), "purchase_receipt");
  assert.equal(sourceType("outsource_receipt"), "outsource_receipt");
  assert.throws(() => sourceType("customer_return"), /invalid payable source/);
});

// ---------------------------------------------------------------------------
// 2026-09-16：对账覆盖口径（用户反馈「创建对账单之后，待创建对账还在展示这条条目」）。
// 「哪些应付属于这张对账单」必须是**一个**定义，否则前端说没对过账、后端说已覆盖，各说各话。
// ---------------------------------------------------------------------------

const entry = (over = {}) => ({ supplierId: "supplier-1", currency: "CNY", orderNo: "SO-1", purchaseOrderId: "po-1", confirmationDate: new Date("2026-09-10T00:00:00.000Z"), ...over });
const scope = (over = {}) => ({ supplierId: "supplier-1", currency: "CNY", orderNo: null, purchaseOrderId: null, periodStart: new Date("2026-09-01T00:00:00.000Z"), periodEnd: new Date("2026-09-30T00:00:00.000Z"), ...over });

test("对账范围 = 供应商 + 币种 + 期间，未填订单/采购单时不收窄", () => {
  assert.equal(payableInReconciliationScope(entry(), scope()), true);
  // 期间边界含首尾两天
  assert.equal(payableInReconciliationScope(entry({ confirmationDate: new Date("2026-09-01T00:00:00.000Z") }), scope()), true);
  assert.equal(payableInReconciliationScope(entry({ confirmationDate: new Date("2026-09-30T00:00:00.000Z") }), scope()), true);
  // 期间外 / 别的供应商 / 别的币种都不算覆盖
  assert.equal(payableInReconciliationScope(entry({ confirmationDate: new Date("2026-08-31T00:00:00.000Z") }), scope()), false);
  assert.equal(payableInReconciliationScope(entry({ supplierId: "supplier-2" }), scope()), false);
  assert.equal(payableInReconciliationScope(entry({ currency: "USD" }), scope()), false);
});

test("对账填了订单或采购单时只覆盖对应的应付", () => {
  assert.equal(payableInReconciliationScope(entry(), scope({ orderNo: "SO-1" })), true);
  assert.equal(payableInReconciliationScope(entry({ orderNo: "SO-2" }), scope({ orderNo: "SO-1" })), false);
  assert.equal(payableInReconciliationScope(entry(), scope({ purchaseOrderId: "po-9" })), false);
});

test("coveringPayableReconciliation 给出覆盖这条应付的第一张对账单，没有则 null", () => {
  const outside = scope({ periodStart: new Date("2026-08-01T00:00:00.000Z"), periodEnd: new Date("2026-08-31T00:00:00.000Z") });
  const inside = scope({ id: "recon-1" });
  assert.equal(coveringPayableReconciliation(entry(), [outside, inside])?.id, "recon-1");
  assert.equal(coveringPayableReconciliation(entry(), [outside]), null);
});
