const assert = require("node:assert/strict");
const test = require("node:test");
const { CustomerPaymentService } = require("../../dist/modules/finance/customer-payment.service.js");

test("customer payment draft update locks and rechecks current status", async () => {
  let lockCount = 0;
  let updateCount = 0;
  const row = { id: "payment-1", status: "posted", amount: "10", paymentDate: new Date(), paymentMethod: "bank", remark: null };
  const prisma = {
    customerPayment: {
      findFirst: async () => row,
      update: async () => { updateCount += 1; return row; },
    },
    $transaction: async (fn) => fn({
      $queryRaw: async () => { lockCount += 1; return []; },
      customerPayment: prisma.customerPayment,
    }),
  };
  const audit = { update: () => ({}) };
  const service = new CustomerPaymentService(prisma, audit, {});
  await assert.rejects(
    () => service.updateDraft("payment-1", { amount: "12" }, { id: "user-1" }),
    (error) => error.getResponse().code === "CUSTOMER_PAYMENT_NOT_EDITABLE",
  );
  assert.equal(lockCount, 1);
  assert.equal(updateCount, 0);
});
