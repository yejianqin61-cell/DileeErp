// 应收管理链路集成测试（真实 PostgreSQL）：
//   已确认销售单 → 已过账出库 → 应收来源 → 确认应收 → 登记收款 → 核销过账 → 收支流水。
//
// 为什么必须用真库：
//   * 应收来源对 outbound_id 有唯一约束（一个出库只能生成一条应收），要真库才能验证；
//   * 核销要跨 customer_payments / receivable_sources / receivable_allocations 闭合，
//     并回写来源状态（confirmed → paid）；
//   * 过账必须自动写收支流水（收入方向、项目「货款」）；
//   * 服务端的「客户/币种必须与来源一致」与「核销额不得超过未收」两条护栏只在真库事务里才完整。
//
// 出库单直接播种：成品入库 → 出库通知 → 出库过账这条物理链路已由成品出库契约测试与
// production 集成测试覆盖；本用例把前置状态固定成「已过账出库」，从财务侧接手验收入账。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { PrismaClient } = require("@prisma/client");
const { ReceivableService } = require("../../dist/modules/finance/receivable.service.js");
const { CustomerPaymentService } = require("../../dist/modules/finance/customer-payment.service.js");
const { CashFlowService } = require("../../dist/modules/finance/cash-flow.service.js");
const { AuditService } = require("../../dist/platform/audit/audit.service.js");
const { assertAuditEventRecorded, assertDecimalEquals, assertOrderNo } = require("../../../../tests/helpers/business-invariants.cjs");
const { requireTestDatabaseUrl } = require("../../../../tests/helpers/test-context.cjs");
const { createFactories } = require("../../../../tests/fixtures/factories.cjs");

test("receivable.outbound_to_confirmed_to_paid_posts_income_cash_flow", async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: requireTestDatabaseUrl() } } });
  const fx = createFactories({ prisma, prefix: "receivable" });
  const user = fx.actor();
  const audit = new AuditService(prisma);
  const receivables = new ReceivableService(prisma, audit);
  const cashFlow = new CashFlowService(prisma, audit);
  const payments = new CustomerPaymentService(prisma, audit, receivables, cashFlow);
  try {
    // ---------- 前置：已确认销售单 + 生产单 + 已过账出库 ----------
    const chain = await fx.productionChain();
    const outbound = fx.track("finishedGoodsOutbound", await prisma.finishedGoodsOutbound.create({
      data: {
        outboundNo: fx.code("FGO"),
        orderNo: fx.run.orderNo,
        salesOrderId: chain.salesOrder.id,
        productionOrderId: chain.productionOrder.id,
        unitId: chain.unit.id,
        productNameSnapshot: "集成测试成品",
        quantity: "100",
        status: "posted",
        idempotencyKey: `fx-${fx.run.id}-outbound`,
        ...fx.audit.create(),
      },
    }));

    // ---------- 1. 出库 → 应收来源 ----------
    const source = fx.track("receivableSource", await receivables.createFromOutbound(outbound.id, {
      amount: "1200",
      amount_reason: "销售单无可结算单价，手工确认应收金额",
      remark: "集成测试应收",
    }, user));
    assert.equal(source.status, "draft");
    assert.equal(source.outboundId, outbound.id);
    assert.equal(source.customerId, chain.salesOrder.customerId);
    assert.equal(source.currency, chain.salesOrder.currency);
    assertDecimalEquals("应收金额为手工确认值", source.amount, "1200");
    assertOrderNo("receivable source 上的订单号", fx.run.orderNo, [source]);

    // 一个出库只能生成一条应收：重复调用返回同一条（outbound_id 唯一）
    const replayed = await receivables.createFromOutbound(outbound.id, { amount: "1200", amount_reason: "重复调用" }, user);
    assert.equal(replayed.id, source.id, "同一出库重复生成应收必须复用原来源");
    assert.equal(await prisma.receivableSource.count({ where: { outboundId: outbound.id } }), 1);

    // ---------- 2. 确认应收 ----------
    const confirmed = await receivables.confirm(source.id, user);
    assert.equal(confirmed.status, "confirmed");
    const balanceBefore = await receivables.allocationBalance(source.id);
    assertDecimalEquals("确认后未收等于应收全额", balanceBefore.available, "1200");

    // ---------- 3. 登记收款 ----------
    const payment = fx.track("customerPayment", await payments.create({
      customer_id: chain.salesOrder.customerId,
      order_no: fx.run.orderNo,
      payment_date: "2026-09-18",
      amount: "1200",
      currency: chain.salesOrder.currency,
      payment_method: "银行转账",
      idempotency_key: `fx-${fx.run.id}-receipt`,
      remark: "集成测试收款",
    }, user));
    assert.equal(payment.status, "draft");

    // ---------- 4. 核销过账 ----------
    await payments.post(payment.id, [{ receivable_source_id: source.id, amount: "1200" }], user);
    const allocations = await prisma.receivableAllocation.findMany({ where: { paymentId: payment.id, deletedAt: null } });
    for (const row of allocations) fx.track("receivableAllocation", row);
    assert.equal(allocations.length, 1);
    assert.equal(allocations[0].status, "active");
    assertDecimalEquals("核销金额等于收款金额", allocations[0].amount, "1200");

    const sourceAfter = await prisma.receivableSource.findUnique({ where: { id: source.id } });
    assert.equal(sourceAfter.status, "paid", "足额核销后应收来源应变为已收款");
    const balanceAfter = await receivables.allocationBalance(source.id);
    assertDecimalEquals("核销后未收归零", balanceAfter.available, "0");

    // ---------- 5. 过账自动写收支流水（收入方向、「货款」项目） ----------
    const flow = await prisma.cashFlowEntry.findFirst({ where: { sourceType: "customer_payment", sourceId: payment.id, deletedAt: null } });
    assert.ok(flow, "收款过账必须自动写一条收支流水");
    assert.equal(flow.direction, "income");
    assertDecimalEquals("流水金额等于收款金额", flow.amount, "1200");
    const item = await prisma.dictionaryItem.findUnique({ where: { id: flow.itemId } });
    assert.equal(item.key, "货款", "客户回款要落到「货款」项目");
    fx.track("cashFlowEntry", flow);

    // ---------- 6. 已核销的收款不能再核销（状态机护栏） ----------
    await assert.rejects(
      () => payments.post(payment.id, [{ receivable_source_id: source.id, amount: "1" }], user),
      (error) => error.getResponse().code === "CUSTOMER_PAYMENT_NOT_POSTABLE",
      "已过账收款不得重复过账",
    );

    // ---------- 7. 审计 ----------
    const events = await fx.auditEvents();
    assertAuditEventRecorded("receivable source confirm audited", events, { action: "receivable_source.confirm", entityId: source.id });
    assertAuditEventRecorded("customer payment post audited", events, { action: "customer_payment.post", entityId: payment.id });
  } finally {
    await fx.cleanup();
    await prisma.$disconnect();
  }
});

test("receivable.allocation_guards_reject_currency_mismatch_and_over_allocation", async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: requireTestDatabaseUrl() } } });
  const fx = createFactories({ prisma, prefix: "arguard" });
  const user = fx.actor();
  const audit = new AuditService(prisma);
  const receivables = new ReceivableService(prisma, audit);
  const cashFlow = new CashFlowService(prisma, audit);
  const payments = new CustomerPaymentService(prisma, audit, receivables, cashFlow);
  try {
    const chain = await fx.productionChain();
    const outbound = fx.track("finishedGoodsOutbound", await prisma.finishedGoodsOutbound.create({
      data: {
        outboundNo: fx.code("FGO"),
        orderNo: fx.run.orderNo,
        salesOrderId: chain.salesOrder.id,
        productionOrderId: chain.productionOrder.id,
        unitId: chain.unit.id,
        quantity: "10",
        status: "posted",
        idempotencyKey: `fx-${fx.run.id}-outbound`,
        ...fx.audit.create(),
      },
    }));
    const source = fx.track("receivableSource", await receivables.createFromOutbound(outbound.id, { amount: "100", amount_reason: "手工确认" }, user));
    await receivables.confirm(source.id, user);
    const sourceCurrency = source.currency;

    // 币种不一致的收款不得核销到该应收上。
    // 这正是用户实际踩到的场景：DL260122 的 CNY 收款单，下拉里却列出了 DL260123ZG-916064 的 USD 应收。
    // 前端下拉已按「同客户 + 同币种」收窄，这里验后端兜底不会被绕过。
    const wrongCurrency = sourceCurrency === "CNY" ? "USD" : "CNY";
    const mismatched = fx.track("customerPayment", await payments.create({
      customer_id: chain.salesOrder.customerId,
      order_no: fx.run.orderNo,
      payment_date: "2026-09-18",
      amount: "100",
      currency: wrongCurrency,
      payment_method: "银行转账",
    }, user));
    await assert.rejects(
      () => payments.post(mismatched.id, [{ receivable_source_id: source.id, amount: "100" }], user),
      (error) => error.getResponse().code === "ALLOCATION_REFERENCE_MISMATCH",
      "币种不一致的收款不得核销到该应收",
    );
    const stillDraft = await prisma.customerPayment.findUnique({ where: { id: mismatched.id } });
    assert.equal(stillDraft.status, "draft", "被拒后收款仍是草稿");
    assert.equal(await prisma.receivableAllocation.count({ where: { paymentId: mismatched.id } }), 0, "被拒时不得留下半条核销");

    // 核销额超过未收 → 422（用正确币种的收款来验余额护栏）
    const payment = fx.track("customerPayment", await payments.create({
      customer_id: chain.salesOrder.customerId,
      order_no: fx.run.orderNo,
      payment_date: "2026-09-18",
      amount: "101",
      currency: sourceCurrency,
      payment_method: "银行转账",
    }, user));
    await assert.rejects(
      () => payments.post(payment.id, [{ receivable_source_id: source.id, amount: "101" }], user),
      (error) => error.getResponse().code === "RECEIVABLE_ALLOCATION_EXCEEDED",
      "核销额不得超过应收未收余额",
    );
    assert.equal(await prisma.receivableAllocation.count({ where: { paymentId: payment.id } }), 0, "被拒时不得留下核销行");

    // 部分核销可以正常通过，来源转为 partially_paid，未收相应减少
    const partialPayment = fx.track("customerPayment", await payments.create({
      customer_id: chain.salesOrder.customerId,
      order_no: fx.run.orderNo,
      payment_date: "2026-09-19",
      amount: "60",
      currency: sourceCurrency,
      payment_method: "银行转账",
    }, user));
    await payments.post(partialPayment.id, [{ receivable_source_id: source.id, amount: "60" }], user);
    const partial = await prisma.receivableSource.findUnique({ where: { id: source.id } });
    assert.equal(partial.status, "partially_paid");
    const balance = await receivables.allocationBalance(source.id);
    assertDecimalEquals("部分核销后未收余额", balance.available, "40");
    const allocationRows = await prisma.receivableAllocation.findMany({ where: { paymentId: partialPayment.id, deletedAt: null } });
    for (const row of allocationRows) fx.track("receivableAllocation", row);
  } finally {
    await fx.cleanup();
    await prisma.$disconnect();
  }
});
