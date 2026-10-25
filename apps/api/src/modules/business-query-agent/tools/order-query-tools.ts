import { BadRequestException } from "@nestjs/common";
import type { Prisma, PrismaClient } from "@prisma/client";

/**
 * 订单领域的只读查询。Phase 1 只有 `search_orders`；第二个查询落地时才继续往这里加
 * （模块设计：每个领域文件在实际需要第二个查询时才建立）。
 *
 * 取数口径沿用 `ReportsService.orders()`：软删过滤、`orderNo contains` 搜索、updatedAt 倒序、
 * 每页上限 20。**投影是新的**：只挑 6 个非财务字段 —— 原报表行的 created_by_name 等列
 * 与可能混入的价格字段一律不带（架构表：禁止返回原销售单或关联客户对象）。
 */

export type AgentReadStore = Pick<PrismaClient, "salesOrder">;

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
