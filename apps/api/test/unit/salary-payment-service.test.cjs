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
