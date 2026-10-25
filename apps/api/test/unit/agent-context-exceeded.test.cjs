// 超窗与超时错误收口的单元测试（假 provider 直接抛业务异常）。
//
// R-6 的收口契约：模型窗口超限返回明确错误 —— provider 抛 `AGENT_MODEL_CONTEXT_EXCEEDED`，
// 编排器把 run 收进 failed 且**错误码原样保留**（SSE error 事件带它，前端据此提示），不静默删改。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { randomUUID } = require("node:crypto");
const { AgentOrchestrator } = require("../../dist/modules/business-query-agent/agent-orchestrator.js");
const { AgentStateManager } = require("../../dist/modules/business-query-agent/state-manager.js");
const { HttpException } = require("@nestjs/common");

const USER_A = "11111111-1111-4111-8111-111111111111";
const PRINCIPAL = { user: { id: USER_A, username: "worker", display_name: "员工" }, accessLevel: "operational" };

function createPrisma() {
  const store = { runs: [], events: [], sessions: [] };
  const matches = (row, where = {}) => Object.entries(where).every(([key, expected]) => {
    const value = row[key];
    if (expected && typeof expected === "object" && Array.isArray(expected.in)) return expected.in.includes(value);
    return value === expected;
  });
  const db = {
    store,
    agentSession: { create: async ({ data }) => { const row = { id: randomUUID(), ...data, createdAt: new Date(), updatedAt: new Date() }; store.sessions.push(row); return row; }, findMany: async () => store.sessions },
    agentRun: {
      create: async ({ data }) => { const row = { id: randomUUID(), ...data, createdAt: new Date(), updatedAt: new Date() }; store.runs.push(row); return row; },
      findFirst: async ({ where = {} } = {}) => store.runs.find((row) => matches(row, where)) ?? null,
      findMany: async ({ where = {} } = {}) => store.runs.filter((row) => matches(row, where)),
      updateMany: async ({ where = {}, data }) => { const m = store.runs.filter((row) => matches(row, where)); m.forEach((row) => Object.assign(row, data, { updatedAt: new Date() })); return { count: m.length }; },
    },
    agentRunEvent: {
      findMany: async ({ where = {} } = {}) => store.events.filter((row) => matches(row, where)),
      createMany: async ({ data }) => { data.forEach((row) => store.events.push({ id: randomUUID(), ...row, createdAt: new Date() })); return { count: data.length }; },
    },
  };
  db.$transaction = async (fn) => fn(db);
  return db;
}

test("provider 抛 AGENT_MODEL_CONTEXT_EXCEEDED → run failed 且错误码原样，事件流有 error 终态", async () => {
  const db = createPrisma();
  const state = new AgentStateManager(db);
  const session = await state.createSession(USER_A);
  const run = await state.createRun({ sessionId: session.id, userId: USER_A, clientMessageId: randomUUID(), question: "把全部历史都算一遍", accessLevel: "operational" });
  const contextExceeded = new HttpException({ code: "AGENT_MODEL_CONTEXT_EXCEEDED", message: "本次问题或历史超出模型上下文窗口，请换个更短的问法", details: [] }, 502);
  const orchestrator = new AgentOrchestrator(state, { async execute() { throw new Error("不应执行工具"); } }, {
    async plan() { throw contextExceeded; },
    async *streamAnswer() { yield { type: "text", text: "不会到达" }; },
  }, { async readActiveRoleKeys() { return ["qita"]; } });

  await orchestrator.run(run, PRINCIPAL, new AbortController().signal);

  const saved = db.store.runs.find((row) => row.id === run.id);
  assert.equal(saved.state, "failed");
  assert.equal(saved.errorCode, "AGENT_MODEL_CONTEXT_EXCEEDED", "超窗错误码不得被吞成 INTERNAL_ERROR");
  const errorEvent = db.store.events.filter((event) => event.runId === run.id).at(-1);
  assert.equal(errorEvent.type, "error");
  assert.equal(errorEvent.payload.code, "AGENT_MODEL_CONTEXT_EXCEEDED");
});

test("FakeLlmProvider 的 AGENT_FAKE_DELAY_MS 延迟钩子：每阶段生效且 run 仍能完成（并发证据的窗口来源）", async () => {
  const { FakeLlmProvider } = require("../../dist/modules/business-query-agent/fake-llm-provider.js");
  const db = createPrisma();
  const state = new AgentStateManager(db);
  const session = await state.createSession(USER_A);
  const run = await state.createRun({ sessionId: session.id, userId: USER_A, clientMessageId: randomUUID(), question: "SO 开头有哪些订单？", accessLevel: "operational" });
  const { ToolExecutor } = require("../../dist/modules/business-query-agent/tools/tool-executor.js");
  const FACT = { operation: "search_orders", order_no: null, as_of: "x", data: [{ order_no: "SO-001", product_name: "p", quantity: "1", unit: "u", status: "s", delivery_date: "d" }], sources: [{ business_type: "sales_order", business_no: "SO-001", queried_at: "x" }], access_level: "operational" };
  const executor = new ToolExecutor({ salesOrder: { findMany: async () => [{ orderNo: "SO-001", productName: "p", quantity: { toString: () => "1" }, unit: "u", status: "s", deliveryDate: new Date() }] } }, { async readActiveRoleKeys() { return ["qita"]; } });
  const orchestrator = new AgentOrchestrator(state, executor, new FakeLlmProvider(60), { async readActiveRoleKeys() { return ["qita"]; } });

  const startedAt = Date.now();
  await orchestrator.run(run, PRINCIPAL, new AbortController().signal);
  const elapsed = Date.now() - startedAt;

  const saved = db.store.runs.find((row) => row.id === run.id);
  assert.equal(saved.state, "completed", "延迟只是窗口，不是故障");
  // fake provider：plan 一次 + 回答 3 段 = 4 个停顿点 × 60ms；下限 200ms 证明延迟生效。
  assert.ok(elapsed >= 200, `延迟应让 run 至少 200ms，实际 ${elapsed}ms`);
});
