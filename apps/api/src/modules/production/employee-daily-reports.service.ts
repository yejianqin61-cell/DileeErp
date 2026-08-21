import { Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { AuditService } from "../../platform/audit/audit.service";
import type { CurrentUser } from "../../platform/auth/auth.service";
import { PrismaService } from "../../platform/database/prisma.service";

type Input = { production_order_id: string; production_order_operation_id: string; employee_id: string; report_date: string; wage_mode: string; quantity: string; duration_minutes?: string; unit_price?: string; price_override_reason?: string; remark?: string; idempotency_key?: string };
type Filter = { employee_id?: string; order_no?: string; production_order_id?: string; production_order_operation_id?: string; report_date?: string; from?: string; to?: string; wage_mode?: string };

@Injectable()
export class EmployeeDailyReportsService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  async list(filter: Filter) {
    return this.prisma.employeeDailyReport.findMany({ where: { deletedAt: null, ...(filter.employee_id ? { employeeId: filter.employee_id } : {}), ...(filter.order_no ? { orderNo: filter.order_no } : {}), ...(filter.production_order_id ? { productionOrderId: filter.production_order_id } : {}), ...(filter.production_order_operation_id ? { productionOrderOperationId: filter.production_order_operation_id } : {}), ...(filter.wage_mode ? { wageMode: filter.wage_mode } : {}), ...(filter.report_date ? { reportDate: this.date(filter.report_date) } : {}), ...(filter.from || filter.to ? { reportDate: { ...(filter.from ? { gte: this.date(filter.from) } : {}), ...(filter.to ? { lte: this.date(filter.to) } : {}) } } : {}) }, include: { employee: true, productionOrderOperation: true }, orderBy: [{ reportDate: "desc" }, { createdAt: "desc" }] });
  }

  async get(id: string) {
    const row = await this.prisma.employeeDailyReport.findFirst({ where: { id, deletedAt: null }, include: { employee: true, productionOrder: true, productionOrderOperation: true } });
    if (!row) throw new NotFoundException({ code: "EMPLOYEE_DAILY_REPORT_NOT_FOUND", message: "员工日报不存在", details: [] });
    return row;
  }

  async create(input: Input, user: CurrentUser) {
    if (input.idempotency_key) { const previous = await this.prisma.employeeDailyReport.findFirst({ where: { idempotencyKey: input.idempotency_key, deletedAt: null } }); if (previous) return this.get(previous.id); }
    const refs = await this.refs(input.production_order_id, input.production_order_operation_id, input.employee_id, input.report_date, false, input.wage_mode);
    const values = this.values(input, refs.rate?.unitPrice);
    const created = await this.prisma.$transaction(async (tx) => {
      const row = await tx.employeeDailyReport.create({ data: { idempotencyKey: input.idempotency_key, productionOrderId: refs.order.id, productionOrderOperationId: refs.operation.id, employeeId: refs.employee.id, orderNo: refs.order.orderNo, productionOrderNoSnapshot: refs.order.productionOrderNo, operationNameSnapshot: refs.operation.operationNameSnapshot, employeeNameSnapshot: refs.employee.name, reportDate: refs.reportDate, wageMode: input.wage_mode, quantity: values.quantity, durationMinutes: values.durationMinutes, unitPrice: values.unitPrice, calculatedAmount: values.amount, priceOverrideReason: input.price_override_reason, remark: input.remark, ...this.audit.create(user) } });
      await this.recomputeDiscrepancy(tx, refs.order.id, refs.operation.id, refs.reportDate, user);
      return row;
    });
    await this.audit.record("employee_daily_report.create", "employee_daily_report", user.id, created.id, { order_no: created.orderNo, reason: input.remark ?? null });
    return this.get(created.id);
  }

  async update(id: string, input: Partial<Omit<Input, "production_order_id" | "production_order_operation_id" | "employee_id">> & { reason: string; expected_version?: number }, user: CurrentUser) {
    if (!input.reason?.trim()) throw new UnprocessableEntityException({ code: "CORRECTION_REASON_REQUIRED", message: "修改员工日报必须填写原因", details: [] });
    const current = await this.get(id);
    if (input.expected_version !== undefined && input.expected_version !== current.version) throw new UnprocessableEntityException({ code: "DAILY_REPORT_VERSION_CONFLICT", message: "员工日报已被其他操作更新，请刷新后重试", details: [{ expected_version: input.expected_version, actual_version: current.version }] });
    const reportDateText = input.report_date ?? current.reportDate.toISOString().slice(0, 10);
    if (input.unit_price !== undefined && !input.price_override_reason?.trim()) throw new UnprocessableEntityException({ code: "PRICE_OVERRIDE_REASON_REQUIRED", message: "覆盖单价必须填写原因", details: [] });
    const refs = await this.refs(current.productionOrderId, current.productionOrderOperationId, current.employeeId, reportDateText, true, input.wage_mode ?? current.wageMode);
    const merged: Input = { production_order_id: current.productionOrderId, production_order_operation_id: current.productionOrderOperationId, employee_id: current.employeeId, report_date: reportDateText, wage_mode: input.wage_mode ?? current.wageMode, quantity: input.quantity ?? current.quantity.toString(), duration_minutes: input.duration_minutes ?? (current.durationMinutes?.toString()), unit_price: input.unit_price, price_override_reason: input.price_override_reason ?? current.priceOverrideReason ?? undefined, remark: input.remark ?? current.remark ?? undefined };
    const values = this.values(merged, input.unit_price !== undefined ? refs.rate?.unitPrice : undefined, current.unitPrice);
    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.employeeDailyReport.update({ where: { id }, data: { reportDate: refs.reportDate, wageMode: merged.wage_mode, quantity: values.quantity, durationMinutes: values.durationMinutes, unitPrice: values.unitPrice, calculatedAmount: values.amount, priceOverrideReason: merged.price_override_reason, remark: merged.remark, version: { increment: 1 }, ...this.audit.update(user) } });
      await this.recomputeDiscrepancy(tx, current.productionOrderId, current.productionOrderOperationId, current.reportDate, user);
      if (refs.reportDate.getTime() !== current.reportDate.getTime()) await this.recomputeDiscrepancy(tx, current.productionOrderId, current.productionOrderOperationId, refs.reportDate, user);
      return row;
    });
    await this.audit.record("employee_daily_report.update", "employee_daily_report", user.id, id, { order_no: current.orderNo, reason: input.reason, before_amount: current.calculatedAmount.toString(), after_amount: values.amount.toString() });
    return updated;
  }

  async remove(id: string, reason: string, user: CurrentUser, expectedVersion?: number) {
    if (!reason?.trim()) throw new UnprocessableEntityException({ code: "CORRECTION_REASON_REQUIRED", message: "删除员工日报必须填写原因", details: [] });
    const current = await this.get(id);
    if (expectedVersion !== undefined && expectedVersion !== current.version) throw new UnprocessableEntityException({ code: "DAILY_REPORT_VERSION_CONFLICT", message: "员工日报已被其他操作更新，请刷新后重试", details: [{ expected_version: expectedVersion, actual_version: current.version }] });
    await this.refs(current.productionOrderId, current.productionOrderOperationId, current.employeeId, current.reportDate.toISOString().slice(0, 10), true);
    const removed = await this.prisma.$transaction(async (tx) => { const row = await tx.employeeDailyReport.update({ where: { id }, data: { ...this.audit.softDelete(user), version: { increment: 1 } } }); await this.recomputeDiscrepancy(tx, current.productionOrderId, current.productionOrderOperationId, current.reportDate, user); return row; });
    await this.audit.record("employee_daily_report.delete", "employee_daily_report", user.id, id, { order_no: current.orderNo, reason });
    return removed;
  }

  async impactPreview(id: string) {
    const current = await this.get(id);
    const [sameDay, employeeTotal] = await Promise.all([this.prisma.employeeDailyReport.aggregate({ where: { productionOrderOperationId: current.productionOrderOperationId, reportDate: current.reportDate, deletedAt: null }, _sum: { quantity: true, calculatedAmount: true } }), this.prisma.employeeDailyReport.aggregate({ where: { employeeId: current.employeeId, reportDate: current.reportDate, deletedAt: null }, _sum: { calculatedAmount: true } })]);
    return { report_id: id, order_no: current.orderNo, current: { quantity: current.quantity.toString(), calculated_amount: current.calculatedAmount.toString() }, after_delete: { operation_employee_quantity: new Prisma.Decimal(sameDay._sum.quantity ?? 0).minus(current.quantity).toString(), operation_employee_amount: new Prisma.Decimal(sameDay._sum.calculatedAmount ?? 0).minus(current.calculatedAmount).toString(), employee_day_amount: new Prisma.Decimal(employeeTotal._sum.calculatedAmount ?? 0).minus(current.calculatedAmount).toString() }, warning: "提交更正后将重算员工件数差异告警和生产薪资来源" };
  }

  async payrollSources(filter: { employee_id?: string; from: string; to: string; wage_mode?: string }) {
    const from = this.date(filter.from); const to = this.date(filter.to); if (to < from) throw new UnprocessableEntityException({ code: "INVALID_PAYROLL_PERIOD", message: "薪资来源日期范围无效", details: [] });
    const rows = await this.prisma.employeeDailyReport.findMany({ where: { deletedAt: null, reportDate: { gte: from, lte: to }, ...(filter.employee_id ? { employeeId: filter.employee_id } : {}), ...(filter.wage_mode ? { wageMode: filter.wage_mode } : {}) }, include: { employee: true }, orderBy: { reportDate: "asc" } });
    const groups = new Map<string, { employee_id: string; employee_name: string; production_order_id: string; order_no: string; wage_mode: string; period_start: string; period_end: string; quantity: Prisma.Decimal; duration_minutes: Prisma.Decimal; amount: Prisma.Decimal; report_ids: string[] }>();
    for (const row of rows) { const key = `${row.employeeId}|${row.productionOrderId}|${row.wageMode}`; const existing = groups.get(key) ?? { employee_id: row.employeeId, employee_name: row.employeeNameSnapshot, production_order_id: row.productionOrderId, order_no: row.orderNo, wage_mode: row.wageMode, period_start: filter.from, period_end: filter.to, quantity: new Prisma.Decimal(0), duration_minutes: new Prisma.Decimal(0), amount: new Prisma.Decimal(0), report_ids: [] }; existing.quantity = existing.quantity.plus(row.quantity); existing.duration_minutes = existing.duration_minutes.plus(row.durationMinutes ?? 0); existing.amount = existing.amount.plus(row.calculatedAmount); existing.report_ids.push(row.id); groups.set(key, existing); }
    return [...groups.values()].map((item) => ({ ...item, quantity: item.quantity.toString(), duration_minutes: item.duration_minutes.toString(), amount: item.amount.toString(), source_read_only: true }));
  }

  private async refs(orderId: string, operationId: string, employeeId: string, dateText: string, correction = false, wageMode?: string) {
    const reportDate = this.validDate(dateText);
    const [order, operation, employee] = await Promise.all([this.prisma.productionOrder.findFirst({ where: { id: orderId, deletedAt: null } }), this.prisma.productionOrderOperation.findFirst({ where: { id: operationId, productionOrderId: orderId, deletedAt: null } }), this.prisma.employee.findFirst({ where: { id: employeeId, deletedAt: null } })]);
    if (!order) throw new NotFoundException({ code: "PRODUCTION_ORDER_NOT_FOUND", message: "生产单不存在", details: [] });
    if (order.executionMode !== "in_house") throw new UnprocessableEntityException({ code: "OUTSOURCED_DAILY_REPORT_FORBIDDEN", message: "外加工生产单不进入员工日报", details: [] });
    if (!operation || operation.status !== "active") throw new UnprocessableEntityException({ code: "PRODUCTION_OPERATION_NOT_FOUND", message: "生产单工序不存在或已取消", details: [] });
    if (!employee || employee.employmentStatus !== "active") throw new UnprocessableEntityException({ code: "EMPLOYEE_DAILY_REPORT_FORBIDDEN", message: "员工不存在、已停用或已离职", details: [] });
    if ((employee.hiredOn && reportDate < employee.hiredOn) || (employee.leftOn && reportDate > employee.leftOn)) throw new UnprocessableEntityException({ code: "EMPLOYEE_NOT_EMPLOYED_ON_REPORT_DATE", message: "员工在日报日期不处于可报工状态", details: [] });
    if (!(correction ? ["in_progress", "completed"] : ["in_progress", "completed"]).includes(order.status)) throw new UnprocessableEntityException({ code: "PRODUCTION_ORDER_DAILY_REPORT_FORBIDDEN", message: "当前生产单状态不允许维护员工日报", details: [] });
    const rates = await this.prisma.operationRate.findMany({ where: { employeeId, operationId: operation.operationCatalogId, ...(wageMode ? { wageMode } : { wageMode: { in: ["piece_rate", "time_rate"] } }), deletedAt: null, effectiveFrom: { lte: reportDate }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: reportDate } }] }, orderBy: { effectiveFrom: "desc" } });
    return { order, operation, employee, reportDate, rate: rates[0] };
  }

  private values(input: Input, ratePrice?: Prisma.Decimal, existingPrice?: Prisma.Decimal) {
    if (input.wage_mode !== "piece_rate" && input.wage_mode !== "time_rate") throw new UnprocessableEntityException({ code: "INVALID_WAGE_MODE", message: "计薪方式无效", details: [] });
    const quantity = this.decimal(input.quantity, "INVALID_EMPLOYEE_REPORT_QUANTITY", "员工日报件数必须大于零");
    const durationMinutes = input.duration_minutes === undefined ? undefined : this.decimal(input.duration_minutes, "INVALID_EMPLOYEE_REPORT_DURATION", "员工日报时长必须大于零");
    if (input.wage_mode === "time_rate" && !durationMinutes) throw new UnprocessableEntityException({ code: "TIME_REPORT_DURATION_REQUIRED", message: "计时日报必须填写时长", details: [] });
    const override = input.unit_price !== undefined;
    if (override && !input.price_override_reason?.trim()) throw new UnprocessableEntityException({ code: "PRICE_OVERRIDE_REASON_REQUIRED", message: "覆盖单价必须填写原因", details: [] });
    const price = input.unit_price !== undefined ? this.decimal(input.unit_price, "INVALID_UNIT_PRICE", "单价必须是非负十进制数", true) : ratePrice ?? existingPrice;
    if (!price) throw new UnprocessableEntityException({ code: "OPERATION_RATE_NOT_FOUND", message: "日报日期没有有效工序计价", details: [] });
    const amount = input.wage_mode === "piece_rate" ? quantity.mul(price) : (durationMinutes as Prisma.Decimal).mul(price);
    return { quantity, durationMinutes, unitPrice: price, amount };
  }

  private async recomputeDiscrepancy(tx: Prisma.TransactionClient, orderId: string, operationId: string, reportDate: Date, user: CurrentUser) {
    const [order, operationReports, employeeReports] = await Promise.all([tx.productionOrder.findUniqueOrThrow({ where: { id: orderId } }), tx.operationDailyReport.aggregate({ where: { productionOrderOperationId: operationId, reportDate, deletedAt: null }, _sum: { completedQuantity: true } }), tx.employeeDailyReport.aggregate({ where: { productionOrderOperationId: operationId, reportDate, deletedAt: null }, _sum: { quantity: true } })]);
    const operationQuantity = new Prisma.Decimal(operationReports._sum.completedQuantity ?? 0); const employeeQuantity = new Prisma.Decimal(employeeReports._sum.quantity ?? 0); const discrepancy = operationQuantity.minus(employeeQuantity);
    const target = (await tx.productionOrderOperation.findUniqueOrThrow({ where: { id: operationId } })).targetQuantity;
    const allReports = await tx.operationDailyReport.aggregate({ where: { productionOrderOperationId: operationId, deletedAt: null }, _sum: { completedQuantity: true } });
    const cumulative = new Prisma.Decimal(allReports._sum.completedQuantity ?? 0); const key = { productionOrderOperationId: operationId, reportDate, alertType: "daily_discrepancy" } as const; const existing = await tx.productionDailyAlert.findUnique({ where: { productionOrderOperationId_reportDate_alertType: key } });
    if (!discrepancy.eq(0)) { const unchanged = existing && existing.status === "confirmed" && existing.operationReportQuantity?.eq(operationQuantity) && existing.employeeReportQuantity?.eq(employeeQuantity) && existing.discrepancyQuantity?.eq(discrepancy); const data = { productionOrderId: orderId, orderNo: order.orderNo, targetQuantity: target, operationReportQuantity: operationQuantity, employeeReportQuantity: employeeQuantity, discrepancyQuantity: discrepancy, cumulativeQuantity: cumulative, updatedBy: user.id, status: unchanged ? "confirmed" : "pending" }; if (existing) await tx.productionDailyAlert.update({ where: { id: existing.id }, data }); else await tx.productionDailyAlert.create({ data: { ...key, ...data, createdBy: user.id } }); await tx.auditEvent.create({ data: { action: existing ? "production_daily_alert.recalculate" : "production_daily_alert.create", entityType: "production_daily_alert", actorId: user.id, entityId: existing?.id, details: { order_no: order.orderNo, alert_type: "daily_discrepancy", operation_quantity: operationQuantity.toString(), employee_quantity: employeeQuantity.toString(), discrepancy_quantity: discrepancy.toString(), status: data.status } } }); }
    else if (existing && existing.status !== "recovered") { await tx.productionDailyAlert.update({ where: { id: existing.id }, data: { status: "recovered", recoveredAt: new Date(), updatedBy: user.id } }); await tx.auditEvent.create({ data: { action: "production_daily_alert.recover", entityType: "production_daily_alert", actorId: user.id, entityId: existing.id, details: { order_no: order.orderNo, alert_type: "daily_discrepancy", status: "recovered" } } }); }
  }

  private date(value: string) { const date = new Date(`${value}T00:00:00.000Z`); if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(date.valueOf())) throw new UnprocessableEntityException({ code: "INVALID_REPORT_DATE", message: "日报日期必须是有效日期", details: [] }); return date; }
  private validDate(value: string) { const date = this.date(value); const today = new Date(); today.setUTCHours(0, 0, 0, 0); if (date > today) throw new UnprocessableEntityException({ code: "FUTURE_REPORT_DATE_FORBIDDEN", message: "日报日期不能晚于今天", details: [] }); return date; }
  private decimal(value: string, code: string, message: string, allowZero = false) { try { const decimal = new Prisma.Decimal(value); if (allowZero ? decimal.lt(0) : !decimal.gt(0)) throw new Error(); return decimal; } catch { throw new UnprocessableEntityException({ code, message, details: [] }); } }
}
