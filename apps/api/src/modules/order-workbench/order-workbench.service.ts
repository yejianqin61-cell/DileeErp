import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../platform/database/prisma.service";
import { MAX_PAGE_SIZE } from "../../platform/http/pagination-query.dto";
import { decimalString, overallStatus, reconciliationBlockers, WORKBENCH_STATUS_LABELS, type WorkbenchBlocker } from "./order-workbench.domain";

type Filter = { order_no?: string; customer_id?: string; status?: string; has_blockers?: string; from?: string; to?: string; page?: number; page_size?: number };

/**
 * 一次查询取回的「一个订单的全链路事实」，按订单号分好组（每单一份）。
 *
 * 类型**从 `queryBundle` 的返回值推导**，而不是手写或用 `findMany` 的宽泛返回：
 * 后者不含 `include`/`select` 出来的关联字段（`lines`、`submission`），会逼出一堆断言。
 * 推导出来的类型与真实查询逐字对齐，select 改了这里自动跟随。
 */
type Bundle = Awaited<ReturnType<typeof queryBundle>>;

/** 批量查询的订单号过滤条件。 */
type OrderNoFilter = Prisma.StringFilter;

/** 单个订单一次 summary 需要的事实字段数量（保持与 queryBundle 一致，供测试断言）。 */
export const SUMMARY_QUERY_COUNT = 22;

/**
 * 列表分页上限。
 *
 * 工作台前端没有分页控件，靠一次拉一段再在前端按关键字过滤（首屏 100，可「加载更多」）。
 * 上限统一到全局的 `MAX_PAGE_SIZE`（2026-11-27：200 → 1000），避免这里 500、控制器 200、
 * 前端 200 三处各说各话 —— 那种漂移会让「前端能传、后端拒绝」变成 400。
 *
 * 这里转出一次是为了不破坏既有 import（测试与调用方一直从本文件拿 MAX_PAGE_SIZE）。
 */
export { MAX_PAGE_SIZE };

@Injectable()
export class OrderWorkbenchService {
  constructor(private readonly prisma: PrismaService) {}

  async list(filter: Filter) {
    const where: Prisma.SalesOrderWhereInput = { deletedAt: null, ...(filter.order_no ? { orderNo: { contains: filter.order_no } } : {}), ...(filter.customer_id ? { customerId: filter.customer_id } : {}), ...(filter.status ? { status: filter.status } : {}), ...(filter.from || filter.to ? { updatedAt: { ...(filter.from ? { gte: new Date(filter.from) } : {}), ...(filter.to ? { lte: new Date(filter.to) } : {}) } } : {}) };
    const pageSize = Math.min(filter.page_size ?? 20, MAX_PAGE_SIZE);
    const [orders, total] = await Promise.all([
      this.prisma.salesOrder.findMany({ where, orderBy: { updatedAt: "desc" }, skip: ((filter.page ?? 1) - 1) * pageSize, take: pageSize }),
      this.prisma.salesOrder.count({ where }),
    ]);

    // ── 2026-11-22：一次批量取全链路事实，不再「每个订单发 22 个查询」──────────────
    // 改前：list() 对每个订单调 summary()，每个 summary() 内含 22 个并发查询，
    //       于是 page_size=200 → 200 × 22 = 4400 个查询打向只有 15 个连接的池，
    //       单个用户打开工作台就能把池打满（实测报 "Timed out fetching a new connection"）。
    // 改后：整批订单只用 22 个查询（每个查询带 `orderNo IN (...)`），在内存里按订单分组。
    //       代价是内存里多放一份本页数据（200 单约几 MB），换来查询数与订单数无关。
    const bundles = await this.fetchBundles(orders.map((order) => order.orderNo));
    const rows = orders.map((order) => this.buildSummary(order.orderNo, order, bundles.get(order.orderNo) ?? emptyBundle()));

    const data = filter.has_blockers === undefined ? rows : rows.filter((row) => (filter.has_blockers === "true") === (row.blockers.length > 0));
    return { data, total: filter.has_blockers === undefined ? total : data.length };
  }

  async detail(orderNo: string) { return await this.summary(orderNo); }

  async timeline(orderNo: string) {
    const exists = await this.prisma.salesOrder.findFirst({ where: { orderNo, deletedAt: null }, select: { id: true } });
    if (!exists) throw new NotFoundException({ code: "ORDER_NOT_FOUND", message: "订单不存在", details: [] });
    return this.prisma.auditEvent.findMany({ where: { orderNo }, orderBy: { createdAt: "desc" }, take: 200 });
  }

  /** 单个订单的汇总：取一个订单的事实再算，与列表走**同一套**计算（口径不可能分叉）。 */
  async summary(orderNo: string, order?: Awaited<ReturnType<PrismaService["salesOrder"]["findFirst"]>>) {
    const root = order ?? await this.prisma.salesOrder.findFirst({ where: { orderNo, deletedAt: null } });
    if (!root) throw new NotFoundException({ code: "ORDER_NOT_FOUND", message: "订单不存在", details: [] });
    const bundles = await this.fetchBundles([orderNo]);
    return this.buildSummary(orderNo, root, bundles.get(orderNo) ?? emptyBundle());
  }

  /**
   * 批量取事实：整批订单共用 22 个查询，按订单号分组成 Map。
   *
   * 空批次直接返回空 Map：`orderNo: { in: [] }` 虽然合法，但没必要发 22 个空查询。
   */
  private async fetchBundles(orderNos: string[]): Promise<Map<string, Bundle>> {
    if (orderNos.length === 0) return new Map();
    const raw = await queryBundle(this.prisma, { in: orderNos });
    return groupBundle(orderNos, raw);
  }

  /**
   * 一个订单的汇总计算。**纯函数**（除了 Decimal 求和无副作用），
   * 列表与详情都走它，所以「列表里的数字」与「点进去看到的数字」不可能不一致。
   */
  private buildSummary(orderNo: string, root: NonNullable<Awaited<ReturnType<PrismaService["salesOrder"]["findFirst"]>>>, bundle: Bundle) {
    const { boms, bomItems, purchases, purchaseItems, receipts, inspections, production, operationReports, movements, inbounds, inventory, qc, finishedInbounds, outbounds, inboundNotices, receivables, receivablePayments, receivableAllocations, payableSources, payables, supplierPayments, supplierPaymentAllocations } = bundle;
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

/**
 * 整批订单共用的一次批量查询（22 个查询，每个带 `orderNo IN (...)`）。
 *
 * 三个查询是「经过父表找到订单号」的（BOM 明细、采购明细、应收核销），
 * 所以额外 select 父表的 orderNo 并摊平到行上，后面统一按 orderNo 分组；其余表本身就有 orderNo。
 *
 * 独立成模块级函数（而不是类方法）有两个好处：
 *   ① `Bundle` 类型可以从它的返回值推导，不必手写一遍、也就不会与真实 select 脱节；
 *   ② 可以直接被单测注入替身 prisma 调用，不用起 Nest 容器。
 */
export async function queryBundle(prisma: PrismaService, orderNo: OrderNoFilter) {
  const [boms, bomItemsRaw, purchases, purchaseItemsRaw, receipts, inspections, production, operationReports, movements, inbounds, inventory, qc, finishedInbounds, outbounds, inboundNotices, receivables, receivablePayments, receivableAllocationsRaw, payableSources, payables, supplierPayments, supplierPaymentAllocations] = await Promise.all([
    prisma.bom.findMany({ where: { orderNo, deletedAt: null }, select: { orderNo: true, id: true, version: true, status: true } }),
    prisma.bomItem.findMany({ where: { bom: { orderNo, deletedAt: null }, deletedAt: null }, select: { requiredQuantity: true, unit: true, bom: { select: { orderNo: true } } } }),
    prisma.purchaseOrder.findMany({ where: { orderNo, deletedAt: null }, select: { orderNo: true, id: true, purchaseOrderNo: true, status: true, totalAmount: true, currency: true } }),
    prisma.purchaseOrderItem.findMany({ where: { purchaseOrder: { orderNo, deletedAt: null }, deletedAt: null }, select: { quantity: true, amount: true, unitId: true, purchaseOrder: { select: { orderNo: true } } } }),
    prisma.purchaseReceipt.findMany({ where: { orderNo, deletedAt: null }, select: { orderNo: true, id: true, receiptNo: true, status: true, quantity: true, extensionData: true } }),
    prisma.incomingInspection.findMany({ where: { orderNo, deletedAt: null }, select: { orderNo: true, id: true, status: true, inspectedQuantity: true, acceptedQuantity: true, conditionalQuantity: true, rejectedQuantity: true } }),
    prisma.productionOrder.findMany({ where: { orderNo, deletedAt: null }, select: { orderNo: true, id: true, productionOrderNo: true, status: true, executionMode: true, plannedQuantity: true, updatedAt: true } }),
    prisma.operationDailyReport.findMany({ where: { orderNo, deletedAt: null }, select: { orderNo: true, completedQuantity: true } }),
    prisma.rawMaterialMovement.findMany({ where: { orderNo, deletedAt: null }, select: { orderNo: true, documentType: true, status: true, lines: { where: { deletedAt: null }, select: { quantity: true } } } }),
    prisma.rawMaterialInbound.findMany({ where: { orderNo, deletedAt: null }, select: { orderNo: true, id: true, inboundNo: true, status: true, quantity: true } }),
    prisma.inventoryFact.findMany({ where: { orderNo }, select: { orderNo: true, id: true, inventoryCategory: true, quantityDelta: true, sourceId: true } }),
    prisma.finishedGoodsQcRecord.findMany({ where: { orderNo, deletedAt: null }, select: { orderNo: true, id: true, qcNo: true, conclusion: true, status: true, inspectedQuantity: true, qualifiedQuantity: true, conditionalAcceptQuantity: true, rejectedQuantity: true } }),
    prisma.finishedGoodsInbound.findMany({ where: { orderNo, deletedAt: null }, select: { orderNo: true, id: true, inboundNo: true, status: true, quantity: true, submission: { select: { sourceType: true } } } }),
    prisma.finishedGoodsOutbound.findMany({ where: { orderNo, deletedAt: null }, select: { orderNo: true, id: true, outboundNo: true, status: true, quantity: true } }),
    // 成品入库通知（包装工序分批通知入库）——工作台要展示待入库/在途数量。
    prisma.finishedGoodsInboundNotice.findMany({ where: { orderNo, deletedAt: null }, select: { orderNo: true, id: true, noticeNo: true, status: true, noticeQuantity: true, noticeDate: true, operationNameSnapshot: true } }),
    prisma.receivableSource.findMany({ where: { orderNo, deletedAt: null }, select: { orderNo: true, id: true, sourceNo: true, status: true, amount: true, currency: true } }),
    prisma.customerPayment.findMany({ where: { orderNo, deletedAt: null }, select: { orderNo: true, id: true, paymentNo: true, status: true, amount: true, currency: true } }),
    prisma.receivableAllocation.findMany({ where: { receivableSource: { orderNo, deletedAt: null }, status: "active", deletedAt: null }, select: { amount: true, receivableSource: { select: { orderNo: true } } } }),
    prisma.payableSource.findMany({ where: { orderNo, status: "pending_finance" }, select: { orderNo: true, id: true, amount: true, currency: true } }),
    prisma.supplierPayableEntry.findMany({ where: { orderNo, deletedAt: null }, select: { orderNo: true, id: true, payableNo: true, status: true, amount: true, currency: true } }),
    prisma.supplierPayment.findMany({ where: { orderNo, deletedAt: null }, select: { orderNo: true, id: true, paymentNo: true, status: true, amount: true, currency: true } }),
    prisma.supplierPaymentAllocation.findMany({ where: { orderNo, status: "active", deletedAt: null }, select: { orderNo: true, amount: true } }),
  ]);
  const bomItems = bomItemsRaw.map((row) => ({ ...row, orderNo: row.bom.orderNo }));
  const purchaseItems = purchaseItemsRaw.map((row) => ({ ...row, orderNo: row.purchaseOrder.orderNo }));
  const receivableAllocations = receivableAllocationsRaw.map((row) => ({ ...row, orderNo: row.receivableSource.orderNo }));
  return { boms, bomItems, purchases, purchaseItems, receipts, inspections, production, operationReports, movements, inbounds, inventory, qc, finishedInbounds, outbounds, inboundNotices, receivables, receivablePayments, receivableAllocations, payableSources, payables, supplierPayments, supplierPaymentAllocations };
}
/** 空事实：订单在页里但一条关联数据都没有时用（等价于「全部查询都没查到」）。 */
function emptyBundle(): Bundle {
  return { boms: [], bomItems: [], purchases: [], purchaseItems: [], receipts: [], inspections: [], production: [], operationReports: [], movements: [], inbounds: [], inventory: [], qc: [], finishedInbounds: [], outbounds: [], inboundNotices: [], receivables: [], receivablePayments: [], receivableAllocations: [], payableSources: [], payables: [], supplierPayments: [], supplierPaymentAllocations: [] };
}

/** 把整批查询结果按 orderNo 分组成「每单一份事实」；没有关联数据的订单一律给空事实。 */
export function groupBundle(orderNos: readonly string[], raw: Record<keyof Bundle, Array<{ orderNo?: string | null }>>): Map<string, Bundle> {
  const maps = new Map<string, Map<string, unknown[]>>();
  for (const key of Object.keys(raw) as Array<keyof Bundle>) {
    const perOrder = new Map<string, unknown[]>();
    for (const row of raw[key]) {
      const orderNo = (row as { orderNo?: string | null }).orderNo;
      if (typeof orderNo !== "string" || orderNo.length === 0) continue;
      const list = perOrder.get(orderNo);
      if (list === undefined) perOrder.set(orderNo, [row]);
      else list.push(row);
    }
    maps.set(key, perOrder);
  }
  const result = new Map<string, Bundle>();
  for (const orderNo of orderNos) {
    const bundle = emptyBundle() as unknown as Record<string, unknown[]>;
    for (const key of maps.keys() as Iterable<keyof Bundle>) {
      bundle[key] = maps.get(key)?.get(orderNo) ?? [];
    }
    result.set(orderNo, bundle as unknown as Bundle);
  }
  return result;
}