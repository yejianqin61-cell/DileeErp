import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../platform/database/prisma.service";
import { decimalString, overallStatus, WORKBENCH_STATUS_LABELS, type WorkbenchBlocker } from "./order-workbench.domain";

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
    const [boms, purchases, production, inbounds, inventory, qc, finishedInbounds, outbounds, receivables, payables] = await Promise.all([
      this.prisma.bom.findMany({ where: { orderNo, deletedAt: null }, select: { id: true, version: true, status: true } }),
      this.prisma.purchaseOrder.findMany({ where: { orderNo, deletedAt: null }, select: { id: true, purchaseOrderNo: true, status: true, totalAmount: true, currency: true } }),
      this.prisma.productionOrder.findMany({ where: { orderNo, deletedAt: null }, select: { id: true, productionOrderNo: true, status: true, executionMode: true, updatedAt: true } }),
      this.prisma.rawMaterialInbound.findMany({ where: { orderNo, deletedAt: null }, select: { id: true, inboundNo: true, status: true, quantity: true } }),
      this.prisma.inventoryFact.findMany({ where: { orderNo }, select: { id: true, inventoryCategory: true, quantityDelta: true, sourceId: true } }),
      this.prisma.finishedGoodsQcRecord.findMany({ where: { orderNo, deletedAt: null }, select: { id: true, qcNo: true, conclusion: true, status: true, inspectedQuantity: true, rejectedQuantity: true } }),
      this.prisma.finishedGoodsInbound.findMany({ where: { orderNo, deletedAt: null }, select: { id: true, inboundNo: true, status: true, quantity: true } }),
      this.prisma.finishedGoodsOutbound.findMany({ where: { orderNo, deletedAt: null }, select: { id: true, outboundNo: true, status: true, quantity: true } }),
      this.prisma.receivableSource.findMany({ where: { orderNo, deletedAt: null }, select: { id: true, sourceNo: true, status: true, amount: true, currency: true } }),
      this.prisma.supplierPayableEntry.findMany({ where: { orderNo, deletedAt: null }, select: { id: true, payableNo: true, status: true, amount: true, currency: true } }),
    ]);
    const blockers: WorkbenchBlocker[] = [];
    if (!boms.length) blockers.push({ code: "BOM_MISSING", label: "BOM 尚未建立", suggestion: "请在销售确认后建立 BOM。" });
    if (qc.some((row) => row.conclusion === "rejected")) blockers.push({ code: "QC_REJECTED", label: "成品 QC 存在不合格", suggestion: "请处理不良品或重新送检。" });
    if (production.some((row) => ["draft", "paused"].includes(row.status))) blockers.push({ code: "PRODUCTION_PENDING", label: "生产单尚未完成", suggestion: "请查看生产进度和阻塞原因。" });
    if (outbounds.length === 0 && finishedInbounds.length > 0) blockers.push({ code: "OUTBOUND_MISSING", label: "已有成品但尚未发货", suggestion: "请根据客户交付计划创建成品出库单。" });
    const statuses = [root.status, boms.length ? "completed" : "not_started", ...production.map((row) => row.status), ...outbounds.map((row) => row.status), ...receivables.map((row) => row.status), ...payables.map((row) => row.status)];
    const status = overallStatus(statuses, blockers);
    const module = (moduleStatus: string, rows: unknown[], sourceIds: string[], extra: Record<string, unknown> = {}) => ({ status: moduleStatus, label: WORKBENCH_STATUS_LABELS[moduleStatus] ?? moduleStatus, counts: { records: rows.length }, source_ids: sourceIds, missing: rows.length === 0, ...extra });
    const amount = (rows: Array<{ amount: Prisma.Decimal; currency: string }>) => ({ amount: rows.reduce((sum, row) => sum.plus(row.amount), new Prisma.Decimal(0)).toString(), currency: rows[0]?.currency ?? root.currency });
    return { order_no: orderNo, customer: root.customerSnapshot, sales_status: root.status, bom_status: boms.length ? "completed" : "not_started", procurement_summary: module(purchases.length ? "in_progress" : "not_started", purchases, purchases.map((row) => row.purchaseOrderNo), { amounts: amount(purchases.map((row) => ({ amount: row.totalAmount, currency: row.currency }))) }), raw_material_inventory_summary: module(inbounds.length ? "in_progress" : "not_started", inbounds, inbounds.map((row) => row.inboundNo), { quantity_delta: decimalString(inventory.filter((row) => row.inventoryCategory === "raw_material").reduce((sum, row) => sum.plus(row.quantityDelta), new Prisma.Decimal(0))) }), production_summary: module(production.length ? "in_progress" : "not_started", production, production.map((row) => row.productionOrderNo)), finished_goods_qc_summary: module(qc.length ? "completed" : "not_started", qc, qc.map((row) => row.qcNo), { rejected_quantity: decimalString(qc.reduce((sum, row) => sum.plus(row.rejectedQuantity), new Prisma.Decimal(0))) }), finished_goods_inventory_summary: module(finishedInbounds.length ? "completed" : "not_started", finishedInbounds, finishedInbounds.map((row) => row.inboundNo)), shipping_summary: module(outbounds.length ? "completed" : "not_started", outbounds, outbounds.map((row) => row.outboundNo)), receivable_summary: module(receivables.length ? "in_progress" : "not_started", receivables, receivables.map((row) => row.sourceNo), { amounts: amount(receivables) }), payable_summary: module(payables.length ? "in_progress" : "not_started", payables, payables.map((row) => row.payableNo), { amounts: amount(payables) }), overall_status: status, overall_status_label: WORKBENCH_STATUS_LABELS[status], blockers, updated_at: root.updatedAt };
  }
}
