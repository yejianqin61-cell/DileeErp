import type { PrismaClient } from "@prisma/client";
import { parseOrderRootInput, type AgentOrderRoot, type OrderRootInput } from "./order-root";
import { getOrderOverview, getOrderStatus } from "./order-overview-tools";
import { getOrderAlerts, getOrderTimeline } from "./order-query-tools";
import { getOrderAttachments } from "./attachment-tools";
import { getBom, getCustomer, getSalesOrder, getSalesReturns } from "./sales-query-tools";
import { getIncomingInspections, getPurchaseOrders, getPurchasePlans, getReceipts } from "./procurement-query-tools";
import { getOperationProgress, getOperationReports, getOutsourceFlow, getProductionOrders } from "./production-query-tools";
import { getFinishedGoodsInbounds, getFinishedGoodsOutbounds, getFinishedGoodsQc, getInventoryFacts, getMaterialMovements, getRawMaterialBalance } from "./warehouse-query-tools";
import { getCustomerPayments, getOrderCostProfit, getOrderPayroll, getPayables, getReceivables, getReconciliations, getSupplierPayments } from "./finance-query-tools";

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
  // P3-T2 销售领域
  get_sales_order: { parse: (raw) => parseOrderRootInput(raw, { withPage: false }), run: (client, root) => getSalesOrder(client, root) },
  get_customer: { parse: (raw) => parseOrderRootInput(raw, { withPage: false }), run: (client, root) => getCustomer(client, root) },
  get_bom: { parse: (raw) => parseOrderRootInput(raw), run: async (client, root, input) => getBom(client, root, input.page ?? 1) },
  get_sales_returns: { parse: (raw) => parseOrderRootInput(raw), run: async (client, root, input) => getSalesReturns(client, root, input.page ?? 1) },
  // P3-T3 采购领域
  get_purchase_plans: { parse: (raw) => parseOrderRootInput(raw), run: async (client, root, input) => getPurchasePlans(client, root, input.page ?? 1) },
  get_purchase_orders: { parse: (raw) => parseOrderRootInput(raw), run: async (client, root, input) => getPurchaseOrders(client, root, input.page ?? 1) },
  get_receipts: { parse: (raw) => parseOrderRootInput(raw), run: async (client, root, input) => getReceipts(client, root, input.page ?? 1) },
  get_incoming_inspections: { parse: (raw) => parseOrderRootInput(raw), run: async (client, root, input) => getIncomingInspections(client, root, input.page ?? 1) },
  // P3-T4 生产领域
  get_production_orders: { parse: (raw) => parseOrderRootInput(raw, { withPage: false }), run: (client, root) => getProductionOrders(client, root) },
  get_operation_progress: { parse: (raw) => parseOrderRootInput(raw, { withPage: false }), run: (client, root) => getOperationProgress(client, root) },
  get_operation_reports: { parse: (raw) => parseOrderRootInput(raw), run: async (client, root, input) => getOperationReports(client, root, input.page ?? 1) },
  get_outsource_flow: { parse: (raw) => parseOrderRootInput(raw, { withPage: false }), run: (client, root) => getOutsourceFlow(client, root) },
  // P3-T5 仓库领域
  get_raw_material_balance: { parse: (raw) => parseOrderRootInput(raw, { withPage: false }), run: (client, root) => getRawMaterialBalance(client, root) },
  get_inventory_facts: { parse: (raw) => parseOrderRootInput(raw), run: async (client, root, input) => getInventoryFacts(client, root, input.page ?? 1) },
  get_material_movements: { parse: (raw) => parseOrderRootInput(raw), run: async (client, root, input) => getMaterialMovements(client, root, input.page ?? 1) },
  get_finished_goods_qc: { parse: (raw) => parseOrderRootInput(raw), run: async (client, root, input) => getFinishedGoodsQc(client, root, input.page ?? 1) },
  get_finished_goods_inbounds: { parse: (raw) => parseOrderRootInput(raw), run: async (client, root, input) => getFinishedGoodsInbounds(client, root, input.page ?? 1) },
  get_finished_goods_outbounds: { parse: (raw) => parseOrderRootInput(raw), run: async (client, root, input) => getFinishedGoodsOutbounds(client, root, input.page ?? 1) },
  // P4-T1 财务领域：只有 full capability 能走到这些只读实现。
  get_receivables: { parse: (raw) => parseOrderRootInput(raw), run: async (client, root, input) => getReceivables(client, root, input.page ?? 1) },
  get_customer_payments: { parse: (raw) => parseOrderRootInput(raw), run: async (client, root, input) => getCustomerPayments(client, root, input.page ?? 1) },
  get_payables: { parse: (raw) => parseOrderRootInput(raw), run: async (client, root, input) => getPayables(client, root, input.page ?? 1) },
  get_supplier_payments: { parse: (raw) => parseOrderRootInput(raw), run: async (client, root, input) => getSupplierPayments(client, root, input.page ?? 1) },
  get_reconciliations: { parse: (raw) => parseOrderRootInput(raw), run: async (client, root, input) => getReconciliations(client, root, input.page ?? 1) },
  get_order_cost_profit: { parse: (raw) => parseOrderRootInput(raw), run: async (client, root, input) => getOrderCostProfit(client, root, input.page ?? 1) },
  get_order_payroll: { parse: (raw) => parseOrderRootInput(raw), run: async (client, root, input) => getOrderPayroll(client, root, input.page ?? 1) },
};
