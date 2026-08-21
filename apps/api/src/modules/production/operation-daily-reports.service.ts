import { Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { AuditService } from "../../platform/audit/audit.service";
import type { CurrentUser } from "../../platform/auth/auth.service";
import { PrismaService } from "../../platform/database/prisma.service";

type ReportInput = { production_order_id: string; production_order_operation_id: string; report_date: string; completed_quantity: string; remark?: string };
type ReportFilter = { order_no?: string; production_order_id?: string; production_order_operation_id?: string; report_date?: string };

@Injectable()
export class OperationDailyReportsService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  async list(filter: ReportFilter) {
    const rows = await this.prisma.operationDailyReport.findMany({
      where: {
        deletedAt: null,
        ...(filter.order_no ? { orderNo: filter.order_no } : {}),
        ...(filter.production_order_id ? { productionOrderId: filter.production_order_id } : {}),
        ...(filter.production_order_operation_id ? { productionOrderOperationId: filter.production_order_operation_id } : {}),
        ...(filter.report_date ? { reportDate: this.date(filter.report_date) } : {}),
      },
      include: { unit: true, productionOrderOperation: true },
      orderBy: [{ reportDate: "desc" }, { createdAt: "desc" }],
    });
    return rows;
  }

  async get(id: string) {
    const row = await this.prisma.operationDailyReport.findFirst({ where: { id, deletedAt: null }, include: { unit: true, productionOrder: true, productionOrderOperation: true } });
    if (!row) throw new NotFoundException({ code: "OPERATION_DAILY_REPORT_NOT_FOUND", message: "工序日报不存在", details: [] });
    return row;
  }

  async create(input: ReportInput, user: CurrentUser) {
    const reportDate = this.validDate(input.report_date);
    const quantity = this.decimal(input.completed_quantity, "INVALID_OPERATION_REPORT_QUANTITY", "工序日报完成量必须是大于零的十进制数");
    const refs = await this.refs(input.production_order_id, input.production_order_operation_id);
    const created = await this.prisma.$transaction(async (tx) => {
      const row = await tx.operationDailyReport.create({ data: {
        productionOrderId: refs.order.id, productionOrderOperationId: refs.operation.id, orderNo: refs.order.orderNo,
        productionOrderNoSnapshot: refs.order.productionOrderNo, operationNameSnapshot: refs.operation.operationNameSnapshot,
        unitId: refs.operation.unitId, reportDate, completedQuantity: quantity, remark: input.remark, ...this.audit.create(user),
      } });
      await this.recomputeOverOrder(tx, refs.order.id, refs.operation.id, user);
      return row;
    });
    await this.audit.record("operation_daily_report.create", "operation_daily_report", user.id, created.id, { order_no: created.orderNo, production_order_id: created.productionOrderId, reason: input.remark ?? null });
    return this.get(created.id);
  }

  async update(id: string, input: Partial<Omit<ReportInput, "production_order_id" | "production_order_operation_id">> & { reason: string }, user: CurrentUser) {
    if (!input.reason?.trim()) throw new UnprocessableEntityException({ code: "CORRECTION_REASON_REQUIRED", message: "修改工序日报必须填写原因", details: [] });
    const current = await this.get(id);
    const refs = await this.refs(current.productionOrderId, current.productionOrderOperationId, true);
    const reportDate = input.report_date === undefined ? current.reportDate : this.validDate(input.report_date);
    const quantity = input.completed_quantity === undefined ? current.completedQuantity : this.decimal(input.completed_quantity, "INVALID_OPERATION_REPORT_QUANTITY", "工序日报完成量必须是大于零的十进制数");
    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.operationDailyReport.update({ where: { id }, data: { reportDate, completedQuantity: quantity, ...(input.remark === undefined ? {} : { remark: input.remark }), ...this.audit.update(user) } });
      await this.recomputeOverOrder(tx, refs.order.id, refs.operation.id, user);
      return row;
    });
    await this.audit.record("operation_daily_report.update", "operation_daily_report", user.id, id, { order_no: current.orderNo, reason: input.reason, before: { report_date: current.reportDate.toISOString().slice(0, 10), completed_quantity: current.completedQuantity.toString() }, after: { report_date: reportDate.toISOString().slice(0, 10), completed_quantity: quantity.toString() } });
    return updated;
  }

  async remove(id: string, reason: string, user: CurrentUser) {
    if (!reason?.trim()) throw new UnprocessableEntityException({ code: "CORRECTION_REASON_REQUIRED", message: "删除工序日报必须填写原因", details: [] });
    const current = await this.get(id);
    await this.refs(current.productionOrderId, current.productionOrderOperationId, true);
    const removed = await this.prisma.$transaction(async (tx) => {
      const row = await tx.operationDailyReport.update({ where: { id }, data: this.audit.softDelete(user) });
      await this.recomputeOverOrder(tx, current.productionOrderId, current.productionOrderOperationId, user);
      return row;
    });
    await this.audit.record("operation_daily_report.delete", "operation_daily_report", user.id, id, { order_no: current.orderNo, reason });
    return removed;
  }

  async progress(productionOrderId: string) {
    const order = await this.prisma.productionOrder.findFirst({ where: { id: productionOrderId, deletedAt: null }, include: { operations: { where: { deletedAt: null }, orderBy: { sequenceNo: "asc" } } } });
    if (!order) throw new NotFoundException({ code: "PRODUCTION_ORDER_NOT_FOUND", message: "生产单不存在", details: [] });
    const operations = await Promise.all(order.operations.map(async (operation) => this.progressForOperation(operation)));
    return { production_order_id: order.id, production_order_no: order.productionOrderNo, order_no: order.orderNo, status: order.status, operations };
  }

  async impactPreview(id: string) {
    const current = await this.get(id);
    const progress = await this.progressForOperation(await this.prisma.productionOrderOperation.findUniqueOrThrow({ where: { id: current.productionOrderOperationId } }));
    return { report_id: id, order_no: current.orderNo, production_order_id: current.productionOrderId, operation_id: current.productionOrderOperationId, current: { report_date: current.reportDate.toISOString().slice(0, 10), completed_quantity: current.completedQuantity.toString() }, after_delete: progress, warning: "提交更正后将重算工序累计量和超单告警" };
  }

  private async progressForOperation(operation: { id: string; targetQuantity: Prisma.Decimal; status: string }) {
    const rows = await this.prisma.operationDailyReport.findMany({ where: { productionOrderOperationId: operation.id, deletedAt: null }, select: { completedQuantity: true } });
    const completed = rows.reduce((sum, row) => sum.plus(row.completedQuantity), new Prisma.Decimal(0));
    const target = new Prisma.Decimal(operation.targetQuantity);
    const difference = target.minus(completed);
    const over = completed.gt(target) ? completed.minus(target) : new Prisma.Decimal(0);
    return { operation_id: operation.id, target_quantity: target.toString(), cumulative_quantity: completed.toString(), difference_quantity: difference.toString(), over_order_quantity: over.toString(), status: operation.status === "cancelled" ? "cancelled" : completed.gt(target) ? "over_order" : completed.eq(target) ? "completed" : "in_progress" };
  }

  private async refs(orderId: string, operationId: string, correction = false) {
    const order = await this.prisma.productionOrder.findFirst({ where: { id: orderId, deletedAt: null } });
    const operation = await this.prisma.productionOrderOperation.findFirst({ where: { id: operationId, productionOrderId: orderId, deletedAt: null } });
    if (!order) throw new NotFoundException({ code: "PRODUCTION_ORDER_NOT_FOUND", message: "生产单不存在", details: [] });
    if (!operation) throw new UnprocessableEntityException({ code: "PRODUCTION_OPERATION_NOT_FOUND", message: "生产单工序不存在或已删除", details: [] });
    if (order.executionMode !== "in_house") throw new UnprocessableEntityException({ code: "OUTSOURCED_DAILY_REPORT_FORBIDDEN", message: "外加工生产单不进入厂内日报", details: [] });
    if (operation.status !== "active") throw new UnprocessableEntityException({ code: "CANCELLED_OPERATION_DAILY_REPORT_FORBIDDEN", message: "已取消工序不能新增日报", details: [] });
    const allowed = correction ? ["in_progress", "completed"] : ["in_progress", "completed"];
    if (!allowed.includes(order.status)) throw new UnprocessableEntityException({ code: "PRODUCTION_ORDER_DAILY_REPORT_FORBIDDEN", message: "当前生产单状态不允许维护日报", details: [] });
    return { order, operation };
  }

  private async recomputeOverOrder(tx: Prisma.TransactionClient, orderId: string, operationId: string, user: CurrentUser) {
    const operation = await tx.productionOrderOperation.findUniqueOrThrow({ where: { id: operationId } });
    const rows = await tx.operationDailyReport.findMany({ where: { productionOrderOperationId: operationId, deletedAt: null }, select: { completedQuantity: true } });
    const cumulative = rows.reduce((sum, row) => sum.plus(row.completedQuantity), new Prisma.Decimal(0));
    const target = new Prisma.Decimal(operation.targetQuantity);
    const over = cumulative.gt(target) ? cumulative.minus(target) : new Prisma.Decimal(0);
    const latest = await tx.operationDailyReport.findFirst({ where: { productionOrderOperationId: operationId, deletedAt: null }, orderBy: { reportDate: "desc" } });
    if (!latest) return;
    const existing = await tx.productionDailyAlert.findUnique({ where: { productionOrderOperationId_reportDate_alertType: { productionOrderOperationId: operationId, reportDate: latest.reportDate, alertType: "over_order" } } });
    if (over.gt(0)) {
      const data = { productionOrderId: orderId, orderNo: latest.orderNo, targetQuantity: target, operationReportQuantity: latest.completedQuantity, cumulativeQuantity: cumulative, overOrderQuantity: over, status: "pending", recoveredAt: null, updatedBy: user.id };
      if (existing) await tx.productionDailyAlert.update({ where: { id: existing.id }, data });
      else await tx.productionDailyAlert.create({ data: { productionOrderOperationId: operationId, reportDate: latest.reportDate, alertType: "over_order", ...data, createdBy: user.id } });
    } else if (existing && existing.status !== "recovered") await tx.productionDailyAlert.update({ where: { id: existing.id }, data: { status: "recovered", recoveredAt: new Date(), updatedBy: user.id } });
  }

  private date(value: string) { const result = new Date(`${value}T00:00:00.000Z`); if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(result.valueOf())) throw new UnprocessableEntityException({ code: "INVALID_REPORT_DATE", message: "日报日期必须是有效日期", details: [] }); return result; }
  private validDate(value: string) { const date = this.date(value); const today = new Date(); today.setUTCHours(0, 0, 0, 0); if (date > today) throw new UnprocessableEntityException({ code: "FUTURE_REPORT_DATE_FORBIDDEN", message: "日报日期不能晚于今天", details: [] }); return date; }
  private decimal(value: string, code: string, message: string) { try { const decimal = new Prisma.Decimal(value); if (!decimal.gt(0)) throw new Error(); return decimal; } catch { throw new UnprocessableEntityException({ code, message, details: [] }); } }
}
