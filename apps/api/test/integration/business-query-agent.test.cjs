// 业务查询 Agent 的数据库层证据（集成测试，需要 TEST_DATABASE_URL；`npm run test:integration`）。
//
// 证明三件事（docs/design/business-query-agent-v0-development-plan-2026-10-25.md 阶段 1 证据）：
//   1. 活动 run 部分唯一索引真实生效 —— 应用层先查是先行拦截，竞态的最后一道闸门在数据库；
//   2. 幂等键与事件序号的唯一约束真实生效；
//   3. 只读账号**写不进**业务表（R-1 只读证明的最小版本）。
// 运行前提：测试库已 `prisma migrate deploy`（scripts/prepare-test-database.mjs）。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { randomUUID } = require("node:crypto");
const { PrismaClient } = require("@prisma/client");
const { cleanup, requireTestDatabaseUrl, testRun } = require("../../../../tests/helpers/test-context.cjs");

const TEST_DATABASE_URL = requireTestDatabaseUrl();
const prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
const context = testRun("bqagent");
const USER_ID = randomUUID();

test("agent_runs 的部分唯一索引：同一用户在活动状态下只能有一行，终态后可以再建", async () => {
  const sessionId = randomUUID();
  await prisma.$executeRawUnsafe(`INSERT INTO agent_sessions (id, user_id, updated_at) VALUES ($1::uuid, $2::uuid, now())`, sessionId, USER_ID);
  const first = randomUUID();
  await prisma.$executeRawUnsafe(
    `INSERT INTO agent_runs (id, session_id, user_id, client_message_id, question, access_level, state, updated_at) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, 'operational', 'planning', now())`,
    first, sessionId, USER_ID, `${context.prefix}-cm-1`, "q1",
  );
  // 同用户第二个活动 run：撞部分唯一索引（这正是并发创建竞态时的数据库裁决）。
  await assert.rejects(
    prisma.$executeRawUnsafe(
      `INSERT INTO agent_runs (id, session_id, user_id, client_message_id, question, access_level, state, updated_at) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, 'operational', 'querying', now())`,
      randomUUID(), randomUUID(), USER_ID, `${context.prefix}-cm-2`, "q2",
    ),
    (error) => /Key \(user_id\)/.test(String(error?.message ?? error)),
  );
  // 第一个 run 落终态后，新活动 run 立即可建 —— "可新开 run" 的路径不受影响。
  await prisma.$executeRawUnsafe(`UPDATE agent_runs SET state = 'completed', updated_at = now() WHERE id = $1::uuid`, first);
  await prisma.$executeRawUnsafe(
    `INSERT INTO agent_runs (id, session_id, user_id, client_message_id, question, access_level, state, updated_at) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, 'operational', 'responding', now())`,
    randomUUID(), sessionId, USER_ID, `${context.prefix}-cm-3`, "q3",
  );
});

test("幂等键与事件序号的唯一约束真实生效", async () => {
  // 独立用户：部分唯一索引按 user_id 生效，本用例不能受其他用例遗留活动 run 的影响。
  const ownerId = randomUUID();
  const sessionId = randomUUID();
  const runId = randomUUID();
  await prisma.$executeRawUnsafe(`INSERT INTO agent_sessions (id, user_id, updated_at) VALUES ($1::uuid, $2::uuid, now())`, sessionId, ownerId);
  await prisma.$executeRawUnsafe(
    `INSERT INTO agent_runs (id, session_id, user_id, client_message_id, question, access_level, state, updated_at) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, 'operational', 'completed', now())`,
    runId, sessionId, ownerId, `${context.prefix}-cm-idem`, "q",
  );
  await prisma.$executeRawUnsafe(`INSERT INTO agent_run_events (id, run_id, seq, type, payload) VALUES ($1::uuid, $2::uuid, 1, 'state', $3::jsonb)`, randomUUID(), runId, JSON.stringify({ state: "planning" }));
  // 同 run 重复 seq：SSE 重放依据，必须撞 (run_id, seq) 唯一。
  await assert.rejects(
    prisma.$executeRawUnsafe(`INSERT INTO agent_run_events (id, run_id, seq, type, payload) VALUES ($1::uuid, $2::uuid, 1, 'state', $3::jsonb)`, randomUUID(), runId, JSON.stringify({ state: "planning" })),
    (error) => /Key \(run_id, seq\)/.test(String(error?.message ?? error)),
  );
  // 同会话重复幂等键：客户端重试网络超时的场景，必须撞 (session_id, client_message_id) 唯一。
  await assert.rejects(
    prisma.$executeRawUnsafe(
      `INSERT INTO agent_runs (id, session_id, user_id, client_message_id, question, access_level, state, updated_at) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, 'operational', 'planning', now())`,
      randomUUID(), sessionId, ownerId, `${context.prefix}-cm-idem`, "q",
    ),
    (error) => /Key \(session_id, client_message_id\)/.test(String(error?.message ?? error)),
  );
});

test("只读账号对业务表与 agent 表都写不进（R-1 的数据库层证明）", async (t) => {
  // 角色名是 SQL 标识符：testRun 前缀带连字符，必须换掉并加引号。
  const roleName = `"${context.prefix.replaceAll("-", "_")}_read_only"`;
  let readClient;
  try {
    await prisma.$executeRawUnsafe(`DROP ROLE IF EXISTS ${roleName}`);
    await prisma.$executeRawUnsafe(`CREATE ROLE ${roleName} LOGIN PASSWORD 'read-only-123'`);
    await prisma.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO ${roleName}`);
    await prisma.$executeRawUnsafe(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${roleName}`);
  } catch (error) {
    t.skip(`测试库账号没有建角色的权限，只读证明无法在本环境执行：${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  try {
    const url = new URL(TEST_DATABASE_URL);
    url.username = context.prefix.replaceAll("-", "_") + "_read_only";
    url.password = "read-only-123";
    readClient = new PrismaClient({ datasources: { db: { url: url.toString() } } });
    // SELECT 应当成功（只读账号能完成全部查询职责）。
    const orders = await readClient.salesOrder.findMany({ take: 1, select: { id: true } });
    assert.ok(Array.isArray(orders));
    // 对业务表与 agent 自有表的任何写都应当被数据库拒绝。
    await assert.rejects(readClient.salesOrder.updateMany({ where: { id: randomUUID() }, data: { status: "hacked" } }), (error) => /permission denied|InsufficientPrivilege/i.test(String(error?.message ?? error) + String(error?.code ?? "")));
    await assert.rejects(readClient.$executeRawUnsafe(`INSERT INTO agent_sessions (id, user_id, updated_at) VALUES ($1::uuid, $2::uuid, now())`, randomUUID(), USER_ID), (error) => /permission denied|InsufficientPrivilege/i.test(String(error?.message ?? error) + String(error?.code ?? "")));
  } finally {
    await readClient?.$disconnect();
    await prisma.$executeRawUnsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = $1 AND pid <> pg_backend_pid()`,
      context.prefix.replaceAll("-", "_") + "_read_only",
    ).catch(() => {});
    await prisma.$executeRawUnsafe(`DROP ROLE IF EXISTS ${roleName}`).catch(() => {});
  }
});

test.after(async () => {
  await cleanup(async () => {
    // schema 不建外键/关联，嵌套过滤用不了：按 user_id 两步删。
    await prisma.$executeRawUnsafe(`DELETE FROM agent_run_events WHERE run_id IN (SELECT id FROM agent_runs WHERE user_id = $1::uuid)`, USER_ID);
    await prisma.$executeRawUnsafe(`DELETE FROM agent_runs WHERE user_id = $1::uuid`, USER_ID);
    await prisma.$executeRawUnsafe(`DELETE FROM agent_sessions WHERE user_id = $1::uuid`, USER_ID);
  }, context).finally(async () => {
    await prisma.$disconnect();
  });
});
