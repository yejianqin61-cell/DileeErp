const assert = require("node:assert/strict");
const { test } = require("node:test");
const { AgentOrchestrator } = require("../../dist/modules/business-query-agent/agent-orchestrator.js");
const { AgentStateManager } = require("../../dist/modules/business-query-agent/state-manager.js");
const { createPrisma, principalFor, createPlanningRun, roleReaderFor, scriptedProvider } = require("../helpers/agent-fake-prisma.cjs");

const call = (id, tool, operation, args = {}) => () => [{ id, tool, operation, args }];
const gap = (id, args) => call(id, "report_gap", "declare_gap", args);

async function drive(question, plans, rows = [{ order_no: "SO-1" }]) {
  const db = createPrisma();
  const state = new AgentStateManager(db);
  const run = await createPlanningRun(state, "operational", question);
  const provider = scriptedProvider(plans);
  const executor = {
    calls: [],
    async execute(toolCall) {
      this.calls.push(toolCall);
      return { operation: toolCall.operation, access_level: "operational", as_of: "2026-11-25T00:00:00.000Z", data: rows, sources: [] };
    },
  };
  await new AgentOrchestrator(state, executor, provider, roleReaderFor("operational")).run(run, principalFor("operational"), new AbortController().signal);
  const saved = db.store.runs.find((row) => row.id === run.id);
  const events = db.store.events.filter((row) => row.runId === run.id);
  const answered = provider.answerInputs[0] ?? [];
  const of = (type) => events.filter((event) => event.type === type);
  return { saved, provider, executor, answered, toolMessages: answered.filter((message) => message.role === "tool"), of };
}

test("真缺口：展开目录后声明，放行且不触达执行器", async () => {
  const result = await drive("各仓库库存多少", [
    call("c1", "catalog_query", "describe_module", { module: "warehouse_query" }),
    gap("g1", { nearest_operation: "list_low_stock_materials", missing: "group_by", missing_detail: "按仓库分组" }),
  ]);
  assert.equal(result.saved.state, "completed");
  assert.equal(result.of("gap_declared").length, 1);
  assert.equal(result.executor.calls.length, 0);
  assert.equal(result.of("source").length, 0);
});

test("误报：参数本来就支持，驳回后改用工具", async () => {
  const result = await drive("列出已确认的订单", [
    gap("g1", { nearest_operation: "list_documents", missing: "filter", missing_detail: "按状态筛选", missing_param: "status" }),
    call("c1", "order_query", "list_documents", { status: "confirmed" }),
  ]);
  const second = result.provider.captured[1].messages.filter((message) => message.role === "tool");
  assert.ok(second[0].content.includes("AGENT_GAP_PARAM_SUPPORTED"));
  assert.ok(JSON.parse(second[0].content).error.message.includes('"accepts"'));
  assert.equal(result.executor.calls.length, 1);
  assert.equal(result.of("gap_declared").length, 0);
  assert.equal(result.saved.state, "completed");
});

test("缺数据：最近邻查到 0 行后声明被驳回", async () => {
  const result = await drive("哪些采购到货超期", [
    call("c1", "procurement_query", "list_overdue_arrivals"),
    gap("g1", { nearest_operation: "list_overdue_arrivals", missing: "object", missing_detail: "超期到货" }),
  ], []);
  assert.equal(JSON.parse(result.toolMessages.at(-1).content).error.code, "AGENT_GAP_NO_DATA");
  assert.equal(result.of("gap_declared").length, 0);
  assert.equal(result.saved.state, "completed");
});

test("连续三次格式错误的声明不把 run 打成失败", async () => {
  const bad = (id) => gap(id, { nearest_operation: "list_documents", missing_detail: "按客户计数" });
  const result = await drive("每个客户多少订单", [bad("g1"), bad("g2"), bad("g3")]);
  assert.equal(result.saved.state, "completed");
  assert.equal(result.answered.some((message) => message.role === "system" && message.content.includes("连续失败")), false);
  const failed = result.of("tool_status").filter((event) => event.payload.status === "failed");
  assert.deepEqual(failed.map((event) => event.payload.code), Array(3).fill("AGENT_GAP_ARGUMENT_INVALID"));
});
