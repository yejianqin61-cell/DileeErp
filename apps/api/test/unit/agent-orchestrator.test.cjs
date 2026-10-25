// Agent 编排器的单元测试（真状态管理器 + 内存假 Prisma + 假 provider/执行器）。
//
// 编排器是唯一运行入口：planning → querying → responding → completed，
// 所有异常落终态，取消后迟到的结果写不进终态（模块设计「Agent orchestrator」行）。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { randomUUID } = require("node:crypto");
const { AgentOrchestrator } = require("../../dist/modules/business-query-agent/agent-orchestrator.js");
const { AgentStateManager } = require("../../dist/modules/business-query-agent/state-manager.js");

const USER_A = "11111111-1111-4111-8111-111111111111";
const PRINCIPAL = { user: { id: USER_A, username: "worker", display_name: "员工" }, accessLevel: "operational" };

/** 与 agent-state-manager.test.cjs 同一套内存假 Prisma（复制而非共享，保持测试文件自足）。 */
function createPrisma() {
  const store = { runs: [], events: [], sessions: [] };
  const matches = (row, where = {}) => Object.entries(where).every(([key, expected]) => {
    const value = row[key];
    if (expected && typeof expected === "object" && Array.isArray(expected.in)) return expected.in.includes(value);
    if (expected && typeof expected === "object" && expected.gt !== undefined) return value > expected.gt;
    return value === expected;
  });
  const db = {
    store,
    agentSession: {
      create: async ({ data }) => { const row = { id: randomUUID(), ...data, createdAt: new Date(), updatedAt: new Date() }; store.sessions.push(row); return row; },
      findMany: async ({ where = {} } = {}) => store.sessions.filter((row) => matches(row, where)),
    },
    agentRun: {
      create: async ({ data }) => { const row = { id: randomUUID(), ...data, createdAt: new Date(), updatedAt: new Date() }; store.runs.push(row); return row; },
      findFirst: async ({ where = {} } = {}) => store.runs.find((row) => matches(row, where)) ?? null,
      findMany: async ({ where = {} } = {}) => store.runs.filter((row) => matches(row, where)),
      updateMany: async ({ where = {}, data }) => { const matched = store.runs.filter((row) => matches(row, where)); for (const row of matched) Object.assign(row, data, { updatedAt: new Date() }); return { count: matched.length }; },
    },
    agentRunEvent: {
      findMany: async ({ where = {}, orderBy } = {}) => { const rows = store.events.filter((row) => matches(row, where)); if (orderBy?.seq === "asc") rows.sort((a, b) => a.seq - b.seq); if (orderBy?.seq === "desc") rows.sort((a, b) => b.seq - a.seq); return rows; },
      createMany: async ({ data }) => { for (const row of data) store.events.push({ id: randomUUID(), ...row, createdAt: new Date() }); return { count: data.length }; },
    },
  };
  // $transaction 回调拿到同一个 db：与真实 Prisma 交互事务同构（状态与事件同事务）。
  db.$transaction = async (fn) => fn(db);
  return db;
}

const FACT = {
  operation: "search_orders", order_no: null, as_of: "2026-10-25T00:00:00.000Z",
  data: [{ order_no: "SO-001", product_name: "手机壳", quantity: "100", unit: "个", status: "confirmed", delivery_date: "2026-11-01T00:00:00.000Z" }],
  sources: [{ business_type: "sales_order", business_no: "SO-001", queried_at: "2026-10-25T00:00:00.000Z" }],
  access_level: "operational",
};

/** 假执行器：记录调用，可配置抛错。 */
function fakeExecutor({ error = null } = {}) {
  const calls = [];
  return {
    calls,
    async execute(call, principal, signal) {
      calls.push({ call, principalAccess: principal.accessLevel });
      if (error) throw error;
      return { ...FACT, access_level: principal.accessLevel };
    },
  };
}

/** 假 provider：plan 默认第一轮返回一次 search_orders、之后返回空（多步循环的回归底线）；streamAnswer 产出 chunk。 */
function fakeProvider({ planCalls = null, onChunk = null } = {}) {
  const planInputs = [];
  return {
    planInputs,
    async plan(messages, tools, signal) {
      planInputs.push({ tools, toolMessages: messages.filter((message) => message.role === "tool").length });
      if (planCalls) return planCalls();
      if (planInputs.length === 1) return { toolCalls: [{ id: "call-1", tool: "order_query", operation: "search_orders", args: { q: "SO" } }] };
      return { toolCalls: [] };
    },
    async *streamAnswer(messages, signal) {
      const facts = messages.filter((message) => message.role === "tool").map((message) => JSON.parse(message.content));
      const rows = facts.flatMap((fact) => fact.data);
      const parts = [`根据本轮查询，找到 ${rows.length} 张订单：`, rows.map((row) => `${row.order_no}（${row.product_name}）`).join("；") + "。", `来源：${facts.flatMap((fact) => fact.sources).map((source) => source.business_no).join("、")}。`];
      for (const [index, text] of parts.entries()) {
        signal?.throwIfAborted();
        if (onChunk && index === 1) await onChunk();
        yield { type: "text", text };
      }
      signal?.throwIfAborted();
      yield { type: "usage", usage: { model: "fake-provider", input_tokens: 12, output_tokens: 34 } };
    },
  };
}

function fakeRoleReader(roleKeys = ["qita"]) { return { async readActiveRoleKeys() { return roleKeys; } }; }

async function planningRun(db, state) {
  const session = await state.createSession(USER_A);
  return state.createRun({ sessionId: session.id, userId: USER_A, clientMessageId: "cm-1", question: "SO 开头有哪些订单？", accessLevel: "operational" });
}

test("编排正常完成：planning → querying → responding → completed，事件类型与 seq 齐全", async () => {
  const db = createPrisma();
  const state = new AgentStateManager(db);
  const run = await planningRun(db, state);
  const executor = fakeExecutor();
  const orchestrator = new AgentOrchestrator(state, executor, fakeProvider(), fakeRoleReader());

  await orchestrator.run(run, PRINCIPAL, new AbortController().signal);

  const saved = db.store.runs.find((row) => row.id === run.id);
  assert.equal(saved.state, "completed");
  assert.equal(saved.answer, "根据本轮查询，找到 1 张订单：SO-001（手机壳）。来源：SO-001。");
  const events = db.store.events.filter((event) => event.runId === run.id);
  assert.deepEqual(events.map((event) => event.seq), events.map((_, index) => index + 1), "seq 必须从 1 起单调");
  assert.deepEqual(events.map((event) => event.type), ["state", "state", "tool_status", "tool_status", "source", "state", "answer_delta", "answer_delta", "answer_delta", "state", "completed"], "状态迁移自动补 state 事件，completed 前也有");
  const completed = events.at(-1).payload;
  assert.equal(completed.answer, saved.answer);
  assert.deepEqual(completed.sources.map((source) => source.business_no), ["SO-001"]);
  assert.equal(completed.usage.tool_calls, 1);
  assert.equal(completed.usage.answer_chunks, 3);
  assert.equal(completed.usage.model, "fake-provider");
  assert.equal(completed.usage.input_tokens, 12, "provider 用量聚合进 completed.usage");
  assert.deepEqual(executor.calls[0].call, { id: "call-1", tool: "order_query", operation: "search_orders", args: { q: "SO" } });
  assert.equal(executor.calls[0].principalAccess, "operational", "执行器拿到的档位来自 run 创建时");
});

test("多步循环：plan 连续两轮都返回调用后第三轮为空，工具按序执行且每轮结果回填消息", async () => {
  const db = createPrisma();
  const state = new AgentStateManager(db);
  const run = await planningRun(db, state);
  const provider = fakeProvider({
    planCalls: () => (provider.planInputs.length <= 2 ? { toolCalls: [{ id: `call-${provider.planInputs.length}`, tool: "order_query", operation: "search_orders", args: { q: "SO" } }] } : { toolCalls: [] }),
  });
  const orchestrator = new AgentOrchestrator(state, fakeExecutor(), provider, fakeRoleReader());

  await orchestrator.run(run, PRINCIPAL, new AbortController().signal);

  assert.deepEqual(provider.planInputs.map((input) => input.toolMessages), [0, 1, 2], "每轮 plan 都拿到上一轮的工具结果");
  const events = db.store.events.filter((event) => event.runId === run.id);
  assert.equal(events.filter((event) => event.type === "tool_status" && event.payload.status === "completed").length, 2);
});

test("run 级超时：provider 卡住超过 AGENT_RUN_TIMEOUT_MS → failed/AGENT_RUN_TIMEOUT", async () => {
  const db = createPrisma();
  const state = new AgentStateManager(db);
  const run = await planningRun(db, state);
  const slowProvider = {
    async plan() { return { toolCalls: [] }; },
    async *streamAnswer(messages, signal) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      signal.throwIfAborted();
      yield { type: "text", text: "不会到达" };
    },
  };
  const orchestrator = new AgentOrchestrator(state, fakeExecutor(), slowProvider, fakeRoleReader(), undefined, { runTimeoutMs: 50 });

  await orchestrator.run(run, PRINCIPAL, new AbortController().signal);

  const saved = db.store.runs.find((row) => row.id === run.id);
  assert.equal(saved.state, "failed");
  assert.equal(saved.errorCode, "AGENT_RUN_TIMEOUT");
});

test("无工具可调（澄清路径）：planning 直达 responding，再完成，无 tool_status 事件", async () => {
  const db = createPrisma();
  const state = new AgentStateManager(db);
  const run = await planningRun(db, state);
  const provider = fakeProvider({ planCalls: () => ({ toolCalls: [] }) });
  const orchestrator = new AgentOrchestrator(state, fakeExecutor(), provider, fakeRoleReader());

  await orchestrator.run(run, PRINCIPAL, new AbortController().signal);

  const events = db.store.events.filter((event) => event.runId === run.id);
  assert.ok(!events.some((event) => event.type === "tool_status"));
  const states = events.filter((event) => event.type === "state").map((event) => event.payload.state);
  assert.deepEqual(states, ["planning", "responding", "completed"]);
});

test("工具执行抛错：run 落 failed，错误码来自业务异常，事件流有 error 终态", async () => {
  const db = createPrisma();
  const state = new AgentStateManager(db);
  const run = await planningRun(db, state);
  const { HttpException } = require("@nestjs/common");
  const failure = new HttpException({ code: "AGENT_TOOL_ARGUMENT_INVALID", message: "搜索词 q 不能为空", details: [] }, 400);
  const orchestrator = new AgentOrchestrator(state, fakeExecutor({ error: failure }), fakeProvider(), fakeRoleReader());

  await orchestrator.run(run, PRINCIPAL, new AbortController().signal);

  const saved = db.store.runs.find((row) => row.id === run.id);
  assert.equal(saved.state, "failed");
  assert.equal(saved.errorCode, "AGENT_TOOL_ARGUMENT_INVALID");
  const lastEvent = db.store.events.filter((event) => event.runId === run.id).at(-1);
  assert.equal(lastEvent.type, "error");
  assert.equal(lastEvent.payload.code, "AGENT_TOOL_ARGUMENT_INVALID");
});

test("非业务异常的错误文本不进事件流（可能夹带业务值）：对外只有稳定文案", async () => {
  const db = createPrisma();
  const state = new AgentStateManager(db);
  const run = await planningRun(db, state);
  const leaky = Object.assign(new Error('relation "orders" does not exist near "SECRET_VALUE"'), {});
  const orchestrator = new AgentOrchestrator(state, fakeExecutor({ error: leaky }), fakeProvider(), fakeRoleReader());

  await orchestrator.run(run, PRINCIPAL, new AbortController().signal);

  const events = db.store.events.filter((event) => event.runId === run.id);
  const errorEvent = events.find((event) => event.type === "error");
  assert.equal(errorEvent.payload.code, "AGENT_INTERNAL_ERROR");
  assert.ok(!JSON.stringify(db.store.events).includes("SECRET_VALUE"), "数据库异常原文不得进入事件流");
});

test("responding 中被取消：迟到增量写不进终态，最终状态保持 cancelled", async () => {
  const db = createPrisma();
  const state = new AgentStateManager(db);
  const run = await planningRun(db, state);
  // 第二段产出前把 run 取消（模拟用户在流式中途点取消）。
  const provider = fakeProvider({ onChunk: () => state.cancel(run.id, USER_A) });
  const orchestrator = new AgentOrchestrator(state, fakeExecutor(), provider, fakeRoleReader());

  await orchestrator.run(run, PRINCIPAL, new AbortController().signal);

  const saved = db.store.runs.find((row) => row.id === run.id);
  assert.equal(saved.state, "cancelled", "取消后的迟到结果不得把 run 写成 completed/failed");
  const types = db.store.events.filter((event) => event.runId === run.id).map((event) => event.type);
  assert.ok(!types.includes("completed"));
});

test("已有非 planning 状态的 run 不重跑（取消后编排器迟到启动是无害空转）", async () => {
  const db = createPrisma();
  const state = new AgentStateManager(db);
  const run = await planningRun(db, state);
  await state.cancel(run.id, USER_A);
  const executor = fakeExecutor();
  const orchestrator = new AgentOrchestrator(state, executor, fakeProvider(), fakeRoleReader());

  await orchestrator.run({ ...run, state: "cancelled" }, PRINCIPAL, new AbortController().signal);
  assert.equal(executor.calls.length, 0);
});
