const assert = require("node:assert/strict");
const { test } = require("node:test");
const { UnprocessableEntityException } = require("@nestjs/common");
const { SalaryPaymentService } = require("../../dist/modules/hr/salary-payment.service.js");

test("salary payment posting locks the payment before allocation checks", async () => {
  const calls = [];
  const current = { id: "payment-1", status: "draft", amount: "10", currency: "CNY" };
  const prisma = {
    salaryPayment: { findFirst: async () => current },
    $transaction: async (fn) => fn({
      $queryRaw: async () => { calls.push("lock"); },
      salaryPayment: { findFirst: async () => ({ ...current, status: "posted" }) },
    }),
  };
  const service = new SalaryPaymentService(prisma, {}, {});
  await assert.rejects(() => service.post(current.id, [{ ledger_id: "ledger-1", amount: "10" }], { id: "user-1" }), (error) => error instanceof UnprocessableEntityException && error.getResponse().code === "SALARY_PAYMENT_NOT_POSTABLE");
  assert.deepEqual(calls, ["lock"]);
});

test("salary payment draft update locks and rechecks current status", async () => {
  let lockCount = 0;
  let updateCount = 0;
  const row = { id: "payment-1", status: "posted", amount: "10", paymentDate: new Date(), paymentMethod: "bank", remark: null };
  const prisma = { salaryPayment: { findFirst: async () => row, update: async () => { updateCount += 1; return row; } }, $transaction: async (fn) => fn({ $queryRaw: async () => { lockCount += 1; }, salaryPayment: prisma.salaryPayment }) };
  const service = new SalaryPaymentService(prisma, { update: () => ({}), record: async () => {} }, {});
  await assert.rejects(() => service.updateDraft("payment-1", { amount: "12" }, { id: "user-1" }), (error) => error.getResponse().code === "SALARY_PAYMENT_NOT_EDITABLE");
  assert.equal(lockCount, 1); assert.equal(updateCount, 0);
});
