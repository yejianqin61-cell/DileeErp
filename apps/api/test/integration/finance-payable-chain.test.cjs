// 应付管理链路集成测试（真实 PostgreSQL）：
//   原料入库过账 → 应付来源 → 接收应付（草稿）→ 对账（含草稿口径）→ 一键确认应付 → 付款核销 → 收支流水。
//
// 为什么必须用真库：
//   * 对账的 system_balance 口径要覆盖**草稿**条目（否则「先对账、再确认应付」的业务顺序会自相矛盾）；
//   * 付款核销要跨 supplier_payments / supplier_payable_entries / supplier_payment_allocations 三张表闭合；
//   * 过账必须自动写收支流水 —— 这里断言项目落到「原材料 成本」，
//     正是历史缺陷（供应商付款写死不存在的「外加工费」→ 每笔都被静默丢掉）的回归保护。
//
// 上游采购链（BOM → 采购单 → 到货 → QC → 通知 → 入库过账）已由 procurement-inbound 集成测试覆盖，
// 本用例复用同一套夹具工厂把它推进到「应付来源已生成」，再从财务侧接手。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { PrismaClient } = require("@prisma/client");
const { RawMaterialInboundsService } = require("../../dist/modules/procurement/raw-material-inbounds.service.js");
const { RawMaterialInboundNoticesService } = require("../../dist/modules/procurement/raw-material-inbound-notices.service.js");
const { InventoryService } = require("../../dist/platform/inventory/inventory.service.js");
const { SupplierPayableService } = require("../../dist/modules/finance/supplier-payable.service.js");
const { SupplierPayableReconciliationService } = require("../../dist/modules/finance/supplier-payable-reconciliation.service.js");
const { SupplierPaymentService } = require("../../dist/modules/finance/supplier-payment.service.js");
const { CashFlowService } = require("../../dist/modules/finance/cash-flow.service.js");
const { AuditService } = require("../../dist/platform/audit/audit.service.js");
const { assertAuditEventRecorded, assertDecimalEquals, assertOrderNo } = require("../../../../tests/helpers/business-invariants.cjs");
const { requireTestDatabaseUrl } = require("../../../../tests/helpers/test-context.cjs");
const { createFactories } = require("../../../../tests/fixtures/factories.cjs");

test("payable.source_to_reconciliation_confirm_and_payment_posts_cash_flow", async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: requireTestDatabaseUrl() } } });
  const fx = createFactories({ prisma, prefix: "payable" });
  const user = fx.actor();
  const audit = new AuditService(prisma);
  const inventory = new InventoryService();
  const inbounds = new RawMaterialInboundsService(prisma, audit, inventory);
  const notices = new RawMaterialInboundNoticesService(prisma, audit, inbounds);
  const payables = new SupplierPayableService(prisma, audit);
  const reconciliations = new SupplierPayableReconciliationService(prisma, audit);
  const cashFlow = new CashFlowService(prisma, audit);
  const payments = new SupplierPaymentService(prisma, audit, payables, cashFlow);
  try {
    // ---------- 上游：把采购链推进到「应付来源 pending_finance」 ----------
    const chain = await fx.procurementChain();
    const notice = fx.track("rawMaterialInboundNotice", await notices.createFromInspection(chain.inspection.id, "应付链集成测试", user));
    await notices.acknowledge(notice.id, user);
    const draft = await prisma.rawMaterialInbound.findFirst({ where: { deletedAt: null, incomingInspectionId: chain.inspection.id } });
    fx.track("rawMaterialInbound", draft);
    await inbounds.post(draft.id, user);
    const posted = await prisma.rawMaterialInbound.findUnique({ where: { id: draft.id }, include: { payableSources: true } });
    const payableSource = posted.payableSources[0];
    assert.equal(payableSource.status, "pending_finance");
    const sourceAmount = payableSource.amount.toString();

    // ---------- 1. 接收应付：按来源金额生成草稿应付 ----------
    const entry = fx.track("supplierPayableEntry", await payables.createFromSource({
      source_type: "raw_material_inbound",
      source_id: payableSource.id,
      confirmation_date: "2026-09-15",
      remark: "集成测试接收应付",
    }, user));
    assert.equal(entry.status, "draft");
    assert.equal(entry.supplierId, chain.supplier.id);
    assert.equal(entry.currency, "USD");
    assertDecimalEquals("接收应付的金额等于来源金额", entry.amount, sourceAmount);
    assertOrderNo("payable entry 上的订单号", fx.run.orderNo, [entry]);
    // 同一来源重复接收必须**复用**原条目（来源 → 应付是 1:1），而不是重复建单。
    const replayed = await payables.createFromSource({ source_type: "raw_material_inbound", source_id: payableSource.id }, user);
    assert.equal(replayed.id, entry.id, "同一应付来源重复接收应复用原条目");
    assert.equal(await prisma.supplierPayableEntry.count({ where: { payableSourceId: payableSource.id } }), 1, "不得为同一来源建出第二条应付");

    // ---------- 2. 对账：system_balance 必须覆盖草稿条目 ----------
    const reconciliation = fx.track("supplierPayableReconciliation", await reconciliations.create({
      supplier_id: chain.supplier.id,
      period_start: "2026-09-01",
      period_end: "2026-09-30",
      external_balance: sourceAmount,
      currency: "USD",
      remark: "集成测试对账",
    }, user));
    assertDecimalEquals("系统余额应等于该供应商期间内的应付（含草稿）", reconciliation.systemBalance, sourceAmount);
    assertDecimalEquals("外部余额与系统余额一致 → 差异为 0", reconciliation.difference, "0");
    assert.equal(reconciliation.status, "matched", "对平后状态应为 matched");

    // ---------- 3. 一键确认应付：把范围内的草稿确认为正式负债 ----------
    const confirmedResult = await reconciliations.confirmPayables(reconciliation.id, user);
    assert.equal(confirmedResult.confirmed_count, 1);
    assertDecimalEquals("批量确认的金额等于应付金额", confirmedResult.confirmed_amount, sourceAmount);
    const confirmedEntry = await prisma.supplierPayableEntry.findUnique({ where: { id: entry.id } });
    assert.equal(confirmedEntry.status, "confirmed");

    // ---------- 4. 付款并核销 ----------
    const payment = fx.track("supplierPayment", await payments.create({
      supplier_id: chain.supplier.id,
      order_no: fx.run.orderNo,
      payment_date: "2026-09-20",
      amount: sourceAmount,
      currency: "USD",
      payment_method: "银行转账",
      payee_name: chain.supplier.name,
      remark: "集成测试付款",
    }, user));
    assert.equal(payment.status, "draft");

    const postedPayment = await payments.post(payment.id, [{ payable_entry_id: entry.id, amount: sourceAmount }], user);
    assert.equal(postedPayment.status, "posted");

    const allocations = await prisma.supplierPaymentAllocation.findMany({ where: { paymentId: payment.id, deletedAt: null } });
    for (const row of allocations) fx.track("supplierPaymentAllocation", row);
    assert.equal(allocations.length, 1);
    assert.equal(allocations[0].status, "active");
    assertDecimalEquals("核销金额等于付款金额", allocations[0].amount, sourceAmount);

    const entryAfter = await prisma.supplierPayableEntry.findUnique({ where: { id: entry.id } });
    assert.equal(entryAfter.status, "paid", "足额核销后应付应变为已付款");

    // ---------- 5. 过账自动写收支流水（历史缺陷的回归保护） ----------
    const flow = await prisma.cashFlowEntry.findFirst({ where: { sourceType: "supplier_payment", sourceId: payment.id, deletedAt: null } });
    assert.ok(flow, "供应商付款过账必须自动写收支流水（曾经每笔都被静默丢掉）");
    assert.equal(flow.direction, "expense");
    assertDecimalEquals("流水金额等于付款金额", flow.amount, sourceAmount);
    const item = await prisma.dictionaryItem.findUnique({ where: { id: flow.itemId } });
    assert.equal(item.key, "原材料 成本", "原料入库来源的付款要落到「原材料 成本」");
    fx.track("cashFlowEntry", flow);

    // ---------- 6. 审计 ----------
    const events = await fx.auditEvents();
    assertAuditEventRecorded("supplier payable create audited", events, { action: "supplier_payable.create", entityId: entry.id });
    assertAuditEventRecorded("supplier payment post audited", events, { action: "supplier_payment.post", entityId: payment.id });
  } finally {
    await fx.cleanup();
    await prisma.$disconnect();
  }
});

test("payable.other_entry_books_management_expense_item", async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: requireTestDatabaseUrl() } } });
  const fx = createFactories({ prisma, prefix: "otherpay" });
  const user = fx.actor();
  const audit = new AuditService(prisma);
  const payables = new SupplierPayableService(prisma, audit);
  const cashFlow = new CashFlowService(prisma, audit);
  const payments = new SupplierPaymentService(prisma, audit, payables, cashFlow);
  try {
    const supplier = await fx.createSupplier();
    // 其他应付：没有订单、没有来源单据的支出（差旅费报销、临时采购…）
    const entry = fx.track("supplierPayableEntry", await payables.createOther({
      supplier_id: supplier.id,
      amount: "3627.41",
      currency: "CNY",
      description: "26.9月出差报销",
      confirmation_date: "2026-09-15",
    }, user));
    assert.equal(entry.sourceType, "other");
    assert.equal(entry.status, "draft");
    await payables.confirm(entry.id, user);

    const payment = fx.track("supplierPayment", await payments.create({
      supplier_id: supplier.id,
      payment_date: "2026-09-21",
      amount: "3627.41",
      currency: "CNY",
      payment_method: "银行转账",
    }, user));
    await payments.post(payment.id, [{ payable_entry_id: entry.id, amount: "3627.41" }], user);

    const flow = await prisma.cashFlowEntry.findFirst({ where: { sourceType: "supplier_payment", sourceId: payment.id, deletedAt: null } });
    assert.ok(flow, "其他应付的付款同样必须进收支流水");
    const item = await prisma.dictionaryItem.findUnique({ where: { id: flow.itemId } });
    assert.equal(item.key, "管理费用", "其他应付没有来源可判，落到「管理费用」（可选人工指定更精确的项目）");
    fx.track("cashFlowEntry", flow);
    const allocations = await prisma.supplierPaymentAllocation.findMany({ where: { paymentId: payment.id, deletedAt: null } });
    for (const row of allocations) fx.track("supplierPaymentAllocation", row);
  } finally {
    await fx.cleanup();
    await prisma.$disconnect();
  }
});
