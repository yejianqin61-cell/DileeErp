const assert = require("node:assert/strict");
const { test } = require("node:test");
const { MockLanguageModelV4 } = require("ai/test");
const { DeepSeekLlmProvider } = require("../../dist/modules/business-query-agent/deepseek-llm-provider.js");
const { AgentOrchestrator } = require("../../dist/modules/business-query-agent/agent-orchestrator.js");
const { AgentStateManager } = require("../../dist/modules/business-query-agent/state-manager.js");
const { describeModule } = require("../../dist/modules/business-query-agent/tools/tool-catalog.js");
const { createPrisma, principalFor, createPlanningRun, roleReaderFor, scriptedProvider } = require("../helpers/agent-fake-prisma.cjs");

const USAGE = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };
const FINISH_STOP = { unified: "stop", raw: "stop" };
const SIGNAL = new AbortController().signal;

const describeCall = (module, id = "d1") => ({ id, tool: "catalog_query", operation: "describe_module", args: { module } });

async function drive(plans, accessLevel = "operational") {
  const db = createPrisma();
  const state = new AgentStateManager(db);
  const run = await createPlanningRun(state, accessLevel);
  const provider = scriptedProvider(plans);
  const executor = { async execute() { throw new Error("目录展开不得触达执行器"); } };
  await new AgentOrchestrator(state, executor, provider, roleReaderFor(accessLevel)).run(run, principalFor(accessLevel), new AbortController().signal);
  return { db, run, provider, saved: db.store.runs.find((row) => row.id === run.id), events: db.store.events.filter((event) => event.runId === run.id) };
}

test("describeModule：采购模块恰好五个 operation，五字段与 accepts 齐全", () => {
  const result = describeModule("procurement_query", "operational");
  assert.equal(result.module, "procurement_query");
  assert.deepEqual(
    result.operations.map((item) => item.operation),
    ["get_purchase_plans", "list_overdue_arrivals", "get_purchase_orders", "get_receipts", "get_incoming_inspections"],
  );
  for (const item of result.operations) {
    for (const field of ["question_shape", "input", "output", "boundary"]) assert.ok(item[field].length > 0, `${item.operation}.${field}`);
    assert.ok(Array.isArray(item.accepts));
  }
  assert.deepEqual(result.operations[1].accepts, ["page"]);
});

test("provider：声明 catalog_query 在末尾，module 与 operation 枚举正确", async () => {
  const model = new MockLanguageModelV4({ doGenerate: { content: [], finishReason: FINISH_STOP, usage: USAGE } });
  const provider = new DeepSeekLlmProvider({ apiKey: "k", model: "deepseek-chat", timeoutMs: 0, modelOverride: model });
  await provider.plan([{ role: "user", content: "查询订单采购进度" }], ["order_query", "procurement_query"], SIGNAL);
  const tools = model.doGenerateCalls[0].tools;
  const last = tools[tools.length - 1];
  assert.equal(last.name, "catalog_query");
  assert.deepEqual(last.inputSchema.properties.module.enum, ["order_query", "procurement_query"]);
  assert.deepEqual(last.inputSchema.properties.operation.enum, ["describe_module"]);
  assert.deepEqual(tools.slice(0, -1).map((tool) => tool.name), ["order_query", "procurement_query"]);
});

test("编排器：describe_module 结果逐字回灌，不算事实、不触达执行器", async () => {
  const { saved, provider, events } = await drive([() => [describeCall("procurement_query")]]);
  assert.equal(saved.state, "completed");
  const toolMessages = provider.captured[1].messages.filter((message) => message.role === "tool");
  assert.equal(toolMessages.length, 1);
  assert.equal(toolMessages[0].content, JSON.stringify(describeModule("procurement_query", "operational")));
  assert.equal(saved.usage.tool_calls, 0);
  assert.equal(events.some((event) => event.type === "source"), false);
});

test("编排器：describe_module 只发 running 与 completed 两个 tool_status", async () => {
  const { events } = await drive([() => [describeCall("procurement_query")]]);
  const statuses = events.filter((event) => event.type === "tool_status").map((event) => event.payload);
  assert.deepEqual(statuses.map((item) => [item.tool, item.operation, item.status]), [
    ["catalog_query", "describe_module", "running"],
    ["catalog_query", "describe_module", "completed"],
  ]);
});

const ALL_MODULES = ["order_query", "sales_query", "procurement_query", "production_query", "warehouse_query", "finance_query"];

function catching(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return null;
}

test("未知模块：422 与专用错误码，消息列出全部六个可用模块", () => {
  const error = catching(() => describeModule("no_such_module", "full"));
  assert.equal(error.getStatus(), 422);
  assert.equal(error.getResponse().code, "AGENT_CATALOG_MODULE_UNKNOWN");
  for (const tool of ALL_MODULES) assert.ok(error.getResponse().message.includes(tool), tool);
});

test("operational 请求财务模块与请求不存在的模块：错误完全相同，且不泄露 finance_query", () => {
  const hidden = catching(() => describeModule("finance_query", "operational")).getResponse();
  const missing = catching(() => describeModule("no_such_module", "operational")).getResponse();
  assert.deepEqual(hidden, missing);
  assert.equal(hidden.message.includes("finance_query"), false);
  for (const tool of ALL_MODULES.slice(0, 5)) assert.ok(hidden.message.includes(tool), tool);
});

test("编排器：先传非法模块再传合法模块，错误信封回灌后正常展开", async () => {
  const { saved, provider } = await drive([() => [describeCall("no_such_module", "d1")], () => [describeCall("sales_query", "d2")]]);
  assert.equal(saved.state, "completed");
  const toolMessages = provider.captured[2].messages.filter((message) => message.role === "tool");
  assert.equal(JSON.parse(toolMessages[0].content).error.code, "AGENT_CATALOG_MODULE_UNKNOWN");
  assert.equal(JSON.parse(toolMessages[1].content).module, "sales_query");
});

test("编排器：连续三次非法模块耗尽失败预算，run 仍以 completed 收尾", async () => {
  const { saved } = await drive([() => [describeCall("x1", "d1"), describeCall("x2", "d2"), describeCall("x3", "d3")]]);
  assert.equal(saved.state, "completed");
});
