import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../platform/database/prisma.service";
import { itemNoKey } from "../sales/item-no";
import { mergeArticles, qualifiedRate, sumByCurrency, unassignedOrderRow, OPEN_PRODUCTION_STATUSES, SHIPPED_OUTBOUND_STATUSES, type ArticleOrderRow, type MergedArticle } from "./reorder.domain";

/**
 * 「返单与总结」的读模型（2026-09-26）。
 *
 * 老板要的是「可以调取该货号。查看当时该批货号的采购，生产，QC 的所有表单，信息」——
 * 这个模块只做**读**：货号清单、该货号的历次批次、某一批的全部单据。写入口只有销售单本身
 * （返单建单走 `SalesOrdersService.create()`，见 T05）。
 *
 * 权限与工作台同口径（六模块任一可读），因为它的内容横跨采购/生产/质检/仓库/财务。
 * `total` 的语义是**归并后的货号数**，不是销售单数 —— 与那几个「total 其实是本页行数」的
 * 既有缺陷端点（见 contract-guardrails 的记载）刻意区分开。
 */
export type ArticleFilter = { q?: string; customer_id?: string; include_closed?: string; include_deleted?: string; page?: number; page_size?: number };
export type UnassignedFilter = { q?: string; customer_id?: string; include_closed?: string; include_deleted?: string; page?: number; page_size?: number };
export type ArticleDetailFilter = { include_closed?: string; include_deleted?: string };

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 200;

/** 下游事实（只对当前页/当前货号的订单号查一次，列表与详情共用）。 */
type DownstreamSources = {
  purchases: Array<{ orderNo: string; totalAmount: Prisma.Decimal; currency: string }>;
  receivables: Array<{ orderNo: string; amount: Prisma.Decimal; currency: string }>;
  qc: Array<{ orderNo: string; inspectedQuantity: Prisma.Decimal; qualifiedQuantity: Prisma.Decimal; conditionalAcceptQuantity: Prisma.Decimal; rejectedQuantity: Prisma.Decimal }>;
  production: Array<{ orderNo: string; status: string }>;
};

@Injectable()
export class ReorderService {
  constructor(private readonly prisma: PrismaService) {}

  /** 订单的轻字段：货号清单与待补录清单都只要这些（下游聚合另算）。 */
  private static readonly LIGHT_SELECT = {
    id: true, orderNo: true, itemNo: true, orderDate: true, deliveryDate: true, status: true, currentVersion: true,
    quantity: true, unit: true, currency: true, productName: true, customerId: true, customerSnapshot: true, reorderFromOrderNo: true,
  } as const;

  private static pageOf(filter: { page?: number; page_size?: number }) {
    const page = Math.max(filter.page ?? 1, 1);
    const pageSize = Math.min(Math.max(filter.page_size ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
    return { page, pageSize, skip: (page - 1) * pageSize };
  }

  /** 客户名取**下当时的快照**（与工作台同口径）：客户后来改名不该改写历史单据上的客户。 */
  private static rowOf(order: { id: string; orderNo: string; itemNo: string | null; orderDate: Date; deliveryDate: Date | null; status: string; currentVersion: number; quantity: Prisma.Decimal; unit: string; currency: string; productName: string; customerId: string; customerSnapshot: Prisma.JsonValue; reorderFromOrderNo: string | null }): ArticleOrderRow {
    const snapshot = (order.customerSnapshot ?? {}) as { name?: unknown };
    return {
      id: order.id, orderNo: order.orderNo, itemNo: order.itemNo, orderDate: order.orderDate, deliveryDate: order.deliveryDate,
      status: order.status, currentVersion: order.currentVersion, quantity: order.quantity, unit: order.unit, currency: order.currency,
      productName: order.productName, customerId: order.customerId, customerName: typeof snapshot.name === "string" ? snapshot.name : null,
      reorderFromOrderNo: order.reorderFromOrderNo,
    };
  }

  private where(filter: { customer_id?: string; include_closed?: string; include_deleted?: string }, itemNo: Prisma.SalesOrderWhereInput["itemNo"]) {
    return {
      // 软删默认排除（可显式包含）；已关闭订单**默认纳入** —— 返单看的是历史经营事实。
      ...(filter.include_deleted === "true" ? {} : { deletedAt: null }),
      ...(filter.include_closed === "false" ? { status: { not: "closed" } } : {}),
      ...(filter.customer_id ? { customerId: filter.customer_id } : {}),
      itemNo,
    } satisfies Prisma.SalesOrderWhereInput;
  }

  private async loadRows(filter: { customer_id?: string; include_closed?: string; include_deleted?: string }, itemNo: Prisma.SalesOrderWhereInput["itemNo"]) {
    const orders = await this.prisma.salesOrder.findMany({ where: this.where(filter, itemNo), select: ReorderService.LIGHT_SELECT, orderBy: { orderDate: "asc" } });
    return orders.map((order) => ReorderService.rowOf(order));
  }

  /**
   * 货号清单：一行一个货号（不是一行一张单）。
   *
   * 三步走（顺序不能换）：
   *   1. 拉全部匹配订单的**轻字段**；
   *   2. 按归一键在内存里归并（原因见 `mergeArticles` 的注释）；
   *   3. 排序分页，**只对当前页的货号**做下游聚合（采购金额 / 应收 / QC / 在制）。
   */
  async listArticles(filter: ArticleFilter) {
    const rows = await this.loadRows(filter, { not: null });
    const merged = mergeArticles(rows, itemNoKey);
    const query = itemNoKey(filter.q);
    const matched = query ? merged.filter((article) => article.itemNoKey.includes(query)) : merged;
    const { page, pageSize, skip } = ReorderService.pageOf(filter);
    const pageRows = matched.slice(skip, skip + pageSize);
    const sources = await this.loadArticleAggregates(ReorderService.orderNosOf(pageRows));
    return { data: pageRows.map((article) => this.aggregate(article, sources)), total: matched.length, page, page_size: pageSize };
  }

  /**
   * 货号详情：该货号的**每一批**（销售单）与跨批汇总。
   *
   * 边界（与设计文档一致）：这里**只做货号轴上的汇总**，不重算工作台那套阻塞与配平 ——
   * 两套阻塞计算一定会漂移，而漂移的后果是业务在返单页看到"没问题"、在工作台看到"卡住了"。
   * 每批给一个 `workbench_href`，要看推进状态去工作台。
   */
  async articleDetail(itemNo: string, filter: ArticleDetailFilter = {}) {
    const rows = await this.loadRows(filter, { not: null });
    const key = itemNoKey(itemNo);
    const article = mergeArticles(rows, itemNoKey).find((candidate) => candidate.itemNoKey === key);
    if (!article) throw new NotFoundException({ code: "ARTICLE_NOT_FOUND", message: `没有找到货号「${itemNo}」的销售单`, details: [{ item_no: itemNo }] });

    const orderNos = article.orderNos;
    const [sources, facts] = await Promise.all([this.loadArticleAggregates(orderNos), this.loadOrderFacts(orderNos)]);
    const index = ReorderService.groupByOrder;
    const qcByOrder = index(sources.qc);
    const inboundByOrder = index(facts.inbounds);
    const outboundByOrder = index(facts.outbounds);
    const sumOf = <T>(rows: T[], pick: (row: T) => Prisma.Decimal) => rows.reduce((total, row) => total.plus(pick(row)), new Prisma.Decimal(0)).toString();

    return {
      ...this.aggregate(article, sources),
      item_no: article.itemNo,
      customers: this.customersOf(rows, orderNos),
      orders: orderNos.map((orderNo) => {
        const row = rows.find((candidate) => candidate.orderNo === orderNo)!;
        const qcRows = qcByOrder.get(orderNo) ?? [];
        const shipped = (outboundByOrder.get(orderNo) ?? []).filter((outbound) => (SHIPPED_OUTBOUND_STATUSES as readonly string[]).includes(outbound.status));
        return {
          sales_order_id: row.id,
          order_no: row.orderNo,
          order_date: new Date(row.orderDate).toISOString(),
          delivery_date: row.deliveryDate ? new Date(row.deliveryDate).toISOString() : null,
          status: row.status,
          quantity: row.quantity.toString(),
          unit: row.unit,
          customer: { id: row.customerId, name: row.customerName },
          current_version: row.currentVersion,
          bom_versions: (facts.boms.get(orderNo) ?? []).map((bom) => bom.version).sort((left, right) => left - right),
          purchase_order_count: (sources.purchases ?? []).filter((purchase) => purchase.orderNo === orderNo).length,
          production_order_count: sources.production.filter((production) => production.orderNo === orderNo).length,
          qc_qualified_quantity: sumOf(qcRows, (row_) => row_.qualifiedQuantity),
          qc_rejected_quantity: sumOf(qcRows, (row_) => row_.rejectedQuantity),
          finished_inbound_quantity: sumOf(inboundByOrder.get(orderNo) ?? [], (row_) => row_.quantity),
          outbound_quantity: sumOf(shipped, (row_) => row_.quantity),
          reorder_from_order_no: row.reorderFromOrderNo,
          // 「能不能拿它返单」由**服务端**判定并给出中文理由：前端自己拼条件，
          // 改口径时就会出现「按钮亮着、点了 422」。
          ...ReorderService.reorderability(row),
          workbench_href: `/?order_no=${encodeURIComponent(row.orderNo)}`,
        };
      }),
    };
  }

  /** 待补货号的历史单（T12 的待办表）：这里返回的是**订单行**，不是货号组。 */
  async listUnassignedOrders(filter: UnassignedFilter) {
    const rows = await this.loadRows(filter, null);
    const query = (filter.q ?? "").trim().toLowerCase();
    const matched = query ? rows.filter((row) => `${row.orderNo} ${row.productName} ${row.customerName ?? ""}`.toLowerCase().includes(query)) : rows;
    // 最近下单的排前面：要补的通常是刚做完的那几批。
    const sorted = [...matched].sort((left, right) => new Date(right.orderDate).getTime() - new Date(left.orderDate).getTime() || (left.orderNo < right.orderNo ? -1 : 1));
    const { page, pageSize, skip } = ReorderService.pageOf(filter);
    return { data: sorted.slice(skip, skip + pageSize).map(unassignedOrderRow), total: sorted.length, page, page_size: pageSize };
  }

  private static orderNosOf(articles: MergedArticle[]) { return [...new Set(articles.flatMap((article) => article.orderNos))]; }

  /** 一张单能不能作为返单来源 —— 与 `SalesOrdersService.resolveReorderSource` 的守卫同一份口径。 */
  private static reorderability(row: ArticleOrderRow) {
    if (row.status !== "confirmed" && row.status !== "closed") return { can_reorder: false, can_reorder_reason: "草稿单不能作为返单来源" };
    if (!itemNoKey(row.itemNo)) return { can_reorder: false, can_reorder_reason: "该批没有货号：请先补货号" };
    return { can_reorder: true, can_reorder_reason: null };
  }

  private customersOf(rows: ArticleOrderRow[], orderNos: string[]) {
    const byCustomer = new Map<string, { customer_id: string; name: string | null; order_count: number }>();
    for (const orderNo of orderNos) {
      const row = rows.find((candidate) => candidate.orderNo === orderNo)!;
      const current = byCustomer.get(row.customerId) ?? { customer_id: row.customerId, name: row.customerName, order_count: 0 };
      current.order_count += 1;
      byCustomer.set(row.customerId, current);
    }
    return [...byCustomer.values()].sort((left, right) => right.order_count - left.order_count || (left.customer_id < right.customer_id ? -1 : 1));
  }

  private static groupByOrder<T extends { orderNo: string }>(rows: readonly T[]): Map<string, T[]> {
    const index = new Map<string, T[]>();
    for (const row of rows) index.set(row.orderNo, [...(index.get(row.orderNo) ?? []), row]);
    return index;
  }

  /** 货号级的四个下游事实（列表与详情共用；只对传入的订单号查）。 */
  private async loadArticleAggregates(orderNos: string[]): Promise<DownstreamSources> {
    if (!orderNos.length) return { purchases: [], receivables: [], qc: [], production: [] };
    const [purchases, receivables, qc, production] = await Promise.all([
      this.prisma.purchaseOrder.findMany({ where: { orderNo: { in: orderNos }, deletedAt: null }, select: { orderNo: true, totalAmount: true, currency: true } }),
      this.prisma.receivableSource.findMany({ where: { orderNo: { in: orderNos }, deletedAt: null }, select: { orderNo: true, amount: true, currency: true } }),
      this.prisma.finishedGoodsQcRecord.findMany({ where: { orderNo: { in: orderNos }, deletedAt: null }, select: { orderNo: true, inspectedQuantity: true, qualifiedQuantity: true, conditionalAcceptQuantity: true, rejectedQuantity: true } }),
      this.prisma.productionOrder.findMany({ where: { orderNo: { in: orderNos }, deletedAt: null }, select: { orderNo: true, status: true } }),
    ]);
    return { purchases, receivables, qc, production };
  }

  /**
   * 单批级的三组事实（只有详情要）：BOM 版本、成品入库、成品出库。
   * 出库只算真正发出去的（与工作台「已出库」同一份状态清单）—— 草稿是待出库，取消/冲销都不算。
   */
  private async loadOrderFacts(orderNos: string[]) {
    if (!orderNos.length) return { boms: new Map<string, Array<{ version: number }>>(), inbounds: [], outbounds: [] };
    const [boms, inbounds, outbounds] = await Promise.all([
      this.prisma.bom.findMany({ where: { orderNo: { in: orderNos }, deletedAt: null }, select: { orderNo: true, version: true } }),
      this.prisma.finishedGoodsInbound.findMany({ where: { orderNo: { in: orderNos }, deletedAt: null }, select: { orderNo: true, quantity: true } }),
      this.prisma.finishedGoodsOutbound.findMany({ where: { orderNo: { in: orderNos }, deletedAt: null }, select: { orderNo: true, quantity: true, status: true } }),
    ]);
    return { boms: ReorderService.groupByOrder(boms), inbounds, outbounds };
  }

  /** 一个货号的汇总：数量按单位分行、金额按币种分行、QC 汇总与合格率、在制批次数。 */
  private aggregate(article: MergedArticle, sources: DownstreamSources) {
    const collect = <T>(rows: readonly T[], index: Map<string, T[]>) => article.orderNos.flatMap((orderNo) => index.get(orderNo) ?? []);
    const qcRows = collect(sources.qc, ReorderService.groupByOrder(sources.qc));
    const inspected = qcRows.reduce((total, row) => total.plus(row.inspectedQuantity), new Prisma.Decimal(0));
    const qualified = qcRows.reduce((total, row) => total.plus(row.qualifiedQuantity), new Prisma.Decimal(0));
    const openOrders = new Set(sources.production.filter((row) => article.orderNos.includes(row.orderNo) && (OPEN_PRODUCTION_STATUSES as readonly string[]).includes(row.status)).map((row) => row.orderNo));
    return {
      item_no: article.itemNo,
      item_no_key: article.itemNoKey,
      order_count: article.orderCount,
      order_nos: article.orderNos,
      customer_names: article.customerNames,
      first_order_date: article.firstOrderDate,
      last_order_date: article.lastOrderDate,
      last_delivery_date: article.lastDeliveryDate,
      open_order_count: openOrders.size,
      quantities: article.quantities,
      purchase_amounts: sumByCurrency(sources.purchases.filter((row) => article.orderNos.includes(row.orderNo)).map((row) => ({ currency: row.currency, amount: row.totalAmount }))),
      receivable_amounts: sumByCurrency(sources.receivables.filter((row) => article.orderNos.includes(row.orderNo)).map((row) => ({ currency: row.currency, amount: row.amount }))),
      qc: {
        inspected: inspected.toString(),
        qualified: qualified.toString(),
        conditional: qcRows.reduce((total, row) => total.plus(row.conditionalAcceptQuantity), new Prisma.Decimal(0)).toString(),
        rejected: qcRows.reduce((total, row) => total.plus(row.rejectedQuantity), new Prisma.Decimal(0)).toString(),
        qualified_rate: qualifiedRate(inspected, qualified),
      },
    };
  }
}
