import { Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { AuditService } from "../../platform/audit/audit.service";
import type { CurrentUser } from "../../platform/auth/auth.service";
import { PrismaService } from "../../platform/database/prisma.service";
import { reconcileDailyDiscrepancy } from "./daily-report-alerts";
import { ProductionProgressService } from "./production-progress.service";

// 计时单位口径（全站统一为“小时”）：对外的录入字段是 duration_hours（小时，最多 4 位小数）；
// duration_minutes 仅作为历史兼容字段保留（按分钟解释）。数据库 duration_minutes 列仍按分钟存储，
// 历史数据不做迁移；界面与导出一律按小时展示。
type Input = { production_order_id: string; production_order_operation_id: string; employee_id: string; report_date: string; wage_mode: string; quantity?: string; duration_hours?: string; duration_minutes?: string; unit_price?: string; remark?: string; idempotency_key?: string };
type Filter = { employee_id?: string; order_no?: string; production_order_id?: string; production_order_operation_id?: string; report_date?: string; from?: string; to?: string; wage_mode?: string };

/**
 * “时长是否改动”的判定容差（分钟）。界面按 4 位小数小时展示时长，
 * 展示值回传时的往返误差最多 0.5e-4 小时 = 0.003 分钟；不同引擎的 toFixed 进位差异也在同一量级。
 * 小于该量级的差异一律视为“没改”，避免只改备注的历史日报被顺带改写时长与金额。
 */
const DURATION_DISPLAY_TOLERANCE = new Prisma.Decimal("0.003");

@Injectable()
export class EmployeeDailyReportsService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly progress: ProductionProgressService) {}

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
    const refs = await this.refs(input.production_order_id, input.production_order_operation_id, input.employee_id, input.report_date, false);
    const values = this.values(input);
    const created = await this.prisma.$transaction(async (tx) => {
      await this.lockOrderAndAssertStatus(tx, refs.order.id, ["in_progress"]);
      await this.lockOperationAndAssert(tx, refs.operation.id, refs.order.id, true, "已取消工序不能新增员工日报");
      if (input.idempotency_key) {
        const previous = await tx.employeeDailyReport.findFirst({ where: { idempotencyKey: input.idempotency_key, deletedAt: null } });
        if (previous) return previous;
      }
      // 业务要求：同一天、同一生产单、同一工序、同一员工可以多次登记（多条日报，各自独立计薪），
      // 因此这里不再做“同一计薪方式合并”或“只能一种计薪方式”的限制，每次提交都新增一条。
      const row = await tx.employeeDailyReport.create({ data: { idempotencyKey: input.idempotency_key, productionOrderId: refs.order.id, productionOrderOperationId: refs.operation.id, employeeId: refs.employee.id, orderNo: refs.order.orderNo, productionOrderNoSnapshot: refs.order.productionOrderNo, operationNameSnapshot: refs.operation.operationNameSnapshot, employeeNameSnapshot: refs.employee.name, reportDate: refs.reportDate, wageMode: input.wage_mode, quantity: values.quantity, durationMinutes: values.durationMinutes, unitPrice: values.unitPrice, calculatedAmount: values.amount, remark: input.remark?.trim() ? input.remark.trim() : null, ...this.audit.create(user) } });
      await reconcileDailyDiscrepancy(tx, refs.order.id, refs.operation.id, refs.reportDate, user);
      await this.syncPayrollSource(tx, refs.employee.id, refs.order.id, refs.order.orderNo, refs.reportDate, input.wage_mode, user);
      await this.progress.recalculateInTransaction(tx, refs.order.id, "employee_daily_report", row.id, user);
      return row;
    });
    await this.audit.record("employee_daily_report.create", "employee_daily_report", user.id, created.id, { order_no: created.orderNo, remark: created.remark ?? null, accumulated: false });
    return this.get(created.id);
  }

  async createBatch(inputs: Input[], user: CurrentUser) {
    if (!inputs.length) throw new UnprocessableEntityException({ code: "EMPLOYEE_DAILY_REPORTS_REQUIRED", message: "请至少登记一名员工日报", details: [] });
    const first = inputs[0];
    if (inputs.some((input) => input.production_order_id !== first.production_order_id || input.production_order_operation_id !== first.production_order_operation_id || input.report_date !== first.report_date)) throw new UnprocessableEntityException({ code: "EMPLOYEE_DAILY_REPORT_BATCH_MISMATCH", message: "批量日报必须属于同一生产单、工序和日期", details: [] });
    const prepared = await Promise.all(inputs.map(async (input, index) => {
      const refs = await this.refs(input.production_order_id, input.production_order_operation_id, input.employee_id, input.report_date, false);
      return { input, refs, values: this.values(input) };
    }));
    const created = await this.prisma.$transaction(async (tx) => {
      await this.lockOrderAndAssertStatus(tx, prepared[0].refs.order.id, ["in_progress"]);
      await this.lockOperationAndAssert(tx, prepared[0].refs.operation.id, prepared[0].refs.order.id, true, "已取消工序不能新增员工日报");
      const rows = [];
      for (const item of prepared) rows.push(await this.createInTransaction(tx, item.input, item.refs, item.values, user));
      await this.progress.recalculateInTransaction(tx, prepared[0].refs.order.id, "employee_daily_report_batch", rows[rows.length - 1]?.id, user);
      return rows;
    });
    await this.audit.record("employee_daily_report.batch_create", "employee_daily_report", user.id, undefined, { order_no: prepared[0].refs.order.orderNo, production_order_operation_id: prepared[0].refs.operation.id, report_date: first.report_date, employee_count: created.length });
    return Promise.all(created.map((row) => this.get(row.id)));
  }

  private async createInTransaction(tx: Prisma.TransactionClient, input: Input, refs: Awaited<ReturnType<EmployeeDailyReportsService["refs"]>>, values: ReturnType<EmployeeDailyReportsService["values"]>, user: CurrentUser) {
    if (input.idempotency_key) {
      const previous = await tx.employeeDailyReport.findFirst({ where: { idempotencyKey: input.idempotency_key, deletedAt: null } });
      if (previous) return previous;
    }
    // 同一员工在同一批里出现多次是允许的（多条目），每条独立成行。
    const row = await tx.employeeDailyReport.create({ data: { idempotencyKey: input.idempotency_key, productionOrderId: refs.order.id, productionOrderOperationId: refs.operation.id, employeeId: refs.employee.id, orderNo: refs.order.orderNo, productionOrderNoSnapshot: refs.order.productionOrderNo, operationNameSnapshot: refs.operation.operationNameSnapshot, employeeNameSnapshot: refs.employee.name, reportDate: refs.reportDate, wageMode: input.wage_mode, quantity: values.quantity, durationMinutes: values.durationMinutes, unitPrice: values.unitPrice, calculatedAmount: values.amount, remark: input.remark?.trim() ? input.remark.trim() : null, ...this.audit.create(user) } });
    await reconcileDailyDiscrepancy(tx, refs.order.id, refs.operation.id, refs.reportDate, user);
    await this.syncPayrollSource(tx, refs.employee.id, refs.order.id, refs.order.orderNo, refs.reportDate, input.wage_mode, user);
    return row;
  }

  async update(id: string, input: Partial<Omit<Input, "production_order_id" | "production_order_operation_id" | "employee_id">> & { reason: string; expected_version?: number }, user: CurrentUser) {
    if (!input.reason?.trim()) throw new UnprocessableEntityException({ code: "CORRECTION_REASON_REQUIRED", message: "修改员工日报必须填写原因", details: [] });
    const current = await this.get(id);
    if (input.expected_version !== undefined && input.expected_version !== current.version) throw new UnprocessableEntityException({ code: "DAILY_REPORT_VERSION_CONFLICT", message: "员工日报已被其他操作更新，请刷新后重试", details: [{ expected_version: input.expected_version, actual_version: current.version }] });
    const reportDateText = input.report_date ?? current.reportDate.toISOString().slice(0, 10);
    const refs = await this.refs(current.productionOrderId, current.productionOrderOperationId, current.employeeId, reportDateText, true);
    // 备注为可清空字段：显式提交空串表示清空（存入 null），未提交则保持原值。
    const nextRemark = input.remark === undefined ? current.remark ?? null : (input.remark.trim() ? input.remark.trim() : null);
    // 与新增一致：同时提交两种时长单位属于口径歧义，直接拒绝，避免静默只取其一。
    if (input.duration_hours?.trim() && input.duration_minutes?.trim()) throw new UnprocessableEntityException({ code: "INVALID_EMPLOYEE_REPORT_DURATION", message: "请勿同时提交时长（小时）与时长（分钟），计时单位统一为小时", details: [] });
    // 旧数据的分钟数换算成小时展示后会丢精度（33.333 分钟 -> "0.5556"），客户端还会把展示值整包回传；
    // 因此判定按“生效值”比较，并留 0.003 分钟（= 4 位小数小时的半个末位）容差：
    // 不同引擎 toFixed 的进位差异（decimal.js 半进位 vs JS 二进制）与展示往返都不应被当成“改了时长”。
    // 注意：容差只用于“是否改动”的判定，不参与写入，真正改动时落库的仍是客户端给出的值。
    const providedMinutes = this.parseDurationHours(input.duration_hours);
    if (input.duration_hours?.trim() && providedMinutes === null) throw new UnprocessableEntityException({ code: "INVALID_EMPLOYEE_REPORT_DURATION", message: "员工日报时长必须是大于 0 的小时数，最多 4 位小数", details: [] });
    const durationProvided = providedMinutes !== null && !this.sameDuration(providedMinutes.mul(60), current.durationMinutes, DURATION_DISPLAY_TOLERANCE);
    const merged: Input = { production_order_id: current.productionOrderId, production_order_operation_id: current.productionOrderOperationId, employee_id: current.employeeId, report_date: reportDateText, wage_mode: input.wage_mode ?? current.wageMode, quantity: input.quantity ?? current.quantity.toString(), ...(durationProvided ? { duration_hours: input.duration_hours } : { duration_minutes: input.duration_minutes ?? (current.durationMinutes?.toString()) }), unit_price: input.unit_price ?? current.unitPrice.toString(), remark: nextRemark ?? undefined };
    const values = this.values(merged);
    // B3/P1-14 + 单位切换口径：只有真正进入金额公式的计价要素发生变化时才重算金额快照。
    // 判定必须比较“生效值”而不是“请求里是否带了这个字段”——前端保存时会整体回传当前值，
    // 只看字段存在会让“只改备注”把按分钟单价录入的历史日报静默重算（÷60）并波及工资台账。
    // 计件看 件数×单价，计时看 时长×单价，因此与金额无关的字段变化不触发重算。
    const recomputeAmount = merged.wage_mode !== current.wageMode
      || !values.unitPrice.eq(current.unitPrice)
      || (merged.wage_mode === "piece_rate" ? !values.quantity.eq(current.quantity) : !this.sameDuration(values.durationMinutes, current.durationMinutes, DURATION_DISPLAY_TOLERANCE));
    const updated = await this.prisma.$transaction(async (tx) => {
      await this.lockOrderAndAssertStatus(tx, current.productionOrderId, ["in_progress", "completed"]);
      await this.lockOperationAndAssert(tx, current.productionOrderOperationId, current.productionOrderId, true, "已取消工序的日报不允许修改（仅允许删除纠错）");
      await tx.$queryRaw`SELECT id FROM employee_daily_reports WHERE id = ${id}::uuid FOR UPDATE`;
      const locked = await tx.employeeDailyReport.findFirst({ where: { id, deletedAt: null }, select: { version: true } });
      if (!locked) throw new NotFoundException({ code: "EMPLOYEE_DAILY_REPORT_NOT_FOUND", message: "员工日报不存在", details: [] });
      if (input.expected_version !== undefined && input.expected_version !== locked.version) throw new UnprocessableEntityException({ code: "DAILY_REPORT_VERSION_CONFLICT", message: "员工日报已被其他操作更新，请刷新后重试", details: [{ expected_version: input.expected_version, actual_version: locked.version }] });
      // 业务要求：同一天、同一生产单、同一工序、同一员工允许存在多条日报（可复选、可混合计薪方式），
      // 因此修改时也不再校验“目标日期+计薪方式是否已存在”或“只能一种计薪方式”。
      const row = await tx.employeeDailyReport.update({ where: { id }, data: { reportDate: refs.reportDate, wageMode: merged.wage_mode, quantity: values.quantity, durationMinutes: values.durationMinutes, unitPrice: values.unitPrice, ...(recomputeAmount ? { calculatedAmount: values.amount } : {}), remark: nextRemark, version: { increment: 1 }, ...this.audit.update(user) } });
      await reconcileDailyDiscrepancy(tx, current.productionOrderId, current.productionOrderOperationId, current.reportDate, user);
      if (refs.reportDate.getTime() !== current.reportDate.getTime()) await reconcileDailyDiscrepancy(tx, current.productionOrderId, current.productionOrderOperationId, refs.reportDate, user);
      await this.syncPayrollSource(tx, current.employeeId, current.productionOrderId, current.orderNo, current.reportDate, current.wageMode, user);
      await this.syncPayrollSource(tx, current.employeeId, current.productionOrderId, current.orderNo, refs.reportDate, merged.wage_mode, user);
      await this.progress.recalculateInTransaction(tx, current.productionOrderId, "employee_daily_report", row.id, user);
      return row;
    });
    await this.audit.record("employee_daily_report.update", "employee_daily_report", user.id, id, { order_no: current.orderNo, reason: input.reason, before_amount: current.calculatedAmount.toString(), after_amount: recomputeAmount ? values.amount.toString() : current.calculatedAmount.toString() });
    return updated;
  }

  async remove(id: string, reason: string, user: CurrentUser, expectedVersion?: number) {
    if (!reason?.trim()) throw new UnprocessableEntityException({ code: "CORRECTION_REASON_REQUIRED", message: "删除员工日报必须填写原因", details: [] });
    const current = await this.get(id);
    if (expectedVersion !== undefined && expectedVersion !== current.version) throw new UnprocessableEntityException({ code: "DAILY_REPORT_VERSION_CONFLICT", message: "员工日报已被其他操作更新，请刷新后重试", details: [{ expected_version: expectedVersion, actual_version: current.version }] });
    await this.refs(current.productionOrderId, current.productionOrderOperationId, current.employeeId, current.reportDate.toISOString().slice(0, 10), true);
    const removed = await this.prisma.$transaction(async (tx) => {
      await this.lockOrderAndAssertStatus(tx, current.productionOrderId, ["in_progress", "completed"]);
      await this.lockOperationAndAssert(tx, current.productionOrderOperationId, current.productionOrderId, false, "");
      await tx.$queryRaw`SELECT id FROM employee_daily_reports WHERE id = ${id}::uuid FOR UPDATE`;
      const locked = await tx.employeeDailyReport.findFirst({ where: { id, deletedAt: null }, select: { version: true } });
      if (!locked) throw new NotFoundException({ code: "EMPLOYEE_DAILY_REPORT_NOT_FOUND", message: "员工日报不存在", details: [] });
      if (expectedVersion !== undefined && expectedVersion !== locked.version) throw new UnprocessableEntityException({ code: "DAILY_REPORT_VERSION_CONFLICT", message: "员工日报已被其他操作更新，请刷新后重试", details: [{ expected_version: expectedVersion, actual_version: locked.version }] });
      const row = await tx.employeeDailyReport.update({ where: { id }, data: { ...this.audit.softDelete(user), version: { increment: 1 } } });
      await reconcileDailyDiscrepancy(tx, current.productionOrderId, current.productionOrderOperationId, current.reportDate, user);
      await this.syncPayrollSource(tx, current.employeeId, current.productionOrderId, current.orderNo, current.reportDate, current.wageMode, user);
      await this.progress.recalculateInTransaction(tx, current.productionOrderId, "employee_daily_report", id, user);
      return row;
    });
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
    // 对外统一小时口径：duration_hours 为换算值（分钟 ÷ 60，保留 4 位小数去尾零），duration_minutes 保留原始分钟（历史兼容）。
    return [...groups.values()].map((item) => ({ ...item, quantity: item.quantity.toString(), duration_minutes: item.duration_minutes.toString(), duration_hours: this.toHoursText(item.duration_minutes), amount: item.amount.toString(), source_read_only: true }));
  }

  /** 分钟 -> 小时文案（最多 4 位小数、去掉尾随零），与前端 hoursText、导出 hours() 保持同一口径；极小非零值提升精度避免显示成 0。 */
  private toHoursText(durationMinutes: Prisma.Decimal | null | undefined) {
    if (durationMinutes === null || durationMinutes === undefined) return "";
    const hours = new Prisma.Decimal(durationMinutes).div(60);
    const text = this.trimZeros(hours.toFixed(4));
    if (text !== "0" || hours.isZero()) return text;
    return this.trimZeros(hours.toFixed(8));
  }

  private trimZeros(value: string) {
    return value.replace(/0+$/, "").replace(/\.$/, "");
  }

  /** 分钟比较：null 表示“未填写”，与任何数值都不相等；两边都是数值时差值在容差内视为相同。 */
  private sameDuration(left: Prisma.Decimal | null | undefined, right: Prisma.Decimal | null | undefined, tolerance: Prisma.Decimal = new Prisma.Decimal(0)) {
    if (left === null || left === undefined) return right === null || right === undefined;
    if (right === null || right === undefined) return false;
    return new Prisma.Decimal(left).minus(right).abs().lte(tolerance);
  }

  /** 解析 duration_hours（最多 4 位小数、必须大于 0）；解析失败返回 null，由调用方决定报错口径。 */
  private parseDurationHours(value: string | undefined): Prisma.Decimal | null {
    const trimmed = value?.trim();
    if (!trimmed || !/^\d+(?:\.\d{1,4})?$/.test(trimmed)) return null;
    try {
      const parsed = new Prisma.Decimal(trimmed);
      return parsed.isFinite() && parsed.gt(0) ? parsed : null;
    } catch {
      return null;
    }
  }

  /** B6: in correction mode (update/remove) skip employment status and hired/left window checks so departed/deactivated employees can still be corrected or removed. Date legality and order/operation state are still validated (also re-checked inside the transaction). */
  private async refs(orderId: string, operationId: string, employeeId: string, dateText: string, correction = false) {
    const reportDate = this.validDate(dateText);
    const [order, operation, employee] = await Promise.all([this.prisma.productionOrder.findFirst({ where: { id: orderId, deletedAt: null } }), this.prisma.productionOrderOperation.findFirst({ where: { id: operationId, productionOrderId: orderId, deletedAt: null } }), this.prisma.employee.findFirst({ where: { id: employeeId, deletedAt: null } })]);
    if (!order) throw new NotFoundException({ code: "PRODUCTION_ORDER_NOT_FOUND", message: "生产单不存在", details: [] });
    if (order.executionMode !== "in_house") throw new UnprocessableEntityException({ code: "OUTSOURCED_DAILY_REPORT_FORBIDDEN", message: "外加工生产单不进入员工日报", details: [] });
    if (!operation || (!correction && operation.status !== "active")) throw new UnprocessableEntityException({ code: "PRODUCTION_OPERATION_NOT_FOUND", message: "生产单工序不存在或已取消", details: [] });
    if (!employee || (!correction && employee.employmentStatus !== "active")) throw new UnprocessableEntityException({ code: "EMPLOYEE_DAILY_REPORT_FORBIDDEN", message: "员工不存在、已停用或已离职", details: [] });
    if (!correction && ((employee.hiredOn && reportDate < employee.hiredOn) || (employee.leftOn && reportDate > employee.leftOn))) throw new UnprocessableEntityException({ code: "EMPLOYEE_NOT_EMPLOYED_ON_REPORT_DATE", message: "员工在日报日期不处于可报工状态", details: [] });
    if (!(correction ? ["in_progress", "completed"] : ["in_progress"]).includes(order.status)) throw new UnprocessableEntityException({ code: "PRODUCTION_ORDER_DAILY_REPORT_FORBIDDEN", message: "当前生产单状态不允许维护员工日报", details: [] });
    return { order, operation, employee, reportDate };
  }

  private values(input: Input) {
    if (input.wage_mode !== "piece_rate" && input.wage_mode !== "time_rate") throw new UnprocessableEntityException({ code: "INVALID_WAGE_MODE", message: "计薪方式无效", details: [] });
    const quantity = input.quantity?.trim() ? this.decimal(input.quantity, "INVALID_EMPLOYEE_REPORT_QUANTITY", input.wage_mode === "piece_rate" ? "计件日报件数必须大于零" : "员工日报件数必须是非负十进制数", input.wage_mode !== "piece_rate") : new Prisma.Decimal(0);
    if (input.wage_mode === "piece_rate" && quantity.isZero()) throw new UnprocessableEntityException({ code: "PIECE_REPORT_QUANTITY_REQUIRED", message: "计件日报必须填写件数", details: [] });
    // 单位口径：计时统一按“小时”录入/展示（duration_hours，最多 4 位小数），
    // duration_minutes 为历史兼容字段（按分钟解释）；两者不可同时提交。落库仍为分钟（小时 × 60）。
    const hoursInput = input.duration_hours?.trim();
    const minutesInput = input.duration_minutes?.trim();
    if (hoursInput && minutesInput) throw new UnprocessableEntityException({ code: "INVALID_EMPLOYEE_REPORT_DURATION", message: "请勿同时提交时长（小时）与时长（分钟），计时单位统一为小时", details: [] });
    let durationHours: Prisma.Decimal | undefined;
    let durationMinutes: Prisma.Decimal | undefined;
    if (hoursInput) {
      durationHours = this.decimal(hoursInput, "INVALID_EMPLOYEE_REPORT_DURATION", "员工日报时长必须是大于 0 的小时数，最多 4 位小数");
      durationMinutes = durationHours.mul(60);
    } else if (minutesInput) {
      durationMinutes = this.decimal(minutesInput, "INVALID_EMPLOYEE_REPORT_DURATION", "员工日报时长必须是大于 0 的分钟数，最多 4 位小数");
      durationHours = durationMinutes.div(60);
    }
    if (input.wage_mode === "time_rate" && !durationHours) throw new UnprocessableEntityException({ code: "TIME_REPORT_DURATION_REQUIRED", message: "计时日报必须填写时长（小时）", details: [] });
    // 小时 × 60 之后也要落在 Decimal(18,4) 内（整数部分最多 14 位），否则会以数据库错误（500）而不是 422 收场。
    if (durationMinutes) this.assertStorable(durationMinutes, "INVALID_EMPLOYEE_REPORT_DURATION", "员工日报时长超出可存储范围");
    const unitPrice = input.unit_price?.trim();
    if (!unitPrice) throw new UnprocessableEntityException({ code: "DAILY_WAGE_PRICE_REQUIRED", message: "请填写当日人工单价", details: [] });
    const price = this.decimal(unitPrice, "INVALID_UNIT_PRICE", "单价必须是非负十进制数", true);
    // 计件：金额 = 件数 × 单价（元/件）；计时：金额 = 时长（小时）× 单价（元/小时）。
    // 计时金额严格由落库的分钟数换算（分钟 ÷ 60 × 单价），保证金额与存储时长始终自洽。
    const amount = input.wage_mode === "piece_rate" ? quantity.mul(price) : (durationMinutes as Prisma.Decimal).div(60).mul(price);
    this.assertStorable(amount, "INVALID_EMPLOYEE_REPORT_AMOUNT", "员工日报金额超出可存储范围");
    return { quantity, durationHours, durationMinutes, unitPrice: price, amount };
  }

  /** Decimal(18,4) 的整数部分最多 14 位；超出时抛出 422，避免落到数据库层变成 500。 */
  private assertStorable(value: Prisma.Decimal, code: string, message: string) {
    if (new Prisma.Decimal(value).abs().gte(new Prisma.Decimal("1e14"))) throw new UnprocessableEntityException({ code, message, details: [] });
    return value;
  }

  private async syncPayrollSource(client: Prisma.TransactionClient, employeeId: string, productionOrderId: string, orderNo: string, reportDate: Date, wageMode: string, user: CurrentUser) {
    const employee = await client.employee.findFirst({ where: { id: employeeId, deletedAt: null }, select: { employeeType: true } });
    if (employee?.employeeType !== "workshop") {
      const existing = await client.productionPayrollSource.findFirst({ where: { employeeId, productionOrderId, periodStart: reportDate, periodEnd: reportDate, wageMode, deletedAt: null } });
      if (existing) await client.productionPayrollSource.update({ where: { id: existing.id }, data: { ...this.audit.softDelete(user) } });
      await this.reconcilePayrollLedgers(client, employeeId, reportDate, orderNo, user);
      await this.refreshDraftPayrollLedgers(client, employeeId, reportDate, user);
      return;
    }
    const rows = await client.employeeDailyReport.findMany({ where: { deletedAt: null, employeeId, productionOrderId, reportDate, wageMode }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
    const existing = await client.productionPayrollSource.findFirst({ where: { employeeId, productionOrderId, periodStart: reportDate, periodEnd: reportDate, wageMode, deletedAt: null } });
    if (!rows.length) {
      if (existing) await client.productionPayrollSource.update({ where: { id: existing.id }, data: { ...this.audit.softDelete(user) } });
      await this.reconcilePayrollLedgers(client, employeeId, reportDate, orderNo, user);
      await this.refreshDraftPayrollLedgers(client, employeeId, reportDate, user);
      return;
    }
    const quantity = rows.reduce((sum, row) => sum.plus(row.quantity), new Prisma.Decimal(0));
    const durationMinutes = rows.reduce((sum, row) => sum.plus(row.durationMinutes ?? 0), new Prisma.Decimal(0));
    const amount = rows.reduce((sum, row) => sum.plus(row.calculatedAmount), new Prisma.Decimal(0));
    // 聚合值同样要落在 Decimal(18,4) 内：多条各自合法的日报相加也可能超限，
    // 这里提前 422，避免聚合结果在数据库层报错（500）并把整个事务状态留在半途。
    this.assertStorable(quantity, "PAYROLL_SOURCE_QUANTITY_OUT_OF_RANGE", "该员工当日件数合计超出可存储范围");
    this.assertStorable(durationMinutes, "PAYROLL_SOURCE_DURATION_OUT_OF_RANGE", "该员工当日时长合计超出可存储范围");
    this.assertStorable(amount, "PAYROLL_SOURCE_AMOUNT_OUT_OF_RANGE", "该员工当日薪资合计超出可存储范围");
    // 薪资来源快照按条留存全部日报（含同一员工同日同工序的重复登记），便于工资侧逐条追溯；
    // 时长同时给出分钟（落库口径）与小时（对外口径），未填写时长（计件）两者都为空串，保持同一对象内自洽。
    const sourceSnapshot = rows.map((row) => ({ id: row.id, report_date: row.reportDate.toISOString().slice(0, 10), employee_name: row.employeeNameSnapshot, order_no: row.orderNo, wage_mode: row.wageMode, quantity: row.quantity.toString(), duration_minutes: row.durationMinutes?.toString() ?? "", duration_hours: this.toHoursText(row.durationMinutes), amount: row.calculatedAmount.toString() }));
    const data = { employeeId, productionOrderId, orderNo, periodStart: reportDate, periodEnd: reportDate, wageMode, quantity, durationMinutes, amount, sourceSnapshot: sourceSnapshot as Prisma.InputJsonValue, remark: null };
    await client.productionPayrollSource.upsert({
      where: { employeeId_productionOrderId_periodStart_periodEnd_wageMode: { employeeId, productionOrderId, periodStart: reportDate, periodEnd: reportDate, wageMode } },
      update: { ...data, deletedAt: null, deletedBy: null, ...this.audit.update(user) },
      create: { ...data, ...this.audit.create(user) },
    });
    await this.reconcilePayrollLedgers(client, employeeId, reportDate, orderNo, user);
    await this.refreshDraftPayrollLedgers(client, employeeId, reportDate, user);
  }

  /** B5/P1-15: a production-side report mutation may never silently expire HR ledgers. Only confirmed ledgers may auto-expire (each with an audit trail); partially paid / paid ledgers stay untouched and raise an audit event for finance handling. Draft ledgers keep the automatic recompute in refreshDraftPayrollLedgers. */
  private async reconcilePayrollLedgers(client: Prisma.TransactionClient, employeeId: string, reportDate: Date, orderNo: string, user: CurrentUser) {
    const affected = await client.payrollLedger.findMany({ where: { employeeId, periodStart: { lte: reportDate }, periodEnd: { gte: reportDate }, status: { in: ["confirmed", "partially_paid", "paid"] }, deletedAt: null }, select: { id: true, ledgerNo: true, periodStart: true, periodEnd: true, status: true } });
    const expired = affected.filter((ledger) => ledger.status === "confirmed");
    const blocked = affected.filter((ledger) => ledger.status === "partially_paid" || ledger.status === "paid");
    if (expired.length) {
      await client.payrollLedger.updateMany({ where: { id: { in: expired.map((ledger) => ledger.id) }, status: "confirmed", deletedAt: null }, data: { status: "expired", ...this.audit.update(user) } });
      for (const ledger of expired) {
        await client.auditEvent.create({ data: { action: "production_payroll_source.expire_ledger", entityType: "payroll_ledger", actorId: user.id, entityId: ledger.id, details: { order_no: orderNo, actor: user.id, ledger_no: ledger.ledgerNo, period: { start: ledger.periodStart.toISOString().slice(0, 10), end: ledger.periodEnd.toISOString().slice(0, 10) }, from_status: "confirmed", to_status: "expired" } } });
      }
    }
    for (const ledger of blocked) {
      await client.auditEvent.create({ data: { action: "production_payroll_source.paid_ledger_blocked", entityType: "payroll_ledger", actorId: user.id, entityId: ledger.id, details: { order_no: orderNo, actor: user.id, ledger_no: ledger.ledgerNo, period: { start: ledger.periodStart.toISOString().slice(0, 10), end: ledger.periodEnd.toISOString().slice(0, 10) }, status: ledger.status, note: "已付/部分付款工资台账不允许自动过期，请由财务处理后再维护生产薪资来源" } } });
    }
  }

  private async refreshDraftPayrollLedgers(client: Prisma.TransactionClient, employeeId: string, reportDate: Date, user: CurrentUser) {
    const ledgers = await client.payrollLedger.findMany({ where: { employeeId, periodStart: { lte: reportDate }, periodEnd: { gte: reportDate }, status: "draft", deletedAt: null }, select: { id: true, periodStart: true, periodEnd: true } });
    for (const ledger of ledgers) {
      const sources = await client.productionPayrollSource.findMany({ where: { employeeId, periodStart: { gte: ledger.periodStart }, periodEnd: { lte: ledger.periodEnd }, deletedAt: null }, orderBy: [{ periodStart: "asc" }, { orderNo: "asc" }, { wageMode: "asc" }] });
      const production = sources.reduce((sum, source) => sum.plus(source.amount), new Prisma.Decimal(0));
      this.assertStorable(production, "PAYROLL_LEDGER_AMOUNT_OUT_OF_RANGE", "该工资台账生产来源合计超出可存储范围");
      const sourceSnapshot = sources.map((source) => ({ id: source.id, order_no: source.orderNo, wage_mode: source.wageMode, quantity: source.quantity.toString(), duration_minutes: source.durationMinutes.toString(), duration_hours: this.toHoursText(source.durationMinutes), amount: source.amount.toString() })) as Prisma.InputJsonValue;
      await client.payrollLedger.update({ where: { id: ledger.id }, data: { productionSourceAmount: production, sourceSnapshot, ...this.audit.update(user) } });
    }
  }

  /** P1-3: after locking the production order row inside the transaction, re-read and re-validate its state so a concurrent transition cannot slip a write onto a completed/paused/closed order. */
  private async lockOrderAndAssertStatus(tx: Prisma.TransactionClient, orderId: string, allowedStatuses: string[]) {
    await tx.$queryRaw`SELECT id FROM production_orders WHERE id = ${orderId}::uuid FOR UPDATE`;
    const order = await tx.productionOrder.findFirst({ where: { id: orderId, deletedAt: null }, select: { status: true, executionMode: true } });
    if (!order) throw new NotFoundException({ code: "PRODUCTION_ORDER_NOT_FOUND", message: "生产单不存在", details: [] });
    if (order.executionMode !== "in_house") throw new UnprocessableEntityException({ code: "OUTSOURCED_DAILY_REPORT_FORBIDDEN", message: "外加工生产单不进入员工日报", details: [] });
    if (!allowedStatuses.includes(order.status)) throw new UnprocessableEntityException({ code: "PRODUCTION_ORDER_DAILY_REPORT_FORBIDDEN", message: "当前生产单状态不允许维护员工日报", details: [{ order_status: order.status }] });
  }

  /** P1-3/B14: lock the operation row and assert it still exists; when requireActive, a cancelled operation only allows removal-style corrections (update/create rejected). */
  private async lockOperationAndAssert(tx: Prisma.TransactionClient, operationId: string, orderId: string, requireActive: boolean, cancelledMessage: string) {
    await tx.$queryRaw`SELECT id FROM production_order_operations WHERE id = ${operationId}::uuid FOR UPDATE`;
    const operation = await tx.productionOrderOperation.findFirst({ where: { id: operationId, productionOrderId: orderId, deletedAt: null }, select: { status: true } });
    if (!operation) throw new UnprocessableEntityException({ code: "PRODUCTION_OPERATION_NOT_FOUND", message: "生产单工序不存在或已取消", details: [] });
    if (requireActive && operation.status !== "active") throw new UnprocessableEntityException({ code: "CANCELLED_OPERATION_DAILY_REPORT_FORBIDDEN", message: cancelledMessage, details: [{ operation_status: operation.status }] });
  }

  private date(value: string) { const date = new Date(`${value}T00:00:00.000Z`); if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(date.valueOf())) throw new UnprocessableEntityException({ code: "INVALID_REPORT_DATE", message: "日报日期必须是有效日期", details: [] }); return date; }
  private validDate(value: string) { const date = this.date(value); const today = new Date(); today.setUTCHours(0, 0, 0, 0); if (date > today) throw new UnprocessableEntityException({ code: "FUTURE_REPORT_DATE_FORBIDDEN", message: "日报日期不能晚于今天", details: [] }); return date; }

  /** B13: unified decimal input guard — rejects exponent notation, more than 4 fractional digits and values outside Decimal(18,4) (integer part beyond 14 digits). */
  private decimal(value: string, code: string, message: string, allowZero = false) {
    const trimmed = value.trim();
    const match = /^(\d+)(?:\.(\d{1,4}))?$/.exec(trimmed);
    if (!match || match[1].replace(/^0+/, "").length > 14) throw new UnprocessableEntityException({ code, message, details: [] });
    const decimal = new Prisma.Decimal(trimmed);
    if (allowZero ? decimal.lt(0) : !decimal.gt(0)) throw new UnprocessableEntityException({ code, message, details: [] });
    return decimal;
  }
}
