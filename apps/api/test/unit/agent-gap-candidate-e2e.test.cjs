const assert = require("node:assert/strict");
const { test } = require("node:test");
const { AgentOrchestrator } = require("../../dist/modules/business-query-agent/agent-orchestrator.js");
const { AgentStateManager } = require("../../dist/modules/business-query-agent/state-manager.js");
const { GapCandidateService } = require("../../dist/modules/business-query-agent/gap-candidates.js");
const { createPrisma, principalFor, roleReaderFor, scriptedProvider, USER_A } = require("../helpers/agent-fake-prisma.cjs");

const QUESTIONS = ["各仓库库存多少", "分仓库看库存", "按仓库汇总原料"];

function harness() {
  const db = createPrisma();
  const state = new AgentStateManager(db);
  const builder = { tickets: [], async build(ticket) { this.tickets.push(ticket); return { dispatched: false }; } };
  const gapCandidates = new GapCandidateService(db, builder);
  let message = 0;
  async function ask(sessionId, question, missing = "group_by") {
    const run = await state.createRun({ sessionId, userId: USER_A, clientMessageId: `cm-${++message}`, question, accessLevel: "operational" });
    const provider = scriptedProvider([() => [{ id: `g${message}`, tool: "report_gap", operation: "declare_gap", args: { nearest_operation: "list_low_stock_materials", missing, missing_detail: "按仓库分组" } }]]);
    const executor = { async execute() { throw new Error("不应触达执行器"); } };
    await new AgentOrchestrator(state, executor, provider, roleReaderFor("operational"), undefined, { gapCandidates }).run(run, principalFor("operational"), new AbortController().signal);
    assert.equal(db.store.runs.find((row) => row.id === run.id).state, "completed");
  }
  const session = async () => (await state.createSession(USER_A)).id;
  return { db, builder, ask, session };
}

test("三个会话问同一缺口：一条候选，第三轮后建单一次，工单不含原话", async () => {
  const { db, builder, ask, session } = harness();
  for (const [index, question] of QUESTIONS.entries()) {
    assert.equal(builder.tickets.length, 0, `第 ${index + 1} 轮之前不应建单`);
    await ask(await session(), question);
  }
  assert.equal(db.store.gapCandidates.length, 1);
  assert.equal(db.store.gapReports.length, 3);
  assert.equal(builder.tickets.length, 1);
  const body = JSON.stringify(builder.tickets[0]);
  for (const question of QUESTIONS) assert.equal(body.includes(question), false, question);
});

test("同一会话连续三轮不建单", async () => {
  const { db, builder, ask, session } = harness();
  const id = await session();
  for (const question of QUESTIONS) await ask(id, question);
  assert.equal(db.store.gapCandidates.length, 1);
  assert.equal(db.store.gapReports.length, 3);
  assert.equal(builder.tickets.length, 0);
});

test("三个会话里差异类型分成两种：两条候选，都不到门槛", async () => {
  const { db, builder, ask, session } = harness();
  await ask(await session(), QUESTIONS[0]);
  await ask(await session(), QUESTIONS[1]);
  await ask(await session(), QUESTIONS[2], "filter");
  assert.equal(db.store.gapCandidates.length, 2);
  assert.equal(builder.tickets.length, 0);
});
