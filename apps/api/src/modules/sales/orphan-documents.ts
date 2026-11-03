import { Prisma } from "@prisma/client";

/**
 * 「销售单被删后留下的下游单据」—— 孤立单据的**唯一清单**。
 *
 * 为什么要有这张表：删除预览（`GET /sales-orders/:id/delete-preview`）与孤立单据汇总页
 * （`GET /sales-orders/orphans`）说的是同一件事 —— 「这张销售单底下有哪些单据」。
 * 两处各写一份清单的下场是「预览说 3 张采购单、汇总页只列出 2 张」，用户会以为漏单了。
 *
 * 这 11 类就是既有删除守卫 `countDownstreamFacts` 数的 11 张表，键名沿用它的 `*_count`
 * 去掉后缀（`purchase_order_count` → `purchase_order`），不另起一套名字。
 *
 * 顺序 = 界面上从左到右的顺序，按业务链路排（BOM → 计划 → 采购 → 生产 → 出库 → 应收）。
 */
export const ORPHAN_DOCUMENT_TYPES = [
  { key: "bom", label: "BOM" },
  { key: "purchase_plan", label: "采购计划" },
  { key: "purchase_order", label: "采购单" },
  { key: "production_order", label: "生产单" },
  { key: "finished_goods_outbound", label: "成品出库单" },
  { key: "finished_goods_outbound_notice", label: "出库通知" },
  { key: "customer_return", label: "客户退货" },
  { key: "receivable_source", label: "应收来源" },
  { key: "customer_payment", label: "客户收款" },
  { key: "receivable_adjustment", label: "应收调整" },
  { key: "receivable_reconciliation", label: "应收对账" },
] as const;

export type OrphanDocumentKey = (typeof ORPHAN_DOCUMENT_TYPES)[number]["key"];

export type OrphanDocumentCount = { key: OrphanDocumentKey; label: string; count: number };

/** 汇总页里的一行单体单据（每类单据的「单号/状态/金额」都归一到这里）。 */
export type OrphanDocumentRow = {
  id: string;
  type: OrphanDocumentKey;
  label: string;
  /** BOM 没有单号列，用 `BOM v3` 这一种写法；其余就是各自单号列的原值。 */
  document_no: string;
  order_no: string | null;
  /** 采购计划没有状态列 —— 那种单据这里给 `null`，界面显示「—」。 */
  status: string | null;
  /** 单据本身没有金额列时给 `null`（BOM / 计划 / 生产单 / 出库 / 通知 / 退货）。 */
  amount: string | null;
  currency: string | null;
  occurred_at: string;
  sales_order_id: string;
};

export type OrphanSalesOrderGroup = {
  sales_order_id: string;
  order_no: string;
  status: string;
  deleted_at: Date;
  deleted_by_name: string | null;
  documents: OrphanDocumentCount[];
  document_total: number;
};

export type OrphanSummary = {
  orders: OrphanSalesOrderGroup[];
  documents: OrphanDocumentRow[];
  by_type: OrphanDocumentCount[];
  totals: { orders: number; documents: number };
  truncated: boolean;
};

/** 汇总页最多列这么多行单体单据；`totals.documents` 仍然是真实总数。 */
export const ORPHAN_DOCUMENT_ROW_LIMIT = 1000;

const labelOf = (key: OrphanDocumentKey) => ORPHAN_DOCUMENT_TYPES.find((type) => type.key === key)!.label;

/**
 * 按一张销售单数 11 类下游单据。
 *
 * **只数 `deleted_at IS NULL` 的行**：已删的下游单据不是「留下来的单据」，
 * 把它算进删除预览会让用户以为删销售单还会带走一张已经作废的单。
 *
 * 传入 `Prisma.TransactionClient`：删除路径要在锁行后、写 `deleted_at` 前数这一遍
 * （与既有 `revertToDraft` 同一个顺序）；预览路径传 `PrismaService` 也满足这个形状。
 */
export async function countOrphanDocuments(
  client: Prisma.TransactionClient,
  salesOrderId: string,
): Promise<{ items: OrphanDocumentCount[]; total: number }> {
  const where = { salesOrderId, deletedAt: null };
  const [bom, purchasePlan, purchaseOrder, productionOrder, outbound, outboundNotice, customerReturn, receivableSource, customerPayment, receivableAdjustment, receivableReconciliation] = await Promise.all([
    client.bom.count({ where }),
    client.purchasePlan.count({ where }),
    client.purchaseOrder.count({ where }),
    client.productionOrder.count({ where }),
    client.finishedGoodsOutbound.count({ where }),
    client.finishedGoodsOutboundNotice.count({ where }),
    client.customerReturn.count({ where }),
    client.receivableSource.count({ where }),
    client.customerPayment.count({ where }),
    client.receivableAdjustment.count({ where }),
    client.receivableReconciliation.count({ where }),
  ]);
  const counts: Record<OrphanDocumentKey, number> = {
    bom,
    purchase_plan: purchasePlan,
    purchase_order: purchaseOrder,
    production_order: productionOrder,
    finished_goods_outbound: outbound,
    finished_goods_outbound_notice: outboundNotice,
    customer_return: customerReturn,
    receivable_source: receivableSource,
    customer_payment: customerPayment,
    receivable_adjustment: receivableAdjustment,
    receivable_reconciliation: receivableReconciliation,
  };
  // 只列有单的类型：预览弹窗里铺 11 行、其中 9 行是 0，读的人要自己跳过 9 行才看见要紧的两行。
  const items = ORPHAN_DOCUMENT_TYPES.map((type) => ({ key: type.key, label: type.label, count: counts[type.key] })).filter((item) => item.count > 0);
  return { items, total: items.reduce((sum, item) => sum + item.count, 0) };
}

/** 把一张单据的公共四格（单号/状态/金额/时间）归一成汇总页的一行。 */
function row(input: {
  id: string;
  type: OrphanDocumentKey;
  documentNo: string;
  orderNo: string | null;
  status: string | null;
  amount: Prisma.Decimal | null;
  currency: string | null;
  createdAt: Date;
  salesOrderId: string;
}): OrphanDocumentRow {
  return {
    id: input.id,
    type: input.type,
    label: labelOf(input.type),
    document_no: input.documentNo,
    order_no: input.orderNo,
    status: input.status,
    amount: input.amount ? input.amount.toFixed(4) : null,
    currency: input.currency,
    occurred_at: input.createdAt.toISOString(),
    sales_order_id: input.salesOrderId,
  };
}

/**
 * 孤立单据汇总：被删的销售单 + 它们留下的单据。
 *
 * 判定式是「`sales_order_id` 指向的销售单 `deleted_at IS NOT NULL`」——
 * 下游单据一行都不用改，删错了把 `deleted_at` 清掉就自动接回（见设计文档 §2）。
 *
 * 为什么要 `groupBy` 单独数一遍、而不是拿 `documents` 的行数充当计数：
 * `documents` 有 `ORPHAN_DOCUMENT_ROW_LIMIT` 截断，用截断后的行数当总数会在单据多的时候少报。
 */
export async function summarizeOrphanDocuments(client: Prisma.TransactionClient, limit = ORPHAN_DOCUMENT_ROW_LIMIT): Promise<OrphanSummary> {
  const deletedOrders = await client.salesOrder.findMany({
    where: { deletedAt: { not: null } },
    select: { id: true, orderNo: true, status: true, deletedAt: true, deletedBy: true },
    orderBy: { deletedAt: "desc" },
  });
  if (!deletedOrders.length) return { orders: [], documents: [], by_type: [], totals: { orders: 0, documents: 0 }, truncated: false };

  const ids = deletedOrders.map((order) => order.id);
  const where = { salesOrderId: { in: ids }, deletedAt: null };

  // 删单的人是 UUID，界面不能显示 UUID（全站约定：取不到姓名补 null，绝不回落到 id）。
  const deletedByIds = [...new Set(deletedOrders.map((order) => order.deletedBy).filter((id): id is string => typeof id === "string" && id.length > 0))];
  const deletedByNames = deletedByIds.length
    ? new Map((await client.user.findMany({ where: { id: { in: deletedByIds } }, select: { id: true, displayName: true } })).map((user) => [user.id, user.displayName]))
    : new Map<string, string>();

  // 计数（精确，不受展示上限影响）与明细（受上限影响）各查一遍：
  // 计数值是页面头部的「共 N 张」，必须是准的；明细是给人看的，可以截断。
  //
  // 参数**逐条内联**、不抽一个共享常量：每个 Prisma 模型的 `groupBy` 参数是各不相同的
  // `*ScalarFieldEnum`，共享一个 `by: readonly [...]` 的常量会让 11 个调用一起报类型错。
  const grouped = await Promise.all([
    client.bom.groupBy({ by: ["salesOrderId"], where, _count: { _all: true } }),
    client.purchasePlan.groupBy({ by: ["salesOrderId"], where, _count: { _all: true } }),
    client.purchaseOrder.groupBy({ by: ["salesOrderId"], where, _count: { _all: true } }),
    client.productionOrder.groupBy({ by: ["salesOrderId"], where, _count: { _all: true } }),
    client.finishedGoodsOutbound.groupBy({ by: ["salesOrderId"], where, _count: { _all: true } }),
    client.finishedGoodsOutboundNotice.groupBy({ by: ["salesOrderId"], where, _count: { _all: true } }),
    client.customerReturn.groupBy({ by: ["salesOrderId"], where, _count: { _all: true } }),
    client.receivableSource.groupBy({ by: ["salesOrderId"], where, _count: { _all: true } }),
    client.customerPayment.groupBy({ by: ["salesOrderId"], where, _count: { _all: true } }),
    client.receivableAdjustment.groupBy({ by: ["salesOrderId"], where, _count: { _all: true } }),
    client.receivableReconciliation.groupBy({ by: ["salesOrderId"], where, _count: { _all: true } }),
  ]);

  const rows = await Promise.all([
    client.bom.findMany({ where, select: { id: true, version: true, orderNo: true, status: true, createdAt: true, salesOrderId: true }, orderBy: { createdAt: "desc" }, take: limit }),
    client.purchasePlan.findMany({ where, select: { id: true, planNo: true, orderNo: true, createdAt: true, salesOrderId: true }, orderBy: { createdAt: "desc" }, take: limit }),
    client.purchaseOrder.findMany({ where, select: { id: true, purchaseOrderNo: true, orderNo: true, status: true, totalAmount: true, currency: true, createdAt: true, salesOrderId: true }, orderBy: { createdAt: "desc" }, take: limit }),
    client.productionOrder.findMany({ where, select: { id: true, productionOrderNo: true, orderNo: true, status: true, createdAt: true, salesOrderId: true }, orderBy: { createdAt: "desc" }, take: limit }),
    client.finishedGoodsOutbound.findMany({ where, select: { id: true, outboundNo: true, orderNo: true, status: true, createdAt: true, salesOrderId: true }, orderBy: { createdAt: "desc" }, take: limit }),
    client.finishedGoodsOutboundNotice.findMany({ where, select: { id: true, noticeNo: true, orderNo: true, status: true, createdAt: true, salesOrderId: true }, orderBy: { createdAt: "desc" }, take: limit }),
    client.customerReturn.findMany({ where, select: { id: true, returnNo: true, orderNo: true, status: true, createdAt: true, salesOrderId: true }, orderBy: { createdAt: "desc" }, take: limit }),
    client.receivableSource.findMany({ where, select: { id: true, sourceNo: true, orderNo: true, status: true, amount: true, currency: true, createdAt: true, salesOrderId: true }, orderBy: { createdAt: "desc" }, take: limit }),
    client.customerPayment.findMany({ where, select: { id: true, paymentNo: true, orderNo: true, status: true, amount: true, currency: true, createdAt: true, salesOrderId: true }, orderBy: { createdAt: "desc" }, take: limit }),
    client.receivableAdjustment.findMany({ where, select: { id: true, adjustmentNo: true, orderNo: true, status: true, amount: true, currency: true, createdAt: true, salesOrderId: true }, orderBy: { createdAt: "desc" }, take: limit }),
    client.receivableReconciliation.findMany({ where, select: { id: true, reconciliationNo: true, orderNo: true, status: true, receivableAmountSnapshot: true, currency: true, createdAt: true, salesOrderId: true }, orderBy: { createdAt: "desc" }, take: limit }),
  ]);

  const [bomRows, planRows, purchaseOrderRows, productionOrderRows, outboundRows, noticeRows, returnRows, receivableRows, paymentRows, adjustmentRows, reconciliationRows] = rows;
  const documents: OrphanDocumentRow[] = [
    ...bomRows.map((item) => row({ id: item.id, type: "bom", documentNo: `BOM v${item.version}`, orderNo: item.orderNo, status: item.status, amount: null, currency: null, createdAt: item.createdAt, salesOrderId: item.salesOrderId })),
    ...planRows.map((item) => row({ id: item.id, type: "purchase_plan", documentNo: item.planNo, orderNo: item.orderNo, status: null, amount: null, currency: null, createdAt: item.createdAt, salesOrderId: item.salesOrderId })),
    ...purchaseOrderRows.map((item) => row({ id: item.id, type: "purchase_order", documentNo: item.purchaseOrderNo, orderNo: item.orderNo, status: item.status, amount: item.totalAmount, currency: item.currency, createdAt: item.createdAt, salesOrderId: item.salesOrderId })),
    ...productionOrderRows.map((item) => row({ id: item.id, type: "production_order", documentNo: item.productionOrderNo, orderNo: item.orderNo, status: item.status, amount: null, currency: null, createdAt: item.createdAt, salesOrderId: item.salesOrderId })),
    ...outboundRows.map((item) => row({ id: item.id, type: "finished_goods_outbound", documentNo: item.outboundNo, orderNo: item.orderNo, status: item.status, amount: null, currency: null, createdAt: item.createdAt, salesOrderId: item.salesOrderId })),
    ...noticeRows.map((item) => row({ id: item.id, type: "finished_goods_outbound_notice", documentNo: item.noticeNo, orderNo: item.orderNo, status: item.status, amount: null, currency: null, createdAt: item.createdAt, salesOrderId: item.salesOrderId })),
    ...returnRows.map((item) => row({ id: item.id, type: "customer_return", documentNo: item.returnNo, orderNo: item.orderNo, status: item.status, amount: null, currency: null, createdAt: item.createdAt, salesOrderId: item.salesOrderId })),
    ...receivableRows.map((item) => row({ id: item.id, type: "receivable_source", documentNo: item.sourceNo, orderNo: item.orderNo, status: item.status, amount: item.amount, currency: item.currency, createdAt: item.createdAt, salesOrderId: item.salesOrderId })),
    ...paymentRows.map((item) => row({ id: item.id, type: "customer_payment", documentNo: item.paymentNo, orderNo: item.orderNo, status: item.status, amount: item.amount, currency: item.currency, createdAt: item.createdAt, salesOrderId: item.salesOrderId ?? "" })),
    ...adjustmentRows.map((item) => row({ id: item.id, type: "receivable_adjustment", documentNo: item.adjustmentNo, orderNo: item.orderNo, status: item.status, amount: item.amount, currency: item.currency, createdAt: item.createdAt, salesOrderId: item.salesOrderId ?? "" })),
    ...reconciliationRows.map((item) => row({ id: item.id, type: "receivable_reconciliation", documentNo: item.reconciliationNo, orderNo: item.orderNo, status: item.status, amount: item.receivableAmountSnapshot, currency: item.currency, createdAt: item.createdAt, salesOrderId: item.salesOrderId ?? "" })),
  ].sort((left, right) => right.occurred_at.localeCompare(left.occurred_at));

  const countMap = (groups: Array<{ salesOrderId: string | null; _count: { _all: number } }>): Map<string, number> => new Map(
    groups
      .filter((group): group is { salesOrderId: string; _count: { _all: number } } => group.salesOrderId !== null)
      .map((group) => [group.salesOrderId, group._count._all]),
  );
  const [bomGroups, planGroups, purchaseOrderGroups, productionOrderGroups, outboundGroups, noticeGroups, returnGroups, receivableGroups, paymentGroups, adjustmentGroups, reconciliationGroups] = grouped;
  const countsByType = [bomGroups, planGroups, purchaseOrderGroups, productionOrderGroups, outboundGroups, noticeGroups, returnGroups, receivableGroups, paymentGroups, adjustmentGroups, reconciliationGroups].map(countMap);
  const perType = ORPHAN_DOCUMENT_TYPES.map((type, index) => ({ type, counts: countsByType[index] }));

  const orders: OrphanSalesOrderGroup[] = deletedOrders.map((order) => {
    const documentsOfOrder = perType
      .map(({ type, counts }) => ({ key: type.key, label: type.label, count: counts.get(order.id) ?? 0 }))
      .filter((item) => item.count > 0);
    return {
      sales_order_id: order.id,
      order_no: order.orderNo,
      status: order.status,
      deleted_at: order.deletedAt!,
      deleted_by_name: order.deletedBy ? deletedByNames.get(order.deletedBy) ?? null : null,
      documents: documentsOfOrder,
      document_total: documentsOfOrder.reduce((sum, item) => sum + item.count, 0),
    };
  });

  const byType = ORPHAN_DOCUMENT_TYPES.map((type, index) => ({
    key: type.key,
    label: type.label,
    count: orders.reduce((sum, order) => sum + (order.documents.find((item) => item.key === type.key)?.count ?? 0), 0),
  })).filter((item) => item.count > 0);

  const totalDocuments = orders.reduce((sum, order) => sum + order.document_total, 0);
  return {
    orders,
    documents: documents.slice(0, limit),
    by_type: byType,
    totals: { orders: orders.length, documents: totalDocuments },
    truncated: totalDocuments > limit,
  };
}
