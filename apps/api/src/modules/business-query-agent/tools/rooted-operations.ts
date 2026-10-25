import type { PrismaClient } from "@prisma/client";
import { parseOrderRootInput, type AgentOrderRoot, type OrderRootInput } from "./order-root";
import { getOrderOverview, getOrderStatus } from "./order-overview-tools";
import { getOrderAlerts, getOrderTimeline } from "./order-query-tools";
import { getOrderAttachments } from "./attachment-tools";

/**
 * 以订单为根的 operation 分发表：executor 的 default 分支查这张表。
 * 每个领域文件只提供「解析输入 → 只读查询 → {data, sources?}」；归属验证（assertOrderRoot）
 * 与 QueryFact 组装统一在 executor —— 领域实现想绕都绕不过去。
 * 新领域任务（P3-T2..T5）往这张表注册；财务 7 个 op 不进这张表（阶段 4）。
 */

export type RootedFact = { data: unknown; sources?: { business_type: string; business_no: string }[] };

export type RootedHandler = {
  parse: (raw: unknown) => OrderRootInput;
  run: (client: PrismaClient, root: AgentOrderRoot, input: OrderRootInput) => Promise<RootedFact>;
};

export const ROOTED_OPERATIONS: Record<string, RootedHandler> = {
  get_order_overview: { parse: (raw) => parseOrderRootInput(raw, { withPage: false }), run: (client, root) => getOrderOverview(client, root) },
  get_order_status: { parse: (raw) => parseOrderRootInput(raw, { withPage: false }), run: (client, root) => getOrderStatus(client, root) },
  get_order_timeline: { parse: (raw) => parseOrderRootInput(raw), run: async (client, root, input) => getOrderTimeline(client, root, input.page ?? 1) },
  get_order_alerts: { parse: (raw) => parseOrderRootInput(raw), run: async (client, root, input) => getOrderAlerts(client, root, input.page ?? 1) },
  get_order_attachments: { parse: (raw) => parseOrderRootInput(raw, { withPage: false }), run: (client, root) => getOrderAttachments(client, root) },
};
