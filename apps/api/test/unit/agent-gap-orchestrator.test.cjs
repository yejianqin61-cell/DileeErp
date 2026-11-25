const assert = require("node:assert/strict");
const { test } = require("node:test");
const { AgentOrchestrator } = require("../../dist/modules/business-query-agent/agent-orchestrator.js");
const { AgentStateManager, AGENT_EVENT_TYPES } = require("../../dist/modules/business-query-agent/state-manager.js");
const { StreamTransport } = require("../../dist/modules/business-query-agent/stream-transport.js");
const { createPrisma, principalFor, createPlanningRun, roleReaderFor, scriptedProvider } = require("../helpers/agent-fake-prisma.cjs");

const QUESTION = "各仓库库存多少";
const declare = (id, patch = {}) => ({ id, tool: "report_gap", operation: "declare_gap", args: { nearest_operation: "list_low_stock_materials", missing: "group_by", missing_detail: "按仓库分组", ...patch } });

async function drive(plans, rows = [{ material_code: "M-1" }]) {
  const db = createPrisma();
  const state = new AgentStateManager(db);
  const run = await createPlanningRun(state, "operational", QUESTION);
  const provider = scriptedProvider(plans);
  const executor = {
    calls: [],
    async execute(call) {
      this.calls.push(call);
      return { operation: call.operation, access_level: "operational", as_of: "2026-11-25T00:00:00.000Z", data: rows, sources: [] };
    },
  };
  await new AgentOrchestrator(state, executor, provider, roleReaderFor("operational")).run(run, principalFor("operational"), new AbortController().signal);
  const saved = db.store.runs.find((row) => row.id === run.id);
  const events = db.store.events.filter((row) => row.runId === run.id).sort((a, b) => a.seq - b.seq);
  const toolMessages = (provider.answerInputs[0] ?? []).filter((message) => message.role === "tool");
  return { saved, events, provider, executor, toolMessages, gaps: events.filter((event) => event.type === "gap_declared") };
}

test("放行：写一条内部事件，回「已记录」，不算事实", async () => {
  const result = await drive([() => [declare("g1", { needed_fields: ["SalesOrder.orderNo", "仓库"] })]]);
  assert.equal(result.saved.state, "completed");
  assert.equal(result.gaps.length, 1);
  assert.deepEqual(result.gaps[0].payload, { nearest_operation: "list_low_stock_materials", missing: "group_by", missing_detail: "按仓库分组", needed_fields: ["SalesOrder.orderNo"], unverified_fields: ["仓库"] });
  assert.equal(JSON.stringify(result.gaps[0].payload).includes(QUESTION), false);
  assert.equal(result.toolMessages[0].content, '{"result":"已记录"}');
  assert.equal(result.saved.usage.tool_calls, 0);
  assert.deepEqual(result.events.filter((event) => event.type === "tool_status").map((event) => [event.payload.tool, event.payload.operation, event.payload.status]), [["report_gap", "declare_gap", "running"], ["report_gap", "declare_gap", "completed"]]);
  assert.equal(result.events.some((event) => event.type === "source" || event.type === "tool_args"), false);
});

test("驳回不计失败预算：同批 4 次都得到回应", async () => {
  const result = await drive([() => [1, 2, 3, 4].map((n) => declare(`g${n}`, { nearest_operation: "made_up" }))]);
  assert.equal(result.saved.state, "completed");
  assert.equal(result.toolMessages.length, 4);
  for (const message of result.toolMessages) assert.equal(JSON.parse(message.content).error.code, "AGENT_GAP_OPERATION_UNKNOWN");
  assert.equal(result.provider.answerInputs[0].some((message) => message.role === "system" && message.content.includes("连续失败")), false);
});

test("最近邻查到 0 行后声明：判缺数据", async () => {
  const result = await drive([() => [{ id: "q1", tool: "warehouse_query", operation: "list_low_stock_materials", args: {} }], () => [declare("g1")]], []);
  assert.equal(JSON.parse(result.toolMessages.at(-1).content).error.code, "AGENT_GAP_NO_DATA");
  assert.equal(result.gaps.length, 0);
});

test("同轮同键只写一次", async () => {
  const result = await drive([() => [declare("g1"), declare("g2", { missing_detail: "分仓库看" })]]);
  assert.equal(result.gaps.length, 1);
  assert.deepEqual(result.toolMessages.map((message) => message.content), ['{"result":"已记录"}', '{"result":"已记录"}']);
});

test("gap_declared 是内部事件：在类型清单里，不推给浏览器", async () => {
  assert.ok(AGENT_EVENT_TYPES.includes("gap_declared"));
  const chunks = [];
  const response = { status() { return this; }, setHeader() { return this; }, flushHeaders() {}, on() {}, write(chunk) { chunks.push(chunk); return true; }, end() { this.writableEnded = true; } };
  const event = (seq, type, payload) => ({ seq, type, payload, createdAt: new Date("2026-11-25T00:00:00.000Z") });
  const state = { async eventsAfter() { return [event(1, "gap_declared", { missing_detail: "按仓库分组" }), event(2, "completed", {})]; } };
  await new StreamTransport(state, { async readActiveRoleKeys() { return ["qita"]; } }).follow(response, { id: "r", userId: "u", accessLevel: "operational" }, 0);
  const body = chunks.join("");
  assert.equal(body.includes("gap_declared"), false);
  assert.equal(body.includes("按仓库分组"), false);
  assert.ok(body.includes('"completed"'));
});
