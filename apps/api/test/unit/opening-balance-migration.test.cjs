// 建账期初余额迁移的守护（源码文本 + schema 一致性检查，不连数据库）。
//
// 2026-09-24（用户「1,3,4 都要」的第 ③ 件）：银行账户档案只有货币资金的期初余额，
// 其它科目没有 —— 只把货币资金期初加进资产侧，资产负债表的勾稽永远差一个期初余额。
// 这张表让财务录一次全科目期初，勾稽才真正为 0。
//
// 四条不变量（改坏了都是「报表悄悄错」）：
//   1) 科目键与凭证同一套（`subject_key`，`分类/名称`）—— 否则期初与凭证余额没法直接相加；
//   2) (as_of_date, subject_key, currency) 唯一，且**软删除后仍占位**（与月度管理费分摊同一处理）——
//      「整批替换」靠它做 upsert（含恢复软删行），否则同一科目会有两条期初、报表不知用哪条；
//   3) 只新增表，不改写任何历史数据、不删任何列或表；
//   4) schema.prisma 必须与迁移一致（表名、字段、唯一索引），否则客户端类型与库对不上。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { readdirSync, readFileSync, statSync } = require("node:fs");
const { join } = require("node:path");

const migrationsRoot = join(__dirname, "..", "..", "prisma", "migrations");
const folder = "20260924130000_accounting_opening_balances";
const sql = readFileSync(join(migrationsRoot, folder, "migration.sql"), "utf8");
const schema = readFileSync(join(__dirname, "..", "..", "prisma", "schema.prisma"), "utf8");

test("期初余额迁移存在、目录名带 14 位时间戳、且排在既有迁移之后", () => {
  const folders = readdirSync(migrationsRoot).filter((name) => statSync(join(migrationsRoot, name)).isDirectory()).sort();
  assert.ok(folders.includes(folder), "期初余额迁移必须存在");
  assert.match(folder.slice(0, 14), /^\d{14}$/);
  assert.ok(folder.slice(0, 14) > "20260924100000", "必须晚于手工凭证迁移，保证升级顺序确定");
});

test("迁移建一张表、三元组唯一索引与查询索引，且不改写历史数据", () => {
  assert.match(sql, /CREATE TABLE "accounting_opening_balances" \(/);
  assert.match(sql, /CREATE UNIQUE INDEX "accounting_opening_balances_as_of_date_subject_key_currency_key" ON "accounting_opening_balances"\("as_of_date", "subject_key", "currency"\);/);
  assert.match(sql, /CREATE INDEX "accounting_opening_balances_as_of_date_currency_idx" ON "accounting_opening_balances"\("as_of_date", "currency"\);/);
  assert.equal(/^\s*(UPDATE|DELETE|INSERT)\b/m.test(sql), false, "迁移不得改写历史数据（宪法：保留历史事实）");
  assert.equal(/DROP COLUMN|DROP TABLE|DROP INDEX/.test(sql), false, "迁移不得删除任何列、表或索引");
});

test("金额存「方向 + 正数金额」：direction 与 amount 都是必填列，没有负数约定", () => {
  assert.match(sql, /"direction" VARCHAR\(10\) NOT NULL/);
  assert.match(sql, /"amount" DECIMAL\(18,4\) NOT NULL/);
  assert.match(sql, /"subject_key" VARCHAR\(200\) NOT NULL/);
  assert.match(sql, /"subject_label" VARCHAR\(200\) NOT NULL/, "科目名要快照：科目改名后历史期初仍显示当时的名字");
  assert.match(sql, /"currency" VARCHAR\(10\) NOT NULL/, "不跨币种：期初必须带币种");
});

test("schema.prisma 与迁移一致（表名、字段、唯一键、软删除列）", () => {
  const block = /model AccountingOpeningBalance \{[\s\S]*?\n\}/.exec(schema);
  assert.ok(block, "schema 必须存在 model AccountingOpeningBalance");
  assert.match(block[0], /@@map\("accounting_opening_balances"\)/);
  assert.match(block[0], /@@unique\(\[asOfDate, subjectKey, currency\]\)/);
  assert.match(block[0], /asOfDate\s+DateTime\s+@map\("as_of_date"\) @db\.Date/, "建账日期是 DATE（不是时间戳）");
  assert.match(block[0], /deletedAt\s+DateTime\?\s+@map\("deleted_at"\)/, "软删除列必须在");
  assert.match(block[0], /deletedBy\s+String\?\s+@map\("deleted_by"\) @db\.Uuid/);
});
