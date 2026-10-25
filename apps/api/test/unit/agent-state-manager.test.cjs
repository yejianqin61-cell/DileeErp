// Agent 状态管理器的单元测试（内存假 Prisma，不连数据库）。
//
// 状态与事件必须同事务、条件更新、终态不可改 —— 这三条是「取消后迟到结果不能写终态」
// 与「断线重放不重执行」的根基（docs/design/business-query-agent-v0-module-design-2026-10-25.md
// 「每个模块的 Interface」State manager 行）。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { randomUUID } = require("node:crypto");
const { AgentStateManager, AgentStateTransitionError } = require("../../dist/modules/business-query-agent/state-manager.js");

const USER_A = "11111111-1111-4111-8111-111111111111";

/** 内存假 Prisma：runs/events/sessions 三张表的 in-memory store + $transaction 顺序执行回调。 */
function fakePrisma({ runs = [], events = [], sessions = [] } = {}) {
  const store = { runs: runs.map((row) => ({ ...row })), events: events.map((row) => ({ ...row })), sessions: [...sessions] };
  const calls = { transaction: 0, updateMany: [], createMany: [], runCreate: 0 };
  const matches = (row, where = {}) => Object.entries(where).every(([key, expected]) => {
    const value = row[key];
    if (expected && typeof expected === "object" && Array.isArray(expected.in)) return expected.in.includes(value);
    if (expected && typeof expected === "object" && expected.gt !== undefined) return value > expected.gt;
    if (expected && typeof expected === "object" && expected.gte !== undefined) return value >= expected.gte;
    return value === expected;
  });
  const db = {
    store, calls,
    agentSession: {
      create: async ({ data }) => { const row = { id: randomUUID(), ...data, createdAt: new Date(), updatedAt: new Date() }; store.sessions.push(row); return row; },
      findMany: async ({ where = {}, orderBy } = {}) => {
        const rows = store.sessions.filter((row) => matches(row, where));
        if (orderBy?.updatedAt === "desc") rows.sort((a, b) => b.updatedAt - a.updatedAt);
        return rows;
      },
    },
    agentRun: {
      create: async ({ data }) => { calls.runCreate += 1; const row = { id: randomUUID(), ...data, createdAt: new Date(), updatedAt: new Date() }; store.runs.push(row); return row; },
      findFirst: async ({ where = {} } = {}) => store.runs.find((row) => matches(row, where)) ?? null,
      findMany: async ({ where = {} } = {}) => store.runs.filter((row) => matches(row, where)),
      updateMany: async ({ where = {}, data }) => {
        calls.updateMany.push({ where, data });
        const matched = store.runs.filter((row) => matches(row, where));
        for (const row of matched) Object.assign(row, data, { updatedAt: new Date() });
        return { count: matched.length };
      },
    },
    agentRunEvent: {
      findMany: async ({ where = {}, orderBy } = {}) => {
        const rows = store.events.filter((row) => matches(row, where));
        if (orderBy?.seq === "desc") rows.sort((a, b) => b.seq - a.seq);
        if (orderBy?.seq === "asc") rows.sort((a, b) => a.seq - b.seq);
        return rows;
      },
      createMany: async ({ data }) => {
        calls.createMany.push({ data });
        for (const row of data) store.events.push({ id: randomUUID(), ...row, createdAt: new Date() });
        return { count: data.length };
      },
    },
    $transaction: async (fn) => { calls.transaction += 1; return fn(db); },
  };
  return db;
}

function activeRun(overrides = {}) {
  return { id: randomUUID(), sessionId: randomUUID(), userId: USER_A, clientMessageId: "cm-1", question: "订单 A 现在什么进度？", answer: null, accessLevel: "operational", state: "planning", errorCode: null, usage: null, createdAt: new Date(), updatedAt: new Date(), ...overrides };
}

test("createRun：建立 planning run 并在同一事务写首个 state 事件（seq=1）", async () => {
  const db = fakePrisma();
  const sessions = new AgentStateManager(db);
  const session = await sessions.createSession(USER_A);

  const run = await sessions.createRun({ sessionId: session.id, userId: USER_A, clientMessageId: "cm-1", question: "订单 A 现在什么进度？", accessLevel: "operational" });

  assert.equal(run.state, "planning");
  assert.equal(db.calls.transaction, 1, "建 run 与首事件必须同事务");
  assert.deepEqual(db.store.events.map((event) => [event.runId === run.id, event.seq, event.type]), [[true, 1, "state"]]);
  assert.deepEqual(db.store.events[0].payload, { state: "planning" });
});

test("transitionAndAppend：planning → responding 自动补 state 事件，事件接在既有 seq 之后", async () => {
  const db = fakePrisma();
  const manager = new AgentStateManager(db);
  const run = await manager.createRun({ sessionId: randomUUID(), userId: USER_A, clientMessageId: "cm-1", question: "q", accessLevel: "operational" });

  const result = await manager.transitionAndAppend(run.id, { from: "planning", to: "responding", events: [{ type: "answer_delta", payload: { text: "这是澄清" } }] });

  assert.equal(result.seq, 3, "state 事件(seq=2)之后是显式事件(seq=3)");
  const saved = db.store.runs.find((row) => row.id === run.id);
  assert.equal(saved.state, "responding");
  const types = db.store.events.filter((event) => event.runId === run.id).map((event) => event.type);
  assert.deepEqual(types, ["state", "state", "answer_delta"], "状态变更自动落 state 事件");
});

test("transitionAndAppend：终态不可离开 —— completed run 再迁移直接抛错且不写事件", async () => {
  const db = fakePrisma({ runs: [activeRun({ state: "completed", answer: "完成" })] });
  const manager = new AgentStateManager(db);
  const run = db.store.runs[0];
  const eventsBefore = db.store.events.length;

  await assert.rejects(
    manager.transitionAndAppend(run.id, { from: "completed", to: "responding", events: [{ type: "answer_delta", payload: { text: "迟到" } }] }),
    AgentStateTransitionError,
  );
  assert.equal(db.store.events.length, eventsBefore, "被拒绝的迁移不得留下任何事件");
});

test("取消后迟到的模型结果不能写终态：cancelled run 上追加 answer_delta 抛错，状态保持 cancelled", async () => {
  const db = fakePrisma({ runs: [activeRun({ state: "querying" })] });
  const manager = new AgentStateManager(db);
  const run = db.store.runs[0];

  await manager.cancel(run.id, USER_A);
  await assert.rejects(
    manager.transitionAndAppend(run.id, { from: "querying", to: "responding", events: [{ type: "answer_delta", payload: { text: "迟到增量" } }] }),
    AgentStateTransitionError,
  );
  assert.equal(db.store.runs[0].state, "cancelled");
});

test("cancel：只取消本人的活动 run；对终态 run 取消是无害的空操作", async () => {
  const db = fakePrisma({ runs: [activeRun({ state: "responding" }), activeRun({ state: "completed" })] });
  const manager = new AgentStateManager(db);
  const [active, done] = db.store.runs;

  const cancelled = await manager.cancel(active.id, USER_A);
  assert.equal(cancelled.state, "cancelled");

  const untouched = await manager.cancel(done.id, USER_A);
  assert.equal(untouched.state, "completed", "对已完成 run 的取消不改变状态");
});

test("cancel：他人（或不存在）的 run 取不到 → 返回 null，不泄露存在性", async () => {
  const db = fakePrisma({ runs: [activeRun({ userId: "22222222-2222-4222-8222-222222222222" })] });
  const manager = new AgentStateManager(db);

  assert.equal(await manager.cancel(db.store.runs[0].id, USER_A), null);
});

test("findRun：以 userId + runId 双条件查询，查不到别人的 run", async () => {
  const db = fakePrisma({ runs: [activeRun()] });
  const manager = new AgentStateManager(db);
  const runId = db.store.runs[0].id;

  assert.equal((await manager.findRun(runId, USER_A)).id, runId);
  assert.equal(await manager.findRun(runId, "22222222-2222-4222-8222-222222222222"), null, "跨用户读取必须落空");
});

test("eventsAfter：只给 seq 之后的按序事件，供断线重放", async () => {
  const db = fakePrisma({ runs: [activeRun()] });
  const manager = new AgentStateManager(db);
  const runId = db.store.runs[0].id;
  // 真实流程里 createRun 已写过 seq=1 的 state 事件；种子行没有，这里补齐再走两次迁移。
  db.store.events.push({ id: randomUUID(), runId, seq: 1, type: "state", payload: { state: "planning" }, createdAt: new Date() });
  await manager.transitionAndAppend(runId, { from: "planning", to: "responding" });
  await manager.transitionAndAppend(runId, { from: "responding", events: [{ type: "answer_delta", payload: { text: "a" } }, { type: "answer_delta", payload: { text: "b" } }] });

  const replayed = await manager.eventsAfter(runId, 2);
  assert.deepEqual(replayed.map((event) => event.seq), [3, 4]);
  assert.deepEqual(replayed.map((event) => event.payload.text), ["a", "b"]);
});

test("failInterrupted：重启时把遗留活动 run 标为 failed/INTERRUPTED 并写终态事件，不碰终态 run", async () => {
  const db = fakePrisma({ runs: [activeRun({ state: "querying" }), activeRun({ state: "completed" })] });
  const manager = new AgentStateManager(db);

  const count = await manager.failInterrupted();
  assert.equal(count, 1);
  const [interrupted, completed] = db.store.runs;
  assert.equal(interrupted.state, "failed");
  assert.equal(interrupted.errorCode, "INTERRUPTED");
  assert.equal(completed.state, "completed", "终态 run 不被动");
  const lastEvent = db.store.events.filter((event) => event.runId === interrupted.id).at(-1);
  assert.equal(lastEvent.type, "error");
});

test("hasActiveRun 与 findRunByIdempotencyKey：并发创建的两个前置检查各归各位", async () => {
  const db = fakePrisma({ runs: [activeRun({ state: "querying" })] });
  const manager = new AgentStateManager(db);

  assert.equal(await manager.hasActiveRun(USER_A), true);
  assert.equal(await manager.hasActiveRun("22222222-2222-4222-8222-222222222222"), false);
  const found = await manager.findRunByIdempotencyKey(db.store.runs[0].sessionId, "cm-1");
  assert.equal(found.id, db.store.runs[0].id);
});
