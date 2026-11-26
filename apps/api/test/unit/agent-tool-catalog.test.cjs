const assert = require("node:assert/strict");
const { test } = require("node:test");
const { buildCatalog, renderL1, candidateOperations } = require("../../dist/modules/business-query-agent/tools/tool-catalog.js");
const { TOOL_CAPABILITIES } = require("../../dist/modules/business-query-agent/tools/tool-registry.js");

const MODULE_ORDER = ["order_query", "sales_query", "procurement_query", "production_query", "warehouse_query", "finance_query"];
const EXPECTED_COUNTS = [8, 4, 5, 4, 7, 7];

function moduleLine(text, tool) {
  return text.split("\n").find((line) => line.startsWith(`- ${tool} `));
}

test("L1 full 档：六个模块行，operation 数依次为 8、4、5、4、7、7", () => {
  const text = renderL1("full");
  MODULE_ORDER.forEach((tool, index) => {
    const line = moduleLine(text, tool);
    assert.ok(line, `缺少模块行 ${tool}`);
    assert.equal(Number(/(\d+) 个/.exec(line)[1]), EXPECTED_COUNTS[index], tool);
  });
});

test("L1 operational 档：只有五个模块，没有财务", () => {
  const text = renderL1("operational");
  assert.equal(text.includes("finance_query"), false);
  assert.equal(text.includes("财务"), false);
  for (const tool of MODULE_ORDER.slice(0, 5)) assert.ok(moduleLine(text, tool), tool);
});

test("candidateOperations：full 35 条，operational 28 条且无财务", () => {
  assert.equal(candidateOperations("任意问句", "full").length, 35);
  const operational = candidateOperations("任意问句", "operational");
  assert.equal(operational.length, 28);
  assert.equal(operational.some((entry) => entry.tool === "finance_query"), false);
});

test("35 个条目的四个文案字段都非空", () => {
  const { entries } = buildCatalog();
  assert.equal(entries.length, 35);
  for (const entry of entries) {
    for (const field of ["questionShape", "input", "output", "boundary"]) {
      assert.equal(typeof entry[field], "string", `${entry.operation}.${field}`);
      assert.ok(entry[field].trim().length > 0, `${entry.operation}.${field}`);
    }
  }
});

test("list_overdue_arrivals 的边界写明不按供应商分组", () => {
  const entry = buildCatalog().entries.find((item) => item.operation === "list_overdue_arrivals");
  assert.ok(entry.boundary.includes("供应商"));
});

test("L1 不超过 600 字符，且点名三个无根入口", () => {
  const text = renderL1("full");
  assert.ok(text.length <= 600, `L1 长度 ${text.length}`);
  for (const name of ["list_documents", "list_low_stock_materials", "list_overdue_arrivals"]) assert.ok(text.includes(name), name);
});

test("buildCatalog：能力表多一条没有规格的 operation 即抛错并带上 key", () => {
  const extra = [...TOOL_CAPABILITIES, { tool: "order_query", operation: "made_up", minAccess: "operational", implemented: true, maxRows: 20 }];
  assert.throws(() => buildCatalog(extra), /order_query:made_up/);
});
