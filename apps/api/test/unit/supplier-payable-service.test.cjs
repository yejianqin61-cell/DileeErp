const assert = require("node:assert/strict");
const test = require("node:test");
const { SupplierPayableService } = require("../../dist/modules/finance/supplier-payable.service.js");

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
  const service = new SupplierPayableService(prisma, audit);
  await assert.rejects(
    () => service.confirm("payable-1", { id: "user-1" }),
    (error) => error.getResponse().code === "SUPPLIER_PAYABLE_NOT_CONFIRMABLE",
  );
  assert.equal(lockCount, 1);
  assert.equal(updateCount, 0);
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
  const service = new SupplierPayableService(prisma, audit);
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
  const service = new SupplierPayableService(prisma, audit);
  await assert.rejects(
    () => service.updateDraft("payable-1", { amount: "12" }, { id: "user-1" }),
    (error) => error.getResponse().code === "SUPPLIER_PAYABLE_NOT_EDITABLE",
  );
  assert.equal(lockCount, 1);
  assert.equal(updateCount, 0);
});

test("payable source creation restores a soft-deleted unique entry", async () => {
  let restored = 0;
  const deleted = { id: "payable-1", deletedAt: new Date(), sourceType: "raw_material_inbound" };
  const prisma = {
    payableSource: { findFirst: async () => ({ id: "source-1", status: "pending_finance", orderNo: "PO-1", supplierId: "supplier-1", quantity: "1", unitPrice: "2", taxRate: "0", amount: "2", currency: "CNY", rawMaterialInbound: { inboundNo: "IN-1" }, purchaseReceipt: null }) },
    supplierPayableEntry: { findUnique: async () => deleted, update: async () => { restored += 1; return { ...deleted, deletedAt: null, orderNo: "PO-1", amount: { toString: () => "2" } }; } },
    $transaction: async (fn) => fn({ $queryRaw: async () => [], payableSource: prisma.payableSource, supplierPayableEntry: prisma.supplierPayableEntry }),
  };
  const service = new SupplierPayableService(prisma, { update: () => ({}), recordWithOrderNo: async () => {} });
  const result = await service.createFromSource({ source_type: "raw_material_inbound", source_id: "source-1" }, { id: "user-1" });
  assert.equal(result.deletedAt, null);
  assert.equal(restored, 1);
});
