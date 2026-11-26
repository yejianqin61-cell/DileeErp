const assert = require("node:assert/strict");
const { test } = require("node:test");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { ValidationPipe } = require("@nestjs/common");
const { BusinessQueryAgentController } = require("../../dist/modules/business-query-agent/business-query-agent.controller.js");
const { UpdateSessionDto } = require("../../dist/modules/business-query-agent/business-query-agent.dto.js");
const { AgentStateManager } = require("../../dist/modules/business-query-agent/state-manager.js");
const { createPrisma, principalFor, USER_A } = require("../helpers/agent-fake-prisma.cjs");

const prismaRoot = join(__dirname, "..", "..", "prisma");
const OTHER = "22222222-2222-4222-8222-222222222222";

function harness() {
  const db = createPrisma();
  const state = new AgentStateManager(db);
  const controller = new BusinessQueryAgentController(state, {}, {}, { tryAcquire: () => ({ release() {} }) }, { record() {} });
  const as = (accessLevel = "operational", id = USER_A) => ({ agentPrincipal: { ...principalFor(accessLevel), user: { ...principalFor(accessLevel).user, id } } });
  const addRun = (sessionId, patch = {}) => db.agentRun.create({ data: { sessionId, userId: USER_A, clientMessageId: `cm-${db.store.runs.length}`, question: "问题", accessLevel: "operational", state: "completed", ...patch } });
  return { db, state, controller, as, addRun };
}

const status = (code, errorCode) => (error) => error.getStatus() === code && error.getResponse().code === errorCode;
const validate = (body) => new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }).transform(body, { type: "body", metatype: UpdateSessionDto });

test("迁移给会话表加两个可空列，不建表不建外键", () => {
  const sql = readFileSync(join(prismaRoot, "migrations", "20261126090000_agent_session_title", "migration.sql"), "utf8");
  assert.match(sql, /ALTER TABLE "agent_sessions"/);
  assert.match(sql, /ADD COLUMN\s+"title" VARCHAR\(100\)(,|;)/);
  assert.match(sql, /ADD COLUMN\s+"deleted_at" TIMESTAMP\(3\)(,|;)/);
  assert.doesNotMatch(sql, /NOT NULL|CREATE TABLE|FOREIGN KEY/);
});

test("本人改名：去首尾空白，不改更新时间", async () => {
  const { db, state, controller, as } = harness();
  const session = await state.createSession(USER_A);
  const before = db.store.sessions[0].updatedAt;
  const result = await controller.renameSession(session.id, await validate({ title: "  十月订单  " }), as());
  assert.deepEqual(result.data, { session_id: session.id, title: "十月订单" });
  assert.equal(db.store.sessions[0].title, "十月订单");
  assert.equal(db.store.sessions[0].updatedAt, before);
});

test("空白标题与超过 100 字被校验拒绝", async () => {
  await assert.rejects(validate({ title: "   " }));
  await assert.rejects(validate({ title: "长".repeat(101) }));
  await assert.rejects(validate({}));
  assert.equal((await validate({ title: "长".repeat(100) })).title.length, 100);
});

test("他人改名与删除都是 404，库里不变", async () => {
  const { db, state, controller, as } = harness();
  const session = await state.createSession(USER_A);
  await assert.rejects(controller.renameSession(session.id, { title: "抢改" }, as("full", OTHER)), status(404, "AGENT_SESSION_NOT_FOUND"));
  await assert.rejects(controller.deleteSession(session.id, as("full", OTHER)), status(404, "AGENT_SESSION_NOT_FOUND"));
  assert.equal(db.store.sessions[0].title, null);
  assert.equal(db.store.sessions[0].deletedAt, null);
});

test("删除后列表没有它，快照、提问、再删都是 404", async () => {
  const { db, state, controller, as } = harness();
  const session = await state.createSession(USER_A);
  const result = await controller.deleteSession(session.id, as());
  assert.deepEqual(result.data, { session_id: session.id });
  assert.ok(db.store.sessions[0].deletedAt instanceof Date);
  assert.deepEqual((await controller.listSessions(as())).data.sessions, []);
  const gone = status(404, "AGENT_SESSION_NOT_FOUND");
  await assert.rejects(controller.sessionSnapshot(session.id, as()), gone);
  await assert.rejects(controller.createRun(session.id, { question: "还在吗", client_message_id: OTHER }, as(), { setHeader() {} }), gone);
  await assert.rejects(controller.deleteSession(session.id, as()), gone);
});

test("有活动轮次时删除返回 409", async () => {
  const { db, state, controller, as, addRun } = harness();
  const session = await state.createSession(USER_A);
  await addRun(session.id, { state: "responding" });
  await assert.rejects(controller.deleteSession(session.id, as()), status(409, "RUN_IN_PROGRESS"));
  assert.equal(db.store.sessions[0].deletedAt, null);
});

test("普通档位看不到含财务轮次会话的自定义标题", async () => {
  const { state, controller, as, addRun } = harness();
  const finance = await state.createSession(USER_A);
  const plain = await state.createSession(USER_A);
  await addRun(finance.id, { accessLevel: "full" });
  await addRun(plain.id);
  await controller.renameSession(finance.id, { title: "应付款" }, as("full"));
  await controller.renameSession(plain.id, { title: "订单" }, as("full"));
  const titles = async (level) => Object.fromEntries((await controller.listSessions(as(level))).data.sessions.map((item) => [item.session_id, item.title]));
  assert.deepEqual(await titles("full"), { [finance.id]: "应付款", [plain.id]: "订单" });
  assert.deepEqual(await titles("operational"), { [finance.id]: null, [plain.id]: "订单" });
});
