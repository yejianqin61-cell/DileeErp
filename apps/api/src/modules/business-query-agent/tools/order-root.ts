import { BadRequestException, NotFoundException } from "@nestjs/common";
import type { PrismaClient } from "@prisma/client";
import { normalizeKeyword } from "./normalize";

/**
 * 订单根验证器（模块设计「工具注册和查询执行如何划清责任」）：
 * 除 search_orders 外，所有内部操作必须先以**未软删的销售单**确认当前 order_no，
 * 再按该单关联读取 —— 输入里的 UUID、客户名、供应商名不能变成跨订单查询范围。
 */

export type AgentOrderRootStore = Pick<PrismaClient, "salesOrder">;

export type AgentOrderRoot = {
  id: string;
  orderNo: string;
  quantity: { toString(): string };
  unit: string;
  status: string;
  updatedAt: Date;
};

export type OrderRootInput = { orderNo: string; page?: number };

const ORDER_ROOT_SELECT = { id: true, orderNo: true, quantity: true, unit: true, status: true, updatedAt: true } as const;

/**
 * 根查询恒带软删过滤；查不到抛 404（不泄露存在性）。
 *
 * 两步匹配：先精确等值（走单号索引），未命中再按「忽略大小写」找一次。
 * 为什么要有第二步：单号是业务手输的，模型或用户把 `DL260170-4H 伞头` 写成 `dl260170-4h 伞头`
 * 时，精确匹配会把整轮打成「订单不存在」——呈现给用户就是「所有工具都查不到」。
 */
export async function assertOrderRoot(client: AgentOrderRootStore, orderNo: string): Promise<AgentOrderRoot> {
  const value = normalizeKeyword(orderNo);
  const exact = await client.salesOrder.findFirst({
    where: { orderNo: value, deletedAt: null },
    select: ORDER_ROOT_SELECT,
  });
  if (exact) return exact;
  const loose = await client.salesOrder.findFirst({
    where: { orderNo: { equals: value, mode: "insensitive" }, deletedAt: null },
    select: ORDER_ROOT_SELECT,
  });
  if (loose) return loose;
  throw new NotFoundException({ code: "ORDER_NOT_FOUND", message: "订单不存在", details: [] });
}

function badRequest(message: string) {
  return new BadRequestException({ code: "AGENT_TOOL_ARGUMENT_INVALID", message, details: [] });
}

/**
 * 订单根类操作的统一输入：`{order_no, page?}`。
 * `withPage: false` 的操作（overview/status 这类单对象）连 page 都不接受——固定 schema，不收额外字段。
 */
export function parseOrderRootInput(raw: unknown, opts: { withPage?: boolean } = {}): OrderRootInput {
  if (raw === null || typeof raw !== "object") throw badRequest("参数必须是 JSON 对象");
  const { order_no, page } = raw as { order_no?: unknown; page?: unknown };
  const allowedKeys = opts.withPage === false ? ["order_no"] : ["order_no", "page"];
  const unknownKeys = Object.keys(raw as Record<string, unknown>).filter((key) => !allowedKeys.includes(key));
  if (unknownKeys.length > 0) throw badRequest(`不接受参数字段：${unknownKeys.join(", ")}`);
  if (typeof order_no !== "string" || order_no.trim().length === 0) throw badRequest("订单号 order_no 不能为空");
  if (order_no.length > 100) throw badRequest("订单号 order_no 不能超过 100 个字符");
  if (page !== undefined && (typeof page !== "number" || !Number.isInteger(page) || page < 1 || page > 1000)) throw badRequest("page 必须是 1 到 1000 的整数");
  return { orderNo: normalizeKeyword(order_no), ...(page !== undefined ? { page } : {}) };
}

/** 统一 20 行分页：skip = (page-1)*20，take = 20。 */
export function orderPage(input: OrderRootInput, maxRows: number): { skip: number; take: number } {
  const page = input.page ?? 1;
  return { skip: (page - 1) * maxRows, take: maxRows };
}
