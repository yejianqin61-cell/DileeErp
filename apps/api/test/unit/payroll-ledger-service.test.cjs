// 工资台账服务的行为测试：真实调用 dist 里的服务类，Prisma 用手写替身（不连数据库）。
//
// 2026-09-15 变化（用户需求第 3 条）：
//   1. 生产工资的取数口径从 `production_payroll_sources`（派生表）改成**员工日报本身**——
//      派生表在员工类型车间→非车间时会被软删、改回车间又不补建，拿它汇总会真的漏单；
//   2. 新增 `importMonth()`：按月幂等导入全部在册员工，车间带生产工资、非车间为 0；
//   3. 新增房补与迟到/旷工/早退扣款三列，且车间的 base_salary 不允许手工填非零。
const assert = require("node:assert/strict");
const test = require("node:test");
const { Prisma } = require("@prisma/client");
const { PayrollLedgerService } = require("../../dist/modules/hr/payroll-ledger.service.js");

const zero = () => new Prisma.Decimal(0);

/** 台账行：13 个类目金额齐全（真实查询永远返回全部标量列）。 */
function ledgerRow(overrides = {}) {
  return {
    id: "ledger-1",
    ledgerNo: "PAYROLL-1",
    status: "draft",
    employeeId: "employee-1",
    periodStart: new Date("2026-01-01T00:00:00.000Z"),
    periodEnd: new Date("2026-01-31T00:00:00.000Z"),
    currency: "CNY",
    adjustments: [],
    allocations: [],
    baseSalary: zero(),
    productionSourceAmount: zero(),
    overtimeAmount: zero(),
    attendanceDeduction: zero(),
    lateDeduction: zero(),
    absenceDeduction: zero(),
    earlyLeaveDeduction: zero(),
    performanceAmount: zero(),
    allowanceAmount: zero(),
    housingAllowance: zero(),
    socialInsurance: zero(),
    individualTax: zero(),
    otherAdjustment: zero(),
    ...overrides,
  };
}

/** 员工日报行（工资侧的事实源）。 */
function report(overrides = {}) {
  return {
    id: "report-1",
    employeeId: "employee-1",
    productionOrderId: "order-1",
    orderNo: "SO-1",
    productionOrderOperationId: "op-1",
    operationNameSnapshot: "裁剪",
    reportDate: new Date("2026-01-05T00:00:00.000Z"),
    wageMode: "piece_rate",
    quantity: new Prisma.Decimal("20"),
    durationMinutes: zero(),
    calculatedAmount: new Prisma.Decimal("40"),
    deletedAt: null,
    ...overrides,
  };
}

function serviceWithStatus(status) {
  const audits = [];
  const row = ledgerRow({ status });
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
    employeeDailyReport: { findMany: async () => [] },
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

// 重复登记/补录会把已确认台账自动置为 expired，同时改大生产工资。
// 此时“重新生成薪资台账”必须把金额刷新到最新并回到草稿，否则接口原样返回过期金额，操作员会以为已重新核算。
function generationFixture(existingStatus, reports) {
  const writes = [];
  const reads = [];
  const existing = { id: "ledger-1", status: existingStatus, employeeId: "employee-1", periodStart: new Date("2026-01-01"), periodEnd: new Date("2026-01-31"), baseSalary: new Prisma.Decimal("100"), productionSourceAmount: new Prisma.Decimal("10"), currency: "CNY", sourceSnapshot: [] };
  const employee = { id: "employee-1", employeeNo: "E001", name: "张三", employeeType: "workshop" };
  const prisma = {
    employee: { findMany: async () => [employee], findFirst: async () => ({ employeeType: "workshop" }) },
    employeeDailyReport: { findMany: async (args) => { reads.push(args); return reports; } },
    payrollLedger: { findFirst: async () => existing, update: async ({ data }) => { writes.push(data); return { ...existing, ...data }; }, create: async ({ data }) => ({ ...existing, ...data }) },
  };
  prisma.$transaction = async (fn) => fn({ $queryRaw: async () => [], payrollLedger: prisma.payrollLedger, employee: prisma.employee, payrollPayableEntry: { findFirst: async () => null } });
  const audits = [];
  const service = new PayrollLedgerService(prisma, { create: () => ({}), update: () => ({ updatedBy: "user-1" }), record: async (...args) => audits.push(args) });
  return { service, writes, reads, audits };
}

test("重新生成已过期台账时按员工日报刷新生产工资并回到草稿（重复登记后的重算路径）", async () => {
  const reports = [
    report({ id: "report-1", productionOrderOperationId: "op-1", operationNameSnapshot: "裁剪", wageMode: "piece_rate", quantity: new Prisma.Decimal("20"), durationMinutes: zero(), calculatedAmount: new Prisma.Decimal("40") }),
    report({ id: "report-2", productionOrderOperationId: "op-2", operationNameSnapshot: "缝制", wageMode: "time_rate", quantity: zero(), durationMinutes: new Prisma.Decimal("90"), calculatedAmount: new Prisma.Decimal("60") }),
  ];
  const { service, writes, reads, audits } = generationFixture("expired", reports);
  const result = await service.generate({ employee_id: "employee-1", period_start: "2026-01-01", period_end: "2026-01-31", currency: "CNY" }, { id: "user-1" });
  assert.equal(writes.length, 1, "重新生成必须刷新台账，而不是原样返回过期数据");
  assert.equal(writes[0].productionSourceAmount.toString(), "100", "生产工资 = 40 + 60");
  assert.equal(writes[0].status, "draft", "刷新后回到草稿等待重新确认");
  // 顺序按「日期 → 订单号 → 工序」排，这里不比全序，只逐工序核对（中文 collation 不该成为断言的一部分）。
  const byOperation = Object.fromEntries(writes[0].sourceSnapshot.map((line) => [line.operation_name, line]));
  assert.deepEqual(Object.keys(byOperation).sort(), ["缝制", "裁剪"], "快照必须逐工序保留，财务才能核对是哪一道工序");
  assert.equal(byOperation["裁剪"].duration_hours, "0", "计件行的时长为 0");
  assert.equal(byOperation["缝制"].duration_hours, "1.5", "90 分钟 = 1.5 小时");
  assert.equal(byOperation["裁剪"].report_count, 1);
  assert.equal(byOperation["裁剪"].report_ids.length, 1, "快照保留日报 ID，可与生产日报逐条对账");
  assert.equal(result.status, "draft");
  assert.equal(audits[0][0], "payroll_ledger.update");
  // 取数只按「员工 + 日期区间 + 未删除」，不做订单/工序预筛 —— 少一个过滤条件就会漏单。
  assert.deepEqual(reads[0].where.employeeId, { in: ["employee-1"] });
  assert.equal(reads[0].where.deletedAt, null);
  assert.equal(reads[0].where.reportDate.gte.toISOString(), "2026-01-01T00:00:00.000Z");
  assert.equal(reads[0].where.reportDate.lte.toISOString(), "2026-01-31T00:00:00.000Z");
  assert.equal(reads[0].where.productionOrderId, undefined, "不得按订单预筛（会漏掉其他订单的工序）");
  assert.equal(reads[0].where.productionOrderOperationId, undefined, "不得按工序预筛（会漏掉其他工序）");
});

test("重新生成草稿台账时同样按日报刷新生产工资（补录后不重新生成就是旧值）", async () => {
  const { service, writes } = generationFixture("draft", [report({ id: "report-1", quantity: new Prisma.Decimal("5"), calculatedAmount: new Prisma.Decimal("12.5") })]);
  await service.generate({ employee_id: "employee-1", period_start: "2026-01-01", period_end: "2026-01-31", currency: "CNY" }, { id: "user-1" });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].productionSourceAmount.toString(), "12.5");
});

test("非车间员工重新生成时生产工资恒为 0（用户要求「非车间员工工资都先为零」）", async () => {
  const reads = [];
  const writes = [];
  const current = ledgerRow({ employeeId: "employee-1" });
  const prisma = {
    employee: { findMany: async () => [{ id: "employee-1", employeeNo: "E101", name: "李四", employeeType: "office" }], findFirst: async () => ({ employeeType: "office" }) },
    employeeDailyReport: { findMany: async (args) => { reads.push(args); return [report({ calculatedAmount: new Prisma.Decimal("999") })]; } },
    payrollLedger: { findFirst: async () => current, update: async ({ data }) => { writes.push(data); return { ...current, ...data }; } },
  };
  prisma.$transaction = async (fn) => fn({ $queryRaw: async () => [], payrollLedger: prisma.payrollLedger, employee: prisma.employee, payrollPayableEntry: { findFirst: async () => null } });
  const service = new PayrollLedgerService(prisma, { create: () => ({}), update: () => ({}), record: async () => {} });
  const result = await service.generate({ employee_id: "employee-1", period_start: "2026-01-01", period_end: "2026-01-31", currency: "CNY" }, { id: "user-1" });
  assert.equal(writes.length, 1, "草稿台账仍要刷新（其他类目可能变过）");
  assert.equal(writes[0].productionSourceAmount.toString(), "0", "非车间员工的生产工资恒为 0");
  assert.deepEqual(writes[0].sourceSnapshot, []);
  assert.equal(reads.length, 0, "非车间员工不读日报");
  assert.equal(result.productionSourceAmount.toString(), "0");
});

test("重新生成已确认台账绝不自动改写金额（已确认工资必须由人工回退或调整单处理）", async () => {
  const { service, writes } = generationFixture("confirmed", [report({ id: "report-1", calculatedAmount: new Prisma.Decimal("999") })]);
  const result = await service.generate({ employee_id: "employee-1", period_start: "2026-01-01", period_end: "2026-01-31", currency: "CNY" }, { id: "user-1" });
  assert.equal(writes.length, 0, "已确认台账不得被静默改写");
  assert.equal(result.status, "confirmed");
  assert.equal(result.productionSourceAmount.toString(), "10");
});

test("重新生成已付款台账不做任何改写", async () => {
  const { service, writes } = generationFixture("paid", [report({ id: "report-1", calculatedAmount: new Prisma.Decimal("999") })]);
  const result = await service.generate({ employee_id: "employee-1", period_start: "2026-01-01", period_end: "2026-01-31", currency: "CNY" }, { id: "user-1" });
  assert.equal(writes.length, 0);
  assert.equal(result.status, "paid");
});


test("payroll ledger list applies period overlap and computes payable/paid/outstanding", async () => {
  let captured;
  const row = ledgerRow({
    periodStart: new Date("2026-01-01"),
    periodEnd: new Date("2026-01-31"),
    baseSalary: new Prisma.Decimal("100"),
    productionSourceAmount: new Prisma.Decimal("50"),
    attendanceDeduction: new Prisma.Decimal("5"),
    adjustments: [{ status: "posted", effect: "increase", amount: new Prisma.Decimal("10") }],
    allocations: [
      { status: "active", amount: new Prisma.Decimal("20"), payment: { status: "posted" } },
      { status: "active", amount: new Prisma.Decimal("100"), payment: { status: "draft" } },
    ],
    employee: { id: "employee-1" },
  });
  const prisma = { payrollLedger: { findMany: async (args) => { captured = args; return [row]; } } };
  const service = new PayrollLedgerService(prisma, {});
  const result = await service.list(undefined, undefined, undefined, undefined, "2026-01-01", "2026-01-31");
  assert.ok(captured.where.AND);
  assert.equal(result[0].payableAmount, "155.0000");
  assert.equal(result[0].paidAmount, "20.0000");
  assert.equal(result[0].outstandingAmount, "135.0000");
});

// 表格只显示六个可编辑类目 + 两个只读格（基本工资、其他增减），因此这两个只读格必须由后端算：
// 前端各算一遍就会出现「表上可见列之和 ≠ 应发」。
test("列表返回「基本工资」与「其他增减」两格的显示值，且与应发闭合", async () => {
  const row = ledgerRow({
    baseSalary: new Prisma.Decimal("100"),
    productionSourceAmount: new Prisma.Decimal("50"),
    performanceAmount: new Prisma.Decimal("30"),
    housingAllowance: new Prisma.Decimal("40"),
    lateDeduction: new Prisma.Decimal("10"),
    absenceDeduction: new Prisma.Decimal("20"),
    earlyLeaveDeduction: new Prisma.Decimal("5"),
    overtimeAmount: new Prisma.Decimal("7"),
    attendanceDeduction: new Prisma.Decimal("3"),
    allowanceAmount: new Prisma.Decimal("2"),
    socialInsurance: new Prisma.Decimal("1"),
    individualTax: new Prisma.Decimal("4"),
    otherAdjustment: new Prisma.Decimal("6"),
    adjustments: [{ status: "posted", effect: "increase", amount: new Prisma.Decimal("9") }],
    employee: { id: "employee-1" },
  });
  const service = new PayrollLedgerService({ payrollLedger: { findMany: async () => [row] } }, {});
  const result = (await service.list())[0];
  assert.equal(result.basicSalaryAmount, "150.0000", "基本工资格 = 基本工资 + 生产来源（车间生产工资）");
  assert.equal(result.otherAdjustmentAmount, "16.0000", "其他增减 = 加班 7 − 考勤 3 + 补贴 2 − 社保 1 − 个税 4 + 其他 6 + 已过账调整 9 = 16");
  // 六个可编辑类目（基本工资 150 + 绩效 30 + 房补 40 − 迟到 10 − 旷工 20 − 早退 5）与只读格必须正好等于应发。
  const visible = new Prisma.Decimal("150").plus("30").plus("40").minus("10").minus("20").minus("5").plus(result.otherAdjustmentAmount);
  assert.ok(visible.eq(result.payableAmount), `表上可见列之和 ${visible} 必须等于应发 ${result.payableAmount}`);
  assert.equal(result.payableAmount, "201.0000");
});

test("payroll ledger with a confirmed payroll payable cannot reopen", async () => {
  let updateCount = 0;
  const row = ledgerRow({ status: "confirmed" });
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

// ------------------------------------------------------------------ 车间工人的基本工资不允许手工填

/** 车间/非车间员工的更新替身：能落到 update 分支。 */
function updateFixture(employeeType, currentOverrides = {}) {
  const writes = [];
  const current = ledgerRow({ employeeId: "employee-1", ...currentOverrides });
  const prisma = {
    payrollLedger: { findFirst: async () => current, update: async ({ data }) => { writes.push(data); return { ...current, ...data }; } },
    employee: { findFirst: async () => ({ id: "employee-1", employeeType }) },
    employeeDailyReport: { findMany: async () => [] },
  };
  prisma.$transaction = async (fn) => fn({ $queryRaw: async () => [], payrollLedger: prisma.payrollLedger, employee: prisma.employee, payrollPayableEntry: { findFirst: async () => null } });
  const service = new PayrollLedgerService(prisma, { create: () => ({}), update: () => ({}), record: async () => {} });
  return { service, writes };
}

test("车间工人的基本工资由生产日报自动汇总：手工改成非零被 422 拒绝", async () => {
  const { service, writes } = updateFixture("workshop");
  await assert.rejects(
    () => service.update("ledger-1", { base_salary: "3000" }, { id: "user-1" }),
    (error) => error.getResponse().code === "PAYROLL_BASE_SALARY_MANAGED",
  );
  assert.equal(writes.length, 0, "被拒绝时不得落任何写入");
});

test("车间工人可以被清零（历史数据要留一条清理路），非车间工人的基本工资照常可改", async () => {
  const workshop = updateFixture("workshop");
  await workshop.service.update("ledger-1", { base_salary: "0" }, { id: "user-1" });
  assert.equal(workshop.writes.length, 1);
  assert.equal(workshop.writes[0].baseSalary.toString(), "0");
  const office = updateFixture("office");
  await office.service.update("ledger-1", { base_salary: "3000" }, { id: "user-1" });
  assert.equal(office.writes[0].baseSalary.toString(), "3000");
});

test("车间工人提交与当前值相同的基本工资不算修改（整体提交表单不该被守卫误伤）", async () => {
  const { service, writes } = updateFixture("workshop", { baseSalary: new Prisma.Decimal("5000") });
  await service.update("ledger-1", { base_salary: "5000" }, { id: "user-1" });
  assert.equal(writes.length, 1);
});

test("新增类目可以通过 PATCH 逐格写入（绩效/房补/迟到/旷工/早退）", async () => {
  const { service, writes } = updateFixture("office");
  await service.update("ledger-1", { performance_amount: "300", housing_allowance: "400", late_deduction: "10", absence_deduction: "20", early_leave_deduction: "5" }, { id: "user-1" });
  assert.equal(writes[0].performanceAmount.toString(), "300");
  assert.equal(writes[0].housingAllowance.toString(), "400");
  assert.equal(writes[0].lateDeduction.toString(), "10");
  assert.equal(writes[0].absenceDeduction.toString(), "20");
  assert.equal(writes[0].earlyLeaveDeduction.toString(), "5");
  // 没提交的类目保持原值（表格逐格保存，不能把整行清成 0）
  assert.equal(writes[0].socialInsurance.toString(), "0");
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
  const row = ledgerRow({ adjustments: [], allocations: [], employee: { id: "employee-1", department: { id: "dep-1", name: "生产部" }, position: { id: "pos-1", name: "缝制工" } } });
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
  const row = ledgerRow({
    status: "partially_paid",
    adjustments: [{ status: "posted", effect: "decrease", amount: new Prisma.Decimal("5") }],
    allocations: [{ status: "active", amount: new Prisma.Decimal("20"), payment: { status: "posted" } }],
    baseSalary: new Prisma.Decimal("100"),
  });
  const prisma = { payrollLedger: { findFirst: async () => row } };
  const service = new PayrollLedgerService(prisma, {});
  const result = await service.get("ledger-1");
  assert.equal(result.payableAmount, "95.0000");
  assert.equal(result.paidAmount, "20.0000");
  assert.equal(result.outstandingAmount, "75.0000");
});

// ------------------------------------------------------------------ 按月导入全部员工

/** importMonth 的替身：员工、既有台账、日报、createMany 全部可注入。 */
function importFixture({ employees, existing = [], reports = [] }) {
  const writes = [];
  const reportReads = [];
  const audits = [];
  const prisma = {
    employee: {
      count: async () => employees.count ?? employees.list.length,
      findMany: async () => employees.list,
    },
    payrollLedger: {
      findMany: async () => existing,
      createMany: async ({ data }) => { writes.push(...data); return { count: data.length }; },
    },
    employeeDailyReport: { findMany: async (args) => { reportReads.push(args); return reports; } },
  };
  const audit = { create: () => ({ createdBy: "user-1", updatedBy: "user-1" }), record: async (...args) => audits.push(args) };
  const service = new PayrollLedgerService(prisma, audit);
  return { service, writes, reportReads, audits };
}

const workshopEmployee = { id: "employee-1", employeeNo: "E-001", name: "张三", employeeType: "workshop" };
const officeEmployee = { id: "employee-2", employeeNo: "E-101", name: "李四", employeeType: "office" };

test("按月导入：新建全部缺失员工的草稿台账，车间带生产工资、非车间为 0", async () => {
  const reports = [
    report({ id: "r1", employeeId: "employee-1", reportDate: new Date("2026-09-01T00:00:00.000Z"), productionOrderId: "order-1", orderNo: "SO-1", productionOrderOperationId: "op-1", operationNameSnapshot: "裁剪", calculatedAmount: new Prisma.Decimal("40") }),
    report({ id: "r2", employeeId: "employee-1", reportDate: new Date("2026-09-02T00:00:00.000Z"), productionOrderId: "order-1", orderNo: "SO-1", productionOrderOperationId: "op-1", operationNameSnapshot: "裁剪", wageMode: "time_rate", quantity: zero(), durationMinutes: new Prisma.Decimal("90"), calculatedAmount: new Prisma.Decimal("60") }),
    report({ id: "r3", employeeId: "employee-1", reportDate: new Date("2026-09-02T00:00:00.000Z"), productionOrderId: "order-2", orderNo: "SO-2", productionOrderOperationId: "op-9", operationNameSnapshot: "包装", calculatedAmount: new Prisma.Decimal("25") }),
  ];
  const { service, writes, audits } = importFixture({ employees: { list: [workshopEmployee, officeEmployee] }, reports });
  const result = await service.importMonth({ month: "2026-09" }, { id: "user-1" });
  assert.equal(result.created, 2);
  assert.equal(result.candidates, 2);
  assert.equal(result.existing, 0);
  assert.equal(result.not_employed, 0);
  assert.equal(result.period_start, "2026-09-01");
  assert.equal(result.period_end, "2026-09-30");
  assert.equal(writes.length, 2, "每个缺失员工一条草稿台账");
  const workshopRow = writes.find((row) => row.employeeId === "employee-1");
  const officeRow = writes.find((row) => row.employeeId === "employee-2");
  assert.equal(workshopRow.productionSourceAmount.toString(), "125", "车间生产工资 = 40 + 60 + 25（跨订单跨工序跨日期全部计入）");
  assert.equal(workshopRow.baseSalary.toString(), "0", "车间的基本工资由生产工资承担，导入时留 0");
  assert.equal(workshopRow.status, undefined, "状态交给数据库默认 draft");
  assert.equal(officeRow.productionSourceAmount.toString(), "0", "非车间员工工资先为零");
  assert.equal(officeRow.sourceSnapshot.length, 0);
  assert.equal(workshopRow.sourceSnapshot.length, 3, "快照逐「日期 × 生产单 × 工序 × 计薪方式」一行，财务可逐条核对");
  assert.deepEqual(workshopRow.sourceSnapshot.map((line) => line.report_date), ["2026-09-01", "2026-09-02", "2026-09-02"]);
  assert.deepEqual(workshopRow.sourceSnapshot.map((line) => line.operation_name), ["裁剪", "裁剪", "包装"]);
  // 导入响应同时给出覆盖度计数：这就是「不能漏掉任何一单任何一个工序任何一天」的核对依据。
  const coverage = result.ledgers.find((row) => row.employee_id === "employee-1");
  assert.equal(coverage.production_amount, "125.0000");
  assert.equal(coverage.report_count, 3);
  assert.equal(coverage.day_count, 2);
  assert.equal(coverage.order_count, 2);
  assert.equal(coverage.operation_count, 2);
  assert.equal(result.report_count, 3);
  assert.equal(audits[0][0], "payroll_ledger.import_month");
  assert.equal(audits[0][4].created, 2);
});

test("按月导入是幂等的：已存在（含已确认/已软删/跨月自定义期间）的台账一律不重建，也不读日报", async () => {
  const existing = [
    { employeeId: "employee-1", ledgerNo: "PAYROLL-A", status: "confirmed", periodStart: new Date("2026-09-01T00:00:00.000Z"), periodEnd: new Date("2026-09-30T00:00:00.000Z"), deletedAt: null },
    { employeeId: "employee-2", ledgerNo: "PAYROLL-B", status: "draft", periodStart: new Date("2026-09-01T00:00:00.000Z"), periodEnd: new Date("2026-09-15T00:00:00.000Z"), deletedAt: null },
  ];
  const { service, writes, reportReads, audits } = importFixture({ employees: { list: [workshopEmployee, officeEmployee] }, existing });
  const result = await service.importMonth({ month: "2026-09" }, { id: "user-1" });
  assert.equal(result.created, 0);
  assert.equal(result.existing, 2);
  assert.equal(writes.length, 0, "重复导入同一月份必须零写入");
  assert.equal(reportReads.length, 0, "没有缺失员工时不得再读日报");
  assert.equal(audits.length, 0, "没有新建就不写导入审计");
  assert.deepEqual(result.skipped.map((row) => row.ledger_no), ["PAYROLL-A", "PAYROLL-B"]);
});

test("软删除过的台账不会被自动导入复活（唯一索引把软删行也算在内）", async () => {
  const existing = [{ employeeId: "employee-1", ledgerNo: "PAYROLL-DEL", status: "draft", periodStart: new Date("2026-09-01T00:00:00.000Z"), periodEnd: new Date("2026-09-30T00:00:00.000Z"), deletedAt: new Date("2026-09-10T00:00:00.000Z") }];
  const { service, writes } = importFixture({ employees: { list: [workshopEmployee], }, existing });
  const result = await service.importMonth({ month: "2026-09" }, { id: "user-1" });
  assert.equal(result.created, 0);
  assert.equal(writes.length, 0, "软删行占着唯一索引，重建会 500，必须跳过");
  assert.equal(result.skipped[0].status, "deleted");
});

test("月前已离职的员工不导入，但会计数并回传（不静默丢弃）", async () => {
  const { service } = importFixture({ employees: { count: 5, list: [workshopEmployee, officeEmployee] } });
  const result = await service.importMonth({ month: "2026-09" }, { id: "user-1" });
  assert.equal(result.candidates, 2);
  assert.equal(result.not_employed, 3, "该月不在职的人单独计数，界面要能提示");
});

test("导入时的部门/岗位/员工类型条件透传到员工查询，币种跟随字典校验", async () => {
  const captured = [];
  const prisma = {
    employee: { count: async () => 0, findMany: async (args) => { captured.push(args); return []; } },
    payrollLedger: { findMany: async () => [], createMany: async () => ({ count: 0 }) },
    employeeDailyReport: { findMany: async () => [] },
  };
  const currencies = { assertSupported: async (value) => { assert.equal(value, "USD"); } };
  const service = new PayrollLedgerService(prisma, { create: () => ({}), record: async () => {} }, currencies);
  const result = await service.importMonth({ month: "2026-09", department_id: "dep-1", position_id: "pos-1", employee_type: "workshop", currency: "USD" }, { id: "user-1" });
  assert.equal(result.currency, "USD");
  assert.equal(captured[0].where.departmentId, "dep-1");
  assert.equal(captured[0].where.positionId, "pos-1");
  assert.equal(captured[0].where.employeeType, "workshop");
  assert.equal(captured[0].where.deletedAt, null);
  // 任职区间与该月有交集：月初已离职的人不能出现在候选里
  assert.equal(captured[0].where.AND[0].OR[0].hiredOn, null);
  assert.equal(captured[0].where.AND[1].OR[0].leftOn, null);
});

test("按月导入拒绝非法月份，车间生产工资合计超限时 422（不落到数据库报 500）", async () => {
  const { service } = importFixture({ employees: { list: [workshopEmployee] } });
  await assert.rejects(() => service.importMonth({ month: "2026/09" }, { id: "user-1" }), (error) => error.getResponse().code === "INVALID_MONTH");
  const huge = importFixture({ employees: { list: [workshopEmployee] }, reports: [report({ calculatedAmount: new Prisma.Decimal("1e15") })] });
  await assert.rejects(() => huge.service.importMonth({ month: "2026-09" }, { id: "user-1" }), (error) => error.getResponse().code === "PAYROLL_LEDGER_AMOUNT_OUT_OF_RANGE");
});
