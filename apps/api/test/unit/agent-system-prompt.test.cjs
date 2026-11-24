const assert = require("node:assert/strict");
const { test } = require("node:test");
const { AgentOrchestrator } = require("../../dist/modules/business-query-agent/agent-orchestrator.js");
const { AgentStateManager } = require("../../dist/modules/business-query-agent/state-manager.js");
const { buildCatalog, renderL1 } = require("../../dist/modules/business-query-agent/tools/tool-catalog.js");
const { TOOL_CAPABILITIES } = require("../../dist/modules/business-query-agent/tools/tool-registry.js");
const { createPrisma, principalFor, createPlanningRun, roleReaderFor, scriptedProvider } = require("../helpers/agent-fake-prisma.cjs");

const MODULES = ["order_query", "sales_query", "procurement_query", "production_query", "warehouse_query", "finance_query"];

async function firstSystemPrompt(accessLevel) {
  const db = createPrisma();
  const state = new AgentStateManager(db);
  const run = await createPlanningRun(state, accessLevel);
  const provider = scriptedProvider([]);
  const executor = { async execute() { throw new Error("不应触达执行器"); } };
  await new AgentOrchestrator(state, executor, provider, roleReaderFor(accessLevel)).run(run, principalFor(accessLevel), new AbortController().signal);
  return provider.captured[0].messages[0];
}

test("full 档：第一条消息是系统指令，含六个模块", async () => {
  const message = await firstSystemPrompt("full");
  assert.equal(message.role, "system");
  for (const tool of MODULES) assert.ok(message.content.includes(`- ${tool} `), tool);
});

test("operational 档：不含 finance_query，含其余五个模块", async () => {
  const message = await firstSystemPrompt("operational");
  assert.equal(message.content.includes("finance_query"), false);
  for (const tool of MODULES.slice(0, 5)) assert.ok(message.content.includes(`- ${tool} `), tool);
});

test("两档都保留句柄约束与不得编造", async () => {
  for (const accessLevel of ["full", "operational"]) {
    const { content } = await firstSystemPrompt(accessLevel);
    assert.ok(content.includes("order_ref"), accessLevel);
    assert.ok(content.includes("search_documents"), accessLevel);
    assert.ok(content.includes("不得编造"), accessLevel);
  }
});

test("三个无根入口由目录点名，并提示用 catalog_query 展开", async () => {
  const { content } = await firstSystemPrompt("full");
  for (const name of ["list_documents", "list_low_stock_materials", "list_overdue_arrivals"]) assert.ok(content.includes(name), name);
  assert.ok(content.includes("catalog_query") && content.includes("describe_module"));
});

test("目录跟随能力表：多一条带规格的 capability，对应模块计数加一", () => {
  const extra = { tool: "order_query", operation: "made_up", minAccess: "operational", implemented: true, maxRows: 20 };
  const specs = { ...require("../../dist/modules/business-query-agent/tools/tool-catalog-specs.js").OPERATION_SPECS };
  specs["order_query:made_up"] = { questionShape: "a", input: "b", output: "c", boundary: "d", accepts: [] };
  const catalog = buildCatalog([...TOOL_CAPABILITIES, extra], specs);
  const line = renderL1("full", catalog).split("\n").find((item) => item.startsWith("- order_query "));
  assert.equal(Number(/(\d+) 个/.exec(line)[1]), 9);
});
