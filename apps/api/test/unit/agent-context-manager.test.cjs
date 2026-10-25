// 八轮上下文管理器的单元测试（真状态管理器 + 内存假 Prisma）。
//
// R-6 的三条：最近 8 个已完成轮次、当前档位读不到的旧 full 轮次不进入、
// 不带旧工具原始结果（只有 question/answer 对）。输入 token **不设**应用层配额 ——
// 这里没有也不该有 token 裁剪逻辑。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { randomUUID } = require("node:crypto");
const { AgentContextManager } = require("../../dist/modules/business-query-agent/context-manager.js");
const { AgentStateManager } = require("../../dist/modules/business-query-agent/state-manager.js");

const USER_A = "11111111-1111-4111-8111-111111111111";

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

async function seedCompletedRun(db, state, { question, answer, accessLevel = "operational", userId = USER_A }) {
  const session = db.store.sessions[0]?.id ?? (await state.createSession(userId)).id;
  const run = await state.createRun({ sessionId: session, userId, clientMessageId: randomUUID(), question, accessLevel });
  await state.transitionAndAppend(run.id, { from: "planning", to: "responding" });
  await state.transitionAndAppend(run.id, { from: "responding", events: [{ type: "answer_delta", payload: { text: answer } }] });
  await state.transitionAndAppend(run.id, { from: "responding", to: "completed", answer });
  return run;
}

test("history：9 个完成轮次只带最近 8 个，第 1 轮不再进入上下文", async () => {
  const db = createPrisma();
  const state = new AgentStateManager(db);
  const manager = new AgentContextManager(state);
  const sessionId = (await state.createSession(USER_A)).id;
  db.store.sessions[0].id = sessionId;
  for (let index = 1; index <= 9; index += 1) {
    await seedCompletedRun(db, state, { question: `第${index}轮问题`, answer: `第${index}轮答案` });
  }

  const history = await manager.history(USER_A, sessionId, "operational");
  const questions = history.filter((message) => message.role === "user").map((message) => message.content);
  assert.equal(questions.length, 8);
  assert.ok(!questions.includes("第1轮问题"), "第 9 轮开始不再携带第 1 轮");
  assert.equal(questions[0], "第2轮问题");
  assert.equal(questions.at(-1), "第9轮问题");
});

test("history：当前 operational 视角过滤掉旧 full 轮次", async () => {
  const db = createPrisma();
  const state = new AgentStateManager(db);
  const manager = new AgentContextManager(state);
  const sessionId = (await state.createSession(USER_A)).id;
  await seedCompletedRun(db, state, { question: "财务问题", answer: "财务答案", accessLevel: "full" });
  await seedCompletedRun(db, state, { question: "进度问题", answer: "进度答案" });

  const operational = await manager.history(USER_A, sessionId, "operational");
  assert.ok(!JSON.stringify(operational).includes("财务问题"), "降权后旧 full 轮次不得进入上下文");
  assert.equal(operational.filter((message) => message.role === "user").length, 1);

  const full = await manager.history(USER_A, sessionId, "full");
  assert.equal(full.filter((message) => message.role === "user").length, 2, "full 视角两轮都在");
});

test("history：只有 user/assistant 问答对，不带 tool 原始结果；未完成轮次不进入", async () => {
  const db = createPrisma();
  const state = new AgentStateManager(db);
  const manager = new AgentContextManager(state);
  const sessionId = (await state.createSession(USER_A)).id;
  await seedCompletedRun(db, state, { question: "已完成", answer: "答案甲" });
  // 一个还在 responding 的活动 run
  await state.createRun({ sessionId, userId: USER_A, clientMessageId: randomUUID(), question: "进行中", accessLevel: "operational" });

  const history = await manager.history(USER_A, sessionId, "operational");
  assert.deepEqual(history.map((message) => message.role), ["user", "assistant"]);
  assert.ok(!JSON.stringify(history).includes("进行中"), "活动 run 不进入历史");
  assert.ok(!history.some((message) => message.role === "tool"), "上下文不携带工具原始结果");
});
