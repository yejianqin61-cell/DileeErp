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
