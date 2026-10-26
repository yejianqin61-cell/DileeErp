// 工具注册表的单元测试（require 编译产物，不连数据库）。
//
// 注册表是「模型能看到什么」的唯一真源：固定 6 个领域工具、31 个内部 operation
// （docs/design/business-query-agent-v0-architecture-2026-10-23.md「工具如何做到广覆盖」）。
// `finance_query` 只对 full 档可见；Phase 1 只实现 search_orders，其余声明在册但拒绝执行。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { toolRegistry, TOOL_CAPABILITIES } = require("../../dist/modules/business-query-agent/tools/tool-registry.js");

test("visibleTools：operational 只见 5 个领域工具，没有 finance_query", () => {
  const names = toolRegistry.visibleTools("operational");
  assert.equal(names.length, 5);
  assert.ok(!names.includes("finance_query"), "operational 不得看到财务领域工具");
  assert.deepEqual([...names].sort(), ["order_query", "production_query", "procurement_query", "sales_query", "warehouse_query"].sort());
});

test("visibleTools：full 见全部 6 个领域工具", () => {
  const names = toolRegistry.visibleTools("full");
  assert.equal(names.length, 6);
  assert.ok(names.includes("finance_query"));
});

test("能力目录共 31 个 operation，与工程布局的清单一一对应", () => {
  assert.equal(TOOL_CAPABILITIES.length, 31);
  const counts = {};
  for (const capability of TOOL_CAPABILITIES) counts[capability.tool] = (counts[capability.tool] ?? 0) + 1;
  assert.deepEqual(counts, { order_query: 6, sales_query: 4, procurement_query: 4, production_query: 4, warehouse_query: 6, finance_query: 7 });
  assert.deepEqual(TOOL_CAPABILITIES.filter((capability) => capability.implemented).map((capability) => capability.operation).sort(), TOOL_CAPABILITIES.map((capability) => capability.operation).sort(), "P4-T3 后 31 个 operation 均有显式只读实现");
});

test("capability：已注册的取得到；未注册的 name/operation 抛业务错误", () => {
  const searchOrders = toolRegistry.capability("order_query", "search_orders");
  assert.equal(searchOrders.minAccess, "operational");
  assert.equal(searchOrders.maxRows, 20);

  assert.throws(() => toolRegistry.capability("order_query", "drop_table"));
  assert.throws(() => toolRegistry.capability("no_such_tool", "search_orders"));
  // finance_query 的能力登记 minAccess = full（架构表：仅 full 档可见）
  assert.equal(toolRegistry.capability("finance_query", "get_receivables").minAccess, "full");
});
