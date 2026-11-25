const assert = require("node:assert/strict");
const { test } = require("node:test");
const { checkGap } = require("../../dist/modules/business-query-agent/tools/gap-check.js");
const { TOOL_CAPABILITIES } = require("../../dist/modules/business-query-agent/tools/tool-registry.js");

const BASE = { nearest_operation: "list_low_stock_materials", missing: "group_by", missing_detail: "按仓库分组", needed_fields: ["SalesOrder.orderNo", "仓库"] };
const check = (patch = {}, accessLevel = "operational", executed = []) => checkGap({ ...BASE, ...patch }, { accessLevel, executed });

test("放行：字段分组，其余原样", () => {
  assert.deepEqual(check(), { accepted: true, gap: { ...BASE, needed_fields: ["SalesOrder.orderNo"], unverified_fields: ["仓库"] } });
});

test("最近邻不存在或本档位不可见：只回可见清单，不泄露财务", () => {
  const hidden = check({ nearest_operation: "get_receivables" });
  assert.equal(hidden.accepted, false);
  assert.equal(hidden.code, "AGENT_GAP_OPERATION_UNKNOWN");
  assert.ok(hidden.message.startsWith("nearest_operation 不是可用的 operation。可用："));
  assert.ok(hidden.message.includes("list_low_stock_materials"));
  for (const item of TOOL_CAPABILITIES.filter((capability) => capability.minAccess === "full")) assert.equal(hidden.message.includes(item.operation), false, item.operation);
  assert.equal(check({ nearest_operation: "made_up" }, "full").code, "AGENT_GAP_OPERATION_UNKNOWN");
});

test("声明缺的参数该 operation 本来就接受：驳回并回传条目", () => {
  const result = check({ nearest_operation: "list_documents", missing: "filter", missing_param: "status" });
  assert.equal(result.code, "AGENT_GAP_PARAM_SUPPORTED");
  assert.ok(result.message.startsWith("list_documents 本来就接受参数 status，直接用它查询。条目："));
  const entry = JSON.parse(result.message.split("条目：")[1]);
  assert.deepEqual(Object.keys(entry), ["operation", "question_shape", "input", "output", "boundary", "accepts"]);
  assert.equal(entry.operation, "list_documents");
});

test("不接受该参数或没填参数名：放行", () => {
  assert.equal(check({ nearest_operation: "get_bom", missing: "filter", missing_param: "status" }).accepted, true);
  assert.equal(check({ nearest_operation: "list_documents", missing: "filter" }).accepted, true);
});

test("最近邻本轮只查到 0 行：判缺数据", () => {
  const result = check({}, "operational", [{ operation: "list_low_stock_materials", rows: 0 }]);
  assert.equal(result.code, "AGENT_GAP_NO_DATA");
  assert.equal(result.message, "list_low_stock_materials 本轮查到 0 行，这是缺数据，不是缺工具。直接告诉用户没有查到记录。");
});

test("最近邻有一次查到行：放行", () => {
  const executed = [{ operation: "list_low_stock_materials", rows: 0 }, { operation: "list_low_stock_materials", rows: 3 }];
  assert.equal(check({}, "operational", executed).accepted, true);
});

test("别的 operation 落空不算", () => {
  assert.equal(check({}, "operational", [{ operation: "search_documents", rows: 0 }]).accepted, true);
});

test("核对顺序：可见性先于缺数据，参数先于缺数据", () => {
  const empty = [{ operation: "list_documents", rows: 0 }, { operation: "made_up", rows: 0 }];
  assert.equal(check({ nearest_operation: "made_up" }, "full", empty).code, "AGENT_GAP_OPERATION_UNKNOWN");
  assert.equal(check({ nearest_operation: "list_documents", missing_param: "status" }, "full", empty).code, "AGENT_GAP_PARAM_SUPPORTED");
});
