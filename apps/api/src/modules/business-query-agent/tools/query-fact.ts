import type { AgentAccessLevel } from "../access-level";

/**
 * 工具执行器的内部结果（模块设计「每个模块的 Interface」）。
 *
 * `data` 必须是显式 DTO —— 不能是 Prisma 原始对象或 `customerSnapshot`；
 * `sources` 是最终回答引用的凭据：答案只能说清「数字从哪张单来」，引用必须能追到本轮事实。
 */
export type QuerySource = { business_type: string; business_no: string; queried_at: string };

export type QueryFact = {
  operation: string;
  /** 搜索类操作没有订单根，为 null；其余操作必须是已验证的当前 order_no。 */
  order_no: string | null;
  as_of: string;
  data: Record<string, unknown>[];
  sources: QuerySource[];
  access_level: AgentAccessLevel;
};
