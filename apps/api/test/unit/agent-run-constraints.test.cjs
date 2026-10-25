// Agent 约束的静态守卫（本机无 PostgreSQL，惯例见 bank-balance-migration.test.cjs）。
//
// T-1 的迁移守卫锁的是「索引存在」；这里锁的是**三边同步**：部分唯一索引 WHERE 里的
// 活动状态清单 ↔ state-manager 导出的 AGENT_ACTIVE_STATES 必须逐字一致 —— 这份清单
// 一旦两边漂移，数据库闸门和应用层检查就会各自为政（模块设计明言"改动必须三边同步"）。
const assert = require("node:assert/strict");
const test = require("node:test");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { AGENT_ACTIVE_STATES, AGENT_TERMINAL_STATES, AGENT_EVENT_TYPES } = require("../../dist/modules/business-query-agent/state-manager.js");

const sql = readFileSync(join(__dirname, "..", "..", "prisma", "migrations", "20261025100000_business_query_agent_tables", "migration.sql"), "utf8");

test("部分唯一索引 WHERE 的活动状态清单与 AGENT_ACTIVE_STATES 逐字一致", () => {
  const match = /WHERE "state" IN \(([^)]*)\)/.exec(sql);
  assert.ok(match, "迁移里必须能找到活动状态清单");
  const inMigration = match[1].split(",").map((item) => item.trim().replaceAll("'", "")).sort();
  assert.deepEqual(inMigration, [...AGENT_ACTIVE_STATES].sort());
  assert.deepEqual([...AGENT_ACTIVE_STATES].sort(), ["planning", "querying", "responding"]);
});

test("终态集合固定为 completed/failed/cancelled，事件类型固定 8 种", () => {
  assert.deepEqual([...AGENT_TERMINAL_STATES].sort(), ["cancelled", "completed", "failed"]);
  assert.deepEqual([...AGENT_EVENT_TYPES].sort(), ["answer_delta", "cancelled", "completed", "error", "source", "state", "tool_status", "usage"].sort());
});

test("activity run 索引只覆盖 agent_runs（不会误伤事件表）", () => {
  assert.match(sql, /CREATE UNIQUE INDEX "agent_runs_user_active_key" ON "agent_runs"/);
  assert.doesNotMatch(sql, /CREATE UNIQUE INDEX "agent_run_events_user_active_key"/);
});
