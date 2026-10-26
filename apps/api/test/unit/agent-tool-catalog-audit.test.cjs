// P3-T6 capability audit.  This is intentionally independent of individual
// domain tests so a later registry edit cannot silently hide an operation.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { ToolExecutor } = require("../../dist/modules/business-query-agent/tools/tool-executor.js");
const { TOOL_CAPABILITIES } = require("../../dist/modules/business-query-agent/tools/tool-registry.js");
const { ROOTED_OPERATIONS } = require("../../dist/modules/business-query-agent/tools/rooted-operations.js");

const OPS = [
  "search_orders", "get_order_overview", "get_order_status", "get_order_timeline", "get_order_alerts", "get_order_attachments",
  "get_sales_order", "get_customer", "get_bom", "get_sales_returns",
  "get_purchase_plans", "get_purchase_orders", "get_receipts", "get_incoming_inspections",
  "get_production_orders", "get_operation_progress", "get_operation_reports", "get_outsource_flow",
  "get_raw_material_balance", "get_inventory_facts", "get_material_movements", "get_finished_goods_qc", "get_finished_goods_inbounds", "get_finished_goods_outbounds",
];

test("目录审计：31 个 operation 均有实现，24 个非财务限 operational，7 个财务限 full", () => {
  const nonFinancial = TOOL_CAPABILITIES.filter((item) => item.tool !== "finance_query");
  const financial = TOOL_CAPABILITIES.filter((item) => item.tool === "finance_query");
  const rooted = TOOL_CAPABILITIES.filter((item) => item.operation !== "search_orders");
  assert.equal(nonFinancial.length, 24);
  assert.deepEqual(nonFinancial.map((item) => item.operation).sort(), OPS.slice().sort());
  assert.ok(nonFinancial.every((item) => item.implemented && item.minAccess === "operational"));
  assert.equal(financial.length, 7);
  assert.ok(financial.every((item) => item.implemented && item.minAccess === "full"));
  assert.ok(TOOL_CAPABILITIES.every((item) => item.implemented));
  assert.deepEqual(Object.keys(ROOTED_OPERATIONS).sort(), rooted.map((item) => item.operation).sort());
});

test("目录审计：财务 operation 对 operational 是 403，且不触达读取器", async () => {
  const calls = { roles: 0 };
  const executor = new ToolExecutor({}, { async readActiveRoleKeys() { calls.roles += 1; return ["qita"]; } });
  const operational = { user: { id: "u-ops", username: "ops", display_name: "员工" }, accessLevel: "operational" };
  await assert.rejects(
    executor.execute({ tool: "finance_query", operation: "get_receivables", args: { order_no: "SO-1" } }, operational),
    (error) => error.getStatus() === 403,
  );
  assert.equal(calls.roles, 0, "档位不足必须在回查角色、读取业务库之前拒绝");
});

test("目录审计：31 个 operation 都有领域测试覆盖", () => {
  // 每个领域测试向实现函数喂入 unitPrice/amount/currency/settlement/payable/
  // receivable/wage 等宽字段，并对实际返回 JSON 断言。这里固定覆盖映射，防止
  // 后续新增 capability 却忘了把它纳入红线测试。
  const coverage = {
    "agent-tool-executor.test.cjs": ["search_orders"],
    "agent-tool-order-domain.test.cjs": ["get_order_overview", "get_order_status", "get_order_timeline", "get_order_alerts", "get_order_attachments"],
    "agent-tool-sales-domain.test.cjs": ["get_sales_order", "get_customer", "get_bom", "get_sales_returns"],
    "agent-tool-procurement-domain.test.cjs": ["get_purchase_plans", "get_purchase_orders", "get_receipts", "get_incoming_inspections"],
    "agent-tool-production-domain.test.cjs": ["get_production_orders", "get_operation_progress", "get_operation_reports", "get_outsource_flow"],
    "agent-tool-warehouse-domain.test.cjs": ["get_raw_material_balance", "get_inventory_facts", "get_material_movements", "get_finished_goods_qc", "get_finished_goods_inbounds", "get_finished_goods_outbounds"],
    "agent-tool-finance-receivable.test.cjs": ["get_receivables", "get_customer_payments"],
    "agent-tool-finance-payable.test.cjs": ["get_payables", "get_supplier_payments", "get_reconciliations"],
    "agent-tool-finance-cost.test.cjs": ["get_order_cost_profit", "get_order_payroll"],
  };
  assert.deepEqual(Object.values(coverage).flat().sort(), TOOL_CAPABILITIES.map((item) => item.operation).sort());
});
