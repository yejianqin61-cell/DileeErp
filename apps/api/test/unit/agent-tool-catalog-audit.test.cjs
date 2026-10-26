// P3-T6 capability audit.  This is intentionally independent of individual
// domain tests so a later registry edit cannot silently hide an operation.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { ToolExecutor } = require("../../dist/modules/business-query-agent/tools/tool-executor.js");
const { TOOL_CAPABILITIES } = require("../../dist/modules/business-query-agent/tools/tool-registry.js");

const OPS = [
  "search_orders", "get_order_overview", "get_order_status", "get_order_timeline", "get_order_alerts", "get_order_attachments",
  "get_sales_order", "get_customer", "get_bom", "get_sales_returns",
  "get_purchase_plans", "get_purchase_orders", "get_receipts", "get_incoming_inspections",
  "get_production_orders", "get_operation_progress", "get_operation_reports", "get_outsource_flow",
  "get_raw_material_balance", "get_inventory_facts", "get_material_movements", "get_finished_goods_qc", "get_finished_goods_inbounds", "get_finished_goods_outbounds",
];

test("P3-T6：24 个非财务 operation 都已开放且仅要求 operational 档位；7 个财务 operation 仍未开放", () => {
  const nonFinancial = TOOL_CAPABILITIES.filter((item) => item.tool !== "finance_query");
  const financial = TOOL_CAPABILITIES.filter((item) => item.tool === "finance_query");
  assert.equal(nonFinancial.length, 24);
  assert.deepEqual(nonFinancial.map((item) => item.operation).sort(), OPS.slice().sort());
  assert.ok(nonFinancial.every((item) => item.implemented && item.minAccess === "operational"));
  assert.equal(financial.length, 7);
  assert.ok(financial.every((item) => !item.implemented && item.minAccess === "full"));
});

test("P3-T6：财务 operation 对 operational 是 403、对 full 是 422，且两条路都不触达读取器", async () => {
  const calls = { roles: 0 };
  const executor = new ToolExecutor({}, { async readActiveRoleKeys() { calls.roles += 1; return ["qita"]; } });
  const operational = { user: { id: "u-ops", username: "ops", display_name: "员工" }, accessLevel: "operational" };
  await assert.rejects(
    executor.execute({ tool: "finance_query", operation: "get_receivables", args: { order_no: "SO-1" } }, operational),
    (error) => error.getStatus() === 403,
  );
  assert.equal(calls.roles, 0, "档位不足必须在回查角色、读取业务库之前拒绝");

  const fullExecutor = new ToolExecutor({}, { async readActiveRoleKeys() { calls.roles += 1; return ["laoban"]; } });
  const full = { user: { id: "u-full", username: "boss", display_name: "老板" }, accessLevel: "full" };
  await assert.rejects(
    fullExecutor.execute({ tool: "finance_query", operation: "get_receivables", args: { order_no: "SO-1" } }, full),
    (error) => error.getStatus() === 422,
  );
  assert.equal(calls.roles, 0, "未实现能力必须在回查角色、读取业务库之前明确拒绝");
});

test("P3-T6：24 个 operation 都有领域测试覆盖宽行财务红线", () => {
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
  };
  assert.deepEqual(Object.values(coverage).flat().sort(), OPS.slice().sort());
});
