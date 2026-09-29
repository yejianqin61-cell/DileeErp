import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../platform/database/prisma.service";
import { itemNoKey } from "../sales/item-no";
import { mergeArticles, qualifiedRate, sumByCurrency, unassignedOrderRow, OPEN_PRODUCTION_STATUSES, type ArticleOrderRow, type MergedArticle } from "./reorder.domain";

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

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 200;

@Injectable()
export class ReorderService {
  constructor(private readonly prisma: PrismaService) {}

  /** 订单的轻字段：货号清单与待补录清单都只要这些（下游聚合另算）。 */
  private static readonly LIGHT_SELECT = {
    id: true, orderNo: true, itemNo: true, orderDate: true, deliveryDate: true, status: true,
    quantity: true, unit: true, currency: true, productName: true, customerSnapshot: true,
  } as const;

  private static pageOf(filter: { page?: number; page_size?: number }) {
    const page = Math.max(filter.page ?? 1, 1);
    const pageSize = Math.min(Math.max(filter.page_size ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
    return { page, pageSize, skip: (page - 1) * pageSize };
  }

  /** 客户名取**下当时的快照**（与工作台同口径）：客户后来改名不该改写历史单据上的客户。 */
  private static rowOf(order: { id: string; orderNo: string; itemNo: string | null; orderDate: Date; deliveryDate: Date | null; status: string; quantity: Prisma.Decimal; unit: string; currency: string; productName: string; customerSnapshot: Prisma.JsonValue }): ArticleOrderRow {
    const snapshot = (order.customerSnapshot ?? {}) as { name?: unknown };
    return {
      id: order.id, orderNo: order.orderNo, itemNo: order.itemNo, orderDate: order.orderDate, deliveryDate: order.deliveryDate,
      status: order.status, quantity: order.quantity, unit: order.unit, currency: order.currency,
      productName: order.productName, customerName: typeof snapshot.name === "string" ? snapshot.name : null,
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
    return { data: await this.enrich(pageRows), total: matched.length, page, page_size: pageSize };
  }

  /** 待补货号的历史单（T12 的待办表）：这里返回的是**订单行**，不是货号组。 */
  async listUnassignedOrders(filter: UnassignedFilter) {
    const rows = await this.loadRows(filter, null);
    const query = (filter.q ?? "").trim().toLowerCase();
    const matched = query ? rows.filter((row) => `${row.orderNo} ${row.productName} ${row.customerName ?? ""}`.toLowerCase().includes(query)) : rows;
    // 最近下单的排前面：要补的通常是刚做完的那几批。
    const sorted = [...matched].sort((left, right) => new Date(right.orderDate).getTime() - new Date(left.orderDate).getTime() || left.orderNo.localeCompare(right.orderNo));
    const { page, pageSize, skip } = ReorderService.pageOf(filter);
    return { data: sorted.slice(skip, skip + pageSize).map(unassignedOrderRow), total: sorted.length, page, page_size: pageSize };
  }

  /**
   * 当前页货号的下游汇总：采购金额、应收金额、成品 QC、在制批次。
   *
   * 四条查询都用 `orderNo in (这一页的订单号)`：贵的是聚合，不是条数 ——
   * 所以只对**当前页**做，而不是对全部匹配订单做。
   */
  private async enrich(articles: MergedArticle[]) {
    if (!articles.length) return [];
    const orderNos = [...new Set(articles.flatMap((article) => article.orderNos))];
    const [purchases, receivables, qcRecords, productionOrders] = await Promise.all([
      this.prisma.purchaseOrder.findMany({ where: { orderNo: { in: orderNos }, deletedAt: null }, select: { orderNo: true, totalAmount: true, currency: true } }),
      this.prisma.receivableSource.findMany({ where: { orderNo: { in: orderNos }, deletedAt: null }, select: { orderNo: true, amount: true, currency: true } }),
      this.prisma.finishedGoodsQcRecord.findMany({ where: { orderNo: { in: orderNos }, deletedAt: null }, select: { orderNo: true, inspectedQuantity: true, qualifiedQuantity: true, conditionalAcceptQuantity: true, rejectedQuantity: true } }),
      this.prisma.productionOrder.findMany({ where: { orderNo: { in: orderNos }, deletedAt: null }, select: { orderNo: true, status: true } }),
    ]);
    const byOrder = <T extends { orderNo: string }>(rows: T[]) => {
      const index = new Map<string, T[]>();
      for (const row of rows) index.set(row.orderNo, [...(index.get(row.orderNo) ?? []), row]);
      return index;
    };
    const purchaseIndex = byOrder(purchases);
    const receivableIndex = byOrder(receivables);
    const qcIndex = byOrder(qcRecords);
    const productionIndex = byOrder(productionOrders);
    const collect = <T>(index: Map<string, T[]>, orderNosOf: string[]) => orderNosOf.flatMap((orderNo) => index.get(orderNo) ?? []);
    return articles.map((article) => {
      const qcRows = collect(qcIndex, article.orderNos);
      const inspected = qcRows.reduce((total, row) => total.plus(row.inspectedQuantity), new Prisma.Decimal(0));
      const qualified = qcRows.reduce((total, row) => total.plus(row.qualifiedQuantity), new Prisma.Decimal(0));
      return {
        ...article,
        open_order_count: new Set(collect(productionIndex, article.orderNos).filter((row) => (OPEN_PRODUCTION_STATUSES as readonly string[]).includes(row.status)).map((row) => row.orderNo)).size,
        purchase_amounts: sumByCurrency(collect(purchaseIndex, article.orderNos).map((row) => ({ currency: row.currency, amount: row.totalAmount }))),
        receivable_amounts: sumByCurrency(collect(receivableIndex, article.orderNos).map((row) => ({ currency: row.currency, amount: row.amount }))),
        qc: {
          inspected: inspected.toString(),
          qualified: qualified.toString(),
          conditional: qcRows.reduce((total, row) => total.plus(row.conditionalAcceptQuantity), new Prisma.Decimal(0)).toString(),
          rejected: qcRows.reduce((total, row) => total.plus(row.rejectedQuantity), new Prisma.Decimal(0)).toString(),
          qualified_rate: qualifiedRate(inspected, qualified),
        },
      };
    });
  }
}
