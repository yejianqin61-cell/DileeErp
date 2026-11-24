const assert = require("node:assert/strict");
const { test } = require("node:test");
const { buildCatalog, reconcileCatalog } = require("../../dist/modules/business-query-agent/tools/tool-catalog.js");
const { MODULE_SPECS, OPERATION_SPECS } = require("../../dist/modules/business-query-agent/tools/tool-catalog-specs.js");
const { AGENT_TOOLS, TOOL_CAPABILITIES } = require("../../dist/modules/business-query-agent/tools/tool-registry.js");

const EMPTY = { missingOperationSpecs: [], orphanOperationSpecs: [], missingModuleSpecs: [], orphanModuleSpecs: [] };
const copyOfSpecs = () => JSON.parse(JSON.stringify(OPERATION_SPECS));
const fakeSpec = { questionShape: "a", input: "b", output: "c", boundary: "d", accepts: [] };

test("真实数据：四个数组全空，规格 35 条，模块声明恰为六个领域工具", () => {
  assert.deepEqual(reconcileCatalog(TOOL_CAPABILITIES, OPERATION_SPECS, MODULE_SPECS), EMPTY);
  assert.equal(Object.keys(OPERATION_SPECS).length, 35);
  assert.deepEqual(MODULE_SPECS.map((item) => item.tool).sort(), [...AGENT_TOOLS].sort());
});

test("能力表多一条：缺规格数组恰含它，其余为空", () => {
  const capabilities = [...TOOL_CAPABILITIES, { tool: "order_query", operation: "made_up", minAccess: "operational", implemented: true, maxRows: 20 }];
  assert.deepEqual(reconcileCatalog(capabilities, OPERATION_SPECS, MODULE_SPECS), { ...EMPTY, missingOperationSpecs: ["order_query:made_up"] });
});

test("规格多一条：孤儿数组恰含它", () => {
  const specs = { ...copyOfSpecs(), "order_query:ghost": fakeSpec };
  assert.deepEqual(reconcileCatalog(TOOL_CAPABILITIES, specs, MODULE_SPECS), { ...EMPTY, orphanOperationSpecs: ["order_query:ghost"] });
});

test("模块声明：缺一个与多一个各自落在对应数组", () => {
  const withoutFinance = MODULE_SPECS.filter((item) => item.tool !== "finance_query");
  assert.deepEqual(reconcileCatalog(TOOL_CAPABILITIES, OPERATION_SPECS, withoutFinance), { ...EMPTY, missingModuleSpecs: ["finance_query"] });
  const withGhost = [...MODULE_SPECS, { tool: "ghost_query", title: "x", scope: "y", negatives: [] }];
  assert.deepEqual(reconcileCatalog(TOOL_CAPABILITIES, OPERATION_SPECS, withGhost), { ...EMPTY, orphanModuleSpecs: ["ghost_query"] });
});

test("buildCatalog 对三种坏拷贝都抛错并带上 key", () => {
  const capabilities = [...TOOL_CAPABILITIES, { tool: "order_query", operation: "made_up", minAccess: "operational", implemented: true, maxRows: 20 }];
  assert.throws(() => buildCatalog(capabilities), /order_query:made_up/);
  assert.throws(() => buildCatalog(TOOL_CAPABILITIES, { ...copyOfSpecs(), "order_query:ghost": fakeSpec }), /order_query:ghost/);
  assert.throws(() => buildCatalog(TOOL_CAPABILITIES, OPERATION_SPECS, MODULE_SPECS.filter((item) => item.tool !== "finance_query")), /finance_query/);
});
