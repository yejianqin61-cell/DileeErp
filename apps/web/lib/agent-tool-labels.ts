/**
 * Agent 执行步骤的**安全展示**文案。
 *
 * 后端 SSE 的 tool_status 只发 `{tool, operation, status, code}`（见
 * apps/api/src/modules/business-query-agent/agent-orchestrator.ts），
 * 不发模型原始参数、SQL 或查询结果 —— 这里只把这两个英文标识翻译成人话，
 * 并在失败时把内部错误码翻成业务用户能看懂的原因。**不要**在这里展示参数或数据行。
 *
 * operation 清单与后端 tool-registry.ts 的 32 项一一对应：后端改名会先在它的审计测试里红，
 * 不会静默漂移。
 */

/** 6 个领域工具 → 数据域名称。 */
export const AGENT_TOOL_LABELS: Record<string, string> = {
  order_query: "订单",
  sales_query: "销售",
  procurement_query: "采购",
  production_query: "生产",
  warehouse_query: "库存",
  finance_query: "财务",
};

/** 32 个内部 operation → 业务对象（用户看得懂的词）。 */
export const AGENT_OPERATION_LABELS: Record<string, string> = {
  // order_query
  search_documents: "单号检索",
  search_orders: "销售订单",
  get_order_overview: "订单全链路",
  get_order_status: "订单状态",
  get_order_timeline: "订单时间线",
  get_order_alerts: "订单阻塞告警",
  get_order_attachments: "订单附件",
  // sales_query
  get_sales_order: "销售单",
  get_customer: "客户资料",
  get_bom: "BOM 物料清单",
  get_sales_returns: "销售退货",
  // procurement_query
  get_purchase_plans: "采购计划",
  get_purchase_orders: "采购订单",
  get_receipts: "采购到货",
  get_incoming_inspections: "来料检验",
  // production_query
  get_production_orders: "生产任务",
  get_operation_progress: "工序进度",
  get_operation_reports: "工序报工",
  get_outsource_flow: "外协流转",
  // warehouse_query
  get_raw_material_balance: "原料库存",
  get_inventory_facts: "成品库存",
  get_material_movements: "物料出入库流水",
  get_finished_goods_qc: "成品质检",
  get_finished_goods_inbounds: "成品入库",
  get_finished_goods_outbounds: "成品出库",
  // finance_query
  get_receivables: "应收账款",
  get_customer_payments: "客户收款",
  get_payables: "应付账款",
  get_supplier_payments: "供应商付款",
  get_reconciliations: "对账记录",
  get_order_cost_profit: "订单成本利润",
  get_order_payroll: "订单工资",
};

/** 认不出的 operation 用数据域名兜底；连工具名都不认识时用中性的「业务数据」。 */
export function toolOperationLabel(tool: string, operation: string): string {
  return AGENT_OPERATION_LABELS[operation] ?? AGENT_TOOL_LABELS[tool] ?? "业务数据";
}

export type AgentToolStepStatus = "pending" | "running" | "success" | "error";

/** 后端发 running/completed/failed；pending 留给未来的排队态，前端先支持四种。 */
export function normalizeToolStatus(status: string): AgentToolStepStatus {
  if (status === "running") return "running";
  if (status === "completed" || status === "success") return "success";
  if (status === "failed" || status === "error") return "error";
  return "pending";
}

/** 步骤摘要（默认只展示这一行）：例「正在查询销售订单」「已查询销售订单」。 */
export function toolStepSummary(tool: string, operation: string, status: string): string {
  const label = toolOperationLabel(tool, operation);
  switch (normalizeToolStatus(status)) {
    case "running":
      return `正在查询${label}`;
    case "success":
      return `已查询${label}`;
    case "error":
      return `未能查询${label}`;
    default:
      return `等待查询${label}`;
  }
}

/** 展开卡片后展示的状态词。 */
export function toolStepStatusLabel(status: string): string {
  switch (normalizeToolStatus(status)) {
    case "running":
      return "进行中";
    case "success":
      return "已完成";
    case "error":
      return "失败";
    default:
      return "等待执行";
  }
}

/**
 * 失败原因：把内部错误码翻成业务用户能理解的一句话。
 * 认不出的码不暴露原始细节，统一说「查询没有完成」，避免把内部实现名甩给普通用户。
 */
const TOOL_ERROR_REASONS: Record<string, string> = {
  AGENT_TOOL_UNKNOWN: "该查询能力暂不可用",
  AGENT_TOOL_ARGUMENT_INVALID: "查询条件不完整，换一种问法可能更好",
  AGENT_OPERATION_NOT_IMPLEMENTED: "该查询能力尚未开放",
  AGENT_TOOL_FORBIDDEN: "当前数据档位不包含这类查询",
  AGENT_ACCESS_DENIED: "当前账号没有该数据的查看权限",
  AGENT_ACCESS_REVOKED: "当前账号的数据档位已变化",
  AGENT_DISABLED: "业务查询入口已关闭",
  AGENT_BUSY: "当前查询人数较多",
  AGENT_RUN_TIMEOUT: "查询耗时过长，已中断",
  AGENT_MODEL_TIMEOUT: "查询耗时过长，已中断",
  AGENT_MODEL_CONTEXT_EXCEEDED: "问题太长，超出模型可处理范围",
  AGENT_MODEL_UNAVAILABLE: "模型服务暂时不可用",
  AGENT_MODEL_AUTH: "模型服务配置异常",
  AGENT_MODEL_ERROR: "模型服务返回异常",
};

export function toolErrorReason(code: string | undefined): string {
  if (!code) return "查询没有完成";
  return TOOL_ERROR_REASONS[code] ?? "查询没有完成";
}
