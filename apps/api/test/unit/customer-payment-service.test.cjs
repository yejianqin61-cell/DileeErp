const assert = require("node:assert/strict");
const test = require("node:test");
const { CustomerPaymentService } = require("../../dist/modules/finance/customer-payment.service.js");

test("customer payment draft update locks and rechecks current status", async () => {
  let lockCount = 0;
  let updateCount = 0;
  const row = { id: "payment-1", status: "posted", amount: "10", paymentDate: new Date(), paymentMethod: "bank", remark: null };
  const prisma = { customerPayment: { findFirst: async () => row, update: async () => { updateCount += 1; return row; } }, $transaction: async (fn) => fn({ $queryRaw: async () => { lockCount += 1; }, customerPayment: prisma.customerPayment }) };
  const service = new CustomerPaymentService(prisma, { update: () => ({}) }, {});
  await assert.rejects(() => service.updateDraft("payment-1", { amount: "12" }, { id: "user-1" }), (error) => error.getResponse().code === "CUSTOMER_PAYMENT_NOT_EDITABLE");
  assert.equal(lockCount, 1); assert.equal(updateCount, 0);
});

test("customer payment reversal locks each receivable source before reversing allocations", async () => {
  const locks = [];
  const row = { id: "payment-1", status: "posted", allocations: [] };
  const prisma = {
    customerPayment: { findFirst: async () => row },
    $transaction: async (fn) => fn({
      $queryRaw: async (_strings, ...values) => { locks.push(values[0]); return []; },
      customerPayment: { findFirst: async () => ({ id: "payment-1", status: "posted", remark: null, orderNo: "SO-1", allocations: [{ receivableSourceId: "source-b" }, { receivableSourceId: "source-a" }] }), update: async () => ({ orderNo: "SO-1" }) },
      receivableAllocation: { updateMany: async () => {} },
    }),
  };
  const service = new CustomerPaymentService(prisma, { update: () => ({}), record: async () => {} }, { refreshStatus: async () => {} });
  await service.reverse("payment-1", "撤销原因", { id: "user-1" });
  assert.deepEqual(locks, ["payment-1", "source-a", "source-b"]);
});
