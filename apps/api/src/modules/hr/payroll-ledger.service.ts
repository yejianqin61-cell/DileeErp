import { Injectable, NotFoundException, UnprocessableEntityException, Optional } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { AuditService } from "../../platform/audit/audit.service";
import type { CurrentUser } from "../../platform/auth/auth.service";
import { CurrencyService } from "../../platform/currency/currency.service";
import { PrismaService } from "../../platform/database/prisma.service";
import { canReopenPayroll } from "./hr-payroll.domain";

@Injectable()
export class PayrollLedgerService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, @Optional() private readonly currencies?: CurrencyService) {}
  /**
   * 工资台账列表。
   *
   * 工资管理页要按「月 + 部门 + 岗位」筛选（客户要求），因此除既有的员工/期间/状态外，
   * 追加 month（按自然月，与 from/to 同为"期间有交集"语义）、department_id、position_id、employee_type。
   * 返回值同时带上部门与岗位（原先只有 departmentId/positionId，前端拿不到名字也就筛不了）。
   */
  async list(employeeId?: string, periodStart?: string, periodEnd?: string, status?: string, from?: string, to?: string, month?: string, departmentId?: string, positionId?: string, employeeType?: string) {
    const where: Prisma.PayrollLedgerWhereInput = { deletedAt: null };
    if (employeeId) where.employeeId = employeeId;
    if (periodStart) where.periodStart = this.date(periodStart);
    if (periodEnd) where.periodEnd = this.date(periodEnd);
    if (status) where.status = status;
    // 期间筛选与 from/to 同口径：只要台账期间与所选区间有交集就算命中，不是"完全落在区间内"。
    const range = month ? this.monthRange(month) : (from || to ? { from: from ? this.date(from) : undefined, to: to ? this.date(to) : undefined } : undefined);
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
  async generate(input: { employee_id?: string; employee_name?: string; period_start: string; period_end: string; currency: string; base_salary?: string; overtime_amount?: string; attendance_deduction?: string; performance_amount?: string; allowance_amount?: string; social_insurance?: string; individual_tax?: string; other_adjustment?: string; attachment?: unknown[]; remark?: string }, user: CurrentUser) {
    await this.currencies?.assertSupported(input.currency, "工资台账币种");
    const start = this.date(input.period_start); const end = this.date(input.period_end); if (end < start) throw this.invalid("INVALID_PAYROLL_PERIOD", "薪资期间无效");
    if (!input.employee_id && !input.employee_name?.trim()) throw this.invalid("EMPLOYEE_REQUIRED", "请选择员工姓名");
    const employees = await this.prisma.employee.findMany({ where: input.employee_id ? { id: input.employee_id, deletedAt: null } : { name: input.employee_name!.trim(), deletedAt: null }, orderBy: { employeeNo: "asc" } });
    if (!employees.length) throw this.notFound("EMPLOYEE_NOT_FOUND", "员工不存在");
    if (!input.employee_id && employees.length > 1) throw this.invalid("EMPLOYEE_NAME_AMBIGUOUS", "存在同名员工，请选择具体工号", employees.map((item) => ({ employee_id: item.id, employee_no: item.employeeNo, name: item.name, employee_type: item.employeeType })));
    const employee = employees[0];
    const sourceData = await this.collectProductionSources(employee.id, start, end);
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM employees WHERE id = ${employee.id}::uuid FOR UPDATE`;
      const existing = await tx.payrollLedger.findFirst({ where: { employeeId: employee.id, periodStart: start, periodEnd: end, deletedAt: null } });
      if (existing) return { row: existing, created: false };
      return { row: await tx.payrollLedger.create({ data: { ledgerNo: this.number("PAYROLL"), employeeId: employee.id, periodStart: start, periodEnd: end, currency: input.currency, baseSalary: this.dec(input.base_salary), productionSourceAmount: sourceData.production, overtimeAmount: this.dec(input.overtime_amount), attendanceDeduction: this.dec(input.attendance_deduction), performanceAmount: this.dec(input.performance_amount), allowanceAmount: this.dec(input.allowance_amount), socialInsurance: this.dec(input.social_insurance), individualTax: this.dec(input.individual_tax), otherAdjustment: this.dec(input.other_adjustment), sourceSnapshot: sourceData.snapshot, attachment: (input.attachment ?? []) as Prisma.InputJsonValue, remark: input.remark, ...this.audit.create(user) } }), created: true };
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
  async update(id: string, input: Partial<{ employee_id: string; period_start: string; period_end: string; currency: string; base_salary: string; overtime_amount: string; attendance_deduction: string; performance_amount: string; allowance_amount: string; social_insurance: string; individual_tax: string; other_adjustment: string; attachment?: unknown[]; remark?: string; reason?: string }>, user: CurrentUser) {
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
      const sourceData = await this.collectProductionSources(employee.id, start, end);
      return tx.payrollLedger.update({ where: { id }, data: { employeeId, periodStart: start, periodEnd: end, currency: input.currency ?? current.currency, baseSalary: input.base_salary ?? current.baseSalary, productionSourceAmount: sourceData.production, overtimeAmount: input.overtime_amount ?? current.overtimeAmount, attendanceDeduction: input.attendance_deduction ?? current.attendanceDeduction, performanceAmount: input.performance_amount ?? current.performanceAmount, allowanceAmount: input.allowance_amount ?? current.allowanceAmount, socialInsurance: input.social_insurance ?? current.socialInsurance, individualTax: input.individual_tax ?? current.individualTax, otherAdjustment: input.other_adjustment ?? current.otherAdjustment, sourceSnapshot: sourceData.snapshot, attachment: (input.attachment ?? current.attachment) as Prisma.InputJsonValue, remark: input.remark ?? current.remark, status: "draft", ...this.audit.update(user) } });
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
  async summary(id: string) { const ledger = await this.get(id); const adjustments = ledger.adjustments.filter((row) => row.status === "posted").reduce((sum, row) => sum.plus(row.effect === "increase" ? row.amount : row.amount.negated()), new Prisma.Decimal(0)); const base = ledger.baseSalary.plus(ledger.productionSourceAmount).plus(ledger.overtimeAmount).minus(ledger.attendanceDeduction).plus(ledger.performanceAmount).plus(ledger.allowanceAmount).minus(ledger.socialInsurance).minus(ledger.individualTax).plus(ledger.otherAdjustment); const net = base.plus(adjustments); const paid = ledger.allocations.filter((row) => row.status === "active").reduce((sum, row) => sum.plus(row.amount), new Prisma.Decimal(0)); return { ledger_id: id, employee_id: ledger.employeeId, period_start: ledger.periodStart, period_end: ledger.periodEnd, base_amount: base.toString(), adjustment_amount: adjustments.toString(), payable_amount: net.toString(), paid_amount: paid.toString(), outstanding_amount: net.minus(paid).toString() }; }
  async refreshStatus(client: Prisma.TransactionClient, id: string, user: CurrentUser) { const ledger = await client.payrollLedger.findFirst({ where: { id, deletedAt: null } }); if (!ledger) throw this.notFound("PAYROLL_LEDGER_NOT_FOUND", "薪资台账不存在"); const adjustments = await client.payrollAdjustment.findMany({ where: { ledgerId: id, deletedAt: null, status: "posted" } }); const base = ledger.baseSalary.plus(ledger.productionSourceAmount).plus(ledger.overtimeAmount).minus(ledger.attendanceDeduction).plus(ledger.performanceAmount).plus(ledger.allowanceAmount).minus(ledger.socialInsurance).minus(ledger.individualTax).plus(ledger.otherAdjustment); const net = base.plus(adjustments.reduce((sum, row) => sum.plus(row.effect === "increase" ? row.amount : row.amount.negated()), new Prisma.Decimal(0))); const paid = await client.salaryPaymentAllocation.aggregate({ where: { ledgerId: id, deletedAt: null, status: "active", payment: { status: "posted" } }, _sum: { amount: true } }); const amount = new Prisma.Decimal(paid._sum.amount ?? 0); const status = amount.eq(0) ? "confirmed" : amount.gte(net) ? "paid" : "partially_paid"; return client.payrollLedger.update({ where: { id }, data: { status, ...this.audit.update(user) } }); }
  private async collectProductionSources(employeeId: string, start: Date, end: Date) { const employee = await this.prisma.employee.findFirst({ where: { id: employeeId, deletedAt: null }, select: { employeeType: true } }); if (employee?.employeeType !== "workshop") return { production: new Prisma.Decimal(0), snapshot: [] as unknown as Prisma.InputJsonValue }; const sources = await this.prisma.productionPayrollSource.findMany({ where: { employeeId, deletedAt: null, periodStart: { gte: start }, periodEnd: { lte: end } } }); const production = sources.reduce((sum, row) => sum.plus(row.amount), new Prisma.Decimal(0)); /* 聚合值也要落在 Decimal(18,4) 内（整数部分最多 14 位），超限提前 422 而不是让数据库报 500。 */ if (production.abs().gte(new Prisma.Decimal("1e14"))) throw this.invalid("PAYROLL_LEDGER_AMOUNT_OUT_OF_RANGE", "生产来源合计超出可存储范围"); const snapshot = sources.map((source) => ({ id: source.id, order_no: source.orderNo, wage_mode: source.wageMode, quantity: source.quantity.toString(), duration_minutes: source.durationMinutes.toString(), duration_hours: this.hoursText(source.durationMinutes), amount: source.amount.toString() })) as Prisma.InputJsonValue; return { production, snapshot }; }
  /**
   * 应发 / 已付 / 未付。
   *
   * 列表与详情必须同口径：已付只统计「有效核销 + 已过账工资付款」，否则列表与详情会给出不同余额。
   */
  private balances(fields: {
    baseSalary: Prisma.Decimal; productionSourceAmount: Prisma.Decimal; overtimeAmount: Prisma.Decimal; attendanceDeduction: Prisma.Decimal;
    performanceAmount: Prisma.Decimal; allowanceAmount: Prisma.Decimal; socialInsurance: Prisma.Decimal; individualTax: Prisma.Decimal; otherAdjustment: Prisma.Decimal;
    adjustments: Array<{ status: string; effect: string; amount: Prisma.Decimal }>;
    allocations: Array<{ status: string; amount: Prisma.Decimal; payment?: { status: string } | null }>;
  }) {
    const adjustments = fields.adjustments.filter((item) => item.status === "posted").reduce((sum, item) => sum.plus(item.effect === "increase" ? item.amount : item.amount.negated()), new Prisma.Decimal(0));
    const payable = fields.baseSalary.plus(fields.productionSourceAmount).plus(fields.overtimeAmount).minus(fields.attendanceDeduction).plus(fields.performanceAmount).plus(fields.allowanceAmount).minus(fields.socialInsurance).minus(fields.individualTax).plus(fields.otherAdjustment).plus(adjustments);
    const paid = fields.allocations.filter((item) => item.status === "active" && item.payment?.status === "posted").reduce((sum, item) => sum.plus(item.amount), new Prisma.Decimal(0));
    return { payableAmount: payable.toFixed(4), paidAmount: paid.toFixed(4), outstandingAmount: payable.minus(paid).toFixed(4) };
  }
  /** 自然月区间（含首尾日）。 */
  private monthRange(value: string) {
    if (!/^\d{4}-\d{2}$/.test(value)) throw this.invalid("INVALID_MONTH", "月份格式为 YYYY-MM");
    const [year, monthIndex] = value.split("-").map(Number);
    return { from: new Date(Date.UTC(year, monthIndex - 1, 1)), to: new Date(Date.UTC(year, monthIndex, 0)) };
  }
  /** 分钟 -> 小时文案（最多 4 位小数、去掉尾随零；极小非零值提升精度），与生产侧 toHoursText/导出 hours() 同口径。 */
  private hoursText(durationMinutes: Prisma.Decimal | null | undefined) { if (durationMinutes === null || durationMinutes === undefined) return ""; const hours = new Prisma.Decimal(durationMinutes).div(60); const trim = (value: string) => value.replace(/0+$/, "").replace(/\.$/, ""); const text = trim(hours.toFixed(4)); return text !== "0" || hours.isZero() ? text : trim(hours.toFixed(8)); }
  private dec(value?: string) { return value ? this.nonNegative(value) : new Prisma.Decimal(0); }
  private positive(value: string) { try { const n = new Prisma.Decimal(value); if (!n.gt(0)) throw new Error(); return n; } catch { throw this.invalid("INVALID_AMOUNT", "金额必须是大于零的十进制数"); } }
  private nonNegative(value: string) { try { const n = new Prisma.Decimal(value); if (n.lt(0)) throw new Error(); return n; } catch { throw this.invalid("INVALID_AMOUNT", "金额必须是非负十进制数"); } }
  private date(value: string) { const d = new Date(`${value}T00:00:00.000Z`); if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(d.valueOf())) throw this.invalid("INVALID_DATE", "日期无效"); return d; }
  private number(prefix: string) { return `${prefix}-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomUUID().slice(0, 8).toUpperCase()}`; }
  private notFound(code: string, message: string) { return new NotFoundException({ code, message, details: [] }); }
  private invalid(code: string, message: string, details: unknown[] = []) { return new UnprocessableEntityException({ code, message, details }); }
}
