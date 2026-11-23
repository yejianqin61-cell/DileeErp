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
      findMany: async ({ where = {}, orderBy } = {}) => { const rows = store.events.filter((row) => matches(row, where)); if (orderBy?.seq === "asc") rows.sort((a, b) => a.seq - b.seq); if (orderBy?.seq === "desc") rows.sort((a, b) => b.seq - a.seq); return rows; },
      createMany: async ({ data }) => { for (const row of data) store.events.push({ id: randomUUID(), ...row, createdAt: new Date() }); return { count: data.length }; },
    },
  };
  db.$transaction = async (fn) => fn(db);
  return db;
}

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

const FACT = { operation: "search_orders", order_no: null, as_of: "2026-11-23T00:00:00.000Z", data: [{ order_no: "SO-001" }], sources: [], access_level: "operational" };
const executor = { async execute() { return FACT; } };
const roleReader = { async readActiveRoleKeys() { return ["qita"]; } };

async function runOnce(plans) {
  const db = createPrisma();
  const state = new AgentStateManager(db);
  const session = await state.createSession(USER_A);
  const run = await state.createRun({ sessionId: session.id, userId: USER_A, clientMessageId: "cm-1", question: "SO 有哪些", accessLevel: "operational" });
  await new AgentOrchestrator(state, executor, fakeProvider({ plans }), roleReader).run(run, PRINCIPAL, new AbortController().signal);
  const events = db.store.events.filter((event) => event.runId === run.id);
  return events.at(-1).payload;
}

test("completed 事件的 usage 带 model_steps，一次规划即为 1", async () => {
  const payload = await runOnce([{ toolCalls: [] }]);
  assert.equal(Number.isInteger(payload.usage.model_steps), true, "model_steps 必须是整数");
  assert.equal(payload.usage.model_steps, 1, "只规划一次就回答时应为 1");
});

test("两次规划轮次时 model_steps 为 2", async () => {
  const payload = await runOnce([
    { toolCalls: [{ id: "c1", tool: "order_query", operation: "search_orders", args: { q: "SO" } }] },
    { toolCalls: [] },
  ]);
  assert.equal(payload.usage.model_steps, 2);
  assert.equal(payload.usage.tool_calls, 1);
});