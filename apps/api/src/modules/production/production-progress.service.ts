import { Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../platform/database/prisma.service";
import { AuditService } from "../../platform/audit/audit.service";
import type { CurrentUser } from "../../platform/auth/auth.service";
import { aggregateMeasurementRows, calculateQuantityProgress, describeProgressBlockers, deriveOrderProgressStatus, PRODUCTION_PROGRESS_STATUS_LABELS, type MeasurementRow, type ProductionProgressBlocker } from "./production-progress.domain";

type ProgressFilter = { order_no?: string; production_order_id?: string; from?: string; to?: string; page?: number; page_size?: number };

@Injectable()
export class ProductionProgressService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  async recalculateAfterSourceChange(productionOrderId: string, sourceType: string, sourceId: string, user: CurrentUser) {
    const summary = await this.getProductionOrderProgress(productionOrderId);
    await this.audit.recordWithOrderNo("production_progress.recalculate", "production_progress", summary.order_no, user.id, productionOrderId, { order_no: summary.order_no, production_order_no: summary.production_order_no, trigger: { source_type: sourceType, source_id: sourceId }, status: summary.status, blockers: summary.blockers, calculated_at: new Date().toISOString() });
    return summary;
  }

  async recalculateInTransaction(tx: Prisma.TransactionClient, productionOrderId: string, sourceType: string, sourceId: string, user: CurrentUser) {
    const order = await tx.productionOrder.findFirst({ where: { id: productionOrderId, deletedAt: null }, include: { unit: true, operations: { where: { deletedAt: null }, include: { unit: true }, orderBy: { sequenceNo: "asc" } } } });
    if (!order) throw new NotFoundException({ code: "PRODUCTION_ORDER_NOT_FOUND", message: "生产单不存在", details: [] });
    const summary = await this.buildProductionOrder(order, {}, tx);
    await tx.auditEvent.create({ data: { action: "production_progress.recalculate", entityType: "production_progress", orderNo: summary.order_no, actorId: user.id, entityId: productionOrderId, details: { order_no: summary.order_no, production_order_no: summary.production_order_no, trigger: { source_type: sourceType, source_id: sourceId }, status: summary.status, blockers: summary.blockers, calculated_at: new Date().toISOString() } } });
    return summary;
  }

  async getProductionOrderProgress(id: string) {
    const order = await this.prisma.productionOrder.findFirst({ where: { id, deletedAt: null }, include: { unit: true, operations: { where: { deletedAt: null }, include: { unit: true }, orderBy: { sequenceNo: "asc" } } } });
    if (!order) throw new NotFoundException({ code: "PRODUCTION_ORDER_NOT_FOUND", message: "生产单不存在", details: [] });
    return this.buildProductionOrder(order);
  }

  async listMeasurements(filter: ProgressFilter) {
    const range = this.range(filter.from, filter.to);
    const orders = await this.prisma.productionOrder.findMany({ where: { deletedAt: null, ...(filter.order_no ? { orderNo: filter.order_no } : {}), ...(filter.production_order_id ? { id: filter.production_order_id } : {}) }, include: { unit: true, operations: { where: { deletedAt: null }, include: { unit: true }, orderBy: { sequenceNo: "asc" } } }, orderBy: { updatedAt: "desc" } });
    const items = (await Promise.all(orders.map((order) => this.buildProductionOrder(order, range)))).flatMap((order) => order.measurements.map((measurement) => ({ ...measurement, production_order_id: order.production_order_id, production_order_no: order.production_order_no, order_no: order.order_no })));
    const filtered = items;
    const page = filter.page ?? 1; const pageSize = filter.page_size ?? 20;
    return { data: filtered.slice((page - 1) * pageSize, page * pageSize), total: filtered.length };
  }

  async listOrderStatuses(filter: ProgressFilter) {
    const range = this.range(filter.from, filter.to);
    const orders = await this.prisma.productionOrder.findMany({ where: { deletedAt: null, ...(filter.order_no ? { orderNo: filter.order_no } : {}), ...(filter.production_order_id ? { id: filter.production_order_id } : {}) }, include: { unit: true, salesOrder: { select: { customerSnapshot: true, productName: true } }, operations: { where: { deletedAt: null }, include: { unit: true }, orderBy: { sequenceNo: "asc" } } }, orderBy: { updatedAt: "desc" } });
    const byOrder = new Map<string, Awaited<ReturnType<ProductionProgressService["buildProductionOrder"]>>[]>();
    for (const order of orders) { const summary = await this.buildProductionOrder(order, range); const current = byOrder.get(order.orderNo) ?? []; current.push(summary); byOrder.set(order.orderNo, current); }
    const data = [...byOrder.entries()].map(([orderNo, summaries]) => this.mergeOrderSummaries(orderNo, summaries));
    const page = filter.page ?? 1; const pageSize = filter.page_size ?? 20;
    return { data: data.slice((page - 1) * pageSize, page * pageSize), total: data.length };
  }

  async timeline(orderNo: string) {
    const order = await this.prisma.productionOrder.findFirst({ where: { orderNo, deletedAt: null }, select: { id: true } });
    if (!order) throw new NotFoundException({ code: "ORDER_NOT_FOUND", message: "订单不存在", details: [] });
    const rows = await this.prisma.auditEvent.findMany({ where: { orderNo, entityType: { in: ["production_progress", "production_order", "operation_daily_report", "outsource_return_transfer", "outsource_direct_shipment"] } }, orderBy: { createdAt: "desc" }, take: 200 });
    return rows;
  }

  async rebuild(filter: { order_no?: string; from?: string; to?: string }) {
    const range = this.range(filter.from, filter.to);
    const orders = await this.prisma.productionOrder.findMany({ where: { deletedAt: null, ...(filter.order_no ? { orderNo: filter.order_no } : {}) }, include: { unit: true, operations: { where: { deletedAt: null }, include: { unit: true }, orderBy: { sequenceNo: "asc" } } } });
    const summaries = await Promise.all(orders.map((order) => this.buildProductionOrder(order, range)));
    return { rebuilt_at: new Date().toISOString(), order_count: summaries.length, measurement_count: summaries.reduce((count, summary) => count + summary.measurements.length, 0), source_of_truth: ["operation_daily_reports", "outsource_return_transfers", "outsource_direct_shipments"], range: { order_no: filter.order_no ?? null, from: filter.from ?? null, to: filter.to ?? null } };
  }

  private async buildProductionOrder(order: { id: string; productionOrderNo: string; orderNo: string; executionMode: string; plannedQuantity: Prisma.Decimal; unit: { name: string }; status: string; updatedAt: Date; operations: Array<{ id: string; operationNameSnapshot: string; sequenceNo: number; targetQuantity: Prisma.Decimal; status: string; unit: { name: string } }> }, range: { from?: Date; to?: Date } = {}, client: PrismaService | Prisma.TransactionClient = this.prisma) {
    const db = client;
    const [reports, alerts, returns, shipments, receipts, reversals, qcSubmissions] = await Promise.all([
      db.operationDailyReport.findMany({ where: { productionOrderId: order.id, deletedAt: null, ...(range.from || range.to ? { reportDate: { ...(range.from ? { gte: range.from } : {}), ...(range.to ? { lte: range.to } : {}) } } : {}) }, select: { id: true, productionOrderOperationId: true, reportDate: true, completedQuantity: true } }),
      db.productionDailyAlert.findMany({ where: { productionOrderId: order.id, deletedAt: null, status: { in: ["pending", "confirmed"] }, ...(range.from || range.to ? { reportDate: { ...(range.from ? { gte: range.from } : {}), ...(range.to ? { lte: range.to } : {}) } } : {}) }, select: { alertType: true, status: true, reportDate: true } }),
      db.outsourceReturnTransfer.findMany({ where: { productionOrderId: order.id, transferType: "finished_goods_return", deletedAt: null, status: { notIn: ["draft", "cancelled", "reversed"] }, ...(range.from || range.to ? { transferDate: { ...(range.from ? { gte: range.from } : {}), ...(range.to ? { lte: range.to } : {}) } } : {}) }, select: { id: true, quantity: true, transferDate: true, unit: { select: { name: true } }, status: true } }),
      db.outsourceDirectShipment.findMany({ where: { productionOrderId: order.id, deletedAt: null, status: "dispatched", ...(range.from || range.to ? { shipmentDate: { ...(range.from ? { gte: range.from } : {}), ...(range.to ? { lte: range.to } : {}) } } : {}) }, select: { id: true, quantity: true, reversalQuantity: true, shipmentDate: true, unit: { select: { name: true } } } }),
      db.outsourceReceipt.findMany({ where: { logisticsBatch: { productionOrderId: order.id }, deletedAt: null, status: "received", differenceReason: { not: null }, ...(range.from || range.to ? { receiptDate: { ...(range.from ? { gte: range.from } : {}), ...(range.to ? { lte: range.to } : {}) } } : {}) }, select: { id: true } }),
      db.outsourceDirectShipment.findMany({ where: { productionOrderId: order.id, deletedAt: null, status: "corrected", ...(range.from || range.to ? { shipmentDate: { ...(range.from ? { gte: range.from } : {}), ...(range.to ? { lte: range.to } : {}) } } : {}) }, select: { id: true } }),
      db.finishedGoodsInspectionSubmission.findMany({ where: { productionOrderId: order.id, deletedAt: null, status: { notIn: ["cancelled", "corrected"] } }, select: { id: true, sourceType: true, sourceId: true, submittedQuantity: true, status: true, qcRecords: { where: { deletedAt: null, status: "active" }, select: { inspectedQuantity: true, qualifiedQuantity: true, conditionalAcceptQuantity: true, rejectedQuantity: true } } } }),
    ]);
    const reportByOperation = new Map<string, { actual: Prisma.Decimal; sourceIds: string[]; dates: string[] }>();
    for (const report of reports) { const current = reportByOperation.get(report.productionOrderOperationId) ?? { actual: new Prisma.Decimal(0), sourceIds: [], dates: [] }; current.actual = current.actual.plus(report.completedQuantity); current.sourceIds.push(report.id); current.dates.push(this.isoDate(report.reportDate)); reportByOperation.set(report.productionOrderOperationId, current); }
    const rows: MeasurementRow[] = order.operations.map((operation) => { const current = reportByOperation.get(operation.id) ?? { actual: new Prisma.Decimal(0), sourceIds: [], dates: [] }; return { order_no: order.orderNo, production_order_id: order.id, production_order_no: order.productionOrderNo, operation_id: operation.id, source_type: "operation_report", source_id: current.sourceIds[0] ?? operation.id, source_ids: current.sourceIds, unit: operation.unit.name, planned_quantity: operation.targetQuantity, actual_quantity: current.actual, execution_mode: "in_house", cancelled: operation.status === "cancelled", warning_codes: alerts.filter((alert) => alert.alertType === "daily_discrepancy" && alert.status === "pending").map(() => "daily_discrepancy") }; });
    for (const item of returns) rows.push({ order_no: order.orderNo, production_order_id: order.id, production_order_no: order.productionOrderNo, source_type: "outsource_finished_goods_return", source_id: item.id, unit: item.unit.name, planned_quantity: "0", actual_quantity: item.quantity, execution_mode: "outsourced" });
    for (const item of shipments) rows.push({ order_no: order.orderNo, production_order_id: order.id, production_order_no: order.productionOrderNo, source_type: "outsource_direct_shipment", source_id: item.id, unit: item.unit.name, planned_quantity: "0", actual_quantity: new Prisma.Decimal(item.quantity).minus(item.reversalQuantity), execution_mode: "outsourced" });
    const aggregate = aggregateMeasurementRows(rows);
    const blockers: ProductionProgressBlocker[] = [...aggregate.warnings];
    if (alerts.some((alert) => alert.alertType === "daily_discrepancy" && alert.status === "pending")) blockers.push("daily_discrepancy");
    if (alerts.some((alert) => alert.alertType === "over_order" && alert.status === "pending")) blockers.push("over_order_unconfirmed");
    if (receipts.length > 0) blockers.push("outsource_short_receipt");
    if (reversals.length > 0) blockers.push("source_reversal_pending");
    const activeOperations = order.operations.filter((operation) => operation.status !== "cancelled");
    const operationGroups = aggregate.groups.filter((group) => group.execution_mode === "in_house");
    if (order.executionMode === "in_house" && order.status !== "draft" && activeOperations.some((operation) => !reportByOperation.has(operation.id))) blockers.push("missing_operation_report");
    const allProductionComplete = order.executionMode === "outsourced" ? returns.length + shipments.length > 0 : activeOperations.length > 0 && activeOperations.every((operation) => { const current = reportByOperation.get(operation.id); return current ? current.actual.gte(operation.targetQuantity) : false; });
    const status = deriveOrderProgressStatus({ has_production_orders: true, has_started_production: order.status !== "draft", all_production_complete: allProductionComplete, blockers, has_outsource_pending_handoff: order.executionMode === "outsourced" && returns.length + shipments.length === 0, has_finished_goods_source: returns.length + shipments.length > 0, qc_capability_available: true, shipping_capability_available: false });
    const operationMeasurements = order.operations.map((operation) => { const current = reportByOperation.get(operation.id) ?? { actual: new Prisma.Decimal(0), sourceIds: [], dates: [] }; return { operation_id: operation.id, operation_name: operation.operationNameSnapshot, source_type: "operation_report" as const, source_ids: current.sourceIds, source_dates: current.dates, unit: operation.unit.name, execution_mode: "in_house" as const, ...calculateQuantityProgress(operation.targetQuantity, current.actual, operation.status === "cancelled") }; });
    const externalMeasurements = rows.filter((row) => row.source_type !== "operation_report").map((row) => ({ operation_id: null, operation_name: null, source_type: row.source_type, source_ids: [row.source_id], source_dates: [this.isoDate(row.source_type === "outsource_finished_goods_return" ? returns.find((item) => item.id === row.source_id)!.transferDate : shipments.find((item) => item.id === row.source_id)!.shipmentDate)], unit: row.unit, execution_mode: row.execution_mode, ...calculateQuantityProgress(row.planned_quantity, row.actual_quantity) }));
    const uniqueBlockers = [...new Set(status.blockers)];
    const qcSummary = qcSubmissions.reduce((summary, submission) => { summary.submission_count += 1; summary.submitted_quantity = summary.submitted_quantity.plus(submission.submittedQuantity); for (const record of submission.qcRecords) { summary.inspected_quantity = summary.inspected_quantity.plus(record.inspectedQuantity); summary.qualified_quantity = summary.qualified_quantity.plus(record.qualifiedQuantity); summary.conditional_accept_quantity = summary.conditional_accept_quantity.plus(record.conditionalAcceptQuantity); summary.rejected_quantity = summary.rejected_quantity.plus(record.rejectedQuantity); } return summary; }, { submission_count: 0, submitted_quantity: new Prisma.Decimal(0), inspected_quantity: new Prisma.Decimal(0), qualified_quantity: new Prisma.Decimal(0), conditional_accept_quantity: new Prisma.Decimal(0), rejected_quantity: new Prisma.Decimal(0) });
    return { production_order_id: order.id, production_order_no: order.productionOrderNo, order_no: order.orderNo, execution_mode: order.executionMode, status: status.status, status_label: PRODUCTION_PROGRESS_STATUS_LABELS[status.status], blockers: uniqueBlockers, blocker_details: describeProgressBlockers(uniqueBlockers), capability_not_implemented: status.capability_not_implemented, measurements: [...operationMeasurements, ...externalMeasurements], unit_summaries: aggregate.groups, operation_count: activeOperations.length, completed_operation_count: operationMeasurements.filter((measurement) => ["completed", "over_order"].includes(measurement.status)).length, outsource_receipt_risk_count: receipts.length, source_warning_codes: aggregate.warnings, qc_summary: Object.fromEntries(Object.entries(qcSummary).map(([key, value]) => [key, value instanceof Prisma.Decimal ? value.toString() : value])) };
  }

  private mergeOrderSummaries(orderNo: string, summaries: Array<Awaited<ReturnType<ProductionProgressService["buildProductionOrder"]>>>) {
    const blockers = [...new Set(summaries.flatMap((summary) => summary.blockers))] as ProductionProgressBlocker[];
    const status = deriveOrderProgressStatus({ has_production_orders: summaries.length > 0, has_started_production: summaries.some((summary) => summary.status !== "not_started"), all_production_complete: summaries.every((summary) => ["production_completed", "ready_for_qc", "ready_to_ship"].includes(summary.status)), blockers });
    const uniqueBlockers = [...new Set(status.blockers)];
    return { order_no: orderNo, status: status.status, status_label: PRODUCTION_PROGRESS_STATUS_LABELS[status.status], blockers: uniqueBlockers, blocker_details: describeProgressBlockers(uniqueBlockers), capability_not_implemented: [...new Set(summaries.flatMap((summary) => summary.capability_not_implemented))], production_orders: summaries, production_order_count: summaries.length, blocking_count: blockers.length };
  }

  private isoDate(value: Date) { return value.toISOString().slice(0, 10); }
  private range(from?: string, to?: string) {
    const parse = (value?: string) => value ? new Date(`${value}T00:00:00.000Z`) : undefined;
    const start = parse(from); const end = parse(to);
    if (from && (!start || Number.isNaN(start.valueOf())) || to && (!end || Number.isNaN(end.valueOf()))) throw new UnprocessableEntityException({ code: "INVALID_PROGRESS_DATE_RANGE", message: "生产进度日期范围无效", details: [] });
    if (start && end && start > end) throw new UnprocessableEntityException({ code: "INVALID_PROGRESS_DATE_RANGE", message: "生产进度开始日期不能晚于结束日期", details: [] });
    return { from: start, to: end };
  }
}
