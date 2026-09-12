import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../platform/database/prisma.service";
import { decimalString, overallStatus, reconciliationBlockers, WORKBENCH_STATUS_LABELS, type WorkbenchBlocker } from "./order-workbench.domain";

type Filter = { order_no?: string; customer_id?: string; status?: string; has_blockers?: string; from?: string; to?: string; page?: number; page_size?: number };

@Injectable()
export class OrderWorkbenchService {
  constructor(private readonly prisma: PrismaService) {}

  async list(filter: Filter) {
    const where: Prisma.SalesOrderWhereInput = { deletedAt: null, ...(filter.order_no ? { orderNo: { contains: filter.order_no } } : {}), ...(filter.customer_id ? { customerId: filter.customer_id } : {}), ...(filter.status ? { status: filter.status } : {}), ...(filter.from || filter.to ? { updatedAt: { ...(filter.from ? { gte: new Date(filter.from) } : {}), ...(filter.to ? { lte: new Date(filter.to) } : {}) } } : {}) };
    const [orders, total] = await Promise.all([this.prisma.salesOrder.findMany({ where, orderBy: { updatedAt: "desc" }, skip: ((filter.page ?? 1) - 1) * (filter.page_size ?? 20), take: filter.page_size ?? 20 }), this.prisma.salesOrder.count({ where })]);
    const rows = await Promise.all(orders.map((order) => this.summary(order.orderNo, order)));
    const data = filter.has_blockers === undefined ? rows : rows.filter((row) => (filter.has_blockers === "true") === (row.blockers.length > 0));
    return { data, total: filter.has_blockers === undefined ? total : data.length };
  }

  async detail(orderNo: string) { const order = await this.prisma.salesOrder.findFirst({ where: { orderNo, deletedAt: null } }); if (!order) throw new NotFoundException({ code: "ORDER_NOT_FOUND", message: "订单不存在", details: [] }); return this.summary(orderNo, order); }

  async timeline(orderNo: string) {
    const exists = await this.prisma.salesOrder.findFirst({ where: { orderNo, deletedAt: null }, select: { id: true } });
    if (!exists) throw new NotFoundException({ code: "ORDER_NOT_FOUND", message: "订单不存在", details: [] });
    return this.prisma.auditEvent.findMany({ where: { orderNo }, orderBy: { createdAt: "desc" }, take: 200 });
  }

  async summary(orderNo: string, order?: Awaited<ReturnType<PrismaService["salesOrder"]["findFirst"]>>) {
    const root = order ?? await this.prisma.salesOrder.findFirst({ where: { orderNo, deletedAt: null } });
    if (!root) throw new NotFoundException({ code: "ORDER_NOT_FOUND", message: "订单不存在", details: [] });
    const [boms, bomItems, purchases, purchaseItems, receipts, inspections, production, operationReports, movements, inbounds, inventory, qc, finishedInbounds, outbounds, inboundNotices, receivables, receivablePayments, receivableAllocations, payableSources, payables, supplierPayments, supplierPaymentAllocations] = await Promise.all([
      this.prisma.bom.findMany({ where: { orderNo, deletedAt: null }, select: { id: true, version: true, status: true } }),
      this.prisma.bomItem.findMany({ where: { bom: { orderNo, deletedAt: null }, deletedAt: null }, select: { requiredQuantity: true, unit: true } }),
      this.prisma.purchaseOrder.findMany({ where: { orderNo, deletedAt: null }, select: { id: true, purchaseOrderNo: true, status: true, totalAmount: true, currency: true } }),
      this.prisma.purchaseOrderItem.findMany({ where: { purchaseOrder: { orderNo, deletedAt: null }, deletedAt: null }, select: { quantity: true, amount: true, unitId: true } }),
      this.prisma.purchaseReceipt.findMany({ where: { orderNo, deletedAt: null }, select: { id: true, receiptNo: true, status: true, quantity: true, extensionData: true } }),
      this.prisma.incomingInspection.findMany({ where: { orderNo, deletedAt: null }, select: { id: true, status: true, inspectedQuantity: true, acceptedQuantity: true, conditionalQuantity: true, rejectedQuantity: true } }),
      this.prisma.productionOrder.findMany({ where: { orderNo, deletedAt: null }, select: { id: true, productionOrderNo: true, status: true, executionMode: true, plannedQuantity: true, updatedAt: true } }),
      this.prisma.operationDailyReport.findMany({ where: { orderNo, deletedAt: null }, select: { completedQuantity: true } }),
      this.prisma.rawMaterialMovement.findMany({ where: { orderNo, deletedAt: null }, select: { documentType: true, status: true, lines: { where: { deletedAt: null }, select: { quantity: true } } } }),
      this.prisma.rawMaterialInbound.findMany({ where: { orderNo, deletedAt: null }, select: { id: true, inboundNo: true, status: true, quantity: true } }),
      this.prisma.inventoryFact.findMany({ where: { orderNo }, select: { id: true, inventoryCategory: true, quantityDelta: true, sourceId: true } }),
      this.prisma.finishedGoodsQcRecord.findMany({ where: { orderNo, deletedAt: null }, select: { id: true, qcNo: true, conclusion: true, status: true, inspectedQuantity: true, qualifiedQuantity: true, conditionalAcceptQuantity: true, rejectedQuantity: true } }),
      this.prisma.finishedGoodsInbound.findMany({ where: { orderNo, deletedAt: null }, select: { id: true, inboundNo: true, status: true, quantity: true, submission: { select: { sourceType: true } } } }),
      this.prisma.finishedGoodsOutbound.findMany({ where: { orderNo, deletedAt: null }, select: { id: true, outboundNo: true, status: true, quantity: true } }),
      // 成品入库通知（包装工序分批通知入库）——工作台要展示待入库/在途数量。
      this.prisma.finishedGoodsInboundNotice.findMany({ where: { orderNo, deletedAt: null }, select: { id: true, noticeNo: true, status: true, noticeQuantity: true, noticeDate: true, operationNameSnapshot: true } }),
      this.prisma.receivableSource.findMany({ where: { orderNo, deletedAt: null }, select: { id: true, sourceNo: true, status: true, amount: true, currency: true } }),
      this.prisma.customerPayment.findMany({ where: { orderNo, deletedAt: null }, select: { id: true, paymentNo: true, status: true, amount: true, currency: true } }),
      this.prisma.receivableAllocation.findMany({ where: { receivableSource: { orderNo, deletedAt: null }, status: "active", deletedAt: null }, select: { amount: true } }),
      this.prisma.payableSource.findMany({ where: { orderNo, status: "pending_finance" }, select: { id: true, amount: true, currency: true } }),
      this.prisma.supplierPayableEntry.findMany({ where: { orderNo, deletedAt: null }, select: { id: true, payableNo: true, status: true, amount: true, currency: true } }),
      this.prisma.supplierPayment.findMany({ where: { orderNo, deletedAt: null }, select: { id: true, paymentNo: true, status: true, amount: true, currency: true } }),
      this.prisma.supplierPaymentAllocation.findMany({ where: { orderNo, status: "active", deletedAt: null }, select: { amount: true } }),
    ]);
    const sum = (values: Array<Prisma.Decimal | null | undefined>): Prisma.Decimal => values.reduce<Prisma.Decimal>((total, value) => total.plus(value ?? 0), new Prisma.Decimal(0));
    const bomRequired = sum(bomItems.map((row) => row.requiredQuantity));
    const orderedQuantity = sum(purchaseItems.map((row) => row.quantity));
    const receivedQuantity = sum(receipts.map((row) => row.quantity));
    const inspectedQuantity = sum(inspections.map((row) => row.inspectedQuantity));
    const acceptedQuantity = sum(inspections.map((row) => row.acceptedQuantity));
    const conditionalQuantity = sum(inspections.map((row) => row.conditionalQuantity));
    const inboundQuantity = sum(inbounds.map((row) => row.quantity));
    const operationQuantity = sum(operationReports.map((row) => row.completedQuantity));
    const plannedQuantity = sum(production.map((row) => row.plannedQuantity));
    const movementQuantity = (documentType: string) => sum(movements.filter((row) => row.status !== "cancelled" && row.documentType === documentType).flatMap((row) => row.lines.map((line) => line.quantity)));
    const issuedQuantity = movementQuantity("issue");
    const returnedQuantity = movementQuantity("return");
    const scrappedQuantity = movementQuantity("scrap");
    const qualifiedQuantity = sum(qc.map((row) => row.qualifiedQuantity));
    const conditionalFinishedQuantity = sum(qc.map((row) => row.conditionalAcceptQuantity));
    // 成品入库通知口径：待入库 = 未取消通知量 − 已过账入库量；同时给出包装工序累计报工量与成品/次品存量。
    const activeNotices = inboundNotices.filter((row) => row.status !== "cancelled");
    const notifiedQuantity = sum(activeNotices.map((row) => row.noticeQuantity));
    const postedFinishedQuantity = sum(finishedInbounds.filter((row) => row.status === "posted").map((row) => row.quantity));
    const draftFinishedQuantity = sum(finishedInbounds.filter((row) => row.status === "draft").map((row) => row.quantity));
    const finishedStockQuantity = sum(inventory.filter((row) => row.inventoryCategory === "finished_goods").map((row) => row.quantityDelta));
    const defectiveStockQuantity = sum(inventory.filter((row) => row.inventoryCategory === "defective_goods").map((row) => row.quantityDelta));
    // 待入库只与「入库通知」这条链相关：历史 in_house_completion / 外加工回厂入库没有通知，
    // 直接拿通知量减全部已过账入库会算出负数，因此这里只减通知来源的过账量，并对 0 取底。
    const noticedPostedQuantity = sum(finishedInbounds.filter((row) => row.status === "posted" && row.submission?.sourceType === "finished_goods_inbound_notice").map((row) => row.quantity));
    const pendingInboundQuantity = Prisma.Decimal.max(notifiedQuantity.minus(noticedPostedQuantity), new Prisma.Decimal(0));
    const finishedInboundQuantity = sum(finishedInbounds.map((row) => row.quantity));
    // 已出库只算真正发出去的（posted/shipped/signed）：草稿是待出库，cancelled/reversed 都不算。
    // 之前把全部出库单（含草稿与 60844f2 新增的 cancelled）都累加，工作台会显示虚高的「已出库」，
    // 甚至误报 OUTBOUND_OVER_ORDER。
    const shippedOutbounds = outbounds.filter((row) => ["posted", "shipped", "signed"].includes(row.status));
    const outboundQuantity = sum(shippedOutbounds.map((row) => row.quantity));
    const paidReceivableAmount = sum(receivableAllocations.map((row) => row.amount));
    const paidPayableAmount = sum(supplierPaymentAllocations.map((row) => row.amount));
    const blockers: WorkbenchBlocker[] = [];
    if (!boms.length) blockers.push({ code: "BOM_MISSING", label: "BOM 尚未建立", suggestion: "请在销售确认后建立 BOM。" });
    if (qc.some((row) => row.conclusion === "rejected")) blockers.push({ code: "QC_REJECTED", label: "成品 QC 存在不合格", suggestion: "请处理不良品或重新送检。" });
    if (production.some((row) => ["draft", "paused"].includes(row.status))) blockers.push({ code: "PRODUCTION_PENDING", label: "生产单尚未完成", suggestion: "请查看生产进度和阻塞原因。" });
    if (shippedOutbounds.length === 0 && finishedInbounds.length > 0) blockers.push({ code: "OUTBOUND_MISSING", label: "已有成品但尚未发货", suggestion: "请根据客户交付计划创建成品出库单。" });
    blockers.push(...reconciliationBlockers({ bomRequired: bomRequired.toString(), ordered: orderedQuantity.toString(), received: receivedQuantity.toString(), inspected: inspectedQuantity.toString(), accepted: acceptedQuantity.toString(), conditional: conditionalQuantity.toString(), inbound: inboundQuantity.toString(), planned: plannedQuantity.toString(), completed: operationQuantity.toString(), outbound: outboundQuantity.toString(), orderQuantity: root.quantity.toString(), receivable: sum(receivables.map((row) => row.amount)).toString(), receivableAllocated: paidReceivableAmount.toString(), payable: sum(payables.map((row) => row.amount)).toString(), payableAllocated: paidPayableAmount.toString() }));
    const statuses = [root.status, boms.length ? "completed" : "not_started", ...production.map((row) => row.status), ...shippedOutbounds.map((row) => row.status), ...receivables.map((row) => row.status), ...payables.map((row) => row.status)];
    const status = overallStatus(statuses, blockers);
    const module = (moduleStatus: string, rows: unknown[], sourceIds: string[], extra: Record<string, unknown> = {}) => ({ status: moduleStatus, label: WORKBENCH_STATUS_LABELS[moduleStatus] ?? moduleStatus, counts: { records: rows.length }, source_ids: sourceIds, missing: rows.length === 0, ...extra });
    const amount = (rows: Array<{ amount: Prisma.Decimal; currency: string }>) => ({ amount: rows.reduce((sum, row) => sum.plus(row.amount), new Prisma.Decimal(0)).toString(), currency: rows[0]?.currency ?? root.currency });
    return { order_no: orderNo, customer: root.customerSnapshot, sales_status: root.status, bom_status: boms.length ? "completed" : "not_started", procurement_summary: module(purchases.length ? "in_progress" : "not_started", purchases, purchases.map((row) => row.purchaseOrderNo), { amounts: amount(purchases.map((row) => ({ amount: row.totalAmount, currency: row.currency }))), bom_required_quantity: bomRequired.toString(), ordered_quantity: orderedQuantity.toString(), receipt_count: receipts.length, received_quantity: receivedQuantity.toString(), inspection_count: inspections.length, inspected_quantity: inspectedQuantity.toString(), accepted_quantity: acceptedQuantity.toString(), conditional_quantity: conditionalQuantity.toString(), inbound_quantity: inboundQuantity.toString() }), raw_material_inventory_summary: module(inbounds.length ? "in_progress" : "not_started", inbounds, inbounds.map((row) => row.inboundNo), { quantity_delta: decimalString(inventory.filter((row) => row.inventoryCategory === "raw_material").reduce((total, row) => total.plus(row.quantityDelta), new Prisma.Decimal(0))), inbound_quantity: inboundQuantity.toString(), issued_quantity: issuedQuantity.toString(), returned_quantity: returnedQuantity.toString(), scrapped_quantity: scrappedQuantity.toString() }), production_summary: module(production.length ? "in_progress" : "not_started", production, production.map((row) => row.productionOrderNo), { planned_quantity: plannedQuantity.toString(), operation_completed_quantity: operationQuantity.toString() }), finished_goods_qc_summary: module(qc.length ? "completed" : "not_started", qc, qc.map((row) => row.qcNo), { inspected_quantity: sum(qc.map((row) => row.inspectedQuantity)).toString(), qualified_quantity: qualifiedQuantity.toString(), conditional_accept_quantity: conditionalFinishedQuantity.toString(), rejected_quantity: sum(qc.map((row) => row.rejectedQuantity)).toString(), finished_inbound_quantity: finishedInboundQuantity.toString() }), finished_goods_inventory_summary: module(finishedInbounds.length || activeNotices.length ? "completed" : "not_started", [...finishedInbounds, ...activeNotices], [...finishedInbounds.map((row) => row.inboundNo), ...activeNotices.map((row) => row.noticeNo)], { quantity: finishedInboundQuantity.toString(), posted_quantity: postedFinishedQuantity.toString(), noticed_posted_quantity: noticedPostedQuantity.toString(), draft_quantity: draftFinishedQuantity.toString(), notice_count: activeNotices.length, notified_quantity: notifiedQuantity.toString(), pending_inbound_quantity: pendingInboundQuantity.toString(), stock_quantity: finishedStockQuantity.toString(), defective_stock_quantity: defectiveStockQuantity.toString(), outbound_quantity: outboundQuantity.toString() }), shipping_summary: module(shippedOutbounds.length ? "completed" : "not_started", shippedOutbounds, shippedOutbounds.map((row) => row.outboundNo), { quantity: outboundQuantity.toString(), draft_count: outbounds.filter((row) => row.status === "draft").length, cancelled_count: outbounds.filter((row) => row.status === "cancelled").length }), receivable_summary: module(receivables.length ? "in_progress" : "not_started", receivables, receivables.map((row) => row.sourceNo), { amounts: amount(receivables), payment_count: receivablePayments.length, paid_amount: paidReceivableAmount.toString(), outstanding_amount: sum(receivables.map((row) => row.amount)).minus(paidReceivableAmount).toString() }), payable_summary: module(payables.length || payableSources.length ? "in_progress" : "not_started", [...payables, ...payableSources], [...payables.map((row) => row.payableNo), ...payableSources.map((row) => row.id)], { amounts: amount(payables), pending_source_count: payableSources.length, pending_source_amount: sum(payableSources.map((row) => row.amount)).toString(), payment_count: supplierPayments.length, paid_amount: paidPayableAmount.toString(), outstanding_amount: sum(payables.map((row) => row.amount)).minus(paidPayableAmount).toString() }), overall_status: status, overall_status_label: WORKBENCH_STATUS_LABELS[status], blockers, updated_at: root.updatedAt };
  }
}
