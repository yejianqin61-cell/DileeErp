import { Injectable, NotFoundException, UnprocessableEntityException, Optional } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { AuditService } from "../../platform/audit/audit.service";
import type { CurrentUser } from "../../platform/auth/auth.service";
import { CurrencyService } from "../../platform/currency/currency.service";
import { PrismaService } from "../../platform/database/prisma.service";
import { canReopenPayroll, monthRange, payrollBaseAmount, payrollBasicSalaryAmount, payrollOtherAdjustmentAmount, type PayrollAmountFields } from "./hr-payroll.domain";
import { aggregateProductionPayroll, emptyProductionPayroll, groupProductionPayroll, type PayrollDailyReport, type ProductionPayrollSummary } from "./production-payroll.domain";

/** 台账行上的 13 个类目金额（Prisma 行，camelCase）。 */
type LedgerAmounts = {
  baseSalary: Prisma.Decimal;
  productionSourceAmount: Prisma.Decimal;
  overtimeAmount: Prisma.Decimal;
  attendanceDeduction: Prisma.Decimal;
  lateDeduction: Prisma.Decimal;
  absenceDeduction: Prisma.Decimal;
  earlyLeaveDeduction: Prisma.Decimal;
  performanceAmount: Prisma.Decimal;
  allowanceAmount: Prisma.Decimal;
  housingAllowance: Prisma.Decimal;
  socialInsurance: Prisma.Decimal;
  individualTax: Prisma.Decimal;
  otherAdjustment: Prisma.Decimal;
};

/** 可写的类目字段（DTO 同名，snake_case）。 */
type CategoryInput = Partial<{
  base_salary: string;
  overtime_amount: string;
  attendance_deduction: string;
  late_deduction: string;
  absence_deduction: string;
  early_leave_deduction: string;
  performance_amount: string;
  allowance_amount: string;
  housing_allowance: string;
  social_insurance: string;
  individual_tax: string;
  other_adjustment: string;
}>;

@Injectable()
export class PayrollLedgerService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, @Optional() private readonly currencies?: CurrencyService) {}
  /**
   * 工资台账列表。
   *
   * 工资管理页要按「月 + 部门 + 岗位」筛选（客户要求），因此除既有的员工/期间/状态外，
   * 追加 month（按自然月，与 from/to 同为"期间有交集"语义）、department_id、position_id、employee_type。
   * 返回值同时带上部门与岗位（原先只有 departmentId/positionId，前端拿不到名字也就筛不了）。
   * 2026-09-15 起还带上「基本工资」与「其他增减」两格的显示值，口径见 balances()。
   */
  async list(employeeId?: string, periodStart?: string, periodEnd?: string, status?: string, from?: string, to?: string, month?: string, departmentId?: string, positionId?: string, employeeType?: string) {
    const where: Prisma.PayrollLedgerWhereInput = { deletedAt: null };
    if (employeeId) where.employeeId = employeeId;
    if (periodStart) where.periodStart = this.date(periodStart);
    if (periodEnd) where.periodEnd = this.date(periodEnd);
    if (status) where.status = status;
    // 期间筛选与 from/to 同口径：只要台账期间与所选区间有交集就算命中，不是"完全落在区间内"。
    const range = month ? monthRange(month) : (from || to ? { from: from ? this.date(from) : undefined, to: to ? this.date(to) : undefined } : undefined);
    if (range) where.AND = [...(range.to ? [{ periodStart: { lte: range.to } }] : []), ...(range.from ? [{ periodEnd: { gte: range.from } }] : [])];
    const employeeWhere: Prisma.EmployeeWhereInput = { ...(departmentId ? { departmentId } : {}), ...(positionId ? { positionId } : {}), ...(employeeType ? { employeeType } : {}) };
    if (Object.keys(employeeWhere).length) where.employee = employeeWhere;
    const rows = await this.prisma.payrollLedger.findMany({
      where,
      include: { employee: { include: { department: true, position: true } }, adjustments: { where: { deletedAt: null } }, allocations: { where: { deletedAt: null }, include: { payment: true } } },
      orderBy: { periodStart: "desc" },
    });
    return rows.map((row) => ({ ...row, ...this.balances(row) }));
  }
  async get(id: string) { const row = await this.prisma.payrollLedger.findFirst({ where: { id, deletedAt: null }, include: { employee: { include: { department: true, position: true } }, adjustments: { where: { deletedAt: null } }, allocations: { where: { deletedAt: null }, include: { payment: true } } } }); if (!row) throw this.notFound("PAYROLL_LEDGER_NOT_FOUND", "薪资台账不存在"); return { ...row, ...this.balances(row) }; }
  async generate(input: { employee_id?: string; employee_name?: string; period_start: string; period_end: string; currency: string; attachment?: unknown[]; remark?: string } & CategoryInput, user: CurrentUser) {
    await this.currencies?.assertSupported(input.currency, "工资台账币种");
    const start = this.date(input.period_start); const end = this.date(input.period_end); if (end < start) throw this.invalid("INVALID_PAYROLL_PERIOD", "薪资期间无效");
    if (!input.employee_id && !input.employee_name?.trim()) throw this.invalid("EMPLOYEE_REQUIRED", "请选择员工姓名");
    const employees = await this.prisma.employee.findMany({ where: input.employee_id ? { id: input.employee_id, deletedAt: null } : { name: input.employee_name!.trim(), deletedAt: null }, orderBy: { employeeNo: "asc" } });
    if (!employees.length) throw this.notFound("EMPLOYEE_NOT_FOUND", "员工不存在");
    if (!input.employee_id && employees.length > 1) throw this.invalid("EMPLOYEE_NAME_AMBIGUOUS", "存在同名员工，请选择具体工号", employees.map((item) => ({ employee_id: item.id, employee_no: item.employeeNo, name: item.name, employee_type: item.employeeType })));
    const employee = employees[0];
    this.assertManualBaseSalaryAllowed(employee.employeeType, input.base_salary, new Prisma.Decimal(0));
    const sourceData = await this.collectProductionSources(employee.id, start, end);
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM employees WHERE id = ${employee.id}::uuid FOR UPDATE`;
      const existing = await tx.payrollLedger.findFirst({ where: { employeeId: employee.id, periodStart: start, periodEnd: end, deletedAt: null } });
      if (existing) return { row: existing, created: false };
      return { row: await tx.payrollLedger.create({ data: { ledgerNo: this.number("PAYROLL"), employeeId: employee.id, periodStart: start, periodEnd: end, currency: input.currency, baseSalary: this.dec(input.base_salary), productionSourceAmount: sourceData.production, overtimeAmount: this.dec(input.overtime_amount), attendanceDeduction: this.dec(input.attendance_deduction), lateDeduction: this.dec(input.late_deduction), absenceDeduction: this.dec(input.absence_deduction), earlyLeaveDeduction: this.dec(input.early_leave_deduction), performanceAmount: this.dec(input.performance_amount), allowanceAmount: this.dec(input.allowance_amount), housingAllowance: this.dec(input.housing_allowance), socialInsurance: this.dec(input.social_insurance), individualTax: this.dec(input.individual_tax), otherAdjustment: this.dec(input.other_adjustment), sourceSnapshot: sourceData.snapshot, attachment: (input.attachment ?? []) as Prisma.InputJsonValue, remark: input.remark, ...this.audit.create(user) } }), created: true };
    });
    if (result.created) await this.audit.record("payroll_ledger.create", "payroll_ledger", user.id, result.row.id, { employee_id: result.row.employeeId, period_start: input.period_start, period_end: input.period_end, production_source_amount: sourceData.production.toString() });
    // 同一员工同一天允许重复登记多条生产日报，补录/重复登记后会重算薪资来源金额，并把已确认台账自动置为 expired。
    // 此时“重新生成”必须把生产来源金额刷新到最新（并回到草稿），否则接口会把过期金额原样返回、
    // 让操作员误以为已重新核算。已确认、部分支付、已支付、已关闭的台账绝不自动改写。
    // 行为变化：若该台账已生成有效工资应付，刷新会被 update() 以 PAYROLL_LEDGER_HAS_PAYABLE 拒绝
    // （以前是原样返回旧台账），因为应付金额是按旧的生产来源算出来的，必须先回退或冲销应付。
    if (!result.created && ["draft", "expired"].includes(result.row.status)) {
      const beforeStatus = result.row.status;
      const beforeAmount = result.row.productionSourceAmount.toString();
      const refreshed = await this.update(result.row.id, {}, user);
      // update() 自己的审计只有状态变化，这里补一条带金额差的重算审计，便于财务对账。
      await this.audit.record("payroll_ledger.refresh_from_production", "payroll_ledger", user.id, result.row.id, { employee_id: result.row.employeeId, before_status: beforeStatus, after_status: refreshed.status, before_production_source_amount: beforeAmount, after_production_source_amount: refreshed.productionSourceAmount.toString() });
      return refreshed;
    }
    return result.row;
  }

  /**
   * 按月导入全部员工（用户要求：每个月自动先导入全部员工）。
   *
   * 规则：
   *   - 幂等：只新建**缺失**的草稿台账；已存在（含已确认/已付款/已软删、以及与该月有交集的非自然月台账）
   *     一律不碰，因此重复访问同一月份是零写入、零日报读取；
   *   - 车间员工：该月全部生产日报按「天 × 生产单 × 工序 × 计薪方式」汇总成生产工资，写进
   *     production_source_amount，并把逐行明细写进 source_snapshot（财务可逐单逐工序逐日核对）；
   *   - 非车间员工：金额全部为 0（用户要求「非车间员工工资都先为零」），由财务在表格里手工填写；
   *   - 月前已离职的人不导入，但会在 not_employed 里计数并回传，不静默丢弃。
   */
  async importMonth(input: { month: string; department_id?: string; position_id?: string; employee_type?: string; currency?: string }, user: CurrentUser) {
    const { from, to } = monthRange(input.month);
    const currency = input.currency ?? "CNY";
    await this.currencies?.assertSupported(currency, "工资台账币种");
    const scope: Prisma.EmployeeWhereInput = {
      deletedAt: null,
      ...(input.department_id ? { departmentId: input.department_id } : {}),
      ...(input.position_id ? { positionId: input.position_id } : {}),
      ...(input.employee_type ? { employeeType: input.employee_type } : {}),
    };
    const [headcount, employees] = await Promise.all([
      this.prisma.employee.count({ where: scope }),
      this.prisma.employee.findMany({
        where: { ...scope, AND: [{ OR: [{ hiredOn: null }, { hiredOn: { lte: to } }] }, { OR: [{ leftOn: null }, { leftOn: { gte: from } }] }] },
        select: { id: true, employeeNo: true, name: true, employeeType: true },
        orderBy: { employeeNo: "asc" },
      }),
    ]);
    // 唯一索引 (employee_id, period_start, period_end) 把软删行也算在内，所以这里连软删一起读：
    // 否则「删掉台账后再导入」会撞唯一索引变成 500。期间有交集的既有台账也不重建，避免同月两条重叠台账。
    const existing = employees.length
      ? await this.prisma.payrollLedger.findMany({
        where: { employeeId: { in: employees.map((item) => item.id) }, periodStart: { lte: to }, periodEnd: { gte: from } },
        select: { employeeId: true, ledgerNo: true, status: true, periodStart: true, periodEnd: true, deletedAt: true },
      })
      : [];
    const existingByEmployee = new Map(existing.map((row) => [row.employeeId, row]));
    const missing = employees.filter((employee) => !existingByEmployee.has(employee.id));
    // 只给缺失的车间员工读日报：重复访问同一月份时既不写库也不读日报。
    const workshopIds = missing.filter((employee) => employee.employeeType === "workshop").map((employee) => employee.id);
    const summaries = workshopIds.length ? groupProductionPayroll(await this.dailyReports(workshopIds, from, to)) : new Map<string, ProductionPayrollSummary>();
    const rows = missing.map((employee) => {
      const summary = summaries.get(employee.id) ?? emptyProductionPayroll(employee.id);
      this.assertStorable(summary.amount);
      return {
        id: randomUUID(),
        ledgerNo: this.number("PAYROLL"),
        employeeId: employee.id,
        periodStart: from,
        periodEnd: to,
        currency,
        baseSalary: new Prisma.Decimal(0),
        productionSourceAmount: summary.amount,
        sourceSnapshot: summary.lines as unknown as Prisma.InputJsonValue,
        updatedAt: new Date(),
        ...this.audit.create(user),
      };
    });
    // skipDuplicates 让并发下重复导入同一月份也不会报错（靠唯一索引兜底）。
    const created = rows.length ? await this.prisma.payrollLedger.createMany({ data: rows, skipDuplicates: true }) : { count: 0 };
    const raced = rows.length - created.count;
    const employeeById = new Map(employees.map((employee) => [employee.id, employee]));
    const notEmployed = headcount - employees.length;
    if (created.count) {
      await this.audit.record("payroll_ledger.import_month", "payroll_ledger", user.id, undefined, {
        month: input.month,
        currency,
        candidates: employees.length,
        created: created.count,
        existing: existing.length + raced,
        not_employed: notEmployed,
        production_amount: rows.reduce((sum, row) => sum.plus(row.productionSourceAmount), new Prisma.Decimal(0)).toString(),
      });
    }
    return {
      month: input.month,
      period_start: from.toISOString().slice(0, 10),
      period_end: to.toISOString().slice(0, 10),
      currency,
      candidates: employees.length,
      created: created.count,
      existing: existing.length + raced,
      not_employed: notEmployed,
      report_count: [...summaries.values()].reduce((sum, item) => sum + item.report_count, 0),
      ledgers: rows.map((row) => {
        const employee = employeeById.get(row.employeeId)!;
        const summary = summaries.get(row.employeeId) ?? emptyProductionPayroll(row.employeeId);
        return { id: row.id, ledger_no: row.ledgerNo, employee_id: row.employeeId, employee_no: employee.employeeNo, employee_name: employee.name, employee_type: employee.employeeType, production_amount: summary.amount.toFixed(4), report_count: summary.report_count, day_count: summary.day_count, order_count: summary.order_count, operation_count: summary.operation_count };
      }),
      skipped: existing.map((row) => {
        const employee = employeeById.get(row.employeeId);
        return { employee_no: employee?.employeeNo ?? "", employee_name: employee?.name ?? "", ledger_no: row.ledgerNo, status: row.deletedAt ? "deleted" : row.status, period_start: row.periodStart.toISOString().slice(0, 10), period_end: row.periodEnd.toISOString().slice(0, 10) };
      }),
    };
  }

  async update(id: string, input: Partial<{ employee_id: string; period_start: string; period_end: string; currency: string; attachment?: unknown[]; remark?: string; reason?: string }> & CategoryInput, user: CurrentUser) {
    await this.currencies?.assertSupported(input.currency, "工资台账币种");
    let beforeStatus = "";
    const row = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM payroll_ledgers WHERE id = ${id}::uuid FOR UPDATE`;
      const current = await tx.payrollLedger.findFirst({ where: { id, deletedAt: null } });
      if (!current) throw this.notFound("PAYROLL_LEDGER_NOT_FOUND", "薪资台账不存在");
      beforeStatus = current.status;
      if (["partially_paid", "paid", "closed"].includes(current.status)) throw this.invalid("PAYROLL_PAID_NOT_EDITABLE", "已支付或已关闭台账不可直接编辑，请使用工资调整单");
      if (current.status === "confirmed" && !input.reason?.trim()) throw this.invalid("CORRECTION_REASON_REQUIRED", "已确认工资台账修改必须填写原因");
        const payable = await tx.payrollPayableEntry.findFirst({ where: { ledgerId: id, deletedAt: null, status: { in: ["draft", "confirmed", "partially_paid", "paid"] } } });
        if (payable) throw this.invalid("PAYROLL_LEDGER_HAS_PAYABLE", "工资台账已生成工资应付，请先回退或冲销工资应付");
      const employeeId = input.employee_id ?? current.employeeId;
      const start = this.date(input.period_start ?? current.periodStart.toISOString().slice(0, 10));
      const end = this.date(input.period_end ?? current.periodEnd.toISOString().slice(0, 10));
      if (end < start) throw this.invalid("INVALID_PAYROLL_PERIOD", "薪资期间无效");
      const employee = await tx.employee.findFirst({ where: { id: employeeId, deletedAt: null } });
      if (!employee) throw this.notFound("EMPLOYEE_NOT_FOUND", "员工不存在");
      this.assertManualBaseSalaryAllowed(employee.employeeType, input.base_salary, current.baseSalary);
      const sourceData = await this.collectProductionSources(employee.id, start, end);
      return tx.payrollLedger.update({ where: { id }, data: { employeeId, periodStart: start, periodEnd: end, currency: input.currency ?? current.currency, baseSalary: input.base_salary ?? current.baseSalary, productionSourceAmount: sourceData.production, overtimeAmount: input.overtime_amount ?? current.overtimeAmount, attendanceDeduction: input.attendance_deduction ?? current.attendanceDeduction, lateDeduction: input.late_deduction ?? current.lateDeduction, absenceDeduction: input.absence_deduction ?? current.absenceDeduction, earlyLeaveDeduction: input.early_leave_deduction ?? current.earlyLeaveDeduction, performanceAmount: input.performance_amount ?? current.performanceAmount, allowanceAmount: input.allowance_amount ?? current.allowanceAmount, housingAllowance: input.housing_allowance ?? current.housingAllowance, socialInsurance: input.social_insurance ?? current.socialInsurance, individualTax: input.individual_tax ?? current.individualTax, otherAdjustment: input.other_adjustment ?? current.otherAdjustment, sourceSnapshot: sourceData.snapshot, attachment: (input.attachment ?? current.attachment) as Prisma.InputJsonValue, remark: input.remark ?? current.remark, status: "draft", ...this.audit.update(user) } });
    });
    await this.audit.record("payroll_ledger.update", "payroll_ledger", user.id, id, { reason: input.reason ?? null, before_status: beforeStatus, after_status: "draft" });
    return row;
  }
  async remove(id: string, user: CurrentUser) { const current = await this.get(id); if (current.status !== "draft") throw this.invalid("PAYROLL_NOT_DELETABLE", "只有草稿台账可以删除"); const result = await this.prisma.$transaction(async (tx) => { await tx.$queryRaw`SELECT id FROM payroll_ledgers WHERE id = ${id}::uuid FOR UPDATE`; const locked = await tx.payrollLedger.findFirst({ where: { id, deletedAt: null } }); if (!locked || locked.status !== "draft") throw this.invalid("PAYROLL_NOT_DELETABLE", "工资台账已被其他操作处理"); return tx.payrollLedger.update({ where: { id }, data: { ...this.audit.softDelete(user) } }); }); return result; }
  async reopen(id: string, reason: string, user: CurrentUser) {
    if (!reason?.trim()) throw this.invalid("CORRECTION_REASON_REQUIRED", "工资台账回退草稿必须填写原因");
    const current = await this.get(id);
    if (current.status === "draft") return current;
    if (!canReopenPayroll(current.status)) throw this.invalid("PAYROLL_PAID_NOT_REOPENABLE", "部分支付、已支付或已关闭台账不可回退，请使用工资调整单");
    const row = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM payroll_ledgers WHERE id = ${id}::uuid FOR UPDATE`;
      const locked = await tx.payrollLedger.findFirst({ where: { id, deletedAt: null } });
      if (!locked || !canReopenPayroll(locked.status)) throw this.invalid("PAYROLL_PAID_NOT_REOPENABLE", "台账已被其他操作处理，当前不可回退");
        const payable = await tx.payrollPayableEntry.findFirst({ where: { ledgerId: id, deletedAt: null, status: { in: ["confirmed", "partially_paid", "paid"] } } });
        if (payable) throw this.invalid("PAYROLL_LEDGER_HAS_PAYABLE", "工资台账已生成有效工资应付，请先回退或冲销工资应付");
      return tx.payrollLedger.update({ where: { id }, data: { status: "draft", ...this.audit.update(user) } });
    });
    await this.audit.record("payroll_ledger.reopen", "payroll_ledger", user.id, id, { before_status: current.status, after_status: "draft", reason: reason.trim() });
    return row;
  }
  async confirm(id: string, user: CurrentUser) { const current = await this.get(id); if (current.status !== "draft") throw this.invalid("PAYROLL_NOT_CONFIRMABLE", "只有草稿台账可以确认"); const row = await this.prisma.$transaction(async (tx) => { await tx.$queryRaw`SELECT id FROM payroll_ledgers WHERE id = ${id}::uuid FOR UPDATE`; const locked = await tx.payrollLedger.findFirst({ where: { id, deletedAt: null } }); if (!locked || locked.status !== "draft") throw this.invalid("PAYROLL_NOT_CONFIRMABLE", "工资台账已被其他操作处理"); return tx.payrollLedger.update({ where: { id }, data: { status: "confirmed", ...this.audit.update(user) } }); }); await this.audit.record("payroll_ledger.confirm", "payroll_ledger", user.id, id); return row; }
  async adjustment(id: string, input: { adjustment_type: string; effect: string; amount: string; reason: string; attachment?: unknown[]; remark?: string }, user: CurrentUser) {
    if (!input.reason?.trim() || !["increase", "decrease"].includes(input.effect)) throw this.invalid("INVALID_PAYROLL_ADJUSTMENT", "调整方向和原因必填");
    const amount = this.positive(input.amount);
    const row = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM payroll_ledgers WHERE id = ${id}::uuid FOR UPDATE`;
      const ledger = await tx.payrollLedger.findFirst({ where: { id, deletedAt: null } });
      if (!ledger) throw this.notFound("PAYROLL_LEDGER_NOT_FOUND", "薪资台账不存在");
      if (!["draft", "confirmed", "partially_paid"].includes(ledger.status)) throw this.invalid("PAYROLL_NOT_ADJUSTABLE", "当前台账不可调整");
      return tx.payrollAdjustment.create({ data: { adjustmentNo: this.number("PADJ"), ledgerId: id, employeeId: ledger.employeeId, adjustmentType: input.adjustment_type, effect: input.effect, amount, reason: input.reason.trim(), attachment: (input.attachment ?? []) as Prisma.InputJsonValue, remark: input.remark, ...this.audit.create(user) } });
    });
    await this.audit.record("payroll_adjustment.create", "payroll_adjustment", user.id, row.id, { ledger_id: id, amount: row.amount.toString() });
    return row;
  }
  async postAdjustment(id: string, user: CurrentUser) { const row = await this.prisma.payrollAdjustment.findFirst({ where: { id, deletedAt: null } }); if (!row) throw this.notFound("PAYROLL_ADJUSTMENT_NOT_FOUND", "薪资调整不存在"); if (row.status !== "draft") throw this.invalid("PAYROLL_ADJUSTMENT_NOT_POSTABLE", "只有草稿调整可以过账"); const result = await this.prisma.$transaction(async (tx) => { await tx.$queryRaw`SELECT id FROM payroll_adjustments WHERE id = ${id}::uuid FOR UPDATE`; const locked = await tx.payrollAdjustment.findFirst({ where: { id, deletedAt: null } }); if (!locked || locked.status !== "draft") throw this.invalid("PAYROLL_ADJUSTMENT_NOT_POSTABLE", "薪资调整已被其他操作处理"); return tx.payrollAdjustment.update({ where: { id }, data: { status: "posted", ...this.audit.update(user) } }); }); await this.audit.record("payroll_adjustment.post", "payroll_adjustment", user.id, id, { ledger_id: row.ledgerId }); return result; }
  async reverseAdjustment(id: string, reason: string, user: CurrentUser) { if (!reason?.trim()) throw this.invalid("REVERSAL_REASON_REQUIRED", "冲销必须填写原因"); const row = await this.prisma.payrollAdjustment.findFirst({ where: { id, deletedAt: null } }); if (!row || row.status !== "posted") throw this.invalid("PAYROLL_ADJUSTMENT_NOT_REVERSIBLE", "当前调整不可冲销"); const result = await this.prisma.$transaction(async (tx) => { await tx.$queryRaw`SELECT id FROM payroll_adjustments WHERE id = ${id}::uuid FOR UPDATE`; const locked = await tx.payrollAdjustment.findFirst({ where: { id, deletedAt: null } }); if (!locked || locked.status !== "posted") throw this.invalid("PAYROLL_ADJUSTMENT_NOT_REVERSIBLE", "薪资调整已被其他操作处理"); return tx.payrollAdjustment.update({ where: { id }, data: { status: "reversed", remark: `${locked.remark ?? ""}\n冲销：${reason}`, ...this.audit.update(user) } }); }); await this.audit.record("payroll_adjustment.reverse", "payroll_adjustment", user.id, id, { ledger_id: row.ledgerId, reason }); return result; }
  async close(id: string, user: CurrentUser) { const current = await this.get(id); if (current.status !== "paid") throw this.invalid("PAYROLL_NOT_CLOSEABLE", "只有已付清台账可以关闭"); const row = await this.prisma.$transaction(async (tx) => { await tx.$queryRaw`SELECT id FROM payroll_ledgers WHERE id = ${id}::uuid FOR UPDATE`; const locked = await tx.payrollLedger.findFirst({ where: { id, deletedAt: null } }); if (!locked || locked.status !== "paid") throw this.invalid("PAYROLL_NOT_CLOSEABLE", "工资台账已被其他操作处理，当前不可关闭"); return tx.payrollLedger.update({ where: { id }, data: { status: "closed", ...this.audit.update(user) } }); }); await this.audit.record("payroll_ledger.close", "payroll_ledger", user.id, id); return row; }
  /**
   * 台账汇总（应发/已过账调整/已付/未付）。
   *
   * 与列表 balances() 同口径：已付只算「有效核销 + 已过账工资付款」。原先这里少了 payment.status 判断，
   * 同一张台账在列表与 summary 上会给出不同的已付/未付 —— 2026-09-15 一并收敛到 balances()。
   */
  async summary(id: string) {
    const ledger = await this.get(id);
    const balances = this.balances(ledger);
    return { ledger_id: id, employee_id: ledger.employeeId, period_start: ledger.periodStart, period_end: ledger.periodEnd, base_amount: payrollBaseAmount(this.categoryFields(ledger)).toString(), adjustment_amount: this.otherAdjustmentAmount(ledger).toString(), payable_amount: balances.payableAmount, paid_amount: balances.paidAmount, outstanding_amount: balances.outstandingAmount };
  }
  async refreshStatus(client: Prisma.TransactionClient, id: string, user: CurrentUser) { const ledger = await client.payrollLedger.findFirst({ where: { id, deletedAt: null } }); if (!ledger) throw this.notFound("PAYROLL_LEDGER_NOT_FOUND", "薪资台账不存在"); const adjustments = await client.payrollAdjustment.findMany({ where: { ledgerId: id, deletedAt: null, status: "posted" } }); const net = payrollBaseAmount(this.categoryFields(ledger)).plus(adjustments.reduce((sum, row) => sum.plus(row.effect === "increase" ? row.amount : row.amount.negated()), new Prisma.Decimal(0))); const paid = await client.salaryPaymentAllocation.aggregate({ where: { ledgerId: id, deletedAt: null, status: "active", payment: { status: "posted" } }, _sum: { amount: true } }); const amount = new Prisma.Decimal(paid._sum.amount ?? 0); const status = amount.eq(0) ? "confirmed" : amount.gte(net) ? "paid" : "partially_paid"; return client.payrollLedger.update({ where: { id }, data: { status, ...this.audit.update(user) } }); }

  /** 把 Prisma 行的 camelCase 金额映射成 domain 的 snake_case 类目字段，公式只有 domain 一份实现。 */
  private categoryFields(row: LedgerAmounts): PayrollAmountFields {
    return {
      base_salary: row.baseSalary,
      production_source_amount: row.productionSourceAmount,
      overtime_amount: row.overtimeAmount,
      attendance_deduction: row.attendanceDeduction,
      late_deduction: row.lateDeduction,
      absence_deduction: row.absenceDeduction,
      early_leave_deduction: row.earlyLeaveDeduction,
      performance_amount: row.performanceAmount,
      allowance_amount: row.allowanceAmount,
      housing_allowance: row.housingAllowance,
      social_insurance: row.socialInsurance,
      individual_tax: row.individualTax,
      other_adjustment: row.otherAdjustment,
    };
  }

  /** 已过账调整净额。 */
  private otherAdjustmentAmount(row: { adjustments: Array<{ status: string; effect: string; amount: Prisma.Decimal }> }) {
    return row.adjustments.filter((item) => item.status === "posted").reduce((sum, item) => sum.plus(item.effect === "increase" ? item.amount : item.amount.negated()), new Prisma.Decimal(0));
  }

  /** 取员工日报（工资侧的事实源）：只按员工与日期过滤，**不做订单/工序预筛**，避免漏掉任何一单任何一道工序。 */
  private async dailyReports(employeeIds: string[], from: Date, to: Date): Promise<PayrollDailyReport[]> {
    const rows = await this.prisma.employeeDailyReport.findMany({
      where: { employeeId: { in: employeeIds }, deletedAt: null, reportDate: { gte: from, lte: to } },
      orderBy: [{ reportDate: "asc" }, { orderNo: "asc" }, { productionOrderOperationId: "asc" }],
    });
    return rows.map((row) => ({ id: row.id, employeeId: row.employeeId, reportDate: row.reportDate, productionOrderId: row.productionOrderId, orderNo: row.orderNo, operationId: row.productionOrderOperationId, operationName: row.operationNameSnapshot, wageMode: row.wageMode, quantity: row.quantity, durationMinutes: row.durationMinutes, amount: row.calculatedAmount }));
  }

  /** 车间员工的生产工资 + 逐单/逐工序/逐日明细；非车间员工恒为 0（用户要求「非车间员工工资都先为零」）。 */
  private async collectProductionSources(employeeId: string, start: Date, end: Date) {
    const employee = await this.prisma.employee.findFirst({ where: { id: employeeId, deletedAt: null }, select: { employeeType: true } });
    if (employee?.employeeType !== "workshop") return { production: new Prisma.Decimal(0), snapshot: [] as unknown as Prisma.InputJsonValue, summary: emptyProductionPayroll(employeeId) };
    const summary = aggregateProductionPayroll(await this.dailyReports([employeeId], start, end));
    this.assertStorable(summary.amount);
    return { production: summary.amount, snapshot: summary.lines as unknown as Prisma.InputJsonValue, summary: { ...summary, employee_id: employeeId } };
  }

  /**
   * 车间工人的基本工资就是生产工资（由生产日报自动汇总），不允许手工填非零值。
   *
   * 允许写 0：历史数据里车间台账可能被老页面填过基本工资，必须留一条清零的路，否则这笔钱永远卡在表上。
   * 传入值等于当前值（未修改）时也放过，避免「整体提交表单」被这条守卫误伤。
   */
  private assertManualBaseSalaryAllowed(employeeType: string, baseSalary: string | undefined, current: Prisma.Decimal) {
    if (employeeType !== "workshop" || baseSalary === undefined || baseSalary === null) return;
    const value = this.dec(baseSalary);
    if (!value.isZero() && !value.eq(current)) throw this.invalid("PAYROLL_BASE_SALARY_MANAGED", "车间工人的基本工资由生产日报自动汇总，不能手工填写或修改；请先在生产日报里登记计件/计时", [{ employee_type: employeeType }]);
  }

  /** Decimal(18,4) 的整数部分最多 14 位；超出时 422，而不是让数据库报 500 把事务留在半途。 */
  private assertStorable(value: Prisma.Decimal) {
    if (new Prisma.Decimal(value).abs().gte(new Prisma.Decimal("1e14"))) throw this.invalid("PAYROLL_LEDGER_AMOUNT_OUT_OF_RANGE", "生产来源合计超出可存储范围");
  }

  /**
   * 应发 / 已付 / 未付，以及表格上「基本工资」「其他增减」两格的显示值。
   *
   * 列表与详情必须同口径：已付只统计「有效核销 + 已过账工资付款」，否则列表与详情会给出不同余额。
   */
  private balances(fields: LedgerAmounts & {
    adjustments: Array<{ status: string; effect: string; amount: Prisma.Decimal }>;
    allocations: Array<{ status: string; amount: Prisma.Decimal; payment?: { status: string } | null }>;
  }) {
    const adjustments = this.otherAdjustmentAmount(fields);
    const categories = this.categoryFields(fields);
    const payable = payrollBaseAmount(categories).plus(adjustments);
    const paid = fields.allocations.filter((item) => item.status === "active" && item.payment?.status === "posted").reduce((sum, item) => sum.plus(item.amount), new Prisma.Decimal(0));
    return {
      payableAmount: payable.toFixed(4),
      paidAmount: paid.toFixed(4),
      outstandingAmount: payable.minus(paid).toFixed(4),
      // 表格「基本工资」格：基本工资 + 生产来源（车间的生产工资就落在这里，只读）。
      basicSalaryAmount: payrollBasicSalaryAmount(categories).toFixed(4),
      // 表格「其他增减」格（只读）：6 个可编辑类目之外的历史类目净额 + 已过账调整净额。
      otherAdjustmentAmount: payrollOtherAdjustmentAmount(categories).plus(adjustments).toFixed(4),
    };
  }
  private dec(value?: string) { return value ? this.nonNegative(value) : new Prisma.Decimal(0); }
  private positive(value: string) { try { const n = new Prisma.Decimal(value); if (!n.gt(0)) throw new Error(); return n; } catch { throw this.invalid("INVALID_AMOUNT", "金额必须是大于零的十进制数"); } }
  private nonNegative(value: string) { try { const n = new Prisma.Decimal(value); if (n.lt(0)) throw new Error(); return n; } catch { throw this.invalid("INVALID_AMOUNT", "金额必须是非负十进制数"); } }
  private date(value: string) { const d = new Date(`${value}T00:00:00.000Z`); if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(d.valueOf())) throw this.invalid("INVALID_DATE", "日期无效"); return d; }
  private number(prefix: string) { return `${prefix}-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomUUID().slice(0, 8).toUpperCase()}`; }
  private notFound(code: string, message: string) { return new NotFoundException({ code, message, details: [] }); }
  private invalid(code: string, message: string, details: unknown[] = []) { return new UnprocessableEntityException({ code, message, details }); }
}
