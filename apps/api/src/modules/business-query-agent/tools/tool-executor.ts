import { ForbiddenException, UnprocessableEntityException } from "@nestjs/common";
import { lowerAccessLevel, resolveAccessLevel, type AgentAccessLevel } from "../access-level";
import type { AgentPrincipal, AgentRoleReader } from "../query-permission.guard";
import { parseSearchOrdersInput, searchOrders, type AgentReadStore } from "./order-query-tools";
import type { QueryFact } from "./query-fact";
import { assertOperationAllowed } from "./tool-permission";
import { toolRegistry, type ToolCapability } from "./tool-registry";

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
    switch (capability.operation) {
      case "search_orders": {
        const input = parseSearchOrdersInput(call.args);
        const rows = await searchOrders(this.prisma, input);
        signal?.throwIfAborted();
        const asOf = new Date().toISOString();
        const data = this.truncate(rows as unknown as Record<string, unknown>[], capability.maxRows);
        return {
          fact: {
            operation: capability.operation,
            order_no: null,
            as_of: asOf,
            data,
            sources: data.map((row) => ({ business_type: "sales_order", business_no: String(row.order_no), queried_at: asOf })),
            access_level: effective,
          },
        };
      }
      default: {
        // registry 说实现了、dispatch 却没有分支，是实现清单与分发不同步 —— 直接暴露而不是吞掉。
        throw new UnprocessableEntityException({ code: "AGENT_OPERATION_NOT_IMPLEMENTED", message: `查询能力 ${capability.operation} 尚未开放`, details: [] });
      }
    }
  }

  /** 行数与字节双重截断：行数按能力登记的 maxRows，字节超限再逐行丢弃。 */
  private truncate(rows: Record<string, unknown>[], maxRows: number): Record<string, unknown>[] {
    let data = rows.slice(0, maxRows);
    while (data.length > 0 && Buffer.byteLength(JSON.stringify(data), "utf8") > MAX_RESULT_BYTES) data = data.slice(0, -1);
    return data;
  }
}
