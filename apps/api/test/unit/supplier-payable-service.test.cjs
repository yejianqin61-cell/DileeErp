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
