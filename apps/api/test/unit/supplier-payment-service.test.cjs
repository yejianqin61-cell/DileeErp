const assert = require("node:assert/strict");
const test = require("node:test");
const { SupplierPaymentService } = require("../../dist/modules/finance/supplier-payment.service.js");

test("supplier payment draft update locks and rechecks current status", async () => {
  let lockCount = 0;
  let updateCount = 0;
  const row = { id: "payment-1", status: "posted", amount: "10", paymentDate: new Date(), paymentMethod: "bank", remark: null };
  const prisma = {
    supplierPayment: {
      findFirst: async () => row,
      update: async () => { updateCount += 1; return row; },
    },
    $transaction: async (fn) => fn({
      $queryRaw: async () => { lockCount += 1; return []; },
      supplierPayment: prisma.supplierPayment,
    }),
  };
  const audit = { update: () => ({}) };
  const service = new SupplierPaymentService(prisma, audit, {});
  await assert.rejects(
    () => service.updateDraft("payment-1", { amount: "12" }, { id: "user-1" }),
    (error) => error.getResponse().code === "SUPPLIER_PAYMENT_NOT_EDITABLE",
  );
  assert.equal(lockCount, 1);
  assert.equal(updateCount, 0);
});

test("supplier payment reversal locks and rechecks the payment", async () => {
  let lockCount = 0;
  const row = { id: "payment-1", status: "reversed", remark: null, allocations: [] };
  const prisma = {
    supplierPayment: { findFirst: async () => row, update: async () => row },
    supplierPaymentAllocation: { updateMany: async () => {} },
    $transaction: async (fn) => fn({
      $queryRaw: async () => { lockCount += 1; return []; },
      supplierPayment: prisma.supplierPayment,
      supplierPaymentAllocation: prisma.supplierPaymentAllocation,
    }),
  };
  const audit = { update: () => ({}), record: async () => {} };
  const service = new SupplierPaymentService(prisma, audit, { refreshStatus: async () => {} });
  await assert.rejects(
    () => service.reverse("payment-1", "撤销原因", { id: "user-1" }),
    (error) => error.getResponse().code === "SUPPLIER_PAYMENT_NOT_REVERSIBLE",
  );
  assert.equal(lockCount, 1);
});
