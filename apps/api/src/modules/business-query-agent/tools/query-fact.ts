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
  /** 数组=行集（可分页截断），对象=单据级 DTO（overview/status）。两者都是显式投影，不是 Prisma 原对象。 */
  data: Record<string, unknown> | Record<string, unknown>[];
  sources: QuerySource[];
  /** 仅数组结果带：本次返回之外还有行没给出（超过行数/字节上限，或下一页还有）。 */
  has_more?: boolean;
  /** 符合条件的总行数；只在实现手里本来就有全量时给，不为它另做计数查询。 */
  total_count?: number;
  access_level: AgentAccessLevel;
};
