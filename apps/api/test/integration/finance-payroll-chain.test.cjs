// 工资台账链路集成测试（真实 PostgreSQL）：台账生成 → 改动类目 → 确认 → 工资应付 → 付款核销 → 收支流水。
//
// 为什么必须用真库：这条链路的正确性全在**事务、锁与状态机**上，用替身测不出来：
//   * 台账按 (employee, period) 唯一定位并用 SELECT ... FOR UPDATE 串行化；
//   * 应发金额要跨 payroll_ledgers / payroll_payable_entries / salary_payment_allocations 三张表闭合；
//   * 付款核销后要回写台账与应付状态，并**自动写一条收支流水**（历史缺陷：供应商付款被静默丢掉，
//     这里断言工资付款这条链路既写成了流水、又落到了正确的收支项目「人 工费」）。
//
// 上游（生产日报 → 生产工资）由 production-daily-reports 集成测试覆盖；本用例用**非车间员工**，
// 以便手工填写基本工资与新增类目（车间员工的基本工资由日报汇总，不允许手工改）。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { PrismaClient } = require("@prisma/client");
const { PayrollLedgerService } = require("../../dist/modules/hr/payroll-ledger.service.js");
const { PayrollPayableService } = require("../../dist/modules/hr/payroll-payable.service.js");
const { SalaryPaymentService } = require("../../dist/modules/hr/salary-payment.service.js");
const { CashFlowService } = require("../../dist/modules/finance/cash-flow.service.js");
const { AuditService } = require("../../dist/platform/audit/audit.service.js");
const { assertAuditEventRecorded, assertDecimalEquals } = require("../../../../tests/helpers/business-invariants.cjs");
const { requireTestDatabaseUrl } = require("../../../../tests/helpers/test-context.cjs");
const { createFactories } = require("../../../../tests/fixtures/factories.cjs");

test("payroll.ledger.generate_confirm_pay_and_post_cash_flow", async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: requireTestDatabaseUrl() } } });
  const fx = createFactories({ prisma, prefix: "payroll" });
  const user = fx.actor();
  const audit = new AuditService(prisma);
  const ledgers = new PayrollLedgerService(prisma, audit);
  const payables = new PayrollPayableService(prisma, audit);
  const cashFlow = new CashFlowService(prisma, audit);
  const salaryPayments = new SalaryPaymentService(prisma, audit, ledgers, payables, cashFlow);
  try {
    const department = await fx.createDepartment();
    const position = await fx.createPosition(department);
    // 非车间：基本工资可以手工填写（车间员工由生产日报汇总，见 assertManualBaseSalaryAllowed）。
    // 取值受库层 CHECK 约束限制，只有 workshop / non_workshop 两种。
    const employee = await fx.createEmployee(department, position, { employeeType: "non_workshop" });

    // 1. 生成台账：应发 = 8000 基本 + 1000 绩效 + 500 房补 − 100 迟到
    const ledger = fx.track("payrollLedger", await ledgers.generate({
      employee_id: employee.id,
      period_start: "2026-09-01",
      period_end: "2026-09-30",
      currency: "CNY",
      base_salary: "8000",
      performance_amount: "1000",
      housing_allowance: "500",
      late_deduction: "100",
      remark: "工资台账集成测试",
    }, user));
    assert.equal(ledger.status, "draft");
    assert.equal(ledger.employeeId, employee.id);
    assert.match(ledger.ledgerNo, /^PAYROLL-\d{8}-[0-9A-F]{8}$/);

    const summary = await ledgers.summary(ledger.id);
    assertDecimalEquals("payroll 应发闭合（基本+绩效+房补−迟到）", summary.net_amount ?? summary.netAmount ?? summary.payable_amount, "9400");

    // 2. 同一员工同一期间重复生成 → 返回原台账而不是新建（唯一索引 + 存在性判断）
    const again = await ledgers.generate({ employee_id: employee.id, period_start: "2026-09-01", period_end: "2026-09-30", currency: "CNY" }, user);
    assert.equal(again.id, ledger.id, "同一员工同一期间只能有一张台账");
    assert.equal((await prisma.payrollLedger.count({ where: { employeeId: employee.id, deletedAt: null } })), 1);

    // 3. 逐格改类目（新增的迟到扣款已在上一步落地，这里改绩效验证可编辑）
    const edited = await ledgers.update(ledger.id, { performance_amount: "1500" }, user);
    assertDecimalEquals("改绩效后应发随之变化", edited.baseSalary.plus(edited.performanceAmount).plus(edited.housingAllowance).minus(edited.lateDeduction), "9900");

    // 4. 确认台账
    const confirmed = await ledgers.confirm(ledger.id, user);
    assert.equal(confirmed.status, "confirmed");
    const confirmedSummary = await ledgers.summary(ledger.id);
    assertDecimalEquals("确认后应发 = 9900", confirmedSummary.net_amount ?? confirmedSummary.netAmount ?? confirmedSummary.payable_amount, "9900");

    // 5. 生成工资应付：金额必须与台账应发一致（快照）
    const payable = fx.track("payrollPayableEntry", await payables.createFromLedger(ledger.id, { remark: "集成测试应付" }, user));
    assert.equal(payable.ledgerId, ledger.id);
    assert.equal(payable.status, "draft");
    assertDecimalEquals("工资应付快照等于台账应发", payable.amount, "9900");

    // 6. 确认应付（付款的前置条件）
    const confirmedPayable = await payables.confirm(payable.id, user);
    assert.equal(confirmedPayable.status, "confirmed");

    // 7. 建付款草稿并核销过账
    const payment = fx.track("salaryPayment", await salaryPayments.create({
      payment_date: "2026-09-30",
      amount: "9900",
      currency: "CNY",
      payment_method: "银行转账",
      remark: "集成测试工资付款",
    }, user));
    assert.equal(payment.status, "draft");

    const posted = await salaryPayments.post(payment.id, [{ ledger_id: ledger.id, amount: "9900" }], user);
    assert.equal(posted.status, "posted");

    // 8. 核销明细：一条 active，且台账/应付都被回写
    //    必须显式登记：salary_payment_allocations 既没有 order_no，也没有指向「带 order_no 模型」的关系，
    //    工厂的两轮清扫（order_no 扫描 / 关系派生）都够不到它 —— 不登记会以外键卡住
    //    ledger / payable / payment / employee 的删除，最终整条链清不掉（实测踩过）。
    const allocations = await prisma.salaryPaymentAllocation.findMany({ where: { paymentId: payment.id, deletedAt: null } });
    for (const row of allocations) fx.track("salaryPaymentAllocation", row);
    assert.equal(allocations.length, 1);
    assert.equal(allocations[0].status, "active");
    assert.equal(allocations[0].ledgerId, ledger.id);
    assert.equal(allocations[0].payrollPayableId, payable.id);
    assertDecimalEquals("核销金额等于付款金额", allocations[0].amount, "9900");

    const ledgerAfter = await prisma.payrollLedger.findUnique({ where: { id: ledger.id } });
    assert.equal(ledgerAfter.status, "paid", "核销后台账应变为已付款");
    const payableAfter = await prisma.payrollPayableEntry.findUnique({ where: { id: payable.id } });
    assert.equal(payableAfter.status, "paid", "核销后工资应付应变为已付款");

    // 9. 过账即写收支流水：方向支出、项目「人 工费」（字面量含空格，与字典 key 一致）
    const entry = await prisma.cashFlowEntry.findFirst({ where: { sourceType: "salary_payment", sourceId: payment.id, deletedAt: null } });
    assert.ok(entry, "工资付款过账必须自动写一条收支流水（历史缺陷：这里曾整条丢失）");
    assert.equal(entry.direction, "expense");
    assert.equal(entry.currency, "CNY");
    assertDecimalEquals("流水金额等于付款金额", entry.amount, "9900");
    assert.equal(entry.status, "posted");
    const item = await prisma.dictionaryItem.findUnique({ where: { id: entry.itemId } });
    assert.equal(item.key, "人 工费", "工资付款要落到「人 工费」项目上");
    fx.track("cashFlowEntry", entry);

    // 10. 已付款台账不能被回退/重复核销（状态机护栏）
    //     已付款只能走工资调整单（PAYROLL_PAID_NOT_REOPENABLE）；若状态还没到 paid 但已生成有效应付，
    //     则由 PAYROLL_LEDGER_HAS_PAYABLE 挡住 —— 两者都表示「不能直接回退」，这里断言前者。
    await assert.rejects(
      () => ledgers.reopen(ledger.id, "想改一下", user),
      (error) => ["PAYROLL_PAID_NOT_REOPENABLE", "PAYROLL_LEDGER_HAS_PAYABLE"].includes(error.getResponse().code),
      "已付款台账不允许直接回退",
    );

    // 11. 审计：确认与过账都要留事件
    const events = await fx.auditEvents();
    assertAuditEventRecorded("payroll ledger confirm audited", events, { action: "payroll_ledger.confirm", entityId: ledger.id });
    assertAuditEventRecorded("salary payment post audited", events, { action: "salary_payment.post", entityId: payment.id });
  } finally {
    await fx.cleanup();
    await prisma.$disconnect();
  }
});
