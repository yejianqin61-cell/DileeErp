const test = require("node:test");
const assert = require("node:assert/strict");
const { allocationAvailable, paymentAllocationRemaining, receivableStatus, receivableInReconciliationScope, coveringReceivableReconciliation } = require("../../dist/modules/finance/receivable.domain.js");

test("E4 prevents allocation beyond receivable balance", () => {
  assert.equal(allocationAvailable("100", "30", "20"), "50");
  assert.throws(() => allocationAvailable("100", "90", "20"));
});

test("E4 prevents payment over-allocation", () => {
  assert.equal(paymentAllocationRemaining("100", "30", "20"), "50");
  assert.throws(() => paymentAllocationRemaining("100", "90", "20"));
});

test("E4 derives receivable payment status", () => {
  assert.equal(receivableStatus("100", "0"), "confirmed");
  assert.equal(receivableStatus("100", "30"), "partially_paid");
  assert.equal(receivableStatus("100", "100"), "paid");
});

// ---------------------------------------------------------------------------
// 2026-09-16：应收对账的覆盖口径（与应付侧 payableInReconciliationScope 对称）。
// 用户要求「应收侧对应的问题也都改」：已纳入对账单的出库条目不该继续出现在「待创建对账」。
// ---------------------------------------------------------------------------

const source = (over = {}) => ({ customerId: "customer-1", orderNo: "SO-1", currency: "CNY", createdAt: new Date("2026-09-10T00:00:00.000Z"), ...over });
const scope = (over = {}) => ({ customerId: "customer-1", orderNo: null, currency: "CNY", periodStart: new Date("2026-09-01T00:00:00.000Z"), periodEnd: new Date("2026-09-30T00:00:00.000Z"), ...over });

test("应收对账范围 = 客户 + 币种 + 期间（未填订单号时不收窄到订单）", () => {
  assert.equal(receivableInReconciliationScope(source(), scope()), true);
  // 客户级对账覆盖该客户所有订单
  assert.equal(receivableInReconciliationScope(source({ orderNo: "SO-9" }), scope()), true);
  // 期间按整天闭区间：结束日 23:59 的条目也算在内
  assert.equal(receivableInReconciliationScope(source({ createdAt: new Date("2026-09-30T23:59:59.000Z") }), scope()), true);
  assert.equal(receivableInReconciliationScope(source({ createdAt: new Date("2026-09-01T00:00:00.000Z") }), scope()), true);
  // 期间外 / 别的客户 / 别的币种都不算覆盖
  assert.equal(receivableInReconciliationScope(source({ createdAt: new Date("2026-10-01T00:00:00.000Z") }), scope()), false, "结束日之后的第二天 00:00 不算");
  assert.equal(receivableInReconciliationScope(source({ createdAt: new Date("2026-08-31T23:59:59.000Z") }), scope()), false);
  assert.equal(receivableInReconciliationScope(source({ customerId: "customer-2" }), scope()), false);
  assert.equal(receivableInReconciliationScope(source({ currency: "USD" }), scope()), false);
});

test("按订单创建的应收对账只覆盖该订单（不再按客户兜底）", () => {
  assert.equal(receivableInReconciliationScope(source({ orderNo: "SO-7" }), scope({ orderNo: "SO-7" })), true);
  assert.equal(receivableInReconciliationScope(source({ orderNo: "SO-8" }), scope({ orderNo: "SO-7" })), false);
});

test("coveringReceivableReconciliation 给出覆盖这条应收的第一张对账单，没有则 null", () => {
  const outside = scope({ periodStart: new Date("2026-08-01T00:00:00.000Z"), periodEnd: new Date("2026-08-31T00:00:00.000Z") });
  const inside = scope({ id: "recon-1" });
  assert.equal(coveringReceivableReconciliation(source(), [outside, inside])?.id, "recon-1");
  assert.equal(coveringReceivableReconciliation(source(), [outside]), null);
});
