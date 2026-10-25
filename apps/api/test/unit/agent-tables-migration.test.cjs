// Agent 自有三张表迁移的静态守卫（不连数据库，本机没有可用 PostgreSQL —— 惯例见 bank-balance-migration.test.cjs）。
//
// 为什么需要它：`agent_runs` 的「单用户单活动 run」是**部分**唯一索引（Prisma schema 表达不了），
// 应用层的先查只是先行拦截，竞态的最后一道闸门在数据库。索引一旦漏建，两个并发 run 就能并存，
// 而单测的内存假对象看不到这件事 —— 所以在这里逐字断言迁移 SQL 原文。
//
// 依据：docs/design/business-query-agent-v0-module-design-2026-10-25.md「API 权限与数据表」。
const assert = require("node:assert/strict");
const test = require("node:test");
const { readdirSync, readFileSync, statSync } = require("node:fs");
const { join } = require("node:path");
const { liveUniqueGuards } = require("../helpers/migration-guards.cjs");

const migrationsRoot = join(__dirname, "..", "..", "prisma", "migrations");
const folder = "20261025100000_business_query_agent_tables";
const sql = readFileSync(join(migrationsRoot, folder, "migration.sql"), "utf8");
const schema = readFileSync(join(migrationsRoot, "..", "schema.prisma"), "utf8");

test("agent 表迁移按时间戳排在所有现有迁移之后（Prisma 按目录名顺序执行）", () => {
  const folders = readdirSync(migrationsRoot).filter((name) => statSync(join(migrationsRoot, name)).isDirectory()).sort();
  const index = folders.indexOf(folder);
  assert.ok(index >= 0, `迁移目录 ${folder} 必须存在`);
  assert.equal(index, folders.length - 1, "agent 表迁移必须排在最后，避免插队");
  for (const name of folders) assert.match(name.slice(0, 14), /^\d{14}$/, `迁移目录 ${name} 必须以 14 位时间戳开头`);
});

test("agent_runs 的活动 run 部分唯一索引：同一用户在活动状态下全库只能有一行", () => {
  assert.match(
    sql,
    /CREATE UNIQUE INDEX "agent_runs_user_active_key" ON "agent_runs"\("user_id"\)\s*WHERE "state" IN \('planning', 'querying', 'responding'\)/,
    "部分唯一索引是单用户单活动 run 的最后闸门，必须落在迁移里",
  );
});

test("幂等键与事件序号的唯一约束齐全，命名与 Prisma 约定一致（避免 schema 与库漂移）", () => {
  assert.match(sql, /CREATE UNIQUE INDEX "agent_runs_session_id_client_message_id_key" ON "agent_runs"\("session_id", "client_message_id"\)/);
  assert.match(sql, /CREATE UNIQUE INDEX "agent_run_events_run_id_seq_key" ON "agent_run_events"\("run_id", "seq"\)/);
  const guards = liveUniqueGuards(sql).filter((guard) => guard.table.startsWith("agent_"));
  assert.deepEqual(
    guards.map((guard) => `${guard.table}:${guard.name}:${guard.columns.join("+")}`).sort(),
    [
      "agent_run_events:agent_run_events_run_id_seq_key:runId+seq".replace("runId+seq", "run_id+seq"),
      "agent_runs:agent_runs_session_id_client_message_id_key:session_id+client_message_id",
      "agent_runs:agent_runs_user_active_key:user_id",
    ].sort(),
  );
});

test("schema.prisma 的三个 model 与迁移列一致（手写迁移不走 prisma migrate dev，漂移不会被工具报出）", () => {
  for (const table of ["agent_sessions", "agent_runs", "agent_run_events"]) {
    assert.match(schema, new RegExp(`@@map\\("${table}"\\)`), `schema 必须有 ${table}`);
  }
  for (const column of ["client_message_id", "access_level", "error_code", "question", "answer", "usage"]) {
    assert.match(sql, new RegExp(`"${column}"`), `agent_runs 必须有 ${column} 列`);
  }
  assert.match(schema, /clientMessageId\s+String\s+@map\("client_message_id"\)/);
  assert.match(schema, /accessLevel\s+String\s+@map\("access_level"\)/);
});

test("agent 表不与业务表建外键（业务表对 Agent 只读，user_id 只是逻辑引用）", () => {
  assert.doesNotMatch(sql, /FOREIGN KEY/, "agent_* 迁移不得创建任何外键");
});
