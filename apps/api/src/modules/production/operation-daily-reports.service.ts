import { Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { AuditService } from "../../platform/audit/audit.service";
import type { CurrentUser } from "../../platform/auth/auth.service";
import { PrismaService } from "../../platform/database/prisma.service";
import { ProductionProgressService } from "./production-progress.service";
// Shared cross-caliber discrepancy reconciliation extracted in task T2a; mirrors the former
// employee-daily-reports recomputeDiscrepancy (FOR UPDATE + alert upsert/recovery + audit).
import { reconcileDailyDiscrepancy } from "./daily-report-alerts";

type ReportInput = { production_order_id: string; production_order_operation_id: string; report_date: string; completed_quantity: string; remark?: string; idempotency_key?: string };
type ReportFilter = { order_no?: string; production_order_id?: string; production_order_operation_id?: string; report_date?: string };
type LockMode = "create" | "update" | "remove";
// Largest value representable by a Decimal(18,4) column: 14 integer digits + 4 fraction digits.
const MAX_QUANTITY = new Prisma.Decimal("99999999999999.9999");

@Injectable()
export class OperationDailyReportsService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly progressService: ProductionProgressService) {}

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
    // Fast path outside the transaction (kept): cheap replay detection for already-committed keys.
    if (input.idempotency_key) { const previous = await this.prisma.operationDailyReport.findFirst({ where: { idempotencyKey: input.idempotency_key, deletedAt: null } }); if (previous) return this.get(previous.id); }
    const reportDate = this.validDate(input.report_date);
    const quantity = this.decimal(input.completed_quantity, "INVALID_OPERATION_REPORT_QUANTITY", "工序日报完成量必须是大于零、最多 4 位小数且不超过 18,4 精度范围的十进制数");
    const today = new Date(); today.setUTCHours(0, 0, 0, 0);
    if (reportDate.getTime() < today.getTime() && !input.remark?.trim()) throw new UnprocessableEntityException({ code: "BACKFILL_REASON_REQUIRED", message: "补录早于今天的工序日报必须填写原因（remark）", details: [] });
    const refs = await this.refs(input.production_order_id, input.production_order_operation_id);
    const created = await this.prisma.$transaction(async (tx) => {
      // Re-lock and re-validate parent order + operation state under the transaction (P1-3).
      await this.lockOrderAndOperation(tx, refs.order.id, refs.operation.id, "create");
      // In-transaction idempotency re-check after acquiring the operation row lock (P1-17).
      if (input.idempotency_key) {
        const previous = await tx.operationDailyReport.findFirst({ where: { idempotencyKey: input.idempotency_key, deletedAt: null } });
        if (previous) return previous;
      }
      const existing = await tx.operationDailyReport.findFirst({ where: { productionOrderOperationId: refs.operation.id, reportDate, deletedAt: null }, orderBy: { createdAt: "asc" } });
      if (existing && existing.completedQuantity.plus(quantity).gt(MAX_QUANTITY)) throw new UnprocessableEntityException({ code: "INVALID_OPERATION_REPORT_QUANTITY", message: "合并后的工序日报累计量超过 18,4 精度范围", details: [] });
      const row = existing
        ? await tx.operationDailyReport.update({ where: { id: existing.id }, data: { completedQuantity: existing.completedQuantity.plus(quantity), remark: input.remark ?? existing.remark, version: { increment: 1 }, ...this.audit.update(user) } })
        : await tx.operationDailyReport.create({ data: {
          productionOrderId: refs.order.id, productionOrderOperationId: refs.operation.id, orderNo: refs.order.orderNo,
          idempotencyKey: input.idempotency_key, productionOrderNoSnapshot: refs.order.productionOrderNo, operationNameSnapshot: refs.operation.operationNameSnapshot,
          unitId: refs.operation.unitId, reportDate, completedQuantity: quantity, remark: input.remark, ...this.audit.create(user),
        } });
      await this.recomputeOverOrder(tx, refs.order.id, refs.operation.id, user);
      await reconcileDailyDiscrepancy(tx, refs.order.id, refs.operation.id, reportDate, user);
      await this.progressService.recalculateInTransaction(tx, refs.order.id, "operation_daily_report", row.id, user);
      return row;
    });
    await this.audit.record("operation_daily_report.create", "operation_daily_report", user.id, created.id, { order_no: created.orderNo, production_order_id: created.productionOrderId, reason: input.remark ?? null });
    return this.get(created.id);
  }

  async update(id: string, input: Partial<Omit<ReportInput, "production_order_id" | "production_order_operation_id">> & { reason: string; expected_version?: number }, user: CurrentUser) {
    if (!input.reason?.trim()) throw new UnprocessableEntityException({ code: "CORRECTION_REASON_REQUIRED", message: "修改工序日报必须填写原因", details: [] });
    const current = await this.get(id);
    if (input.expected_version !== undefined && input.expected_version !== current.version) throw new UnprocessableEntityException({ code: "DAILY_REPORT_VERSION_CONFLICT", message: "工序日报已被其他操作更新，请刷新后重试", details: [{ expected_version: input.expected_version, actual_version: current.version }] });
    const refs = await this.refs(current.productionOrderId, current.productionOrderOperationId, true);
    const reportDate = input.report_date === undefined ? current.reportDate : this.validDate(input.report_date);
    const quantity = input.completed_quantity === undefined ? current.completedQuantity : this.decimal(input.completed_quantity, "INVALID_OPERATION_REPORT_QUANTITY", "工序日报完成量必须是大于零、最多 4 位小数且不超过 18,4 精度范围的十进制数");
    const dateChanged = reportDate.getTime() !== current.reportDate.getTime();
    const updated = await this.prisma.$transaction(async (tx) => {
      // Canonical lock order: operation row -> parent order row -> report row; re-validate state under lock (P1-3).
      const state = await this.lockOrderAndOperation(tx, refs.order.id, refs.operation.id, "update");
      await tx.$queryRaw`SELECT id FROM operation_daily_reports WHERE id = ${id}::uuid FOR UPDATE`;
      const locked = await tx.operationDailyReport.findFirst({ where: { id, deletedAt: null }, select: { version: true } });
      if (!locked) throw new NotFoundException({ code: "OPERATION_DAILY_REPORT_NOT_FOUND", message: "工序日报不存在", details: [] });
      if (input.expected_version !== undefined && input.expected_version !== locked.version) throw new UnprocessableEntityException({ code: "DAILY_REPORT_VERSION_CONFLICT", message: "工序日报已被其他操作更新，请刷新后重试", details: [{ expected_version: input.expected_version, actual_version: locked.version }] });
      // B14: a report of a cancelled operation is frozen; only deletion-based correction is allowed.
      if (state.operation.status === "cancelled" && (input.report_date !== undefined || input.completed_quantity !== undefined || input.remark !== undefined)) throw new UnprocessableEntityException({ code: "OPERATION_CANCELLED_REPORT_FROZEN", message: "工序已取消，日报已冻结，仅支持删除纠错", details: [] });
      // P1-4: never produce a second live row for the same operation + target date.
      const duplicateTarget = await tx.operationDailyReport.findFirst({ where: { productionOrderOperationId: refs.operation.id, reportDate, deletedAt: null, id: { not: id } }, select: { id: true } });
      if (duplicateTarget) throw new UnprocessableEntityException({ code: "DAILY_REPORT_DUPLICATE_TARGET", message: "目标日期已存在同工序日报，请先更正或删除原日报", details: [{ target_report_id: duplicateTarget.id }] });
      const row = await tx.operationDailyReport.update({ where: { id }, data: { reportDate, completedQuantity: quantity, version: { increment: 1 }, ...(input.remark === undefined ? {} : { remark: input.remark }), ...this.audit.update(user) } });
      await this.recomputeOverOrder(tx, refs.order.id, refs.operation.id, user);
      await reconcileDailyDiscrepancy(tx, refs.order.id, refs.operation.id, current.reportDate, user);
      if (dateChanged) await reconcileDailyDiscrepancy(tx, refs.order.id, refs.operation.id, reportDate, user);
      await this.progressService.recalculateInTransaction(tx, refs.order.id, "operation_daily_report", row.id, user);
      return row;
    });
    await this.audit.record("operation_daily_report.update", "operation_daily_report", user.id, id, { order_no: current.orderNo, reason: input.reason, before: { report_date: current.reportDate.toISOString().slice(0, 10), completed_quantity: current.completedQuantity.toString() }, after: { report_date: reportDate.toISOString().slice(0, 10), completed_quantity: quantity.toString() } });
    return updated;
  }

  async remove(id: string, reason: string, user: CurrentUser, expectedVersion?: number) {
    if (!reason?.trim()) throw new UnprocessableEntityException({ code: "CORRECTION_REASON_REQUIRED", message: "删除工序日报必须填写原因", details: [] });
    const current = await this.get(id);
    if (expectedVersion !== undefined && expectedVersion !== current.version) throw new UnprocessableEntityException({ code: "DAILY_REPORT_VERSION_CONFLICT", message: "工序日报已被其他操作更新，请刷新后重试", details: [{ expected_version: expectedVersion, actual_version: current.version }] });
    const refs = await this.refs(current.productionOrderId, current.productionOrderOperationId, true);
    const removed = await this.prisma.$transaction(async (tx) => {
      // Canonical lock order: operation row -> parent order row -> report row; re-validate state under lock (P1-3).
      await this.lockOrderAndOperation(tx, refs.order.id, refs.operation.id, "remove");
      await tx.$queryRaw`SELECT id FROM operation_daily_reports WHERE id = ${id}::uuid FOR UPDATE`;
      const locked = await tx.operationDailyReport.findFirst({ where: { id, deletedAt: null }, select: { version: true } });
      if (!locked) throw new NotFoundException({ code: "OPERATION_DAILY_REPORT_NOT_FOUND", message: "工序日报不存在", details: [] });
      if (expectedVersion !== undefined && expectedVersion !== locked.version) throw new UnprocessableEntityException({ code: "DAILY_REPORT_VERSION_CONFLICT", message: "工序日报已被其他操作更新，请刷新后重试", details: [{ expected_version: expectedVersion, actual_version: locked.version }] });
      const row = await tx.operationDailyReport.update({ where: { id }, data: { ...this.audit.softDelete(user), version: { increment: 1 } } });
      await this.recomputeOverOrder(tx, refs.order.id, refs.operation.id, user);
      await reconcileDailyDiscrepancy(tx, refs.order.id, refs.operation.id, current.reportDate, user);
      await this.progressService.recalculateInTransaction(tx, refs.order.id, "operation_daily_report", id, user);
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
    const operation = await this.prisma.productionOrderOperation.findFirst({ where: { id: current.productionOrderOperationId, deletedAt: null } });
    if (!operation) throw new NotFoundException({ code: "PRODUCTION_OPERATION_NOT_FOUND", message: "生产单工序不存在", details: [] });
    const [beforeDelete, afterDelete] = await Promise.all([this.progressForOperation(operation), this.progressForOperation(operation, current.id)]);
    return { report_id: id, order_no: current.orderNo, production_order_id: current.productionOrderId, operation_id: current.productionOrderOperationId, current: { report_date: current.reportDate.toISOString().slice(0, 10), completed_quantity: current.completedQuantity.toString() }, before_delete: beforeDelete, after_delete: afterDelete, warning: "提交更正后将重算工序累计量和超单告警" };
  }

  private async progressForOperation(operation: { id: string; targetQuantity: Prisma.Decimal; status: string }, excludeReportId?: string) {
    const rows = await this.prisma.operationDailyReport.findMany({ where: { productionOrderOperationId: operation.id, deletedAt: null, ...(excludeReportId ? { id: { not: excludeReportId } } : {}) }, select: { completedQuantity: true } });
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
    if (!correction && operation.status !== "active") throw new UnprocessableEntityException({ code: "CANCELLED_OPERATION_DAILY_REPORT_FORBIDDEN", message: "已取消工序不能新增日报", details: [] });
      if (correction && operation.status !== "active" && operation.status !== "cancelled") throw new UnprocessableEntityException({ code: "PRODUCTION_OPERATION_NOT_FOUND", message: "生产单工序不存在或状态无效", details: [] });
    const allowed = correction ? ["in_progress", "completed"] : ["in_progress"];
    if (!allowed.includes(order.status)) throw new UnprocessableEntityException({ code: "PRODUCTION_ORDER_DAILY_REPORT_FORBIDDEN", message: "当前生产单状态不允许维护日报", details: [] });
    return { order, operation };
  }

  // Re-read parent order + operation rows under FOR UPDATE and re-validate against concurrent
  // completion / pausing / closure / cancellation (P1-3). Canonical lock order is operation row
  // first, then parent order row, so every transaction in this service serializes on the same
  // pair in the same order and cannot deadlock with itself or the state-machine writes.
  private async lockOrderAndOperation(tx: Prisma.TransactionClient, orderId: string, operationId: string, mode: LockMode) {
    await tx.$queryRaw`SELECT id FROM production_order_operations WHERE id = ${operationId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM production_orders WHERE id = ${orderId}::uuid FOR UPDATE`;
    const [operation, order] = await Promise.all([
      tx.productionOrderOperation.findFirst({ where: { id: operationId, deletedAt: null }, select: { id: true, status: true } }),
      tx.productionOrder.findFirst({ where: { id: orderId, deletedAt: null }, select: { id: true, status: true, executionMode: true } }),
    ]);
    if (!operation) throw new UnprocessableEntityException({ code: "PRODUCTION_OPERATION_NOT_FOUND", message: "生产单工序不存在或已删除", details: [] });
    if (!order) throw new NotFoundException({ code: "PRODUCTION_ORDER_NOT_FOUND", message: "生产单不存在", details: [] });
    if (order.executionMode !== "in_house") throw new UnprocessableEntityException({ code: "OUTSOURCED_DAILY_REPORT_FORBIDDEN", message: "外加工生产单不进入厂内日报", details: [] });
    if (mode === "create") {
      if (operation.status !== "active") throw new UnprocessableEntityException({ code: "CANCELLED_OPERATION_DAILY_REPORT_FORBIDDEN", message: "已取消工序不能新增日报", details: [] });
      if (order.status !== "in_progress") throw new UnprocessableEntityException({ code: "PRODUCTION_ORDER_DAILY_REPORT_FORBIDDEN", message: "当前生产单状态不允许维护日报", details: [] });
    } else {
      if (operation.status !== "active" && operation.status !== "cancelled") throw new UnprocessableEntityException({ code: "PRODUCTION_OPERATION_NOT_FOUND", message: "生产单工序不存在或状态无效", details: [] });
      if (order.status !== "in_progress" && order.status !== "completed") throw new UnprocessableEntityException({ code: "PRODUCTION_ORDER_DAILY_REPORT_FORBIDDEN", message: "当前生产单状态不允许维护日报", details: [] });
    }
    return { order: { id: order.id, status: order.status }, operation: { id: operation.id, status: operation.status } };
  }

  // Over-order alerts are maintained per operation, decoupled from the report date (P1-16/B1):
  // while over target there is at most one continuously-open alert whose reportDate anchor stays
  // at its creation date; falling back to (or below) the target recovers every non-recovered
  // over-order alert of the operation (which also converges historical date-duplicated alerts).
  private async recomputeOverOrder(tx: Prisma.TransactionClient, orderId: string, operationId: string, user: CurrentUser) {
    const operation = await tx.productionOrderOperation.findUniqueOrThrow({ where: { id: operationId } });
    const rows = await tx.operationDailyReport.findMany({ where: { productionOrderOperationId: operationId, deletedAt: null }, select: { completedQuantity: true } });
    const cumulative = rows.reduce((sum, row) => sum.plus(row.completedQuantity), new Prisma.Decimal(0));
    const target = new Prisma.Decimal(operation.targetQuantity);
    const over = cumulative.gt(target) ? cumulative.minus(target) : new Prisma.Decimal(0);
    const latest = await tx.operationDailyReport.findFirst({ where: { productionOrderOperationId: operationId, deletedAt: null }, orderBy: { reportDate: "desc" } });
    if (!latest) {
      // No live report remains: recover every outstanding over-order alert of the operation.
      const staleAlerts = await tx.productionDailyAlert.findMany({ where: { productionOrderOperationId: operationId, alertType: "over_order", deletedAt: null, status: { not: "recovered" } } });
      for (const alert of staleAlerts) {
        await tx.productionDailyAlert.update({ where: { id: alert.id }, data: { status: "recovered", recoveredAt: new Date(), updatedBy: user.id } });
        await tx.auditEvent.create({ data: { action: "production_daily_alert.recover", entityType: "production_daily_alert", actorId: user.id, entityId: alert.id, details: { order_no: alert.orderNo, alert_type: "over_order", status: "recovered" } } });
      }
      return;
    }
    if (over.gt(0)) {
      // Locate the one continuously-open over-order alert for this operation (oldest first).
      const anchor = await tx.productionDailyAlert.findFirst({ where: { productionOrderOperationId: operationId, alertType: "over_order", deletedAt: null, status: { not: "recovered" } }, orderBy: { createdAt: "asc" } });
      const unchanged = anchor !== null && anchor.status === "confirmed" && anchor.operationReportQuantity?.eq(latest.completedQuantity) && anchor.cumulativeQuantity?.eq(cumulative) && anchor.overOrderQuantity?.eq(over);
      const snapshots = { productionOrderId: orderId, orderNo: latest.orderNo, targetQuantity: target, operationReportQuantity: latest.completedQuantity, cumulativeQuantity: cumulative, overOrderQuantity: over, recoveredAt: null, updatedBy: user.id };
      if (anchor) {
        // Keep the original reportDate anchor, only refresh quantity snapshots and status.
        await tx.productionDailyAlert.update({ where: { id: anchor.id }, data: { ...snapshots, status: unchanged ? "confirmed" : "pending" } });
        await tx.auditEvent.create({ data: { action: "production_daily_alert.recalculate", entityType: "production_daily_alert", actorId: user.id, entityId: anchor.id, details: { order_no: latest.orderNo, alert_type: "over_order", cumulative_quantity: cumulative.toString(), over_order_quantity: over.toString(), status: unchanged ? "confirmed" : "pending" } } });
        return;
      }
      // No open alert: start a new one anchored on the latest report date. If a recovered alert
      // already occupies that (operation, date, type) unique slot, re-open it instead of inserting.
      const sameDate = await tx.productionDailyAlert.findUnique({ where: { productionOrderOperationId_reportDate_alertType: { productionOrderOperationId: operationId, reportDate: latest.reportDate, alertType: "over_order" } } });
      if (sameDate) {
        await tx.productionDailyAlert.update({ where: { id: sameDate.id }, data: { ...snapshots, status: "pending" } });
        await tx.auditEvent.create({ data: { action: "production_daily_alert.recalculate", entityType: "production_daily_alert", actorId: user.id, entityId: sameDate.id, details: { order_no: latest.orderNo, alert_type: "over_order", cumulative_quantity: cumulative.toString(), over_order_quantity: over.toString(), status: "pending" } } });
        return;
      }
      await tx.productionDailyAlert.create({ data: { productionOrderOperationId: operationId, reportDate: latest.reportDate, alertType: "over_order", ...snapshots, status: "pending", createdBy: user.id } });
      await tx.auditEvent.create({ data: { action: "production_daily_alert.create", entityType: "production_daily_alert", actorId: user.id, entityId: undefined, details: { order_no: latest.orderNo, alert_type: "over_order", cumulative_quantity: cumulative.toString(), over_order_quantity: over.toString(), status: "pending" } } });
      return;
    }
    // Cumulative <= target: recover every non-recovered over-order alert of this operation
    // (existing full-recovery semantics, extended from latest-date-only to all dates).
    const openAlerts = await tx.productionDailyAlert.findMany({ where: { productionOrderOperationId: operationId, alertType: "over_order", deletedAt: null, status: { not: "recovered" } } });
    for (const alert of openAlerts) {
      await tx.productionDailyAlert.update({ where: { id: alert.id }, data: { status: "recovered", recoveredAt: new Date(), updatedBy: user.id } });
      await tx.auditEvent.create({ data: { action: "production_daily_alert.recover", entityType: "production_daily_alert", actorId: user.id, entityId: alert.id, details: { order_no: alert.orderNo, alert_type: "over_order", status: "recovered" } } });
    }
  }

  private date(value: string) { const result = new Date(`${value}T00:00:00.000Z`); if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(result.valueOf())) throw new UnprocessableEntityException({ code: "INVALID_REPORT_DATE", message: "日报日期必须是有效日期", details: [] }); return result; }
  private validDate(value: string) { const date = this.date(value); const today = new Date(); today.setUTCHours(0, 0, 0, 0); if (date > today) throw new UnprocessableEntityException({ code: "FUTURE_REPORT_DATE_FORBIDDEN", message: "日报日期不能晚于今天", details: [] }); return date; }
  // Quantity guardrails (B13): plain positive decimal only - no exponent/hex/whitespace forms,
  // at most 4 fractional digits and within the Decimal(18,4) range.
  private decimal(value: string, code: string, message: string) {
    try {
      if (!/^(\d+(\.\d+)?|\.\d+)$/.test(value)) throw new Error();
      const decimal = new Prisma.Decimal(value);
      if (!decimal.gt(0) || decimal.gt(MAX_QUANTITY) || !decimal.mul(10000).isInteger()) throw new Error();
      return decimal;
    } catch { throw new UnprocessableEntityException({ code, message, details: [] }); }
  }
}
