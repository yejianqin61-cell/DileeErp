import { test } from "node:test";
import assert from "node:assert/strict";
import { MockLanguageModelV4 } from "ai/test";

import { runOne } from "./run-one.mjs";

const USAGE = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };
let seq = 0;
const call = (toolName, input) => ({
  content: [{ type: "tool-call", toolCallId: `call-${++seq}`, toolName, input: JSON.stringify(input) }],
  finishReason: { unified: "tool-calls", raw: "tool_calls" },
  usage: USAGE,
  warnings: [],
});
const say = (text) => ({ content: [{ type: "text", text }], finishReason: { unified: "stop", raw: "stop" }, usage: USAGE, warnings: [] });
const scripted = (...responses) => {
  let index = 0;
  return new MockLanguageModelV4({ doGenerate: async () => responses[Math.min(index++, responses.length - 1)] });
};
const question = (id, stub = "rows") => ({ id, question: `题目 ${id}`, stub });
const toolResults = (model, callIndex) => model.doGenerateCalls[callIndex].prompt
  .flatMap((message) => (message.role === "tool" ? message.content : []))
  .map((part) => ({ tool: part.toolName, value: part.output.value }));

test("没报缺口：记录调用数与收尾", async () => {
  const model = scripted(call("order_query", { operation: "search_documents", q: "MOCK-ORD-001" }), say("客户是某某"));
  const record = await runOne({ group: "C", question: question("decoy-06"), model, rep: 2 });
  assert.deepEqual(record, { group: "C", id: "decoy-06", rep: 2, gap: null, domainCallsBeforeGap: null, domainCalls: 1, catalogCalls: 0, capped: false, answered: true });
});

test("报缺口前的领域调用数与缺口参数", async () => {
  const args = { nearest_operation: "list_low_stock_materials", missing: "group_by", missing_detail: "按仓库分组" };
  const model = scripted(call("warehouse_query", { operation: "list_low_stock_materials" }), call("report_gap", args), say("目前无法回答"));
  const record = await runOne({ group: "C", question: question("gap-03"), model, rep: 1 });
  assert.deepEqual(record.gap, args);
  assert.equal(record.domainCallsBeforeGap, 1);
  assert.equal(record.domainCalls, 1);
  assert.deepEqual(toolResults(model, 2).at(-1), { tool: "report_gap", value: "已记录" });
});

test("stub 为 empty：检索仍给一行，其余领域工具给空数组", async () => {
  const model = scripted(
    call("order_query", { operation: "search_documents", q: "MOCK-ORD-001" }),
    call("finance_query", { operation: "get_reconciliations", order_ref: "o_1" }),
    say("没有对账记录"),
  );
  await runOne({ group: "A", question: question("nodata-01", "empty"), model, rep: 1 });
  assert.deepEqual(toolResults(model, 2).map((item) => item.value), [[{ order_ref: "o_1", order_no: "MOCK-ORD-001" }], []]);
});

test("stub 为 rows：非检索的领域工具给一行示例", async () => {
  const model = scripted(call("sales_query", { operation: "get_customer", order_ref: "o_1" }), say("好"));
  await runOne({ group: "A", question: question("decoy-06"), model, rep: 1 });
  assert.deepEqual(toolResults(model, 1)[0].value, [{ 示例字段: "示例值" }]);
});

test("跑满 8 步仍在调工具：capped", async () => {
  const model = scripted(call("order_query", { operation: "search_documents", q: "x" }));
  const record = await runOne({ group: "C", question: question("gap-01"), model, rep: 1 });
  assert.equal(record.capped, true);
  assert.equal(record.answered, false);
  assert.equal(record.gap, null);
  assert.equal(record.domainCalls, 8);
  assert.equal(model.doGenerateCalls.length, 8);
});

test("展开工具单独计数，结果来自 describeModule", async () => {
  const model = scripted(call("catalog_query", { operation: "describe_module", module: "procurement_query" }), say("好"));
  const record = await runOne({ group: "B", question: question("decoy-01"), model, rep: 1 });
  assert.equal(record.catalogCalls, 1);
  assert.equal(record.domainCalls, 0);
  assert.equal(toolResults(model, 1)[0].value.operations.length, 5);
});

test("系统指令用所在组的提示，用户消息是题面，工具含六领域、展开与 report_gap", async () => {
  const model = scripted(say("好"));
  await runOne({ group: "B", question: question("decoy-01"), model, rep: 1 });
  const { prompt, tools } = model.doGenerateCalls[0];
  assert.match(prompt.find((message) => message.role === "system").content, /可用查询模块的轴声明/);
  assert.equal(prompt.find((message) => message.role === "user").content[0].text, "题目 decoy-01");
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ["catalog_query", "finance_query", "order_query", "procurement_query", "production_query", "report_gap", "sales_query", "warehouse_query"]);
});
