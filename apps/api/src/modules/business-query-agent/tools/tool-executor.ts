import { ForbiddenException, UnprocessableEntityException } from "@nestjs/common";
import { lowerAccessLevel, resolveAccessLevel, type AgentAccessLevel } from "../access-level";
import type { AgentPrincipal, AgentRoleReader } from "../query-permission.guard";
import { parseSearchOrdersInput, searchOrders, type AgentReadStore } from "./order-query-tools";
import { parseSearchDocumentsInput, searchDocumentsPage } from "./document-search-tools";
import { listDocuments, parseListDocumentsInput } from "./list-documents-tools";
import { UNROOTED_OPERATIONS } from "./unrooted-operations";
import type { QueryFact, QuerySource } from "./query-fact";
import { assertOperationAllowed } from "./tool-permission";
import { toolRegistry, type ToolCapability } from "./tool-registry";
import { assertOrderRoot, type AgentOrderRoot } from "./order-root";
import { ROOTED_OPERATIONS } from "./rooted-operations";

/**
 * 工具执行器：模型与数据库之间的**唯一**通道。
 *
 * 顺序固定（模块设计「Tool executor 的顺序固定」）：查 registry → 验证 name/operation/参数
 * → 重查用户档位 → 执行只读查询 → 按档位投影 → 生成来源 → 限制行数/字节数。
 * 浏览器只收到「哪个工具完成/失败」，工具参数与结果原文不进 SSE。
 *
 * 有效档位 = 创建时档位与当前档位的**较低者**：执行前重查角色，被清空角色直接
 * AGENT_ACCESS_REVOKED，降权后 full run 的后续工具调用在这里被挡下。
 */

/** 结果字节数上限：超限逐行裁剪，是输出保护（不是输入 token 配额）。 */
const MAX_RESULT_BYTES = 128 * 1024;

export type ToolCall = { tool: string; operation: string; args: unknown };

export class ToolExecutor {
  constructor(private readonly prisma: AgentReadStore, private readonly roleReader: AgentRoleReader) {}

  async execute(call: ToolCall, principal: AgentPrincipal, signal?: AbortSignal): Promise<QueryFact> {
    const capability = toolRegistry.capability(call.tool, call.operation);
    assertOperationAllowed(principal.accessLevel, capability.tool, capability);
    if (!capability.implemented) {
      throw new UnprocessableEntityException({ code: "AGENT_OPERATION_NOT_IMPLEMENTED", message: `查询能力 ${capability.operation} 尚未开放`, details: [] });
    }

    const roleKeys = await this.roleReader.readActiveRoleKeys(principal.user.id);
    const current = resolveAccessLevel(roleKeys);
    if (current === "denied") {
      throw new ForbiddenException({ code: "AGENT_ACCESS_REVOKED", message: "当前账号已无可用角色，业务查询被终止", details: [] });
    }
    const effective = lowerAccessLevel(current, principal.accessLevel);
    assertOperationAllowed(effective, capability.tool, capability);

    signal?.throwIfAborted();
    const { fact } = await this.dispatch(call, capability, effective, signal);
    return fact;
  }

  private async dispatch(call: ToolCall, capability: ToolCapability, effective: AgentAccessLevel, signal?: AbortSignal): Promise<{ fact: QueryFact }> {
    const asOf = new Date().toISOString();
    if (capability.operation === "search_orders") {
      const input = parseSearchOrdersInput(call.args);
      const rows = await searchOrders(this.prisma, input);
      signal?.throwIfAborted();
      const { data, ...completeness } = await this.bounded(rows, capability.maxRows, { nextPage: () => searchOrders(this.prisma, { ...input, page: input.page + 1 }) });
      signal?.throwIfAborted();
      return {
        fact: {
          operation: capability.operation,
          order_no: null,
          as_of: asOf,
          data,
          sources: data.map((row) => ({ business_type: "sales_order", business_no: String(row.order_no), queried_at: asOf })),
          ...completeness,
          access_level: effective,
        },
      };
    }

    // 按号检索任意单据（R-1）：销售单号、采购单号、生产单号都能进，每行落回所属销售单号。
    if (capability.operation === "search_documents") {
      const input = parseSearchDocumentsInput(call.args);
      const found = await searchDocumentsPage(this.prisma, input);
      signal?.throwIfAborted();
      const { data, ...completeness } = await this.bounded(found.rows, capability.maxRows, { hasMore: found.hasMore });
      return {
        fact: {
          operation: capability.operation,
          order_no: null,
          as_of: asOf,
          data,
          sources: data.map((row) => ({ business_type: String(row.document_type), business_no: String(row.document_no), queried_at: asOf })),
          ...completeness,
          access_level: effective,
        },
      };
    }

    if (capability.operation === "list_documents") {
      const input = parseListDocumentsInput(call.args);
      const rows = await listDocuments(this.prisma, input);
      signal?.throwIfAborted();
      const { data, ...completeness } = await this.bounded(rows, capability.maxRows, { nextPage: () => listDocuments(this.prisma, { ...input, page: input.page + 1 }) });
      signal?.throwIfAborted();
      return {
        fact: {
          operation: capability.operation,
          order_no: null,
          as_of: asOf,
          data,
          sources: data.map((row) => ({ business_type: "sales_order", business_no: String(row.order_no), queried_at: asOf })),
          ...completeness,
          access_level: effective,
        },
      };
    }

    // 无根 operation：不需要单据根也能执行。没有这条支线时，模型问「哪些物料库存不足」会先撞根守卫。
    const unrooted = UNROOTED_OPERATIONS[capability.operation];
    if (unrooted) {
      const input = unrooted.parse(call.args);
      const result = await unrooted.run(this.prisma, input, new Date());
      signal?.throwIfAborted();
      const { data, ...completeness } = await this.bounded(result.data, capability.maxRows, { total: result.total, page: input.page });
      return {
        fact: {
          operation: capability.operation,
          order_no: null,
          as_of: asOf,
          data,
          sources: result.sources.map((source) => ({ ...source, queried_at: asOf })),
          ...completeness,
          access_level: effective,
        },
      };
    }

    // 以订单为根的操作：解析输入 → 根验证（404 兜底）→ 只读实现 → 统一组装 QueryFact。
    const handler = ROOTED_OPERATIONS[capability.operation];
    if (!handler) {
      // registry 说实现了、分发表里却没有，是实现清单与分发不同步 —— 直接暴露而不是吞掉。
      throw new UnprocessableEntityException({ code: "AGENT_OPERATION_NOT_IMPLEMENTED", message: `查询能力 ${capability.operation} 尚未开放`, details: [] });
    }
    const input = handler.parse(call.args);
    const root = await assertOrderRoot(this.prisma, input.orderNo);
    signal?.throwIfAborted();
    const result = await handler.run(this.prisma, root, input);
    signal?.throwIfAborted();
    const page = input.page ?? 1;
    const bounded = Array.isArray(result.data)
      ? await this.bounded(result.data, capability.maxRows, {
          total: result.total,
          page,
          nextPage: handler.paged === false ? undefined : async () => (await handler.run(this.prisma, root, { ...input, page: page + 1 })).data as unknown[],
        })
      : { data: result.data as Record<string, unknown> };
    signal?.throwIfAborted();
    const sources: QuerySource[] = (result.sources ?? [{ business_type: "sales_order", business_no: root.orderNo }]).map((source) => ({ ...source, queried_at: asOf }));
    return {
      fact: {
        operation: capability.operation,
        order_no: root.orderNo,
        as_of: asOf,
        ...bounded,
        sources,
        access_level: effective,
      },
    };
  }

  /**
   * 行数与字节双重截断，并说清结果是否完整：数组按能力登记的 maxRows 截行，字节超限逐行丢弃。
   * 判断顺序：本次就切掉了行 → 实现给了总数就按页算 → 满页的分页查询再取一次下一页。
   */
  private async bounded(
    rows: unknown[],
    maxRows: number,
    more: { hasMore?: boolean; total?: number; page?: number; nextPage?: () => Promise<unknown[]> } = {},
  ): Promise<{ data: Record<string, unknown>[]; has_more: boolean; total_count?: number }> {
    let data = rows.slice(0, maxRows) as Record<string, unknown>[];
    while (data.length > 0 && Buffer.byteLength(JSON.stringify(data), "utf8") > MAX_RESULT_BYTES) data = data.slice(0, -1);
    let hasMore = data.length < rows.length || more.hasMore === true;
    if (!hasMore && more.total !== undefined) hasMore = ((more.page ?? 1) - 1) * maxRows + data.length < more.total;
    else if (!hasMore && more.nextPage && rows.length >= maxRows) hasMore = (await more.nextPage()).length > 0;
    return { data, has_more: hasMore, ...(more.total !== undefined ? { total_count: more.total } : {}) };
  }
}
