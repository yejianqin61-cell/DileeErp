const assert = require("node:assert/strict");
const { test } = require("node:test");
const { Prisma } = require("@prisma/client");
const { PayrollPayableService } = require("../../dist/modules/hr/payroll-payable.service.js");

function auditStub() {
  return {
    create: () => ({ createdBy: "user-1", updatedBy: "user-1" }),
    update: () => ({ updatedBy: "user-1" }),
    record: async () => undefined,
  };
}

function ledgerRow(overrides = {}) {
  return {
    id: "ledger-1",
    ledgerNo: "PAYROLL-1",
    employeeId: "employee-1",
    currency: "CNY",
    periodStart: new Date("2026-01-01T00:00:00.000Z"),
    periodEnd: new Date("2026-01-31T00:00:00.000Z"),
    baseSalary: new Prisma.Decimal("100"),
    productionSourceAmount: new Prisma.Decimal("20"),
    overtimeAmount: new Prisma.Decimal("0"),
    attendanceDeduction: new Prisma.Decimal("0"),
    lateDeduction: new Prisma.Decimal("0"),
    absenceDeduction: new Prisma.Decimal("0"),
    earlyLeaveDeduction: new Prisma.Decimal("0"),
    performanceAmount: new Prisma.Decimal("0"),
    allowanceAmount: new Prisma.Decimal("0"),
    housingAllowance: new Prisma.Decimal("0"),
    socialInsurance: new Prisma.Decimal("0"),
    individualTax: new Prisma.Decimal("0"),
    otherAdjustment: new Prisma.Decimal("0"),
    adjustments: [{ effect: "increase", amount: new Prisma.Decimal("10") }],
    status: "confirmed",
    ...overrides,
  };
}

test("payroll payable creation computes ledger net amount and snapshots it", async () => {
  let created;
  const tx = {
    $queryRaw: async () => [],
    payrollLedger: { findFirst: async () => ledgerRow() },
    payrollPayableEntry: {
      findUnique: async () => null,
      create: async ({ data }) => { created = data; return { id: "payable-1", ...data }; },
    },
  };
  const service = new PayrollPayableService({ $transaction: async (fn) => fn(tx) }, auditStub());
  const row = await service.createFromLedger("ledger-1", { order_no: "SO-1" }, { id: "user-1" });
  assert.equal(row.amount.toString(), "130");
  assert.equal(row.orderNo, "SO-1");
  assert.equal(created.sourceSnapshot.payable_amount, "130");
  assert.equal(created.sourceSnapshot.adjustment_amount, "10");
});

test("payroll payable creation is idempotent for the same ledger", async () => {
  let createCount = 0;
  const existing = { id: "payable-existing", ledgerId: "ledger-1", amount: new Prisma.Decimal("130") };
  const tx = {
    $queryRaw: async () => [],
    payrollLedger: { findFirst: async () => ledgerRow() },
    payrollPayableEntry: { findUnique: async () => existing, create: async () => { createCount += 1; } },
  };
  const service = new PayrollPayableService({ $transaction: async (fn) => fn(tx) }, auditStub());
  const row = await service.createFromLedger("ledger-1", {}, { id: "user-1" });
  assert.equal(row.id, "payable-existing");
  assert.equal(createCount, 0);
});

test("payroll payable creation rejects non-confirmed ledger", async () => {
  const tx = {
    $queryRaw: async () => [],
    payrollLedger: { findFirst: async () => ledgerRow({ status: "draft" }) },
    payrollPayableEntry: { findUnique: async () => null, create: async () => { throw new Error("must not create"); } },
  };
  const service = new PayrollPayableService({ $transaction: async (fn) => fn(tx) }, auditStub());
  await assert.rejects(() => service.createFromLedger("ledger-1", {}, { id: "user-1" }), (error) => error.getResponse().code === "PAYROLL_LEDGER_NOT_CONFIRMED");
});

test("payroll payable reopen is blocked by posted payment allocations", async () => {
  const tx = {
    $queryRaw: async () => [],
    payrollPayableEntry: { findFirst: async () => ({ id: "payable-1", ledgerId: "ledger-1", status: "confirmed", remark: null }), update: async () => { throw new Error("must not update"); } },
    salaryPaymentAllocation: { findFirst: async () => ({ id: "allocation-1" }) },
  };
  const service = new PayrollPayableService({ $transaction: async (fn) => fn(tx) }, auditStub());
  await assert.rejects(() => service.reopen("payable-1", "重新核算", { id: "user-1" }), (error) => error.getResponse().code === "PAYROLL_PAYABLE_HAS_PAYMENTS");
});

test("payroll payable reverse is blocked by posted payment allocations", async () => {
  const tx = {
    $queryRaw: async () => [],
    payrollPayableEntry: { findFirst: async () => ({ id: "payable-1", ledgerId: "ledger-1", status: "paid", remark: null }), update: async () => { throw new Error("must not update"); } },
    salaryPaymentAllocation: { findFirst: async () => ({ id: "allocation-1" }) },
  };
  const service = new PayrollPayableService({ $transaction: async (fn) => fn(tx) }, auditStub());
  await assert.rejects(() => service.reverse("payable-1", "错误付款", { id: "user-1" }), (error) => error.getResponse().code === "PAYROLL_PAYABLE_HAS_PAYMENTS");
});


test("payroll payable refresh follows posted payment allocations", async () => {
  let updatedStatus;
  const tx = {
    payrollPayableEntry: {
      findFirst: async () => ({ id: "payable-1", ledgerId: "ledger-1", amount: new Prisma.Decimal("100"), status: "confirmed" }),
      update: async ({ data }) => { updatedStatus = data.status; return { id: "payable-1", ...data }; },
    },
    salaryPaymentAllocation: { aggregate: async () => ({ _sum: { amount: new Prisma.Decimal("40") } }) },
  };
  const service = new PayrollPayableService({}, auditStub());
  await service.refreshStatusForLedger(tx, "ledger-1", { id: "user-1" });
  assert.equal(updatedStatus, "partially_paid");
});
