import { Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../platform/database/prisma.service";
import { AuditService } from "../../platform/audit/audit.service";
import type { CurrentUser } from "../../platform/auth/auth.service";
import { aggregateMeasurementRows, calculateQuantityProgress, describeProgressBlockers, deriveOrderProgressStatus, PRODUCTION_PROGRESS_STATUS_LABELS, type MeasurementRow, type ProductionProgressBlocker } from "./production-progress.domain";

type ProgressFilter = { order_no?: string; production_order_id?: string; from?: string; to?: string; page?: number; page_size?: number };
type ProductionOrderSnapshot = { id: string; productionOrderNo: string; orderNo: string; executionMode: string; plannedQuantity: Prisma.Decimal; unit: { name: string }; status: string; updatedAt: Date; operations: Array<{ id: string; operationNameSnapshot: string; sequenceNo: number; targetQuantity: Prisma.Decimal; status: string; unit: { name: string } }> };

@Injectable()
export class ProductionProgressService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  async recalculateAfterSourceChange(productionOrderId: string, sourceType: string, sourceId: string, user: CurrentUser) {
    const summary = await this.getProductionOrderProgress(productionOrderId);
    await this.audit.recordWithOrderNo("production_progress.recalculate", "production_progress", summary.order_no, user.id, productionOrderId, { order_no: summary.order_no, production_order_no: summary.production_order_no, trigger: { source_type: sourceType, source_id: sourceId }, status: summary.status, blockers: summary.blockers, calculated_at: new Date().toISOString() });
    return summary;
  }

  async recalculateInTransaction(tx: Prisma.TransactionClient, productionOrderId: string, sourceType: string, sourceId: string, user: CurrentUser) {
    const order = await this.findOrder(tx, { id: productionOrderId });
    if (!order) throw new NotFoundException({ code: "PRODUCTION_ORDER_NOT_FOUND", message: "生产单不存在", details: [] });
    const summary = await this.buildProductionOrder(order, {}, tx);
    await tx.auditEvent.create({ data: { action: "production_progress.recalculate", entityType: "production_progress", orderNo: summary.order_no, actorId: user.id, entityId: productionOrderId, details: { order_no: summary.order_no, production_order_no: summary.production_order_no, trigger: { source_type: sourceType, source_id: sourceId }, status: summary.status, blockers: summary.blockers, calculated_at: new Date().toISOString() } } });
    return summary;
  }

  async getProductionOrderProgress(id: string) {
    const order = await this.findOrder(this.prisma, { id });
    if (!order) throw new NotFoundException({ code: "PRODUCTION_ORDER_NOT_FOUND", message: "生产单不存在", details: [] });
    return this.buildProductionOrder(order);
  }

  // A16：分页下推。production_orders 主查询直接应用 skip/take，只对当页生产单构建明细；
  // total 使用与主查询同一 where 的 count。注意 total 与分页单位都是“匹配的生产单数”而非“计量行数”，
  // 不再在内存里先全表 findMany 再 slice。
  async listMeasurements(filter: ProgressFilter) {
    const range = this.range(filter.from, filter.to);
    const where = this.productionOrderWhere(filter);
    const page = filter.page ?? 1; const pageSize = filter.page_size ?? 20;
    const orders = await this.findOrdersPage(where, page, pageSize);
    const items = (await Promise.all(orders.map((order) => this.buildProductionOrder(order, range)))).flatMap((order) => order.measurements.map((measurement) => ({ ...measurement, production_order_id: order.production_order_id, production_order_no: order.production_order_no, order_no: order.order_no })));
    const total = await this.prisma.productionOrder.count({ where });
    return { data: items, total };
  }

  // A16：分页下推 + 订单号归并仅在当页内进行。跨页的同一 order_no 会被拆成两行（已知局限，
  // 注释于此：避免为归并而全表聚合，后续若需要精确跨页归并应改用服务端游标/快照读）。
  // total 使用与主查询同一 where 的 count，分页单位是“生产单”而非“归并后的订单数”。
  async listOrderStatuses(filter: ProgressFilter) {
    const range = this.range(filter.from, filter.to);
    const where = this.productionOrderWhere(filter);
    const page = filter.page ?? 1; const pageSize = filter.page_size ?? 20;
    const orders = await this.findOrdersPage(where, page, pageSize);
    const byOrder = new Map<string, Awaited<ReturnType<ProductionProgressService["buildProductionOrder"]>>[]>();
    for (const order of orders) {
        const full = await this.buildProductionOrder(order);
        let summary = full;
        if (range.from || range.to) {
          const period = await this.buildProductionOrder(order, range);
          summary = { ...full, measurements: period.measurements, unit_summaries: period.unit_summaries };
        }
        const current = byOrder.get(order.orderNo) ?? [];
        current.push(summary);
        byOrder.set(order.orderNo, current);
      }
    const data = [...byOrder.entries()].map(([orderNo, summaries]) => this.mergeOrderSummaries(orderNo, summaries));
    const total = await this.prisma.productionOrder.count({ where });
    return { data, total };
  }

  // A16：audit 时间线查询依赖 orderNo + entityType 的复合过滤。
  // audit_events 当前没有 (order_no, entity_type[, created_at]) 复合索引（见 prisma/schema.prisma），
  // 该过滤属后置说明口径：需要新增 DB 索引的迁移项列在交付说明的后续待办中，不在本文件改动 schema。
  async timeline(orderNo: string) {
    const order = await this.prisma.productionOrder.findFirst({ where: { orderNo, deletedAt: null }, select: { id: true } });
    if (!order) throw new NotFoundException({ code: "ORDER_NOT_FOUND", message: "订单不存在", details: [] });
    const rows = await this.prisma.auditEvent.findMany({ where: { orderNo, entityType: { in: ["production_progress", "production_order", "operation_daily_report", "outsource_return_transfer", "outsource_direct_shipment"] } }, orderBy: { createdAt: "desc" }, take: 200 });
    return rows;
  }

  async rebuild(filter: { order_no?: string; from?: string; to?: string }) {
    const range = this.range(filter.from, filter.to);
    const orders = await this.findOrders(this.prisma, { order_no: filter.order_no });
    const summaries = await Promise.all(orders.map((order) => this.buildProductionOrder(order, range)));
    return { rebuilt_at: new Date().toISOString(), order_count: summaries.length, measurement_count: summaries.reduce((count, summary) => count + summary.measurements.length, 0), source_of_truth: ["operation_daily_reports", "employee_daily_reports", "outsource_return_transfers", "outsource_direct_shipments"], range: { order_no: filter.order_no ?? null, from: filter.from ?? null, to: filter.to ?? null } };
  }

  private productionOrderWhere(filter: ProgressFilter): Prisma.ProductionOrderWhereInput {
    return { deletedAt: null, ...(filter.order_no ? { orderNo: filter.order_no } : {}), ...(filter.production_order_id ? { id: filter.production_order_id } : {}) };
  }

  private async findOrder(client: PrismaService | Prisma.TransactionClient, where: { id: string }) {
    return client.productionOrder.findFirst({ where: { ...where, deletedAt: null }, include: { unit: true, operations: { where: { deletedAt: null }, include: { unit: true }, orderBy: { sequenceNo: "asc" } } } });
  }

  private async findOrders(client: PrismaService | Prisma.TransactionClient, filter: { order_no?: string; from?: string; to?: string }) {
    return client.productionOrder.findMany({ where: this.productionOrderWhere(filter), include: { unit: true, operations: { where: { deletedAt: null }, include: { unit: true }, orderBy: { sequenceNo: "asc" } } }, orderBy: { updatedAt: "desc" } });
  }

  private async findOrdersPage(where: Prisma.ProductionOrderWhereInput, page: number, pageSize: number) {
    return this.prisma.productionOrder.findMany({ where, include: { unit: true, operations: { where: { deletedAt: null }, include: { unit: true }, orderBy: { sequenceNo: "asc" } } }, orderBy: { updatedAt: "desc" }, skip: (page - 1) * pageSize, take: pageSize });
  }

  private async buildProductionOrder(order: ProductionOrderSnapshot, range: { from?: Date; to?: Date } = {}, client: PrismaService | Prisma.TransactionClient = this.prisma) {
    const db = client;
    const isInHouse = order.executionMode === "in_house";
    const [reports, employeeReports, alerts, returns, shipments, receipts, reversals, qcSubmissions] = await Promise.all([
      db.operationDailyReport.findMany({ where: { productionOrderId: order.id, deletedAt: null, ...(range.from || range.to ? { reportDate: { ...(range.from ? { gte: range.from } : {}), ...(range.to ? { lte: range.to } : {}) } } : {}) }, select: { id: true, productionOrderOperationId: true, reportDate: true, completedQuantity: true } }),
      db.employeeDailyReport.findMany({ where: { productionOrderId: order.id, deletedAt: null, ...(range.from || range.to ? { reportDate: { ...(range.from ? { gte: range.from } : {}), ...(range.to ? { lte: range.to } : {}) } } : {}) }, select: { id: true, productionOrderOperationId: true, reportDate: true, quantity: true } }),
      db.productionDailyAlert.findMany({ where: { productionOrderId: order.id, deletedAt: null, status: { in: ["pending", "confirmed"] }, ...(range.from || range.to ? { reportDate: { ...(range.from ? { gte: range.from } : {}), ...(range.to ? { lte: range.to } : {}) } } : {}) }, select: { alertType: true, status: true, reportDate: true, productionOrderOperationId: true } }),
      db.outsourceReturnTransfer.findMany({ where: { productionOrderId: order.id, transferType: "finished_goods_return", deletedAt: null, status: { notIn: ["draft", "cancelled", "reversed"] }, ...(range.from || range.to ? { transferDate: { ...(range.from ? { gte: range.from } : {}), ...(range.to ? { lte: range.to } : {}) } } : {}) }, select: { id: true, quantity: true, transferDate: true, unit: { select: { name: true } }, status: true } }),
      db.outsourceDirectShipment.findMany({ where: { productionOrderId: order.id, deletedAt: null, status: "dispatched", ...(range.from || range.to ? { shipmentDate: { ...(range.from ? { gte: range.from } : {}), ...(range.to ? { lte: range.to } : {}) } } : {}) }, select: { id: true, quantity: true, reversalQuantity: true, shipmentDate: true, unit: { select: { name: true } } } }),
      db.outsourceReceipt.findMany({ where: { logisticsBatch: { productionOrderId: order.id }, deletedAt: null, status: "received", differenceReason: { not: null }, ...(range.from || range.to ? { receiptDate: { ...(range.from ? { gte: range.from } : {}), ...(range.to ? { lte: range.to } : {}) } } : {}) }, select: { id: true } }),
      db.outsourceDirectShipment.findMany({ where: { productionOrderId: order.id, deletedAt: null, status: "corrected", ...(range.from || range.to ? { shipmentDate: { ...(range.from ? { gte: range.from } : {}), ...(range.to ? { lte: range.to } : {}) } } : {}) }, select: { id: true } }),
      db.finishedGoodsInspectionSubmission.findMany({ where: { productionOrderId: order.id, deletedAt: null, status: { notIn: ["cancelled", "corrected"] } }, select: { id: true, sourceType: true, sourceId: true, submittedQuantity: true, status: true, qcRecords: { where: { deletedAt: null, status: "active" }, select: { inspectedQuantity: true, qualifiedQuantity: true, conditionalAcceptQuantity: true, rejectedQuantity: true } } } }),
    ]);
    const reportByOperation = new Map<string, { actual: Prisma.Decimal; sourceIds: string[]; dates: string[] }>();
    for (const report of reports) { const current = reportByOperation.get(report.productionOrderOperationId) ?? { actual: new Prisma.Decimal(0), sourceIds: [], dates: [] }; current.actual = current.actual.plus(report.completedQuantity); current.sourceIds.push(report.id); current.dates.push(this.isoDate(report.reportDate)); reportByOperation.set(report.productionOrderOperationId, current); }
    // 工序实际完成量口径：工序日报与员工日报是同一事实的两个人工登记面（每日差异告警负责提示二者不一致）。
    // 取两源累计的较大者作为 actual：员工日报是唯一有 UI 录入入口的路径，只算工序日报会永远低估；
    // 简单相加则在两源同填时双重计数。max 保证不低估、不重复。
    const employeeByOperation = new Map<string, { actual: Prisma.Decimal; sourceIds: string[]; dates: string[] }>();
    for (const report of employeeReports) { const current = employeeByOperation.get(report.productionOrderOperationId) ?? { actual: new Prisma.Decimal(0), sourceIds: [], dates: [] }; current.actual = current.actual.plus(report.quantity); current.sourceIds.push(report.id); current.dates.push(this.isoDate(report.reportDate)); employeeByOperation.set(report.productionOrderOperationId, current); }
    const combinedByOperation = new Map<string, { actual: Prisma.Decimal; sourceIds: string[]; dates: string[] }>();
    for (const [operationId, operationSource] of reportByOperation) combinedByOperation.set(operationId, { ...operationSource, sourceIds: [...operationSource.sourceIds], dates: [...operationSource.dates] });
    for (const [operationId, employeeSource] of employeeByOperation) {
      const current = combinedByOperation.get(operationId);
      if (!current || employeeSource.actual.gt(current.actual)) combinedByOperation.set(operationId, { actual: employeeSource.actual, sourceIds: [...(current?.sourceIds ?? []), ...employeeSource.sourceIds], dates: [...(current?.dates ?? []), ...employeeSource.dates] });
      else { current.sourceIds.push(...employeeSource.sourceIds); current.dates.push(...employeeSource.dates); }
    }

    // B12：差异告警按工序归属——只有属于该工序（productionOrderOperationId 匹配）的 pending daily_discrepancy 告警才
    // 贴到该工序计量行；订单级 blockers 仍按整单 pending 去重（见下方 blockers 组装），避免 A 工序告警被贴到 B 工序行。
    const pendingDiscrepancyOperationIds = new Set(alerts.filter((alert) => alert.alertType === "daily_discrepancy" && alert.status === "pending").map((alert) => alert.productionOrderOperationId));

    // A9：只有 in_house 生产单才把工序展开为 in_house 计量行并参与工序完成计数；outsourced 单的工序仅作工艺说明。
    const rows: MeasurementRow[] = [];
    if (isInHouse) {
      for (const operation of order.operations) { const current = combinedByOperation.get(operation.id) ?? { actual: new Prisma.Decimal(0), sourceIds: [], dates: [] }; rows.push({ order_no: order.orderNo, production_order_id: order.id, production_order_no: order.productionOrderNo, operation_id: operation.id, source_type: "operation_report", source_id: current.sourceIds[0] ?? operation.id, source_ids: current.sourceIds, unit: operation.unit.name, planned_quantity: operation.targetQuantity, actual_quantity: current.actual, execution_mode: "in_house", cancelled: operation.status === "cancelled", warning_codes: pendingDiscrepancyOperationIds.has(operation.id) ? ["daily_discrepancy"] : undefined }); }
    }

    // A4（外加工计量口径）：不再把每条回厂/直装柜来源都作为 planned=0 的计量行参与单位聚合
    // （旧实现会把“整批回厂量”误标成超单）。这里把回厂与直装柜来源按 unit 归并后，每个单位只追加一条
    // “order 级外协测量行”：单位与订单主单位一致时 planned_quantity = order.plannedQuantity；
    // 单位不一致时该组没有单位换算支持、不能与订单计划量直接比较，planned 保持 0（口径限制见注释）。
    // actual 为该组累计量（回厂为非冲销 quantity；直装柜为 dispatched 的 quantity - reversalQuantity，
    // 即“非 corrected”口径），source_ids/source_dates 保留该单位组下的全部来源。
    const outsourceByUnit = new Map<string, { unit: string; actual: Prisma.Decimal; sourceIds: string[]; sourceDates: string[]; hasReturn: boolean; hasShipment: boolean }>();
    for (const item of returns) { const group = outsourceByUnit.get(item.unit.name) ?? { unit: item.unit.name, actual: new Prisma.Decimal(0), sourceIds: [], sourceDates: [], hasReturn: false, hasShipment: false }; group.actual = group.actual.plus(item.quantity); group.sourceIds.push(item.id); group.sourceDates.push(this.isoDate(item.transferDate)); group.hasReturn = true; outsourceByUnit.set(item.unit.name, group); }
    for (const item of shipments) { const net = new Prisma.Decimal(item.quantity).minus(item.reversalQuantity); const group = outsourceByUnit.get(item.unit.name) ?? { unit: item.unit.name, actual: new Prisma.Decimal(0), sourceIds: [], sourceDates: [], hasReturn: false, hasShipment: false }; group.actual = group.actual.plus(net); group.sourceIds.push(item.id); group.sourceDates.push(this.isoDate(item.shipmentDate)); group.hasShipment = true; outsourceByUnit.set(item.unit.name, group); }
    for (const group of outsourceByUnit.values()) {
      // 口径限制：unit 与 order.unit.name 不一致时无法做单位换算，planned 保持 0，避免异单位累计量被当作对订单计划的超单。
      const planned = group.unit === order.unit.name ? order.plannedQuantity : new Prisma.Decimal(0);
      // 同一单位组内同时存在回厂与直装柜时以回厂类型作为行标签；来源明细仍保留在 source_ids/source_dates 中。
      const sourceType: "outsource_finished_goods_return" | "outsource_direct_shipment" = group.hasReturn ? "outsource_finished_goods_return" : "outsource_direct_shipment";
      rows.push({ order_no: order.orderNo, production_order_id: order.id, production_order_no: order.productionOrderNo, source_type: sourceType, source_id: group.sourceIds[0] ?? group.unit, source_ids: group.sourceIds, unit: group.unit, planned_quantity: planned, actual_quantity: group.actual, execution_mode: "outsourced" });
    }

    // A4（外加工完成判定）：非冲销 finished_goods_return 合计 + 非 corrected direct_shipment 合计 >= order.plannedQuantity
    // 才算生产完成，部分交付不得判完成；全部使用 Decimal 比较。
    const outsourceDeliveredTotal = [...outsourceByUnit.values()].reduce((sum, group) => sum.plus(group.actual), new Prisma.Decimal(0));

    const aggregate = aggregateMeasurementRows(rows);
    const blockers: ProductionProgressBlocker[] = [...aggregate.warnings];
    // B12：订单级 blockers 按整单 pending 告警去重（口径说明：blocker 表示“本单存在待处理差异/超单告警”，
    // 不代表告警具体挂在哪道工序；工序归属细节由各工序计量行的 warning_codes 表达）。
    if (alerts.some((alert) => alert.alertType === "daily_discrepancy" && alert.status === "pending")) blockers.push("daily_discrepancy");
    if (alerts.some((alert) => alert.alertType === "over_order" && alert.status === "pending")) blockers.push("over_order_unconfirmed");
    if (receipts.length > 0) blockers.push("outsource_short_receipt");
    if (reversals.length > 0) blockers.push("source_reversal_pending");
    const activeOperations = order.operations.filter((operation) => operation.status !== "cancelled");
    // A9：missing_operation_report 只适用于 in_house（outsourced 的工序不参与工序完成计数）。
    if (isInHouse && order.status !== "draft" && activeOperations.some((operation) => !combinedByOperation.has(operation.id))) blockers.push("missing_operation_report");
    const allProductionComplete = isInHouse ? activeOperations.length > 0 && activeOperations.every((operation) => { const current = combinedByOperation.get(operation.id); return current ? current.actual.gte(operation.targetQuantity) : false; }) : outsourceDeliveredTotal.gte(order.plannedQuantity);
    const status = deriveOrderProgressStatus({ has_production_orders: true, has_started_production: order.status !== "draft", all_production_complete: allProductionComplete, blockers, has_outsource_pending_handoff: !isInHouse && outsourceDeliveredTotal.eq(0), has_finished_goods_source: !isInHouse && outsourceDeliveredTotal.gt(0), qc_capability_available: true, shipping_capability_available: false });
    // A9：只有 in_house 才生成工序计量行；outsourced 的工序不再出现在 operationMeasurements 里。
    const operationMeasurements = isInHouse ? order.operations.map((operation) => { const current = combinedByOperation.get(operation.id) ?? { actual: new Prisma.Decimal(0), sourceIds: [], dates: [] }; const warningCodes = pendingDiscrepancyOperationIds.has(operation.id) ? ["daily_discrepancy"] : undefined; return { operation_id: operation.id, operation_name: operation.operationNameSnapshot, source_type: "operation_report" as const, source_ids: current.sourceIds, source_dates: current.dates, unit: operation.unit.name, execution_mode: "in_house" as const, ...calculateQuantityProgress(operation.targetQuantity, current.actual, operation.status === "cancelled"), ...(warningCodes ? { warning_codes: warningCodes } : {}) }; }) : [];
    const externalMeasurements = [...outsourceByUnit.values()].map((group) => {
      const planned = group.unit === order.unit.name ? order.plannedQuantity : new Prisma.Decimal(0);
      const sourceType = group.hasReturn ? "outsource_finished_goods_return" : "outsource_direct_shipment";
      return { operation_id: null, operation_name: null, source_type: sourceType, source_ids: group.sourceIds, source_dates: group.sourceDates, unit: group.unit, execution_mode: "outsourced", ...calculateQuantityProgress(planned, group.actual) };
    });
    const uniqueBlockers = [...new Set(status.blockers)];
    const qcSummary = qcSubmissions.reduce((summary, submission) => { summary.submission_count += 1; summary.submitted_quantity = summary.submitted_quantity.plus(submission.submittedQuantity); for (const record of submission.qcRecords) { summary.inspected_quantity = summary.inspected_quantity.plus(record.inspectedQuantity); summary.qualified_quantity = summary.qualified_quantity.plus(record.qualifiedQuantity); summary.conditional_accept_quantity = summary.conditional_accept_quantity.plus(record.conditionalAcceptQuantity); summary.rejected_quantity = summary.rejected_quantity.plus(record.rejectedQuantity); } return summary; }, { submission_count: 0, submitted_quantity: new Prisma.Decimal(0), inspected_quantity: new Prisma.Decimal(0), qualified_quantity: new Prisma.Decimal(0), conditional_accept_quantity: new Prisma.Decimal(0), rejected_quantity: new Prisma.Decimal(0) });
    return { production_order_id: order.id, production_order_no: order.productionOrderNo, order_no: order.orderNo, execution_mode: order.executionMode, status: status.status, status_label: PRODUCTION_PROGRESS_STATUS_LABELS[status.status], blockers: uniqueBlockers, blocker_details: describeProgressBlockers(uniqueBlockers), capability_not_implemented: status.capability_not_implemented, measurements: [...operationMeasurements, ...externalMeasurements], unit_summaries: aggregate.groups, operation_count: isInHouse ? activeOperations.length : 0, completed_operation_count: isInHouse ? operationMeasurements.filter((measurement) => ["completed", "over_order"].includes(measurement.status)).length : 0, outsource_receipt_risk_count: receipts.length, source_warning_codes: aggregate.warnings, qc_summary: Object.fromEntries(Object.entries(qcSummary).map(([key, value]) => [key, value instanceof Prisma.Decimal ? value.toString() : value])) };
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
