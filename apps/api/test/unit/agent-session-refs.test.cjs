const assert = require("node:assert/strict");
const { test } = require("node:test");
const { randomUUID } = require("node:crypto");
const { AgentOrchestrator } = require("../../dist/modules/business-query-agent/agent-orchestrator.js");
const { AgentStateManager } = require("../../dist/modules/business-query-agent/state-manager.js");

const USER_A = "11111111-1111-4111-8111-111111111111";
const PRINCIPAL = { user: { id: USER_A, username: "worker", display_name: "员工" }, accessLevel: "operational" };

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
      findMany: async ({ where = {}, orderBy } = {}) => { const rows = store.events.filter((row) => matches(row, where)); if (orderBy?.seq === "asc") rows.sort((a, b) => a.seq - b.seq); return rows; },
      createMany: async ({ data }) => { for (const row of data) store.events.push({ id: randomUUID(), ...row, createdAt: new Date() }); return { count: data.length }; },
    },
  };
  db.$transaction = async (fn) => fn(db);
  return db;
}

const SEARCH_FACT = {
  operation: "search_documents",
  order_no: null,
  as_of: "2026-11-23T00:00:00.000Z",
  data: [{ document_type: "sales_order", document_no: "MOCK-ORD-001", sales_order_no: "MOCK-ORD-001", status: "confirmed", related_documents: [] }],
  sources: [{ business_type: "sales_order", business_no: "MOCK-ORD-001", queried_at: "2026-11-23T00:00:00.000Z" }],
  access_level: "operational",
};

const OVERVIEW_FACT = {
  operation: "get_order_overview",
  order_no: "MOCK-ORD-001",
  as_of: "2026-11-23T00:00:00.000Z",
  data: { order_no: "MOCK-ORD-001", status: "confirmed" },
  sources: [{ business_type: "sales_order", business_no: "MOCK-ORD-001", queried_at: "2026-11-23T00:00:00.000Z" }],
  access_level: "operational",
};

function fakeProvider({ plans }) {
  let index = 0;
  return {
    async plan() {
      const plan = plans[Math.min(index, plans.length - 1)];
      index += 1;
      return plan;
    },
    async *streamAnswer() {
      yield { type: "text", text: "好的。" };
      yield { type: "usage", usage: { model: "fake-provider" } };
    },
  };
}

const roleReader = { async readActiveRoleKeys() { return ["qita"]; } };

async function runTurn({ db, state, sessionId, calls, executorCalls }) {
  const run = await state.createRun({ sessionId, userId: USER_A, clientMessageId: randomUUID(), question: "问题", accessLevel: "operational" });
  const executor = {
    async execute(call) {
      executorCalls.push({ operation: call.operation, args: call.args });
      return call.operation === "search_documents" ? SEARCH_FACT : OVERVIEW_FACT;
    },
  };
  await new AgentOrchestrator(state, executor, fakeProvider({ plans: calls }), roleReader).run(run, PRINCIPAL, new AbortController().signal);
  return db.store.events.filter((event) => event.runId === run.id);
}

test("第二轮追问复用上一轮句柄：不再判 ORDER_REF_INVALID，直接还原成单号", async () => {
  const db = createPrisma();
  const state = new AgentStateManager(db);
  const session = await state.createSession(USER_A);
  const executorCalls = [];

  await runTurn({
    db,
    state,
    sessionId: session.id,
    calls: [{ toolCalls: [{ id: "c1", tool: "order_query", operation: "search_documents", args: { q: "MOCK-ORD-001" } }] }, { toolCalls: [] }],
    executorCalls,
  });
  const secondEvents = await runTurn({
    db,
    state,
    sessionId: session.id,
    calls: [{ toolCalls: [{ id: "c2", tool: "order_query", operation: "get_order_overview", args: { order_ref: "o_1" } }] }, { toolCalls: [] }],
    executorCalls,
  });

  const secondCall = executorCalls.at(-1);
  assert.equal(secondCall.operation, "get_order_overview");
  assert.equal(secondCall.args.order_no, "MOCK-ORD-001", "句柄必须被还原成上一轮检索到的单号");
  assert.equal(secondCall.args.order_ref, undefined, "句柄不进执行器");
  const refRequired = secondEvents.filter((event) => event.type === "tool_status" && event.payload?.code === "ORDER_REF_INVALID");
  assert.deepEqual(refRequired, [], "同一会话第二轮不该再报 ORDER_REF_INVALID");
});

test("同会话里伪造的句柄照样被拒，不触达执行器", async () => {
  const db = createPrisma();
  const state = new AgentStateManager(db);
  const session = await state.createSession(USER_A);
  const executorCalls = [];

  await runTurn({
    db,
    state,
    sessionId: session.id,
    calls: [{ toolCalls: [{ id: "c1", tool: "order_query", operation: "search_documents", args: { q: "MOCK-ORD-001" } }] }, { toolCalls: [] }],
    executorCalls,
  });
  const before = executorCalls.length;
  const events = await runTurn({
    db,
    state,
    sessionId: session.id,
    calls: [{ toolCalls: [{ id: "c2", tool: "order_query", operation: "get_order_overview", args: { order_ref: "o_99" } }] }, { toolCalls: [] }],
    executorCalls,
  });

  assert.equal(executorCalls.length, before, "伪造句柄不得进入执行器");
  const codes = events.filter((event) => event.type === "tool_status").map((event) => event.payload?.code).filter(Boolean);
  assert.ok(codes.includes("ORDER_REF_INVALID"));
});

test("另一会话拿不到本会话的句柄", async () => {
  const db = createPrisma();
  const state = new AgentStateManager(db);
  const sessionA = await state.createSession(USER_A);
  const sessionB = await state.createSession(USER_A);
  const executorCalls = [];

  await runTurn({
    db,
    state,
    sessionId: sessionA.id,
    calls: [{ toolCalls: [{ id: "c1", tool: "order_query", operation: "search_documents", args: { q: "MOCK-ORD-001" } }] }, { toolCalls: [] }],
    executorCalls,
  });
  const before = executorCalls.length;
  const events = await runTurn({
    db,
    state,
    sessionId: sessionB.id,
    calls: [{ toolCalls: [{ id: "c2", tool: "order_query", operation: "get_order_overview", args: { order_ref: "o_1" } }] }, { toolCalls: [] }],
    executorCalls,
  });

  assert.equal(executorCalls.length, before, "跨会话句柄不得复用");
  const codes = events.filter((event) => event.type === "tool_status").map((event) => event.payload?.code).filter(Boolean);
  assert.ok(codes.includes("ORDER_REF_INVALID"));
});

test("本会话发出的句柄事件不推送浏览器（内部事件）", async () => {
  const db = createPrisma();
  const state = new AgentStateManager(db);
  const session = await state.createSession(USER_A);
  const executorCalls = [];
  const events = await runTurn({
    db,
    state,
    sessionId: session.id,
    calls: [{ toolCalls: [{ id: "c1", tool: "order_query", operation: "search_documents", args: { q: "MOCK-ORD-001" } }] }, { toolCalls: [] }],
    executorCalls,
  });
  const refEvent = events.find((event) => event.type === "order_ref");
  assert.ok(refEvent, "检索成功后必须留一条 order_ref 事件供下一轮解析");
  assert.deepEqual(refEvent.payload.refs, [{ ref: "o_1", orderNo: "MOCK-ORD-001" }]);
});