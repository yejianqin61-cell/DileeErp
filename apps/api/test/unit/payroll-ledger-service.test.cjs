const assert = require("node:assert/strict");
const test = require("node:test");
const { PayrollLedgerService } = require("../../dist/modules/hr/payroll-ledger.service.js");

function serviceWithStatus(status) {
  const audits = [];
  const row = { id: "ledger-1", status, employeeId: "employee-1" };
  const prisma = {
    payrollLedger: {
      findFirst: async () => row,
      update: async ({ data }) => ({ ...row, ...data }),
    },
  };
  prisma.$transaction = async (fn) => fn({ $queryRaw: async () => [], payrollLedger: prisma.payrollLedger, payrollPayableEntry: { findFirst: async () => null } });
  const audit = {
    update: () => ({ updatedBy: "user-1" }),
    record: async (...args) => audits.push(args),
  };
  return { service: new PayrollLedgerService(prisma, audit), audits };
}

test("payroll ledger reopen requires a reason", async () => {
  const { service } = serviceWithStatus("confirmed");
  await assert.rejects(() => service.reopen("ledger-1", "", { id: "user-1" }), (error) => error.getResponse().code === "CORRECTION_REASON_REQUIRED");
});

test("payroll ledger reopen permits confirmed and expired statuses and audits the transition", async () => {
  for (const status of ["confirmed", "expired"]) {
    const { service, audits } = serviceWithStatus(status);
    const result = await service.reopen("ledger-1", "重新核算", { id: "user-1" });
    assert.equal(result.status, "draft");
    assert.equal(audits[0][0], "payroll_ledger.reopen");
    assert.equal(audits[0][4].reason, "重新核算");
  }
});

test("paid payroll ledger cannot reopen directly", async () => {
  const { service } = serviceWithStatus("paid");
  await assert.rejects(() => service.reopen("ledger-1", "差额调整", { id: "user-1" }), (error) => error.getResponse().code === "PAYROLL_PAID_NOT_REOPENABLE");
});

test("payroll adjustment locks and rechecks the latest ledger status", async () => {
  const audits = [];
  let lockCount = 0;
  let createCount = 0;
  const prisma = {
    payrollLedger: { findFirst: async () => ({ id: "ledger-1", status: "paid", employeeId: "employee-1" }) },
    payrollAdjustment: { create: async () => { createCount += 1; return { id: "adjustment-1", amount: "10" }; } },
    $transaction: async (fn) => fn({
      $queryRaw: async () => { lockCount += 1; return []; },
      payrollLedger: prisma.payrollLedger,
      payrollAdjustment: prisma.payrollAdjustment,
    }),
  };
  const audit = { record: async (...args) => audits.push(args) };
  const service = new PayrollLedgerService(prisma, audit);
  await assert.rejects(
    () => service.adjustment("ledger-1", { adjustment_type: "bonus", effect: "increase", amount: "10", reason: "补录" }, { id: "user-1" }),
    (error) => error.getResponse().code === "PAYROLL_NOT_ADJUSTABLE",
  );
  assert.equal(lockCount, 1);
  assert.equal(createCount, 0);
  assert.equal(audits.length, 0);
});

test("payroll ledger update locks and rechecks paid status", async () => {
  let lockCount = 0;
  let updateCount = 0;
  const row = { id: "ledger-1", status: "paid", employeeId: "employee-1" };
  const prisma = {
    payrollLedger: { findFirst: async () => row, update: async () => { updateCount += 1; return row; } },
    $transaction: async (fn) => fn({
      $queryRaw: async () => { lockCount += 1; return []; },
      payrollLedger: prisma.payrollLedger,
        payrollPayableEntry: { findFirst: async () => null },
    }),
  };
  const audit = { update: () => ({}), record: async () => {} };
  const service = new PayrollLedgerService(prisma, audit);
  await assert.rejects(
    () => service.update("ledger-1", { base_salary: "20" }, { id: "user-1" }),
    (error) => error.getResponse().code === "PAYROLL_PAID_NOT_EDITABLE",
  );
  assert.equal(lockCount, 1);
  assert.equal(updateCount, 0);
});

test("payroll ledger generation locks employee before idempotency check", async () => {
  let lockCount = 0;
  let createCount = 0;
  const employee = { id: "employee-1", employeeNo: "E001", name: "张三", employeeType: "office" };
  const existing = { id: "ledger-1", employeeId: employee.id, periodStart: new Date("2026-01-01"), periodEnd: new Date("2026-01-31") };
  const prisma = {
    employee: { findMany: async () => [employee], findFirst: async () => ({ employeeType: "office" }) },
    productionPayrollSource: { findMany: async () => [] },
    payrollLedger: { findFirst: async () => existing, create: async () => { createCount += 1; } },
    $transaction: async (fn) => fn({
      $queryRaw: async () => { lockCount += 1; return []; },
      payrollLedger: prisma.payrollLedger,
      employee: prisma.employee,
    }),
  };
  const service = new PayrollLedgerService(prisma, { create: () => ({}), record: async () => {} });
  const result = await service.generate({ employee_id: employee.id, period_start: "2026-01-01", period_end: "2026-01-31", currency: "CNY" }, { id: "user-1" });
  assert.equal(result.id, existing.id);
  assert.equal(lockCount, 1);
  assert.equal(createCount, 0);
});


test("payroll ledger list applies period overlap and computes payable/paid/outstanding", async () => {
  const { Prisma } = require("@prisma/client");
  let captured;
  const row = {
    id: "ledger-1",
    periodStart: new Date("2026-01-01"),
    periodEnd: new Date("2026-01-31"),
    baseSalary: new Prisma.Decimal("100"),
    productionSourceAmount: new Prisma.Decimal("50"),
    overtimeAmount: new Prisma.Decimal("0"),
    attendanceDeduction: new Prisma.Decimal("5"),
    performanceAmount: new Prisma.Decimal("0"),
    allowanceAmount: new Prisma.Decimal("0"),
    socialInsurance: new Prisma.Decimal("0"),
    individualTax: new Prisma.Decimal("0"),
    otherAdjustment: new Prisma.Decimal("0"),
    adjustments: [{ status: "posted", effect: "increase", amount: new Prisma.Decimal("10") }],
    allocations: [
      { status: "active", amount: new Prisma.Decimal("20"), payment: { status: "posted" } },
      { status: "active", amount: new Prisma.Decimal("100"), payment: { status: "draft" } },
    ],
    employee: { id: "employee-1" },
  };
  const prisma = { payrollLedger: { findMany: async (args) => { captured = args; return [row]; } } };
  const service = new PayrollLedgerService(prisma, {});
  const result = await service.list(undefined, undefined, undefined, undefined, "2026-01-01", "2026-01-31");
  assert.ok(captured.where.AND);
  assert.equal(result[0].payableAmount, "155.0000");
  assert.equal(result[0].paidAmount, "20.0000");
  assert.equal(result[0].outstandingAmount, "135.0000");
});


test("payroll ledger with a confirmed payroll payable cannot reopen", async () => {
  let updateCount = 0;
  const row = { id: "ledger-1", status: "confirmed", employeeId: "employee-1" };
  const prisma = {
    payrollLedger: { findFirst: async () => row, update: async () => { updateCount += 1; return row; } },
    $transaction: async (fn) => fn({
      $queryRaw: async () => [],
      payrollLedger: prisma.payrollLedger,
      payrollPayableEntry: { findFirst: async () => ({ id: "payable-1", status: "confirmed" }) },
    }),
  };
  const service = new PayrollLedgerService(prisma, { update: () => ({}), record: async () => {} });
  await assert.rejects(
    () => service.reopen("ledger-1", "重新核算", { id: "user-1" }),
    (error) => error.getResponse().code === "PAYROLL_LEDGER_HAS_PAYABLE",
  );
  assert.equal(updateCount, 0);
});


test("payroll ledger update is blocked when a payroll payable exists", async () => {
  let updateCount = 0;
  const row = { id: "ledger-1", status: "confirmed", employeeId: "employee-1" };
  const prisma = {
    payrollLedger: { findFirst: async () => row, update: async () => { updateCount += 1; return row; } },
    $transaction: async (fn) => fn({
      $queryRaw: async () => [],
      payrollLedger: prisma.payrollLedger,
      payrollPayableEntry: { findFirst: async () => ({ id: "payable-1", status: "confirmed" }) },
    }),
  };
  const service = new PayrollLedgerService(prisma, { update: () => ({}), record: async () => {} });
  await assert.rejects(
    () => service.update("ledger-1", { base_salary: "20", reason: "修改" }, { id: "user-1" }),
    (error) => error.getResponse().code === "PAYROLL_LEDGER_HAS_PAYABLE",
  );
  assert.equal(updateCount, 0);
});
