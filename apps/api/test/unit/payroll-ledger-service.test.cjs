const assert = require("node:assert/strict");
const test = require("node:test");
const { Prisma } = require("@prisma/client");
const { PayrollLedgerService } = require("../../dist/modules/hr/payroll-ledger.service.js");

function serviceWithStatus(status) {
  const audits = [];
  // get() 现在统一附带 adjustments / allocations 计算应发与已付，替身也必须给出这两个关系
  // 以及计算所需的金额字段（真实查询永远 include 它们并返回 Decimal）。
  const zero = () => new Prisma.Decimal(0);
  const row = {
    id: "ledger-1", status, employeeId: "employee-1", adjustments: [], allocations: [],
    baseSalary: zero(), productionSourceAmount: zero(), overtimeAmount: zero(), attendanceDeduction: zero(),
    performanceAmount: zero(), allowanceAmount: zero(), socialInsurance: zero(), individualTax: zero(), otherAdjustment: zero(),
  };
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

// 重复登记/补录会把已确认台账自动置为 expired，同时改大生产来源金额。
// 此时“重新生成薪资台账”必须把金额刷新到最新并回到草稿，否则接口原样返回过期金额，操作员会以为已重新核算。
function generationFixture(existingStatus, sources) {
  const { Prisma } = require("@prisma/client");
  const writes = [];
  const existing = { id: "ledger-1", status: existingStatus, employeeId: "employee-1", periodStart: new Date("2026-01-01"), periodEnd: new Date("2026-01-31"), baseSalary: new Prisma.Decimal("100"), productionSourceAmount: new Prisma.Decimal("10"), currency: "CNY", sourceSnapshot: [] };
  const employee = { id: "employee-1", employeeNo: "E001", name: "张三", employeeType: "workshop" };
  const prisma = {
    employee: { findMany: async () => [employee], findFirst: async () => ({ employeeType: "workshop" }) },
    productionPayrollSource: { findMany: async () => sources },
    payrollLedger: { findFirst: async () => existing, update: async ({ data }) => { writes.push(data); return { ...existing, ...data }; }, create: async ({ data }) => ({ ...existing, ...data }) },
  };
  prisma.$transaction = async (fn) => fn({ $queryRaw: async () => [], payrollLedger: prisma.payrollLedger, employee: prisma.employee, payrollPayableEntry: { findFirst: async () => null } });
  const audits = [];
  const service = new PayrollLedgerService(prisma, { create: () => ({}), update: () => ({ updatedBy: "user-1" }), record: async (...args) => audits.push(args) });
  return { service, writes, audits };
}

test("重新生成已过期台账时刷新生产来源金额并回到草稿（重复登记后的重算路径）", async () => {
  const { Prisma } = require("@prisma/client");
  const sources = [
    { id: "source-1", orderNo: "SO-1", wageMode: "piece_rate", quantity: new Prisma.Decimal("20"), durationMinutes: new Prisma.Decimal("0"), amount: new Prisma.Decimal("40") },
    { id: "source-2", orderNo: "SO-1", wageMode: "time_rate", quantity: new Prisma.Decimal("0"), durationMinutes: new Prisma.Decimal("90"), amount: new Prisma.Decimal("60") },
  ];
  const { service, writes, audits } = generationFixture("expired", sources);
  const result = await service.generate({ employee_id: "employee-1", period_start: "2026-01-01", period_end: "2026-01-31", currency: "CNY" }, { id: "user-1" });
  assert.equal(writes.length, 1, "重新生成必须刷新台账，而不是原样返回过期数据");
  assert.equal(writes[0].productionSourceAmount.toString(), "100", "生产来源金额 = 40 + 60");
  assert.equal(writes[0].status, "draft", "刷新后回到草稿等待重新确认");
  assert.deepEqual(writes[0].sourceSnapshot.map((item) => item.duration_hours), ["0", "1.5"], "台账快照同样按小时给出时长");
  assert.equal(result.status, "draft");
  assert.equal(audits[0][0], "payroll_ledger.update");
});

test("重新生成草稿台账时同样刷新生产来源金额（补录后不重新生成就是旧值）", async () => {
  const { Prisma } = require("@prisma/client");
  const { service, writes } = generationFixture("draft", [{ id: "source-1", orderNo: "SO-1", wageMode: "piece_rate", quantity: new Prisma.Decimal("5"), durationMinutes: new Prisma.Decimal("0"), amount: new Prisma.Decimal("12.5") }]);
  await service.generate({ employee_id: "employee-1", period_start: "2026-01-01", period_end: "2026-01-31", currency: "CNY" }, { id: "user-1" });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].productionSourceAmount.toString(), "12.5");
});

test("重新生成已确认台账绝不自动改写金额（已确认工资必须由人工回退或调整单处理）", async () => {
  const { Prisma } = require("@prisma/client");
  const { service, writes } = generationFixture("confirmed", [{ id: "source-1", orderNo: "SO-1", wageMode: "piece_rate", quantity: new Prisma.Decimal("5"), durationMinutes: new Prisma.Decimal("0"), amount: new Prisma.Decimal("999") }]);
  const result = await service.generate({ employee_id: "employee-1", period_start: "2026-01-01", period_end: "2026-01-31", currency: "CNY" }, { id: "user-1" });
  assert.equal(writes.length, 0, "已确认台账不得被静默改写");
  assert.equal(result.status, "confirmed");
  assert.equal(result.productionSourceAmount.toString(), "10");
});

test("重新生成已付款台账不做任何改写", async () => {
  const { service, writes } = generationFixture("paid", [{ id: "source-1", orderNo: "SO-1", wageMode: "piece_rate", quantity: "5", durationMinutes: "0", amount: "999" }]);
  const result = await service.generate({ employee_id: "employee-1", period_start: "2026-01-01", period_end: "2026-01-31", currency: "CNY" }, { id: "user-1" });
  assert.equal(writes.length, 0);
  assert.equal(result.status, "paid");
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
  const zero = () => new Prisma.Decimal(0);
  const row = {
    id: "ledger-1", status: "confirmed", employeeId: "employee-1", adjustments: [], allocations: [],
    baseSalary: zero(), productionSourceAmount: zero(), overtimeAmount: zero(), attendanceDeduction: zero(),
    performanceAmount: zero(), allowanceAmount: zero(), socialInsurance: zero(), individualTax: zero(), otherAdjustment: zero(),
  };
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

// ------------------------------------------------------------------ 工资管理页筛选（月 / 部门 / 岗位）

test("工资台账按月筛选：与所选自然月有交集的台账都要查出来", async () => {
  let captured;
  const prisma = { payrollLedger: { findMany: async (args) => { captured = args; return []; } } };
  const service = new PayrollLedgerService(prisma, {});
  await service.list(undefined, undefined, undefined, undefined, undefined, undefined, "2026-09");
  const [overlap] = captured.where.AND;
  assert.equal(overlap.periodStart.lte.toISOString(), "2026-09-30T00:00:00.000Z", "跨月台账只要与 9 月有交集就要出现");
  assert.equal(captured.where.AND[1].periodEnd.gte.toISOString(), "2026-09-01T00:00:00.000Z");
});

test("工资台账按部门/岗位/员工类型筛选员工，并在返回里带上部门与岗位名称", async () => {
  let captured;
  const row = {
    id: "ledger-1", baseSalary: new Prisma.Decimal("0"), productionSourceAmount: new Prisma.Decimal("0"), overtimeAmount: new Prisma.Decimal("0"),
    attendanceDeduction: new Prisma.Decimal("0"), performanceAmount: new Prisma.Decimal("0"), allowanceAmount: new Prisma.Decimal("0"),
    socialInsurance: new Prisma.Decimal("0"), individualTax: new Prisma.Decimal("0"), otherAdjustment: new Prisma.Decimal("0"),
    adjustments: [], allocations: [], employee: { id: "employee-1", department: { id: "dep-1", name: "生产部" }, position: { id: "pos-1", name: "缝制工" } },
  };
  const prisma = { payrollLedger: { findMany: async (args) => { captured = args; return [row]; } } };
  const service = new PayrollLedgerService(prisma, {});
  const result = await service.list(undefined, undefined, undefined, undefined, undefined, undefined, undefined, "dep-1", "pos-1", "workshop");
  assert.deepEqual(captured.where.employee, { departmentId: "dep-1", positionId: "pos-1", employeeType: "workshop" });
  assert.equal(captured.include.employee.include.department, true);
  assert.equal(captured.include.employee.include.position, true);
  assert.equal(result[0].employee.department.name, "生产部", "前端筛选下拉与表格都需要部门/岗位名称");
  assert.equal(result[0].employee.position.name, "缝制工");
});

test("没有筛选条件时不会给 employee 加上空 where（避免过滤掉任何台账）", async () => {
  let captured;
  const prisma = { payrollLedger: { findMany: async (args) => { captured = args; return []; } } };
  const service = new PayrollLedgerService(prisma, {});
  await service.list();
  assert.equal(captured.where.employee, undefined);
  assert.equal(captured.where.AND, undefined);
});

test("非法月份格式返回 422 而不是静默忽略", async () => {
  const service = new PayrollLedgerService({ payrollLedger: { findMany: async () => [] } }, {});
  await assert.rejects(() => service.list(undefined, undefined, undefined, undefined, undefined, undefined, "2026/09"), (error) => error.getResponse().code === "INVALID_MONTH");
});

test("详情接口与列表同口径：也返回应发/已付/未付", async () => {
  const row = {
    id: "ledger-1", status: "partially_paid", adjustments: [{ status: "posted", effect: "decrease", amount: new Prisma.Decimal("5") }],
    allocations: [{ status: "active", amount: new Prisma.Decimal("20"), payment: { status: "posted" } }],
    baseSalary: new Prisma.Decimal("100"), productionSourceAmount: new Prisma.Decimal("0"), overtimeAmount: new Prisma.Decimal("0"),
    attendanceDeduction: new Prisma.Decimal("0"), performanceAmount: new Prisma.Decimal("0"), allowanceAmount: new Prisma.Decimal("0"),
    socialInsurance: new Prisma.Decimal("0"), individualTax: new Prisma.Decimal("0"), otherAdjustment: new Prisma.Decimal("0"),
  };
  const prisma = { payrollLedger: { findFirst: async () => row } };
  const service = new PayrollLedgerService(prisma, {});
  const result = await service.get("ledger-1");
  assert.equal(result.payableAmount, "95.0000");
  assert.equal(result.paidAmount, "20.0000");
  assert.equal(result.outstandingAmount, "75.0000");
});
