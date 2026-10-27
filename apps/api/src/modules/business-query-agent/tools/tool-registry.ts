import { UnprocessableEntityException } from "@nestjs/common";
import type { AgentAccessLevel } from "../access-level";

/**
 * 工具注册表：模型可见的 6 个领域工具与 31 个内部 operation 的唯一清单。
 *
 * 为什么模型只见领域工具（工程布局「工具如何做到广覆盖而不撑大上下文」）：
 * 二十多个 schema 反复送进上下文会把它撑爆，所以模型看到的是 6 个以 `operation`
 * 枚举分发的领域工具；每个内部能力在这里登记输入校验、档位与行数上限。
 * operation 名同时是审计日志与测试的稳定标识，不改名。
 */

export const AGENT_TOOLS = ["order_query", "sales_query", "procurement_query", "production_query", "warehouse_query", "finance_query"] as const;
export type AgentToolName = (typeof AGENT_TOOLS)[number];

export type ToolCapability = {
  tool: AgentToolName;
  operation: string;
  /** 最低数据档位：finance_query 的全部能力都要 full。 */
  minAccess: AgentAccessLevel;
  /** Phase 1 只实现 search_orders；其余登记在册，executor 显式拒绝而不是静默消失。 */
  implemented: boolean;
  maxRows: number;
};

const row = (tool: AgentToolName, operation: string, opts: { minAccess?: AgentAccessLevel; implemented?: boolean; maxRows?: number } = {}): ToolCapability => ({
  tool,
  operation,
  minAccess: opts.minAccess ?? "operational",
  implemented: opts.implemented ?? false,
  maxRows: opts.maxRows ?? 20,
});

export const TOOL_CAPABILITIES: ToolCapability[] = [
  // order_query（7）—— P3-T1 起订单领域全部实现；search_documents 是三类单号的统一入口
  row("order_query", "search_documents", { implemented: true }),
  row("order_query", "search_orders", { implemented: true }),
  row("order_query", "get_order_overview", { implemented: true }),
  row("order_query", "get_order_status", { implemented: true }),
  row("order_query", "get_order_timeline", { implemented: true }),
  row("order_query", "get_order_alerts", { implemented: true }),
  row("order_query", "get_order_attachments", { implemented: true }),
  // sales_query（4）—— P3-T2 起销售领域全部实现
  row("sales_query", "get_sales_order", { implemented: true }),
  row("sales_query", "get_customer", { implemented: true }),
  row("sales_query", "get_bom", { implemented: true }),
  row("sales_query", "get_sales_returns", { implemented: true }),
  // procurement_query（4）—— P3-T3 起采购领域全部实现
  row("procurement_query", "get_purchase_plans", { implemented: true }),
  row("procurement_query", "get_purchase_orders", { implemented: true }),
  row("procurement_query", "get_receipts", { implemented: true }),
  row("procurement_query", "get_incoming_inspections", { implemented: true }),
  // production_query（4）—— P3-T4 起生产领域全部实现
  row("production_query", "get_production_orders", { implemented: true }),
  row("production_query", "get_operation_progress", { implemented: true }),
  row("production_query", "get_operation_reports", { implemented: true }),
  row("production_query", "get_outsource_flow", { implemented: true }),
  // warehouse_query（6）—— P3-T5 起仓库领域全部实现
  row("warehouse_query", "get_raw_material_balance", { implemented: true }),
  row("warehouse_query", "get_inventory_facts", { implemented: true }),
  row("warehouse_query", "get_material_movements", { implemented: true }),
  row("warehouse_query", "get_finished_goods_qc", { implemented: true }),
  row("warehouse_query", "get_finished_goods_inbounds", { implemented: true }),
  row("warehouse_query", "get_finished_goods_outbounds", { implemented: true }),
  // finance_query（7，仅 full）
  row("finance_query", "get_receivables", { minAccess: "full", implemented: true }),
  row("finance_query", "get_customer_payments", { minAccess: "full", implemented: true }),
  row("finance_query", "get_payables", { minAccess: "full", implemented: true }),
  row("finance_query", "get_supplier_payments", { minAccess: "full", implemented: true }),
  row("finance_query", "get_reconciliations", { minAccess: "full", implemented: true }),
  row("finance_query", "get_order_cost_profit", { minAccess: "full", implemented: true }),
  row("finance_query", "get_order_payroll", { minAccess: "full", implemented: true }),
];

const CAPABILITY_INDEX = new Map(TOOL_CAPABILITIES.map((capability) => [`${capability.tool}:${capability.operation}`, capability]));

/** 工具名不可拼错：模型给来的 name 先过这一关，不存在就拒绝。 */
export function isAgentToolName(name: string): name is AgentToolName {
  return (AGENT_TOOLS as readonly string[]).includes(name);
}

export const toolRegistry = {
  /** 模型可见的领域工具：operational 5 个、full 6 个。 */
  visibleTools(accessLevel: AgentAccessLevel): readonly AgentToolName[] {
    return AGENT_TOOLS.filter((tool) => accessLevel === "full" || tool !== "finance_query");
  },

  /** 未注册的 name/operation 抛业务错误（422），调用方不得自行兜底放行。 */
  capability(tool: string, operation: string): ToolCapability {
    const found = isAgentToolName(tool) ? CAPABILITY_INDEX.get(`${tool}:${operation}`) : undefined;
    if (!found) {
      throw new UnprocessableEntityException({ code: "AGENT_TOOL_UNKNOWN", message: `未注册的查询能力：${tool}/${operation}`, details: [] });
    }
    return found;
  },
};
