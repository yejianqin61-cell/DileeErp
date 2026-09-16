const assert = require("node:assert/strict");
const test = require("node:test");
const { Prisma } = require("@prisma/client");
const { SupplierPayableService } = require("../../dist/modules/finance/supplier-payable.service.js");

/**
 * CashFlowService 替身：确认应付（逐条 / 按对账单批量）都要记账 ——
 * `requireItem` 校验收支项目，`recordConfirmation` 写支出流水（= 钱从银行账户转出）。
 */
const cashFlowStub = (extra = {}) => ({ requireItem: async () => null, recordConfirmation: async () => null, ...extra });

test("payable list exposes purchase batch traceability, supplier name and payable balance", async () => {
  const prisma = {
    supplierPayableEntry: { findMany: async () => [{
      id: "entry-1", sourceNoSnapshot: "GR-1", amount: new Prisma.Decimal("100"),
      supplierId: "supplier-1", currency: "CNY", orderNo: "SO-1", purchaseOrderId: null, confirmationDate: new Date("2026-09-10T00:00:00.000Z"),
      supplier: { id: "supplier-1", name: "绍兴纺织", supplierCode: "S001" },
      payableSource: { purchaseReceipt: { receiptNo: "GR-1", extensionData: { batch_sequence: 2 } }, rawMaterialInbound: null, purchaseOrder: { purchaseOrderNo: "PO-1" } },
      outsourcePayableSource: null,
      allocations: [
        { status: "active", amount: new Prisma.Decimal("40"), payment: { status: "posted" } },
        { status: "active", amount: new Prisma.Decimal("10"), payment: { status: "draft" } },
        { status: "reversed", amount: new Prisma.Decimal("5"), payment: { status: "posted" } },
      ],
    }] },
    supplierPayableReconciliation: { findMany: async () => [] },
  };
  const service = new SupplierPayableService(prisma, {}, cashFlowStub());
  const [row] = await service.list();
  assert.equal(row.source_no, "GR-1");
  assert.equal(row.purchase_order_no, "PO-1");
  assert.equal(row.batch_sequence, 2);
  assert.equal(row.supplier_name, "绍兴纺织", "财务列表要能看出供应商名称，不能只给 UUID");
  // 已付只算「有效核销 + 已过账付款」：草稿付款与已冲销核销都不算。
  assert.equal(row.paid_amount, "40.0000");
  assert.equal(row.outstanding_amount, "60.0000");
  assert.equal(row.reconciliation, null, "没有被任何对账单覆盖时必须是 null，前端据此判断「待创建对账」");
});

// ---------------------------------------------------------------------------
// 2026-09-16（用户反馈）：
//   「待创建对账中，对某条条目创建对账单之后，待创建对账就不该继续展示这条条目了」
//   「某条条目我点击接受应付，为什么没有在待创建对账中看见这条条目」
// 已纳入某张对账单范围的草稿必须被标记出来，前端才能既不重复对账、又能说明它去哪了。
// ---------------------------------------------------------------------------

test("应付列表标出每条应付被哪张对账单覆盖（供应商+币种+期间，可收窄到订单/采购单）", async () => {
  const base = { amount: new Prisma.Decimal("100"), status: "draft", allocations: [], payableSource: null, outsourcePayableSource: null, supplier: null };
  const rows = [
    { ...base, id: "covered-by-order", supplierId: "supplier-1", currency: "CNY", orderNo: "SO-7", purchaseOrderId: null, confirmationDate: new Date("2026-09-11T00:00:00.000Z") },
    { ...base, id: "order-mismatch", supplierId: "supplier-1", currency: "CNY", orderNo: "SO-8", purchaseOrderId: null, confirmationDate: new Date("2026-09-11T00:00:00.000Z") },
    { ...base, id: "other-month", supplierId: "supplier-1", currency: "CNY", orderNo: "SO-7", purchaseOrderId: null, confirmationDate: new Date("2026-08-10T00:00:00.000Z") },
    { ...base, id: "other-currency", supplierId: "supplier-1", currency: "USD", orderNo: "SO-7", purchaseOrderId: null, confirmationDate: new Date("2026-09-12T00:00:00.000Z") },
    { ...base, id: "other-supplier", supplierId: "supplier-2", currency: "CNY", orderNo: "SO-7", purchaseOrderId: null, confirmationDate: new Date("2026-09-12T00:00:00.000Z") },
  ];
  const prisma = {
    supplierPayableEntry: { findMany: async () => rows },
    supplierPayableReconciliation: {
      findMany: async (args) => {
        assert.deepEqual(args.where.supplierId, { in: ["supplier-1", "supplier-2"] }, "只取涉及供应商的对账单，不要全表扫");
        return [{ id: "recon-2", reconciliationNo: "APREC-2", status: "difference", supplierId: "supplier-1", currency: "CNY", orderNo: "SO-7", purchaseOrderId: null, periodStart: new Date("2026-09-01T00:00:00.000Z"), periodEnd: new Date("2026-09-30T00:00:00.000Z") }];
      },
    },
  };
  const service = new SupplierPayableService(prisma, {}, cashFlowStub());
  const result = await service.list();
  const byId = Object.fromEntries(result.map((row) => [row.id, row]));
  assert.deepEqual(byId["covered-by-order"].reconciliation, { id: "recon-2", reconciliation_no: "APREC-2", status: "difference", period_start: new Date("2026-09-01T00:00:00.000Z"), period_end: new Date("2026-09-30T00:00:00.000Z") });
  assert.equal(byId["order-mismatch"].reconciliation, null, "按订单创建的对账只覆盖同订单的应付");
  assert.equal(byId["other-month"].reconciliation, null, "8 月的应付不在 9 月对账范围里");
  assert.equal(byId["other-currency"].reconciliation, null, "币种不一致不算覆盖");
  assert.equal(byId["other-supplier"].reconciliation, null, "别家供应商的对账不覆盖这条");
});

test("supplier payable confirmation locks and rechecks the current draft", async () => {
  let lockCount = 0;
  let updateCount = 0;
  const row = { id: "payable-1", status: "confirmed", orderNo: "SO-1", payableNo: "AP-1" };
  const prisma = {
    supplierPayableEntry: {
      findFirst: async () => row,
      update: async () => { updateCount += 1; return row; },
    },
    $transaction: async (fn) => fn({
      $queryRaw: async () => { lockCount += 1; return []; },
      supplierPayableEntry: prisma.supplierPayableEntry,
    }),
  };
  const audit = { recordWithOrderNo: async () => {} };
  const service = new SupplierPayableService(prisma, audit, cashFlowStub());
  await assert.rejects(
    () => service.confirm("payable-1", { id: "user-1" }),
    (error) => error.getResponse().code === "SUPPLIER_PAYABLE_NOT_CONFIRMABLE",
  );
  assert.equal(lockCount, 1);
  assert.equal(updateCount, 0);
});

test("supplier payable confirmation rejects a voided source", async () => {
  const row = { id: "payable-1", status: "draft", payableSource: { status: "voided" }, outsourcePayableSource: null };
  const prisma = { supplierPayableEntry: { findFirst: async () => row, update: async () => { throw new Error("must not write"); } }, $transaction: async (fn) => fn({ $queryRaw: async () => [], supplierPayableEntry: prisma.supplierPayableEntry }) };
  const service = new SupplierPayableService(prisma, { recordWithOrderNo: async () => {} }, cashFlowStub());
  await assert.rejects(() => service.confirm("payable-1", { id: "user-1" }), (error) => error.getResponse().code === "PAYABLE_SOURCE_VOIDED");
});

// ---------------------------------------------------------------------------
// 2026-09-16（用户要求「一旦确认应付，金额就要转出对应的账户」）：
//   逐条确认应付也要记账。用户点的是「确认应付」列表行上的那条路，不记账的话
//   用户实际看到的仍然是「确认了但银行余额没动」。
// ---------------------------------------------------------------------------

function payableConfirmHarness(entry) {
  const cashFlowCalls = [];
  const prisma = {
    bank: { findFirst: async ({ where }) => (where.id === "bank-dead" ? null : { id: where.id, bankName: "农业银行", accountNumber: "5706" }) },
    supplierPayableEntry: { findFirst: async () => entry, update: async ({ data }) => ({ ...entry, ...data }) },
  };
  prisma.$transaction = async (fn) => fn({ $queryRaw: async () => [], supplierPayableEntry: prisma.supplierPayableEntry });
  const audit = { update: () => ({ updatedBy: "user-1" }), recordWithOrderNo: async () => {} };
  const cashFlow = cashFlowStub({ recordConfirmation: async (input) => { cashFlowCalls.push(input); return { id: "cf-1", created: true, amount: input.amount }; } });
  return { service: new SupplierPayableService(prisma, audit, cashFlow), cashFlowCalls };
}

const draftPayable = (extra = {}) => ({
  id: "payable-1", payableNo: "AP-1", status: "draft", orderNo: "SO-1", supplierId: "supplier-1",
  amount: new Prisma.Decimal("500"), currency: "CNY", sourceType: "raw_material_inbound",
  supplier: { name: "晋江大田" }, payableSource: { status: "received" }, outsourcePayableSource: null, ...extra,
});

test("逐条确认应付：写一条支出流水并从指定的支付银行转出", async () => {
  const { service, cashFlowCalls } = payableConfirmHarness(draftPayable());
  const result = await service.confirm("payable-1", { id: "user-1" }, { bank_id: "bank-1" });
  assert.equal(cashFlowCalls.length, 1);
  const input = cashFlowCalls[0];
  assert.equal(input.direction, "expense", "确认应付 = 钱出去");
  assert.equal(input.sourceType, "supplier_payable_entry");
  assert.equal(input.sourceId, "payable-1");
  assert.equal(input.amount.toString(), "500");
  assert.equal(input.bankId, "bank-1");
  assert.equal(input.counterpartyName, "晋江大田", "对方名称取供应商名，不能退化成 UUID");
  assert.deepEqual(input.itemKeys, ["原材料 成本", "货款"], "项目候选链按来源类型选定");
  assert.equal(result.cash_flow_entry_id, "cf-1");
  assert.equal(result.bank_missing, false);
});

test("逐条确认应付：外加工来源归到成品外加工费；没选银行时回报 bank_missing", async () => {
  const outsource = payableConfirmHarness(draftPayable({ sourceType: "outsource_receipt", outsourcePayableSource: { status: "received" }, payableSource: null }));
  const result = await outsource.service.confirm("payable-1", { id: "user-1" });
  assert.deepEqual(outsource.cashFlowCalls[0].itemKeys, ["成品外加工费", "加工费"]);
  assert.equal(outsource.cashFlowCalls[0].bankId, null);
  assert.equal(result.bank_missing, true);
});

test("逐条确认应付：银行非法时先拒绝，不确认任何应付", async () => {
  const { service, cashFlowCalls } = payableConfirmHarness(draftPayable());
  await assert.rejects(
    () => service.confirm("payable-1", { id: "user-1" }, { bank_id: "bank-dead" }),
    (error) => error.getResponse().code === "BANK_NOT_FOUND",
  );
  assert.deepEqual(cashFlowCalls, []);
});

test("supplier payable reversal locks and rechecks active allocations", async () => {
  let lockCount = 0;
  let updateCount = 0;
  const row = {
    id: "payable-1", status: "confirmed", orderNo: "SO-1", payableNo: "AP-1", remark: null,
    allocations: [{ payment: { status: "posted" } }],
  };
  const prisma = {
    supplierPayableEntry: {
      findFirst: async () => row,
      update: async () => { updateCount += 1; return row; },
    },
    $transaction: async (fn) => fn({
      $queryRaw: async () => { lockCount += 1; return []; },
      supplierPayableEntry: prisma.supplierPayableEntry,
    }),
  };
  const audit = { recordWithOrderNo: async () => {} };
  const service = new SupplierPayableService(prisma, audit, cashFlowStub());
  await assert.rejects(
    () => service.reverse("payable-1", "撤销原因", { id: "user-1" }),
    (error) => error.getResponse().code === "SUPPLIER_PAYABLE_HAS_ALLOCATIONS",
  );
  assert.equal(lockCount, 1);
  assert.equal(updateCount, 0);
});

test("supplier payable draft update locks and rechecks the current status", async () => {
  let lockCount = 0;
  let updateCount = 0;
  const row = { id: "payable-1", status: "confirmed", amount: "10", confirmationDate: new Date(), remark: null };
  const prisma = {
    supplierPayableEntry: {
      findFirst: async () => row,
      update: async () => { updateCount += 1; return row; },
    },
    $transaction: async (fn) => fn({
      $queryRaw: async () => { lockCount += 1; return []; },
      supplierPayableEntry: prisma.supplierPayableEntry,
    }),
  };
  const audit = { recordWithOrderNo: async () => {}, update: () => ({}) };
  const service = new SupplierPayableService(prisma, audit, cashFlowStub());
  await assert.rejects(
    () => service.updateDraft("payable-1", { amount: "12" }, { id: "user-1" }),
    (error) => error.getResponse().code === "SUPPLIER_PAYABLE_NOT_EDITABLE",
  );
  assert.equal(lockCount, 1);
  assert.equal(updateCount, 0);
});

// 2026-09-15：「应付管理都要支持选择币种、编辑币种」。
test("应付草稿可编辑币种：走币种字典校验并写回应付条目", async () => {
  let updated;
  const checked = [];
  const row = { id: "payable-1", status: "draft", amount: "10", currency: "CNY", confirmationDate: new Date("2026-09-15"), remark: null };
  const prisma = {
    supplierPayableEntry: { findFirst: async () => row, update: async ({ data }) => { updated = data; return { ...row, ...data }; } },
    $transaction: async (fn) => fn({ $queryRaw: async () => [], supplierPayableEntry: prisma.supplierPayableEntry }),
  };
  const audit = { recordWithOrderNo: async () => {}, update: () => ({}) };
  const service = new SupplierPayableService(prisma, audit, cashFlowStub(), { assertSupported: async (code) => { checked.push(code); } });
  await service.updateDraft("payable-1", { currency: "USD", amount: "12" }, { id: "user-1" });
  assert.deepEqual(checked, ["USD"]);
  assert.equal(updated.currency, "USD");
  assert.equal(updated.amount.toString(), "12");
});

test("confirmed supplier payable can be reopened to draft with a reason", async () => {
  let updated;
  const row = { id: "payable-1", status: "confirmed", orderNo: "SO-1", remark: null, allocations: [] };
  const prisma = {
    supplierPayableEntry: {
      findFirst: async () => row,
      update: async ({ data }) => { updated = data; return { ...row, ...data }; },
    },
    $transaction: async (fn) => fn({
      $queryRaw: async () => [],
      supplierPayableEntry: prisma.supplierPayableEntry,
    }),
  };
  const service = new SupplierPayableService(prisma, { update: () => ({}), recordWithOrderNo: async () => {} }, cashFlowStub());
  const result = await service.reopen("payable-1", "修正供应商金额", { id: "user-1" });
  assert.equal(result.status, "draft");
  assert.equal(updated.status, "draft");
});

test("payable source creation restores a soft-deleted unique entry", async () => {
  let restored = 0;
  const received = [];
  const deleted = { id: "payable-1", deletedAt: new Date(), sourceType: "raw_material_inbound" };
  const prisma = {
    payableSource: { findFirst: async () => ({ id: "source-1", status: "pending_finance", orderNo: "PO-1", supplierId: "supplier-1", quantity: "1", unitPrice: "2", taxRate: "0", amount: "2", currency: "CNY", rawMaterialInbound: { inboundNo: "IN-1" }, purchaseReceipt: null }), updateMany: async ({ where, data }) => { received.push({ where, data }); return { count: 1 }; } },
    supplierPayableEntry: { findUnique: async () => deleted, update: async () => { restored += 1; return { ...deleted, deletedAt: null, orderNo: "PO-1", amount: { toString: () => "2" } }; } },
    $transaction: async (fn) => fn({ $queryRaw: async () => [], payableSource: prisma.payableSource, supplierPayableEntry: prisma.supplierPayableEntry }),
  };
  const service = new SupplierPayableService(prisma, { update: () => ({}), recordWithOrderNo: async () => {} }, cashFlowStub());
  const result = await service.createFromSource({ source_type: "raw_material_inbound", source_id: "source-1" }, { id: "user-1" });
  assert.equal(result.deletedAt, null);
  assert.equal(restored, 1);
  // 接收应付必须把来源推进到「已接收」：否则列表永远显示按钮、永远「待财务接收」。
  assert.deepEqual(received.map((item) => ({ where: item.where, status: item.data.status })), [{ where: { id: "source-1", status: { not: "voided" } }, status: "received" }]);
});

test("外加工签收来源接收后同样标记为已接收（来源模型不同，状态口径一致）", async () => {
  const received = [];
  const source = { id: "osource-1", orderNo: "SO-2", supplierId: "supplier-2", quantity: new Prisma.Decimal("8"), unitPrice: new Prisma.Decimal("3"), taxRate: null, amount: new Prisma.Decimal("24"), currency: "CNY", purchaseOrderId: null, purchaseOrderItemId: null, logisticsBatchId: "batch-2", logisticsBatch: { batchNo: "B-2" }, outsourceReceipt: { id: "receipt-2" } };
  const prisma = {
    outsourcePayableSource: { updateMany: async ({ where, data }) => { received.push({ where, data }); return { count: 1 }; } },
    $transaction: async (fn) => fn({
      $queryRaw: async () => [],
      outsourcePayableSource: { findFirst: async () => source, updateMany: prisma.outsourcePayableSource.updateMany },
      supplierPayableEntry: { findUnique: async () => null, create: async ({ data }) => ({ id: "entry-2", orderNo: data.orderNo, payableNo: data.payableNo, sourceType: data.sourceType, amount: data.amount, deletedAt: null }) },
    }),
  };
  const service = new SupplierPayableService(prisma, { create: () => ({ createdBy: "user-1", updatedBy: "user-1" }), update: () => ({ updatedBy: "user-1" }), recordWithOrderNo: async () => {} }, cashFlowStub());
  await service.createFromSource({ source_type: "outsource_receipt", source_id: "osource-1" }, { id: "user-1" });
  assert.equal(received.length, 1);
  assert.deepEqual(received[0].where, { id: "osource-1", status: { not: "voided" } });
  assert.equal(received[0].data.status, "received");
});

test("创建应付时把采购单/采购明细关联落库（否则按采购单对账的系统余额恒为 0）", async () => {
  let captured;
  const source = { id: "source-1", orderNo: "SO-1", supplierId: "supplier-1", quantity: new Prisma.Decimal("10"), unitPrice: new Prisma.Decimal("5"), taxRate: null, amount: new Prisma.Decimal("50"), currency: "CNY", purchaseOrderId: "po-1", purchaseOrderItemId: "poi-1", rawMaterialInbound: { inboundNo: "IN-1" }, purchaseReceipt: null };
  const prisma = {
    $transaction: async (fn) => fn({
      $queryRaw: async () => [],
      payableSource: { findFirst: async () => source, updateMany: async () => ({ count: 1 }) },
      supplierPayableEntry: {
        findUnique: async () => null,
        create: async ({ data }) => { captured = data; return { id: "entry-1", ...data }; },
      },
    }),
  };
  const service = new SupplierPayableService(prisma, { create: () => ({ createdBy: "user-1", updatedBy: "user-1" }), update: () => ({ updatedBy: "user-1" }), recordWithOrderNo: async () => {} }, cashFlowStub());
  await service.createFromSource({ source_type: "raw_material_inbound", source_id: "source-1" }, { id: "user-1" });
  assert.equal(captured.purchaseOrderId, "po-1");
  assert.equal(captured.purchaseOrderItemId, "poi-1");
  assert.equal(captured.outsourceLogisticsBatchId, null, "原料入库来源没有外加工批次");
});

test("外加工签收来源创建应付时带上批次关联", async () => {
  let captured;
  const source = { id: "osource-1", orderNo: "SO-2", supplierId: "supplier-2", quantity: new Prisma.Decimal("8"), unitPrice: new Prisma.Decimal("3"), taxRate: null, amount: new Prisma.Decimal("24"), currency: "CNY", purchaseOrderId: "po-2", purchaseOrderItemId: "poi-2", logisticsBatchId: "batch-2", logisticsBatch: { batchNo: "B-2" }, outsourceReceipt: { id: "receipt-2" } };
  const prisma = {
    $transaction: async (fn) => fn({
      $queryRaw: async () => [],
      outsourcePayableSource: { findFirst: async () => source, updateMany: async () => ({ count: 1 }) },
      supplierPayableEntry: {
        findUnique: async () => null,
        create: async ({ data }) => { captured = data; return { id: "entry-2", ...data }; },
      },
    }),
  };
  const service = new SupplierPayableService(prisma, { create: () => ({ createdBy: "user-1", updatedBy: "user-1" }), update: () => ({ updatedBy: "user-1" }), recordWithOrderNo: async () => {} }, cashFlowStub());
  await service.createFromSource({ source_type: "outsource_receipt", source_id: "osource-1" }, { id: "user-1" });
  assert.equal(captured.outsourceLogisticsBatchId, "batch-2");
  assert.equal(captured.purchaseOrderId, "po-2");
});
