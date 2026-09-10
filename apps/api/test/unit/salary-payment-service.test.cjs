const assert = require("node:assert/strict");
const { test } = require("node:test");
const { UnprocessableEntityException } = require("@nestjs/common");
const { Prisma } = require("@prisma/client");
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


test("salary payment posting requires a confirmed payroll payable", async () => {
  const payment = { id: "payment-1", status: "draft", amount: "10", currency: "CNY" };
  const ledger = { id: "ledger-1", employeeId: "employee-1", currency: "CNY", status: "confirmed", baseSalary: "10" };
  const tx = {
    $queryRaw: async () => [],
    salaryPayment: { findFirst: async () => ({ ...payment, status: "draft" }) },
    payrollLedger: { findFirst: async () => ledger },
    payrollPayableEntry: { findFirst: async () => null },
  };
  const prisma = { salaryPayment: { findFirst: async () => payment }, $transaction: async (fn) => fn(tx) };
  const audit = { create: () => ({}), update: () => ({}), record: async () => {} };
  const service = new SalaryPaymentService(prisma, audit, {});
  await assert.rejects(
    () => service.post("payment-1", [{ ledger_id: "ledger-1", amount: "10" }], { id: "user-1" }),
    (error) => error.getResponse().code === "PAYROLL_PAYABLE_REQUIRED",
  );
});


test("salary payment posting requires a confirmed payroll payable status", async () => {
  const payment = { id: "payment-1", status: "draft", amount: "10", currency: "CNY" };
  const ledger = { id: "ledger-1", employeeId: "employee-1", currency: "CNY", status: "confirmed", baseSalary: "10" };
  const tx = {
    $queryRaw: async () => [],
    salaryPayment: { findFirst: async () => ({ ...payment, status: "draft" }) },
    payrollLedger: { findFirst: async () => ledger },
    payrollPayableEntry: { findFirst: async () => ({ id: "payable-1", ledgerId: "ledger-1", status: "draft", amount: "10" }) },
  };
  const prisma = { salaryPayment: { findFirst: async () => payment }, $transaction: async (fn) => fn(tx) };
  const audit = { create: () => ({}), update: () => ({}), record: async () => {} };
  const service = new SalaryPaymentService(prisma, audit, {});
  await assert.rejects(
    () => service.post("payment-1", [{ ledger_id: "ledger-1", amount: "10" }], { id: "user-1" }),
    (error) => error.getResponse().code === "PAYROLL_PAYABLE_NOT_ALLOCATABLE",
  );
});


test("salary payment posting rejects payroll payable amount mismatch", async () => {
  const payment = { id: "payment-1", status: "draft", amount: "10", currency: "CNY" };
  const ledger = {
    id: "ledger-1", employeeId: "employee-1", currency: "CNY", status: "confirmed",
    baseSalary: new Prisma.Decimal("10"), productionSourceAmount: new Prisma.Decimal("0"),
    overtimeAmount: new Prisma.Decimal("0"), attendanceDeduction: new Prisma.Decimal("0"),
    performanceAmount: new Prisma.Decimal("0"), allowanceAmount: new Prisma.Decimal("0"),
    socialInsurance: new Prisma.Decimal("0"), individualTax: new Prisma.Decimal("0"),
    otherAdjustment: new Prisma.Decimal("0"),
  };
  const tx = {
    $queryRaw: async () => [],
    salaryPayment: { findFirst: async () => ({ ...payment, status: "draft" }) },
    payrollLedger: { findFirst: async () => ledger },
    payrollPayableEntry: { findFirst: async () => ({ id: "payable-1", ledgerId: "ledger-1", status: "confirmed", amount: new Prisma.Decimal("9") }) },
    payrollAdjustment: { findMany: async () => [] },
    salaryPaymentAllocation: { aggregate: async () => ({ _sum: { amount: null } }) },
  };
  const prisma = { salaryPayment: { findFirst: async () => payment }, $transaction: async (fn) => fn(tx) };
  const audit = { create: () => ({}), update: () => ({}), record: async () => {} };
  const service = new SalaryPaymentService(prisma, audit, {});
  await assert.rejects(
    () => service.post("payment-1", [{ ledger_id: "ledger-1", amount: "10" }], { id: "user-1" }),
    (error) => error.getResponse().code === "PAYROLL_PAYABLE_AMOUNT_MISMATCH",
  );
});
