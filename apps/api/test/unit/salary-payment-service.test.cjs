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
    lateDeduction: new Prisma.Decimal("0"), absenceDeduction: new Prisma.Decimal("0"), earlyLeaveDeduction: new Prisma.Decimal("0"),
    performanceAmount: new Prisma.Decimal("0"), allowanceAmount: new Prisma.Decimal("0"),
    housingAllowance: new Prisma.Decimal("0"),
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

// 2026-09-15：工资台账新增房补与迟到/旷工/早退扣款。付款过账时的实发校验必须走同一份公式，
// 否则新类目会被静默忽略（工资应付 10、实发 19 却照样按 10 核销）。
function postingFixture({ housing = "15", late = "1", absence = "2", early = "3", payableAmount = "10" } = {}) {
  const payment = { id: "payment-1", status: "draft", amount: "100", currency: "CNY", paymentNo: "SALARY-1", paymentDate: new Date("2026-09-05"), paymentMethod: "bank", remark: null };
  const ledger = {
    id: "ledger-1", employeeId: "employee-1", currency: "CNY", status: "confirmed",
    baseSalary: new Prisma.Decimal("10"), productionSourceAmount: new Prisma.Decimal("0"),
    overtimeAmount: new Prisma.Decimal("0"), attendanceDeduction: new Prisma.Decimal("0"),
    lateDeduction: new Prisma.Decimal(late), absenceDeduction: new Prisma.Decimal(absence), earlyLeaveDeduction: new Prisma.Decimal(early),
    performanceAmount: new Prisma.Decimal("0"), allowanceAmount: new Prisma.Decimal("0"),
    housingAllowance: new Prisma.Decimal(housing),
    socialInsurance: new Prisma.Decimal("0"), individualTax: new Prisma.Decimal("0"),
    otherAdjustment: new Prisma.Decimal("0"),
  };
  const created = [];
  const tx = {
    $queryRaw: async () => [],
    salaryPayment: { findFirst: async () => ({ ...payment, status: "draft" }), update: async () => ({ ...payment, status: "posted" }) },
    payrollLedger: { findFirst: async () => ledger },
    payrollPayableEntry: { findFirst: async () => ({ id: "payable-1", ledgerId: "ledger-1", status: "confirmed", amount: new Prisma.Decimal(payableAmount) }) },
    payrollAdjustment: { findMany: async () => [] },
    salaryPaymentAllocation: { aggregate: async () => ({ _sum: { amount: null } }), create: async ({ data }) => { created.push(data); return data; } },
  };
  const prisma = { salaryPayment: { findFirst: async () => payment }, $transaction: async (fn) => fn(tx) };
  const audit = { create: () => ({}), update: () => ({}), record: async () => {} };
  const service = new SalaryPaymentService(prisma, audit, { refreshStatus: async () => {} }, undefined, { autoCreateFromPayment: async () => {} });
  return { service, created };
}

test("房补与三种扣款参与过账的实发金额校验：应付 10 而实发 19 时拒绝核销", async () => {
  const { service, created } = postingFixture();
  await assert.rejects(
    () => service.post("payment-1", [{ ledger_id: "ledger-1", amount: "10" }], { id: "user-1" }),
    (error) => error.getResponse().code === "PAYROLL_PAYABLE_AMOUNT_MISMATCH",
  );
  assert.equal(created.length, 0, "金额不一致时不得落任何核销明细");
});

test("实发金额与新增类目一致时允许核销（10 + 房补 15 − 迟到 1 − 旷工 2 − 早退 3 = 19）", async () => {
  const { service, created } = postingFixture({ payableAmount: "19" });
  const result = await service.post("payment-1", [{ ledger_id: "ledger-1", amount: "19" }], { id: "user-1" });
  assert.equal(result.status, "posted");
  assert.equal(created.length, 1);
  assert.equal(created[0].amount.toString(), "19");
});

test("工资付款按月份/部门/岗位筛选（用户需求第 4 条）", async () => {
  let captured;
  const prisma = { salaryPayment: { findMany: async (args) => { captured = args; return []; } } };
  const service = new SalaryPaymentService(prisma, {}, {});
  await service.list(undefined, "2026-09", "dep-1", "pos-1");
  assert.equal(captured.where.paymentDate.gte.toISOString(), "2026-09-01T00:00:00.000Z");
  assert.equal(captured.where.paymentDate.lte.toISOString(), "2026-09-30T00:00:00.000Z");
  assert.deepEqual(captured.where.allocations, { some: { deletedAt: null, ledger: { deletedAt: null, employee: { departmentId: "dep-1", positionId: "pos-1" } } } });
  assert.equal(captured.include.allocations.include.ledger.include.employee.include.department, true, "部门/岗位筛的是核销员工，界面还要显示名称");
  assert.equal(captured.include.allocations.include.ledger.include.employee.include.position, true);
});

test("工资付款没有筛选条件时不加 paymentDate / allocations 过滤（避免过滤掉任何付款单）", async () => {
  let captured;
  const prisma = { salaryPayment: { findMany: async (args) => { captured = args; return []; } } };
  const service = new SalaryPaymentService(prisma, {}, {});
  await service.list("posted");
  assert.equal(captured.where.status, "posted");
  assert.equal(captured.where.paymentDate, undefined);
  assert.equal(captured.where.allocations, undefined);
});

test("工资付款非法月份返回 422，而不是静默返回全部付款", async () => {
  const service = new SalaryPaymentService({ salaryPayment: { findMany: async () => [] } }, {}, {});
  await assert.rejects(() => service.list(undefined, "2026/09"), (error) => error.getResponse().code === "INVALID_MONTH");
});
