const assert = require("node:assert/strict");
const { test } = require("node:test");
const { OPERATION_SPECS } = require("../../dist/modules/business-query-agent/tools/tool-catalog-specs.js");
const { TOOL_CAPABILITIES } = require("../../dist/modules/business-query-agent/tools/tool-registry.js");
const { ROOTED_OPERATIONS } = require("../../dist/modules/business-query-agent/tools/rooted-operations.js");
const { UNROOTED_OPERATIONS } = require("../../dist/modules/business-query-agent/tools/unrooted-operations.js");
const { parseSearchOrdersInput } = require("../../dist/modules/business-query-agent/tools/order-query-tools.js");
const { parseSearchDocumentsInput } = require("../../dist/modules/business-query-agent/tools/document-search-tools.js");
const { parseListDocumentsInput } = require("../../dist/modules/business-query-agent/tools/list-documents-tools.js");

const PROBES = { page: 1, q: "x", status: "draft", customer_q: "x", product_q: "x", from: "2026-01-01", to: "2026-01-31" };

function parserFor(operation) {
  if (operation === "search_orders") return { parse: parseSearchOrdersInput, base: { q: "x" }, rooted: false };
  if (operation === "search_documents") return { parse: parseSearchDocumentsInput, base: { q: "x" }, rooted: false };
  if (operation === "list_documents") return { parse: parseListDocumentsInput, base: {}, rooted: false };
  if (UNROOTED_OPERATIONS[operation]) return { parse: UNROOTED_OPERATIONS[operation].parse, base: {}, rooted: false };
  return { parse: ROOTED_OPERATIONS[operation].parse, base: { order_no: "SO-1" }, rooted: true };
}

function acceptedByParser(operation) {
  const { parse, base, rooted } = parserFor(operation);
  const accepted = [];
  for (const [key, value] of Object.entries(PROBES)) {
    try {
      parse({ ...base, [key]: value });
      accepted.push(key);
    } catch {
      continue;
    }
  }
  if (rooted) accepted.push("order_ref");
  return accepted.sort();
}

function mismatches(specs) {
  return TOOL_CAPABILITIES.filter((capability) => {
    const declared = [...(specs[`${capability.tool}:${capability.operation}`].accepts ?? [])].sort();
    return JSON.stringify(declared) !== JSON.stringify(acceptedByParser(capability.operation));
  }).map((capability) => `${capability.tool}:${capability.operation}`);
}

test("list_documents 的 accepts 恰为六个筛选与分页参数", () => {
  assert.deepEqual([...OPERATION_SPECS["order_query:list_documents"].accepts].sort(), ["customer_q", "from", "page", "product_q", "status", "to"]);
});

test("带页与不带页的根查询：accepts 分别为 [order_ref, page] 与 [order_ref]", () => {
  assert.deepEqual(OPERATION_SPECS["order_query:get_order_overview"].accepts, ["order_ref"]);
  assert.deepEqual(OPERATION_SPECS["order_query:get_order_timeline"].accepts, ["order_ref", "page"]);
});

test("两条无根入口：accepts 恰为 [page]，不含 order_ref", () => {
  assert.deepEqual(OPERATION_SPECS["procurement_query:list_overdue_arrivals"].accepts, ["page"]);
  assert.deepEqual(OPERATION_SPECS["warehouse_query:list_low_stock_materials"].accepts, ["page"]);
});

test("35 个 operation：accepts 与解析器实际接受的参数逐个一致", () => {
  assert.equal(TOOL_CAPABILITIES.length, 35);
  assert.deepEqual(mismatches(OPERATION_SPECS), []);
});

test("对账函数不会恒绿：去掉 get_order_timeline 的 page 后报告不一致", () => {
  const broken = JSON.parse(JSON.stringify(OPERATION_SPECS));
  broken["order_query:get_order_timeline"].accepts = ["order_ref"];
  assert.deepEqual(mismatches(broken), ["order_query:get_order_timeline"]);
});
