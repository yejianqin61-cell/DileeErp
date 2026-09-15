// 应收调整（退款/红冲/折让/坏账/更正）的单元测试（不连数据库）。
//
// 为什么值得单独测：调整会**直接改变应收净额**，是收款之外唯一能动账的路径。
// 这里覆盖三类最容易出事的规则：
//   1) 方向白名单 —— 只有「更正」允许增加应收，其余四类只能减少（否则可以凭空做大应收）；
//   2) 引用一致性 —— 来源/订单/客户/币种必须互相对得上，且草稿/已取消来源不能挂调整；
//   3) 过账余额护栏 —— 减少额不得超过该来源的**净**未收（应收 + 增加调整 − 减少调整 − 已核销）。
const assert = require("node:assert/strict");
const test = require("node:test");
const { Prisma } = require("@prisma/client");
const { ReceivableAdjustmentService } = require("../../dist/modules/finance/receivable-adjustment.service.js");

const user = { id: "user-1" };
const audit = { create: () => ({ createdBy: user.id, updatedBy: user.id }), update: () => ({ updatedBy: user.id }), recordWithOrderNo: async () => {} };
/** 币种服务替身：create() 会调用 assertSupported，缺了它整条 create 路径会先抛 TypeError。 */
const currencies = { assertSupported: async () => {} };

/**
 * 只实现被调用到的那几个方法，未用到的模型一律不出现（用不到就是不该被调用）。
 *
 * 两个容易踩的点，都在这里一次做对：
 *   * `source.amount` 必须是 Prisma.Decimal —— service 直接对它调 `.plus()`，给字符串会 TypeError；
 *   * `receivableAdjustment.update` 要返回**整行**（含 amount/effect）—— 真实 Prisma 就是返回整行，
 *     service 随后要拿 result.amount.toString() 写审计，mock 少给字段会假报错。
 */
function build({ source = null, order = { id: "so-1", customerId: "cust-1", currency: "USD" }, created = null, allocations = null, postedAdjustments = [], current = null, onLock } = {}) {
  const calls = { create: [], updates: [], locks: [] };
  const sourceRow = source ?? { id: "src-1", amount: new Prisma.Decimal("100"), orderNo: "SO-1", customerId: "cust-1", currency: "USD", status: "confirmed" };
  const prisma = {
    receivableSource: { findFirst: async () => source },
    salesOrder: { findFirst: async () => order },
    receivableAdjustment: {
      create: async ({ data }) => { calls.create.push(data); return created ?? { id: "adj-1", ...data }; },
      findMany: async () => postedAdjustments,
      update: async ({ data }) => { calls.updates.push(data); return { id: "adj-1", orderNo: "SO-1", amount: new Prisma.Decimal("1"), effect: "increase", ...data }; },
    },
    $transaction: async (fn) => fn({
      $queryRaw: async (_strings, ...values) => { calls.locks.push(values[0]); if (onLock) onLock(values[0]); },
      receivableAdjustment: {
        findFirst: async () => current,
        findMany: async () => postedAdjustments,
        update: async ({ data }) => { calls.updates.push(data); return { id: "adj-1", orderNo: current?.orderNo ?? "SO-1", amount: current?.amount, effect: current?.effect, ...data }; },
      },
      receivableSource: { findFirst: async () => sourceRow },
      receivableAllocation: { aggregate: async () => ({ _sum: { amount: allocations } }) },
    }),
  };
  const service = new ReceivableAdjustmentService(prisma, audit, currencies);
  return { service, calls };
}

const base = { order_no: "SO-1", customer_id: "cust-1", adjustment_type: "refund", effect: "decrease", amount: "20", currency: "USD", reason: "客户退款", adjustment_date: "2026-09-15" };

test("退款/红冲/折让/坏账都必须减少应收：「更正」是唯一允许增加的类型", async () => {
  for (const adjustment_type of ["refund", "red_credit", "discount", "bad_debt"]) {
    const { service } = build();
    await assert.rejects(
      () => service.create({ ...base, adjustment_type, effect: "increase" }, user),
      (error) => error.getResponse().code === "ADJUSTMENT_EFFECT_NOT_ALLOWED",
      `${adjustment_type} 不应允许 increase`,
    );
  }
  const { service, calls } = build();
  await service.create({ ...base, adjustment_type: "correction", effect: "increase", amount: "5" }, user);
  assert.equal(calls.create.length, 1, "correction 允许 increase（可以凭空做大应收的唯一合法出口）");
});

test("类型与方向都走白名单，拒绝拼错的值而不是静默落库", async () => {
  const { service } = build();
  await assert.rejects(
    () => service.create({ ...base, adjustment_type: "refundd" }, user),
    (error) => error.getResponse().code === "INVALID_ADJUSTMENT_TYPE",
  );
  await assert.rejects(
    () => service.create({ ...base, effect: "decreasee" }, user),
    (error) => error.getResponse().code === "INVALID_ADJUSTMENT_EFFECT",
  );
});

test("金额必须是大于零的十进制：0、负数、非数字一律 422", async () => {
  for (const amount of ["0", "-1", "abc", ""]) {
    const { service } = build();
    await assert.rejects(
      () => service.create({ ...base, amount }, user),
      (error) => error.getResponse().code === "INVALID_ADJUSTMENT_AMOUNT",
      `金额 ${JSON.stringify(amount)} 应被拒绝`,
    );
  }
});

test("调整原因必填（只填空白也算没填）", async () => {
  const { service } = build();
  await assert.rejects(
    () => service.create({ ...base, reason: "   " }, user),
    (error) => error.getResponse().code === "ADJUSTMENT_REASON_REQUIRED",
  );
});

test("调整日期必须是 YYYY-MM-DD", async () => {
  const { service } = build();
  await assert.rejects(
    () => service.create({ ...base, adjustment_date: "2026/09/15" }, user),
    (error) => error.getResponse().code === "INVALID_ADJUSTMENT_DATE",
  );
});

test("既不传订单号也不传应收来源时拒绝（调整必须能追溯到订单）", async () => {
  const { service } = build();
  await assert.rejects(
    () => service.create({ ...{ adjustment_type: "refund", effect: "decrease", amount: "20", currency: "USD", reason: "退款", adjustment_date: "2026-09-15" } }, user),
    (error) => error.getResponse().code === "ORDER_NO_REQUIRED",
  );
});

test("指定了不存在的应收来源 → 404，不会退化成「只挂订单」继续写", async () => {
  const { service, calls } = build({ source: null });
  await assert.rejects(
    () => service.create({ ...base, receivable_source_id: "src-missing" }, user),
    (error) => error.getResponse().code === "RECEIVABLE_SOURCE_NOT_FOUND",
  );
  assert.deepEqual(calls.create, []);
});

test("来源与订单/客户/币种必须一致，且草稿、已取消的来源不能挂调整", async () => {
  const cases = [
    { label: "订单不一致", source: { id: "src-1", amount: "100", orderNo: "SO-9", customerId: "cust-1", currency: "USD", status: "confirmed" } },
    { label: "客户不一致", source: { id: "src-1", amount: "100", orderNo: "SO-1", customerId: "cust-9", currency: "USD", status: "confirmed" } },
    { label: "币种不一致", source: { id: "src-1", amount: "100", orderNo: "SO-1", customerId: "cust-1", currency: "CNY", status: "confirmed" } },
    { label: "来源还是草稿", source: { id: "src-1", amount: "100", orderNo: "SO-1", customerId: "cust-1", currency: "USD", status: "draft" } },
    { label: "来源已取消", source: { id: "src-1", amount: "100", orderNo: "SO-1", customerId: "cust-1", currency: "USD", status: "cancelled" } },
  ];
  for (const { label, source } of cases) {
    const { service, calls } = build({ source });
    await assert.rejects(
      () => service.create({ ...base, receivable_source_id: "src-1" }, user),
      (error) => error.getResponse().code === "ADJUSTMENT_REFERENCE_MISMATCH",
      label,
    );
    assert.deepEqual(calls.create, [], `${label} 时不得落库`);
  }
});

test("订单与客户/币种不一致时同样拒绝", async () => {
  const { service } = build({ order: { id: "so-1", customerId: "cust-9", currency: "USD" } });
  await assert.rejects(
    () => service.create(base, user),
    (error) => error.getResponse().code === "ADJUSTMENT_REFERENCE_MISMATCH",
  );
});

test("订单不存在且没有来源 → 404；来源能把 salesOrderId / customerId / orderNo 补齐", async () => {
  const missing = build({ order: null });
  await assert.rejects(
    () => missing.service.create(base, user),
    (error) => error.getResponse().code === "SALES_ORDER_NOT_FOUND",
  );

  const source = { id: "src-1", amount: "100", orderNo: "SO-1", customerId: "cust-1", currency: "USD", status: "confirmed", salesOrderId: "so-from-source" };
  const { service, calls } = build({ source, order: null });
  await service.create({ ...base, receivable_source_id: "src-1", order_no: undefined, customer_id: undefined }, user);
  assert.equal(calls.create[0].salesOrderId, "so-from-source", "来源存在时应取来源的 salesOrderId");
  assert.equal(calls.create[0].orderNo, "SO-1");
  assert.equal(calls.create[0].customerId, "cust-1");
});

test("reason 落库前去首尾空格，订单号与调整号格式固定", async () => {
  const { service, calls } = build();
  await service.create({ ...base, reason: "  客户要求退款  " }, user);
  assert.equal(calls.create[0].reason, "客户要求退款");
  assert.match(calls.create[0].adjustmentNo, /^ADJ-\d{8}-[0-9A-F]{8}$/);
  assert.deepEqual(calls.create[0].createdBy, user.id);
});

// ---------------------------------------------------------------- 过账护栏

test("减少额超过来源净未收 → 422 ADJUSTMENT_EXCEEDS_BALANCE，并给出可用余额", async () => {
  const current = { id: "adj-1", status: "draft", effect: "decrease", amount: { gt: () => true, toString: () => "80" }, receivableSourceId: "src-1", orderNo: "SO-1" };
  const { service, calls } = build({ current, source: { id: "src-1", amount: new Prisma.Decimal("100"), orderNo: "SO-1", customerId: "cust-1", currency: "USD", status: "confirmed" }, allocations: null });
  await assert.rejects(
    () => service.post("adj-1", user),
    (error) => error.getResponse().code === "ADJUSTMENT_EXCEEDS_BALANCE" && error.getResponse().details[0].available_amount === "100",
  );
  assert.deepEqual(calls.updates, [], "被拒时不得改成 posted");
});

test("净未收把已核销与已过账调整一起算进去：应收100 − 已核销70 − 已减10 = 20", async () => {
  const amount = { gt: (other) => true, toString: () => "21" };
  const current = { id: "adj-1", status: "draft", effect: "decrease", amount, receivableSourceId: "src-1", orderNo: "SO-1" };
  const { service } = build({
    current,
    source: { id: "src-1", amount: new Prisma.Decimal("100"), orderNo: "SO-1", customerId: "cust-1", currency: "USD", status: "confirmed" },
    allocations: "70",
    postedAdjustments: [{ effect: "decrease", amount: "10" }],
  });
  await assert.rejects(
    () => service.post("adj-1", user),
    (error) => error.getResponse().details[0].available_amount === "20",
  );
});

test("增加类调整不做余额校验（只有减少需要护栏），并在事务里先锁调整行", async () => {
  const current = { id: "adj-1", status: "draft", effect: "increase", amount: { gt: () => false, toString: () => "5" }, receivableSourceId: null, orderNo: "SO-1" };
  const { service, calls } = build({ current });
  const posted = await service.post("adj-1", user);
  assert.equal(posted.status, "posted");
  assert.deepEqual(calls.locks, ["adj-1"], "没有来源的调整只锁调整行本身");
});

test("过账与冲销都要求前置状态，锁在事务内先取", async () => {
  const { service, calls } = build({ current: { id: "adj-1", status: "posted", effect: "increase", receivableSourceId: null, orderNo: "SO-1" } });
  await assert.rejects(
    () => service.post("adj-1", user),
    (error) => error.getResponse().code === "RECEIVABLE_ADJUSTMENT_NOT_POSTABLE",
  );
  assert.deepEqual(calls.locks, ["adj-1"]);
});

test("冲销必须填原因，且只能冲销已过账的调整", async () => {
  const { service } = build({ current: { id: "adj-1", status: "posted", orderNo: "SO-1" } });
  await assert.rejects(
    () => service.reverse("adj-1", "  ", user),
    (error) => error.getResponse().code === "REVERSAL_REASON_REQUIRED",
  );
});

// ---------------------------------------------------------------- 订单净额汇总

test("订单净额汇总：应收 + 增加 − 减少 − 已收，且只统计已过账的调整", async () => {
  const captured = [];
  const prisma = {
    receivableSource: {
      findMany: async () => [
        { amount: "100.0000", allocations: [{ amount: "30.0000", payment: { status: "posted" } }, { amount: "5.0000", payment: { status: "draft" } }] },
        { amount: "50.0000", allocations: [] },
      ],
    },
    receivableAdjustment: { findMany: async (args) => { captured.push(args.where); return [{ effect: "increase", amount: "10" }, { effect: "decrease", amount: "20" }]; } },
  };
  const service = new ReceivableAdjustmentService(prisma, audit, {});
  const summary = await service.orderNetSummary("SO-1");
  assert.equal(captured[0].status, "posted", "草稿/已冲销的调整不得计入净额");
  assert.equal(summary.receivable_amount, "150");
  assert.equal(summary.paid_amount, "30", "只有已过账收款的核销才算已收（草稿不算）");
  assert.equal(summary.adjustment_increase, "10");
  assert.equal(summary.adjustment_decrease, "20");
  assert.equal(summary.receivable_net_amount, "140");
  assert.equal(summary.outstanding_amount, "110");
  assert.equal(summary.posted_adjustment_count, 2);
});
