import { Prisma, type PrismaClient } from "@prisma/client";
import { decimalString, overallStatus, reconciliationBlockers, WORKBENCH_STATUS_LABELS, type WorkbenchBlocker } from "../../order-workbench/order-workbench.domain";
import type { AgentOrderRoot } from "./order-root";

/**
 * get_order_overview / get_order_status（R-12 的核心口径）：
 *
 * **不是**从 OrderWorkbenchService 返回里删财务字段——那个返回的 overall_status 与 blockers
 * 本身就被应收应付污染（模块设计明文）。这里是按工作台的**数量与进度规则**重建非财务汇总：
 *   - 各模块 summary 只保留 counts/quantities（采购金额、应收应付、工资不进）；
 *   - overall_status 的状态源去掉 receivables/payables（operational 视角的「完成」是物流完成）；
 *   - reconciliationBlockers 复用领域纯函数，财务四个参数传 "0" —— 数量类 blocker 全保留，
 *     财务 blocker（收款/付款核销超额）恒不触发。
 * 上限是口径可能与原服务漂移：同单据对照（P3-T6 集成测试）盯住数量字段。
 */

export type OrderOverviewStore = Pick<PrismaClient, "bom" | "bomItem" | "purchaseOrder" | "purchaseOrderItem" | "purchaseReceipt" | "incomingInspection" | "productionOrder" | "operationDailyReport" | "rawMaterialMovement" | "rawMaterialInbound" | "inventoryFact" | "finishedGoodsQcRecord" | "finishedGoodsInbound" | "finishedGoodsInboundNotice" | "finishedGoodsOutbound">;

const d = (value: string) => new Prisma.Decimal(value);
const sumOf = (values: string[]) => values.reduce((total, value) => total.plus(d(value)), new Prisma.Decimal(0));

function moduleSummary(moduleStatus: string, sourceIds: string[], extra: Record<string, unknown> = {}) {
  return { status: moduleStatus, label: WORKBENCH_STATUS_LABELS[moduleStatus] ?? moduleStatus, counts: { records: sourceIds.length }, source_ids: sourceIds, missing: sourceIds.length === 0, ...extra };
}

export type NonFinancialOverviewInput = {
  root: AgentOrderRoot;
  boms: { id: string; version: number; status: string }[];
  bomRequired: string;
  purchases: { purchaseOrderNo: string; status: string }[];
  ordered: string;
  received: string;
  receiptCount: number;
  inspections: { status: string; inspectedQuantity: string; acceptedQuantity: string; conditionalQuantity: string; rejectedQuantity: string }[];
  inboundQuantity: string;
  production: { productionOrderNo: string; status: string; plannedQuantity: string }[];
  operationQuantity: string;
  rawMaterialDelta: string;
  issued: string;
  returned: string;
  scrapped: string;
  qc: { qcNo: string; conclusion: string; status: string; inspectedQuantity: string; qualifiedQuantity: string; conditionalAcceptQuantity: string; rejectedQuantity: string }[];
  finishedInbounds: { inboundNo: string; status: string; quantity: string; submissionType?: string }[];
  activeNotices: { noticeNo: string; status: string; noticeQuantity: string }[];
  outbounds: { outboundNo: string; status: string; quantity: string }[];
  shippedOutbounds: { outboundNo: string; status: string; quantity: string }[];
  finishedDelta: string;
  defectiveDelta: string;
  updatedAt: Date;
};

export function buildNonFinancialOverview(input: NonFinancialOverviewInput): Record<string, unknown> {
  const inspectedQuantity = sumOf(input.inspections.map((row) => row.inspectedQuantity));
  const acceptedQuantity = sumOf(input.inspections.map((row) => row.acceptedQuantity));
  const conditionalQuantity = sumOf(input.inspections.map((row) => row.conditionalQuantity));
  const rejectedQuantity = sumOf(input.inspections.map((row) => row.rejectedQuantity));
  const plannedQuantity = sumOf(input.production.map((row) => row.plannedQuantity));
  const finishedInboundQuantity = sumOf(input.finishedInbounds.map((row) => row.quantity));
  const postedFinishedQuantity = sumOf(input.finishedInbounds.filter((row) => row.status === "posted").map((row) => row.quantity));
  const draftFinishedQuantity = sumOf(input.finishedInbounds.filter((row) => row.status === "draft").map((row) => row.quantity));
  const noticedPostedQuantity = sumOf(input.finishedInbounds.filter((row) => row.status === "posted" && row.submissionType === "finished_goods_inbound_notice").map((row) => row.quantity));
  const notifiedQuantity = sumOf(input.activeNotices.map((row) => row.noticeQuantity));
  const pendingInbound = Prisma.Decimal.max(d(notifiedQuantity.toString()).minus(d(noticedPostedQuantity.toString())), d("0"));
  const outboundQuantity = sumOf(input.shippedOutbounds.map((row) => row.quantity));

  // 阻塞：数量对账沿用领域纯函数；财务四个参数传 "0"，财务 blocker 恒不触发（见文件头）。
  const blockers: WorkbenchBlocker[] = [];
  if (!input.boms.length) blockers.push({ code: "BOM_MISSING", label: "BOM 尚未建立", suggestion: "请在销售确认后建立 BOM。" });
  if (input.qc.some((row) => row.conclusion === "rejected")) blockers.push({ code: "QC_REJECTED", label: "成品 QC 存在不合格", suggestion: "请处理不良品或重新送检。" });
  if (input.production.some((row) => ["draft", "paused"].includes(row.status))) blockers.push({ code: "PRODUCTION_PENDING", label: "生产单尚未完成", suggestion: "请查看生产进度和阻塞原因。" });
  if (input.shippedOutbounds.length === 0 && input.finishedInbounds.length > 0) blockers.push({ code: "OUTBOUND_MISSING", label: "已有成品但尚未发货", suggestion: "请根据客户交付计划创建成品出库单。" });
  blockers.push(...reconciliationBlockers({
    bomRequired: input.bomRequired, ordered: input.ordered, received: input.received,
    inspected: inspectedQuantity.toString(), accepted: acceptedQuantity.toString(), conditional: conditionalQuantity.toString(),
    inbound: input.inboundQuantity, planned: plannedQuantity.toString(), completed: input.operationQuantity,
    outbound: outboundQuantity.toString(), orderQuantity: input.root.quantity.toString(),
    receivable: "0", receivableAllocated: "0", payable: "0", payableAllocated: "0",
  }));

  // 状态源只含非财务事实：销售单、BOM、生产单、出货（不含应收应付）。
  const statuses = [input.root.status, input.boms.length ? "completed" : "not_started", ...input.production.map((row) => row.status), ...input.shippedOutbounds.map((row) => row.status)];
  const status = overallStatus(statuses, blockers);

  return {
    bom_status: input.boms.length ? "completed" : "not_started",
    procurement_summary: moduleSummary(input.purchases.length ? "in_progress" : "not_started", input.purchases.map((row) => row.purchaseOrderNo), {
      bom_required_quantity: input.bomRequired, ordered_quantity: input.ordered, receipt_count: input.receiptCount, received_quantity: input.received,
      inspection_count: input.inspections.length, inspected_quantity: inspectedQuantity.toString(), accepted_quantity: acceptedQuantity.toString(),
      conditional_quantity: conditionalQuantity.toString(), inbound_quantity: input.inboundQuantity,
    }),
    raw_material_inventory_summary: moduleSummary(input.inboundQuantity !== "0" || input.issued !== "0" ? "in_progress" : "not_started", [], {
      quantity_delta: input.rawMaterialDelta, inbound_quantity: input.inboundQuantity, issued_quantity: input.issued, returned_quantity: input.returned, scrapped_quantity: input.scrapped,
    }),
    production_summary: moduleSummary(input.production.length ? "in_progress" : "not_started", input.production.map((row) => row.productionOrderNo), {
      planned_quantity: plannedQuantity.toString(), operation_completed_quantity: input.operationQuantity,
    }),
    finished_goods_qc_summary: moduleSummary(input.qc.length ? "completed" : "not_started", input.qc.map((row) => row.qcNo), {
      inspected_quantity: inspectedQuantity.toString(), qualified_quantity: sumOf(input.qc.map((row) => row.qualifiedQuantity)).toString(),
      conditional_accept_quantity: sumOf(input.qc.map((row) => row.conditionalAcceptQuantity)).toString(), rejected_quantity: rejectedQuantity.toString(),
      finished_inbound_quantity: finishedInboundQuantity.toString(),
    }),
    finished_goods_inventory_summary: moduleSummary(input.finishedInbounds.length || input.activeNotices.length ? "completed" : "not_started",
      [...input.finishedInbounds.map((row) => row.inboundNo), ...input.activeNotices.map((row) => row.noticeNo)], {
        quantity: finishedInboundQuantity.toString(), posted_quantity: postedFinishedQuantity.toString(), draft_quantity: draftFinishedQuantity.toString(),
        notice_count: input.activeNotices.length, notified_quantity: notifiedQuantity.toString(), pending_inbound_quantity: pendingInbound.toString(),
        stock_quantity: input.finishedDelta, defective_stock_quantity: input.defectiveDelta, outbound_quantity: outboundQuantity.toString(),
      }),
    shipping_summary: moduleSummary(input.shippedOutbounds.length ? "completed" : "not_started", input.shippedOutbounds.map((row) => row.outboundNo), {
      quantity: outboundQuantity.toString(),
      draft_count: input.outbounds.filter((row) => row.status === "draft").length,
      cancelled_count: input.outbounds.filter((row) => row.status === "cancelled").length,
    }),
    overall_status: status,
    overall_status_label: WORKBENCH_STATUS_LABELS[status],
    blockers,
    updated_at: input.updatedAt,
  };
}

export async function getOrderOverview(client: OrderOverviewStore, root: AgentOrderRoot): Promise<{ data: Record<string, unknown>; sources: { business_type: string; business_no: string }[] }> {
  const orderNo = root.orderNo;
  const [boms, bomItems, purchases, purchaseItems, receipts, inspections, production, operationReports, movements, inbounds, inventory, qc, finishedInbounds, inboundNotices, outbounds] = await Promise.all([
    client.bom.findMany({ where: { orderNo, deletedAt: null }, select: { id: true, version: true, status: true } }),
    client.bomItem.findMany({ where: { bom: { orderNo, deletedAt: null }, deletedAt: null }, select: { requiredQuantity: true } }),
    client.purchaseOrder.findMany({ where: { orderNo, deletedAt: null }, select: { purchaseOrderNo: true, status: true } }),
    client.purchaseOrderItem.findMany({ where: { purchaseOrder: { orderNo, deletedAt: null }, deletedAt: null }, select: { quantity: true } }),
    client.purchaseReceipt.findMany({ where: { orderNo, deletedAt: null }, select: { id: true, receiptNo: true, status: true, quantity: true } }),
    client.incomingInspection.findMany({ where: { orderNo, deletedAt: null }, select: { status: true, inspectedQuantity: true, acceptedQuantity: true, conditionalQuantity: true, rejectedQuantity: true } }),
    client.productionOrder.findMany({ where: { orderNo, deletedAt: null }, select: { productionOrderNo: true, status: true, plannedQuantity: true } }),
    client.operationDailyReport.findMany({ where: { orderNo, deletedAt: null }, select: { completedQuantity: true } }),
    client.rawMaterialMovement.findMany({ where: { orderNo, deletedAt: null }, select: { documentType: true, status: true, lines: { where: { deletedAt: null }, select: { quantity: true } } } }),
    client.rawMaterialInbound.findMany({ where: { orderNo, deletedAt: null }, select: { inboundNo: true, status: true, quantity: true } }),
    client.inventoryFact.findMany({ where: { orderNo }, select: { inventoryCategory: true, quantityDelta: true } }),
    client.finishedGoodsQcRecord.findMany({ where: { orderNo, deletedAt: null }, select: { qcNo: true, conclusion: true, status: true, inspectedQuantity: true, qualifiedQuantity: true, conditionalAcceptQuantity: true, rejectedQuantity: true } }),
    client.finishedGoodsInbound.findMany({ where: { orderNo, deletedAt: null }, select: { inboundNo: true, status: true, quantity: true, submission: { select: { sourceType: true } } } }),
    client.finishedGoodsInboundNotice.findMany({ where: { orderNo, deletedAt: null }, select: { noticeNo: true, status: true, noticeQuantity: true } }),
    client.finishedGoodsOutbound.findMany({ where: { orderNo, deletedAt: null }, select: { outboundNo: true, status: true, quantity: true } }),
  ]);

  const sum = (values: Array<{ toString(): string } | null | undefined>) => values.reduce<Prisma.Decimal>((total, value) => total.plus(value === null || value === undefined ? 0 : String(value)), new Prisma.Decimal(0));
  const movementQuantity = (documentType: string) => sum(movements.filter((row) => row.status !== "cancelled" && row.documentType === documentType).flatMap((row) => row.lines.map((line) => line.quantity))).toString();
  const shippedOutbounds = outbounds.filter((row) => ["posted", "shipped", "signed"].includes(row.status));

  const overview = buildNonFinancialOverview({
    root,
    boms,
    bomRequired: sum(bomItems.map((row) => row.requiredQuantity)).toString(),
    purchases: purchases.map((row) => ({ purchaseOrderNo: row.purchaseOrderNo, status: row.status })),
    ordered: sum(purchaseItems.map((row) => row.quantity)).toString(),
    received: sum(receipts.map((row) => row.quantity)).toString(),
    receiptCount: receipts.length,
    inspections: inspections.map((row) => ({ status: row.status, inspectedQuantity: decimalString(row.inspectedQuantity), acceptedQuantity: decimalString(row.acceptedQuantity), conditionalQuantity: decimalString(row.conditionalQuantity), rejectedQuantity: decimalString(row.rejectedQuantity) })),
    inboundQuantity: sum(inbounds.map((row) => row.quantity)).toString(),
    production: production.map((row) => ({ productionOrderNo: row.productionOrderNo, status: row.status, plannedQuantity: decimalString(row.plannedQuantity) })),
    operationQuantity: sum(operationReports.map((row) => row.completedQuantity)).toString(),
    rawMaterialDelta: decimalString(inventory.filter((row) => row.inventoryCategory === "raw_material").reduce<Prisma.Decimal>((total, row) => total.plus(String(row.quantityDelta)), new Prisma.Decimal(0))),
    issued: movementQuantity("issue"), returned: movementQuantity("return"), scrapped: movementQuantity("scrap"),
    qc: qc.map((row) => ({ qcNo: row.qcNo, conclusion: row.conclusion, status: row.status, inspectedQuantity: decimalString(row.inspectedQuantity), qualifiedQuantity: decimalString(row.qualifiedQuantity), conditionalAcceptQuantity: decimalString(row.conditionalAcceptQuantity), rejectedQuantity: decimalString(row.rejectedQuantity) })),
    finishedInbounds: finishedInbounds.map((row) => ({ inboundNo: row.inboundNo, status: row.status, quantity: decimalString(row.quantity), submissionType: row.submission?.sourceType })),
    activeNotices: inboundNotices.filter((row) => row.status !== "cancelled").map((row) => ({ noticeNo: row.noticeNo, status: row.status, noticeQuantity: decimalString(row.noticeQuantity) })),
    outbounds: outbounds.map((row) => ({ outboundNo: row.outboundNo, status: row.status, quantity: decimalString(row.quantity) })),
    shippedOutbounds: shippedOutbounds.map((row) => ({ outboundNo: row.outboundNo, status: row.status, quantity: decimalString(row.quantity) })),
    finishedDelta: decimalString(inventory.filter((row) => row.inventoryCategory === "finished_goods").reduce<Prisma.Decimal>((total, row) => total.plus(String(row.quantityDelta)), new Prisma.Decimal(0))),
    defectiveDelta: decimalString(inventory.filter((row) => row.inventoryCategory === "defective_goods").reduce<Prisma.Decimal>((total, row) => total.plus(String(row.quantityDelta)), new Prisma.Decimal(0))),
    updatedAt: root.updatedAt,
  });

  return {
    data: { order_no: orderNo, sales_status: root.status, ...overview },
    sources: [{ business_type: "sales_order", business_no: orderNo }],
  };
}

export async function getOrderStatus(client: OrderOverviewStore, root: AgentOrderRoot): Promise<{ data: Record<string, unknown>; sources: { business_type: string; business_no: string }[] }> {
  const overview = await getOrderOverview(client, root);
  const full = overview.data;
  return {
    data: {
      order_no: root.orderNo,
      sales_status: root.status,
      bom_status: full.bom_status,
      overall_status: full.overall_status,
      overall_status_label: full.overall_status_label,
      blockers: full.blockers,
    },
    sources: [{ business_type: "sales_order", business_no: root.orderNo }],
  };
}
