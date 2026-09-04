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
  prisma.$transaction = async (fn) => fn({ $queryRaw: async () => [], payrollLedger: prisma.payrollLedger });
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
