const assert = require("node:assert/strict");
const { test } = require("node:test");
const { AgentOrchestrator } = require("../../dist/modules/business-query-agent/agent-orchestrator.js");
const { AgentStateManager } = require("../../dist/modules/business-query-agent/state-manager.js");
const { OPERATION_SPECS } = require("../../dist/modules/business-query-agent/tools/tool-catalog-specs.js");
const { createPrisma, principalFor, createPlanningRun, roleReaderFor, scriptedProvider } = require("../helpers/agent-fake-prisma.cjs");

const OVERDUE_FACT = {
  operation: "list_overdue_arrivals",
  order_no: null,
  as_of: "2026-11-24T00:00:00.000Z",
  data: [{ purchase_order_no: "PO-001", order_no: "SO-001", status: "ordered", expected_date: "2026-11-01", overdue_days: 23, supplier: "某供应商" }],
  sources: [{ business_type: "purchase_order", business_no: "PO-001", queried_at: "2026-11-24T00:00:00.000Z" }],
  access_level: "operational",
};

async function run(accessLevel = "operational") {
  const db = createPrisma();
  const state = new AgentStateManager(db);
  const record = await createPlanningRun(state, accessLevel, "哪些采购到货超期");
  const executed = [];
  const executor = { async execute(call) { executed.push(call); return { ...OVERDUE_FACT, access_level: accessLevel }; } };
  const provider = scriptedProvider([
    () => [{ id: "c1", tool: "catalog_query", operation: "describe_module", args: { module: "procurement_query" } }],
    () => [{ id: "c2", tool: "procurement_query", operation: "list_overdue_arrivals", args: {} }],
  ]);
  await new AgentOrchestrator(state, executor, provider, roleReaderFor(accessLevel)).run(record, principalFor(accessLevel), new AbortController().signal);
  const events = db.store.events.filter((event) => event.runId === record.id);
  return { saved: db.store.runs.find((row) => row.id === record.id), events, provider, executed };
}

test("先展开采购模块再直接选中无根入口：三步完成，只有真查询算事实", async () => {
  const { saved, executed } = await run();
  assert.equal(saved.state, "completed");
  assert.equal(saved.usage.model_steps, 3);
  assert.equal(saved.usage.tool_calls, 1);
  assert.deepEqual(executed.map((call) => call.operation), ["list_overdue_arrivals"]);
});

test("第三轮规划时，模型已经看到 list_overdue_arrivals 的问句形状原文", async () => {
  const { provider } = await run();
  const toolMessages = provider.captured[2].messages.filter((message) => message.role === "tool");
  const expected = OPERATION_SPECS["procurement_query:list_overdue_arrivals"].questionShape;
  assert.ok(toolMessages.some((message) => message.content.includes(expected)));
});

test("全程没有失败的 tool_status，也没有根守卫错误", async () => {
  const { events } = await run();
  const statuses = events.filter((event) => event.type === "tool_status").map((event) => event.payload.status);
  assert.deepEqual(statuses, ["running", "completed", "running", "completed"]);
  const blob = JSON.stringify(events);
  for (const code of ["ORDER_SEARCH_REQUIRED", "ORDER_REF_REQUIRED"]) assert.equal(blob.includes(code), false, code);
});

test("系统指令：full 档含六个模块，operational 档不含 finance_query", async () => {
  const full = await run("full");
  const operational = await run("operational");
  const fullPrompt = full.provider.captured[0].messages[0].content;
  const operationalPrompt = operational.provider.captured[0].messages[0].content;
  for (const tool of ["order_query", "sales_query", "procurement_query", "production_query", "warehouse_query", "finance_query"]) assert.ok(fullPrompt.includes(`- ${tool} `), tool);
  assert.equal(operationalPrompt.includes("finance_query"), false);
});
