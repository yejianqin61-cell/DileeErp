const assert = require("node:assert/strict");
const { test } = require("node:test");
const { ValidationPipe } = require("@nestjs/common");
const { BusinessQueryAgentController } = require("../../dist/modules/business-query-agent/business-query-agent.controller.js");
const { CreateRunDto } = require("../../dist/modules/business-query-agent/business-query-agent.dto.js");
const { AgentContextManager } = require("../../dist/modules/business-query-agent/context-manager.js");
const { AgentOrchestrator } = require("../../dist/modules/business-query-agent/agent-orchestrator.js");
const { AgentStateManager } = require("../../dist/modules/business-query-agent/state-manager.js");
const { createPrisma, principalFor, roleReaderFor, scriptedProvider, USER_A } = require("../helpers/agent-fake-prisma.cjs");

const OTHER_ID = "33333333-3333-4333-8333-333333333333";

async function harness() {
  const db = createPrisma();
  const state = new AgentStateManager(db);
  const session = await state.createSession(USER_A);
  let tick = 0;
  const addRun = async (name, patch = {}) => {
    const run = await db.agentRun.create({ data: { sessionId: session.id, userId: USER_A, clientMessageId: `seed-${name}`, question: `问${name}`, answer: `答${name}`, accessLevel: "operational", state: "completed", ...patch } });
    run.createdAt = new Date(Date.UTC(2026, 10, 26, 0, 0, (tick += 1)));
    return run;
  };
  const a = await addRun("甲");
  const b = await addRun("乙");
  const c = await addRun("丙");
  return { db, state, session, addRun, a, b, c };
}

const questions = (messages) => messages.filter((message) => message.role === "user").map((message) => message.content);

test("不传轮次号时带全部已完成历史", async () => {
  const { state, session } = await harness();
  const history = await new AgentContextManager(state).history(USER_A, session.id, "operational");
  assert.deepEqual(history.map((message) => message.content), ["问甲", "答甲", "问乙", "答乙", "问丙", "答丙"]);
});

test("只带指定轮次并按时间排序；空数组不带历史", async () => {
  const { state, session, a, c } = await harness();
  const context = new AgentContextManager(state);
  assert.deepEqual(questions(await context.history(USER_A, session.id, "operational", [c.id, a.id])), ["问甲", "问丙"]);
  assert.deepEqual(await context.history(USER_A, session.id, "operational", []), []);
});

test("指定的财务轮次与未完成轮次对普通档位仍被过滤", async () => {
  const { state, session, addRun, a } = await harness();
  const finance = await addRun("财", { accessLevel: "full" });
  const pending = await addRun("未", { state: "failed" });
  const history = await new AgentContextManager(state).history(USER_A, session.id, "operational", [a.id, finance.id, pending.id]);
  assert.deepEqual(questions(history), ["问甲"]);
});

test("指定超过八轮时取最后八轮", async () => {
  const { state, session, addRun, a, b, c } = await harness();
  const ids = [a.id, b.id, c.id];
  for (let index = 4; index <= 10; index += 1) ids.push((await addRun(String(index))).id);
  const history = await new AgentContextManager(state).history(USER_A, session.id, "operational", ids);
  assert.deepEqual(questions(history), ["问丙", "问4", "问5", "问6", "问7", "问8", "问9", "问10"]);
});

test("请求体接受 UUID 数组，拒绝非 UUID 与超过 200 项", async () => {
  const validate = (extra) => new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }).transform({ question: "问", client_message_id: OTHER_ID, ...extra }, { type: "body", metatype: CreateRunDto });
  assert.deepEqual((await validate({ context_run_ids: [OTHER_ID] })).context_run_ids, [OTHER_ID]);
  assert.equal((await validate({})).context_run_ids, undefined);
  await assert.rejects(validate({ context_run_ids: ["甲"] }));
  await assert.rejects(validate({ context_run_ids: OTHER_ID }));
  await assert.rejects(validate({ context_run_ids: Array.from({ length: 201 }, () => OTHER_ID) }));
});

function controllerFor(state, orchestrator, gate) {
  return new BusinessQueryAgentController(state, orchestrator, {}, gate, { record() {} });
}

const request = { agentPrincipal: principalFor("operational") };

test("别的会话的轮次号返回 400，不建轮次、不占许可", async () => {
  const { db, state, session } = await harness();
  const elsewhere = await state.createSession(USER_A);
  const foreign = await db.agentRun.create({ data: { sessionId: elsewhere.id, userId: USER_A, clientMessageId: "x", question: "别处", accessLevel: "operational", state: "completed" } });
  let acquired = 0;
  const gate = { tryAcquire: () => { acquired += 1; return { release() {} }; } };
  const orchestrator = { run: async () => undefined };
  const controller = controllerFor(state, orchestrator, gate);
  const before = db.store.runs.length;
  await assert.rejects(controller.createRun(session.id, { question: "追问", client_message_id: OTHER_ID, context_run_ids: [foreign.id] }, request, { setHeader() {} }), (error) => error.getStatus() === 400 && error.getResponse().code === "AGENT_CONTEXT_INVALID");
  assert.equal(db.store.runs.length, before);
  assert.equal(acquired, 0);
  await controller.createRun(session.id, { question: "追问", client_message_id: OTHER_ID }, request, { setHeader() {} });
  assert.equal(db.store.runs.length, before + 1);
});

test("模型只收到指定历史，轮次与事件里不存这份数组", async () => {
  const { db, state, session, a, b } = await harness();
  const provider = scriptedProvider([() => []]);
  const orchestrator = new AgentOrchestrator(state, { async execute() { throw new Error("不应触达执行器"); } }, provider, roleReaderFor("operational"), new AgentContextManager(state));
  let finished;
  const wrapped = { run: (...args) => (finished = orchestrator.run(...args)) };
  const controller = controllerFor(state, wrapped, { tryAcquire: () => ({ release() {} }) });
  const created = await controller.createRun(session.id, { question: "追问", client_message_id: OTHER_ID, context_run_ids: [a.id] }, request, { setHeader() {} });
  await finished;
  assert.deepEqual(questions(provider.captured[0].messages), ["问甲", "追问"]);
  const saved = db.store.runs.find((run) => run.id === created.data.run_id);
  const stored = JSON.stringify([saved, db.store.events.filter((event) => event.runId === saved.id)]);
  assert.equal(stored.includes(a.id), false);
  assert.equal(stored.includes(b.id), false);
});
