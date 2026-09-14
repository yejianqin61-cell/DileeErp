const assert = require("node:assert/strict");
const test = require("node:test");
const { Prisma } = require("@prisma/client");
const { SupplierPayableReconciliationService } = require("../../dist/modules/finance/supplier-payable-reconciliation.service.js");

test("supplier payable reconciliation resolution locks and rechecks status", async () => {
  let lockCount = 0;
  let updateCount = 0;
  const row = { id: "recon-1", status: "resolved" };
  const prisma = {
    supplierPayableReconciliation: { findFirst: async () => row, update: async () => { updateCount += 1; return row; } },
    $transaction: async (fn) => fn({
      $queryRaw: async () => { lockCount += 1; return []; },
      supplierPayableReconciliation: prisma.supplierPayableReconciliation,
    }),
  };
  const service = new SupplierPayableReconciliationService(prisma, { update: () => ({}), record: async () => {} });
  await assert.rejects(() => service.resolve("recon-1", "已核实", { id: "user-1" }), (error) => error.getResponse().code === "RECONCILIATION_NOT_RESOLVABLE");
  assert.equal(lockCount, 1);
  assert.equal(updateCount, 0);
});

// ------------------------------------------------------------------ 对账完成 → 批量确认应付

function confirmHarness(reconciliation, drafts) {
  const locks = [];
  const updates = [];
  const audits = [];
  let lastQuery;
  const prisma = {
    supplierPayableReconciliation: { findFirst: async () => reconciliation },
    supplierPayableEntry: {
      findMany: async (args) => { lastQuery = args; return drafts; },
      update: async ({ where, data }) => { updates.push({ id: where.id, status: data.status }); return { ...where, status: data.status }; },
    },
  };
  prisma.$transaction = async (fn) => fn({
    $queryRaw: async (strings) => { locks.push(Array.isArray(strings) ? strings.join("") : String(strings)); return []; },
    supplierPayableReconciliation: prisma.supplierPayableReconciliation,
    supplierPayableEntry: prisma.supplierPayableEntry,
  });
  const audit = { create: () => ({}), update: () => ({ updatedBy: "user-1" }), record: async (...args) => audits.push(args), recordWithOrderNo: async (...args) => audits.push(args) };
  return { service: new SupplierPayableReconciliationService(prisma, audit, {}), locks, updates, audits, query: () => lastQuery };
}

const draftEntry = (id, amount, sourceStatus) => ({ id, payableNo: `AP-${id}`, orderNo: "SO-1", amount: new Prisma.Decimal(amount), currency: "CNY", payableSource: { status: sourceStatus ?? "pending_finance" }, outsourcePayableSource: null });

const scopeRow = (status) => ({ id: "recon-1", status, reconciliationNo: "APREC-1", supplierId: "supplier-1", orderNo: null, purchaseOrderId: null, currency: "CNY", periodStart: new Date("2026-09-01"), periodEnd: new Date("2026-09-30") });

test("应付对账还有未处理差异时不允许批量确认应付", async () => {
  const { service, updates } = confirmHarness(scopeRow("difference"), [draftEntry("e1", "10")]);
  await assert.rejects(
    () => service.confirmPayables("recon-1", { id: "user-1" }),
    (error) => error.getResponse().code === "RECONCILIATION_NOT_COMPLETED",
  );
  assert.deepEqual(updates, [], "被拒绝时不得写入任何应付");
});

test("应付对账对平后批量确认草稿应付，来源已作废的草稿被跳过并回报", async () => {
  const { service, locks, updates, audits } = confirmHarness(scopeRow("matched"), [draftEntry("e1", "10"), draftEntry("e2", "32.5"), draftEntry("e3", "99", "voided")]);
  const result = await service.confirmPayables("recon-1", { id: "user-1" });
  assert.equal(result.confirmed_count, 2);
  assert.equal(result.confirmed_amount, "42.5000");
  assert.equal(result.skipped_count, 1);
  assert.equal(result.skipped[0].reason, "来源已作废");
  assert.deepEqual(updates.map((item) => item.id), ["e1", "e2"]);
  // 1 次对账行锁 + 每条被确认的应付一次行锁（被跳过的草稿不锁也不写）
  assert.equal(locks.filter((sql) => sql.includes("supplier_payable_reconciliations")).length, 1);
  assert.equal(locks.filter((sql) => sql.includes("supplier_payable_entries")).length, 2);
  assert.equal(audits[0][0], "supplier_payable_reconciliation.confirm_payables");
  assert.equal(audits[0][4].confirmed_amount, "42.5000");
});

test("批量确认只取对账范围内的草稿应付，可选收窄到订单与采购单", async () => {
  const { service, query } = confirmHarness({ ...scopeRow("matched"), orderNo: "SO-7", purchaseOrderId: "po-9" }, []);
  await service.confirmPayables("recon-1", { id: "user-1" });
  const where = query().where;
  assert.equal(where.status, "draft");
  assert.equal(where.supplierId, "supplier-1");
  assert.equal(where.currency, "CNY");
  assert.equal(where.orderNo, "SO-7");
  assert.equal(where.purchaseOrderId, "po-9");
});
