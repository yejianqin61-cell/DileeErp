import { BadRequestException } from "@nestjs/common";
import type { Prisma, PrismaClient } from "@prisma/client";
import { deduplicateAlerts } from "../../alerts/alerts.domain";
import { orderPage } from "./order-root";

/**
 * 订单领域的只读查询。Phase 1 只有 `search_orders`；第二个查询落地时才继续往这里加
 * （模块设计：每个领域文件在实际需要第二个查询时才建立）。
 *
 * 取数口径沿用 `ReportsService.orders()`：软删过滤、`orderNo contains` 搜索、updatedAt 倒序、
 * 每页上限 20。**投影是新的**：只挑 6 个非财务字段 —— 原报表行的 created_by_name 等列
 * 与可能混入的价格字段一律不带（架构表：禁止返回原销售单或关联客户对象）。
 */

/** 工具的只读 client：连接串指向只读账号（R-1）；类型上是完整 PrismaClient，写权限由数据库 GRANT 兜底。 */
export type AgentReadStore = PrismaClient;

export type SearchOrdersInput = { q: string; page: number };
export const SEARCH_ORDERS_MAX_ROWS = 20;

/** 输入校验内聚在查询旁：不引新校验库，模型给的参数先在这里过筛。 */
export function parseSearchOrdersInput(raw: unknown): SearchOrdersInput {
  if (raw === null || typeof raw !== "object") throw badRequest("参数必须是 JSON 对象");
  const { q, page } = raw as { q?: unknown; page?: unknown };
  // 固定 schema：不接受额外字段（模块设计「工具注册和查询执行如何划清责任」），
  // 否则模型慢慢学会往参数里塞过滤字典，输入面就失控了。
  const allowedKeys = ["q", "page"];
  const unknownKeys = Object.keys(raw as Record<string, unknown>).filter((key) => !allowedKeys.includes(key));
  if (unknownKeys.length > 0) throw badRequest(`不接受参数字段：${unknownKeys.join(", ")}`);
  if (typeof q !== "string" || q.trim().length === 0) throw badRequest("搜索词 q 不能为空");
  if (q.length > 100) throw badRequest("搜索词 q 不能超过 100 个字符");
  if (page !== undefined && (typeof page !== "number" || !Number.isInteger(page) || page < 1 || page > 1000)) throw badRequest("page 必须是 1 到 1000 的整数");
  return { q: q.trim(), page: page ?? 1 };
}

function badRequest(message: string) {
  return new BadRequestException({ code: "AGENT_TOOL_ARGUMENT_INVALID", message, details: [] });
}

export async function searchOrders(client: AgentReadStore, input: SearchOrdersInput) {
  const rows = await client.salesOrder.findMany({
    where: { deletedAt: null, orderNo: { contains: input.q } },
    orderBy: { updatedAt: "desc" },
    skip: (input.page - 1) * SEARCH_ORDERS_MAX_ROWS,
    take: SEARCH_ORDERS_MAX_ROWS,
    select: { orderNo: true, productName: true, quantity: true, unit: true, status: true, deliveryDate: true },
  });
  return rows.map((row) => ({
    order_no: row.orderNo,
    product_name: row.productName,
    quantity: row.quantity.toString(),
    unit: row.unit,
    status: row.status,
    delivery_date: row.deliveryDate instanceof Date ? row.deliveryDate.toISOString() : row.deliveryDate,
  }));
}

export type SearchOrderRow = Prisma.PromiseReturnType<typeof searchOrders>[number];

// ============================================================================
// get_order_timeline / get_order_alerts（P3-T1）
// ============================================================================

/**
 * 订单时间线的**非财务动作白名单**（模块设计：operational 仅允许非财务动作类型）。
 *
 * 依据：全库审计动作枚举（`grep audit.record`，2026-10-26 共 221 个）里，财务相关动作
 * 全部落在以下前缀——它们**不进**白名单：receivable_*、supplier_payable*、supplier_payment*、
 * customer_payment*、customer_return*、salary_*、payroll_*、voucher.*、cash_flow_entry.*、
 * bank*、accounting_subject.*、opening_balance.*、exchange_rate.*、overhead_allocation.*、
 * operation_rate.*（工序工价=计件单价）、production_payroll_export、supplier.*、
 * purchase_order_item.price_refilled（采购填价）。
 * 新增非财务领域时**必须**把前缀加进来，否则时间线会静默缺段——这条注释就是提醒。
 */
const TIMELINE_ACTION_PREFIXES = [
  "sales_order.", "bom.", "purchase_order.", "purchase_plan.", "purchase_receipt.", "incoming_inspection.",
  "material.", "finished_goods_", "raw_material_", "production_order.", "production_order_operation.",
  "production_daily_alert.", "outsource_", "operation_daily_report.", "stocktake.", "customer_contact.",
  "customer.", "employee.", "attendance.", "daily_report_merge_anomaly.", "alert.", "form_definition.",
  "operation_catalog.", "production_location.", "unit.", "department.", "position.", "performance.",
  "user.", "auth.",
] as const;

export type TimelineStore = Pick<PrismaClient, "auditEvent">;

export async function getOrderTimeline(client: TimelineStore, root: { orderNo: string }, page: number): Promise<{ data: Record<string, unknown>[]; sources: { business_type: string; business_no: string }[] }> {
  const { skip, take } = orderPage({ orderNo: root.orderNo, page }, 20);
  const events = await client.auditEvent.findMany({
    // 白名单前缀下推到查询（OR startsWith），而不是取回再滤——分页语义才正确。
    where: { orderNo: root.orderNo, OR: TIMELINE_ACTION_PREFIXES.map((prefix) => ({ action: { startsWith: prefix } })) },
    orderBy: { createdAt: "desc" },
    skip, take,
    select: { id: true, action: true, entityType: true, entityId: true, createdAt: true },
  });
  return {
    // 固定三字段投影：不传 details 自由 JSON（可能含未审计内容）。
    data: events.map((event) => ({ time: event.createdAt, action: event.action, entity_type: event.entityType, entity_id: event.entityId })),
    sources: [{ business_type: "audit_event", business_no: root.orderNo }],
  };
}

export type OrderAlertsStore = Pick<PrismaClient, "productionDailyAlert" | "finishedGoodsQcRecord" | "inventoryFact" | "alertHandling">;

/** 三源告警按订单下推（AlertsService.list() 是全库聚合，不能直接复用；去重/分级复用其领域纯函数）。 */
export async function getOrderAlerts(client: OrderAlertsStore, root: { orderNo: string }, page: number): Promise<{ data: Record<string, unknown>[]; sources: { business_type: string; business_no: string }[] }> {
  const orderNo = root.orderNo;
  const [daily, qcRejected, inventoryGroups] = await Promise.all([
    client.productionDailyAlert.findMany({ where: { deletedAt: null, status: { in: ["pending", "confirmed"] }, orderNo }, select: { id: true, alertType: true, orderNo: true, createdAt: true } }),
    client.finishedGoodsQcRecord.findMany({ where: { deletedAt: null, conclusion: "rejected", orderNo }, select: { id: true, orderNo: true, createdAt: true } }),
    // 库存净变动为负：与 AlertsService 同口径，但只算当前订单（group by 收敛到一行）。
    client.inventoryFact.groupBy({ by: ["orderNo"], where: { orderNo }, _sum: { quantityDelta: true } }),
  ]);
  const rows: Array<{ source_type: string; source_id: string; alert_type: string; order_no: string | null; severity: "high" | "medium" | "low"; title: string; suggestion: string; status: string; created_at: Date }> = [
    ...daily.map((row) => ({ source_type: "production_daily_alert", source_id: row.id, alert_type: row.alertType, order_no: row.orderNo, severity: "high" as const, title: row.alertType === "over_order" ? "生产超单" : "生产日报差异", suggestion: "请核对日报与生产单累计数量。", status: "pending", created_at: row.createdAt })),
    ...qcRejected.map((row) => ({ source_type: "finished_goods_qc", source_id: row.id, alert_type: "qc_rejected", order_no: row.orderNo, severity: "high" as const, title: "成品 QC 不合格", suggestion: "请处理不良品或重新送检。", status: "pending", created_at: row.createdAt })),
    ...inventoryGroups.filter((row) => row._sum.quantityDelta !== null && row._sum.quantityDelta !== undefined && (row._sum.quantityDelta as { lt(v: number): boolean }).lt(0)).map((row) => ({ source_type: "inventory", source_id: `00000000-0000-0000-0000-${(row.orderNo ?? "00000000").slice(-12).padStart(12, "0")}`, alert_type: "inventory_delta", order_no: row.orderNo, severity: "medium" as const, title: "库存净变动为负", suggestion: "请核对出入库事实和库存不足风险。", status: "pending", created_at: new Date() })),
  ];
  // 处理状态合并：键集合由本订单的告警行决定（不会全表拉取）。
  const handlings = rows.length ? await client.alertHandling.findMany({ where: { OR: rows.map((row) => ({ sourceType: row.source_type, sourceId: row.source_id, alertType: row.alert_type })) }, select: { sourceType: true, sourceId: true, alertType: true, status: true } }) : [];
  const handled = new Map(handlings.map((row) => [`${row.sourceType}:${row.sourceId}:${row.alertType}`, row.status]));
  const { skip, take } = orderPage({ orderNo, page }, 20);
  const merged = deduplicateAlerts(rows).slice(skip, skip + take);
  const data = merged.map((row) => ({ source_type: row.source_type, alert_type: row.alert_type, severity: row.severity, title: row.title, suggestion: row.suggestion, status: handled.get(`${row.source_type}:${row.source_id}:${row.alert_type}`) ?? row.status, created_at: row.created_at }));
  return { data, sources: merged.map((row) => ({ business_type: row.source_type, business_no: row.source_id })) };
}
