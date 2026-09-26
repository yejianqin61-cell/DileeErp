// 期末汇率迁移的守护（源码文本 + schema 一致性检查，不连数据库）。
//
// 2026-09-24（用户「1,3,4 都要」的第 ④ 件）：凭证上有 currency 却没有汇率，三大报表是人民币报表。
// 这张表让财务每月维护一次汇率，报表取数时把外币分录**逐行**折成人民币。
//
// 四条不变量（改坏了都是「报表悄悄错」，或者更糟：悄悄少钱）：
//   1) 汇率精度 DECIMAL(18,8) 高于金额（1e-4）：汇率是乘数，精度不够时逐行折算的累计偏差
//      会被当成「汇率变动影响」，变成一个谁也解释不了的数；
//   2) (period, currency) 唯一且**软删除后仍占位**（与期初余额 / 月度分摊同一处理）——
//      「整批替换」靠它做 upsert（含恢复软删行），否则同一期间同一币种会有两条汇率；
//   3) 只新增表，不改写任何历史数据、不删任何列或表；
//   4) schema.prisma 必须与迁移一致（表名、字段、唯一索引），否则客户端类型与库对不上。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { readdirSync, readFileSync, statSync } = require("node:fs");
const { join } = require("node:path");

const migrationsRoot = join(__dirname, "..", "..", "prisma", "migrations");
const folder = "20260924160000_exchange_rates";
const sql = readFileSync(join(migrationsRoot, folder, "migration.sql"), "utf8");
const schema = readFileSync(join(__dirname, "..", "..", "prisma", "schema.prisma"), "utf8");

test("期末汇率迁移存在、目录名带 14 位时间戳、且排在既有迁移之后", () => {
  const folders = readdirSync(migrationsRoot).filter((name) => statSync(join(migrationsRoot, name)).isDirectory()).sort();
  assert.ok(folders.includes(folder), "期末汇率迁移必须存在");
  assert.match(folder.slice(0, 14), /^\d{14}$/);
  assert.ok(folder.slice(0, 14) > "20260924130000", "必须晚于期初余额迁移，保证升级顺序确定");
});

test("迁移建一张表、二元组唯一索引与查询索引，且不改写历史数据", () => {
  assert.match(sql, /CREATE TABLE "exchange_rates" \(/);
  assert.match(sql, /CREATE UNIQUE INDEX "exchange_rates_period_currency_key" ON "exchange_rates"\("period", "currency"\);/);
  assert.match(sql, /CREATE INDEX "exchange_rates_currency_period_idx" ON "exchange_rates"\("currency", "period"\);/);
  assert.equal(/^\s*(UPDATE|DELETE|INSERT)\b/m.test(sql), false, "迁移不得改写历史数据（宪法：保留历史事实）");
  assert.equal(/DROP COLUMN|DROP TABLE|DROP INDEX/.test(sql), false, "迁移不得删除任何列、表或索引");
});

test("汇率存「期间 + 币种 + 1 外币 = rate 人民币」：精度 18,8 是刻意的", () => {
  assert.match(sql, /"period" VARCHAR\(7\) NOT NULL/, "期间是 YYYY-MM（财务维护的是「9 月的汇率」）");
  assert.match(sql, /"currency" VARCHAR\(10\) NOT NULL/);
  assert.match(sql, /"rate" DECIMAL\(18,8\) NOT NULL/, "汇率精度必须比金额（18,4）高");
  assert.match(sql, /"remark" VARCHAR\(1000\)/, "汇率来源要能记一笔（谁给的、哪个网站）");
});

test("schema.prisma 与迁移一致（表名、字段、唯一键、软删除列）", () => {
  const block = /model ExchangeRate \{[\s\S]*?\n\}/.exec(schema);
  assert.ok(block, "schema 必须存在 model ExchangeRate");
  assert.match(block[0], /@@map\("exchange_rates"\)/);
  assert.match(block[0], /@@unique\(\[period, currency\]\)/);
  assert.match(block[0], /rate\s+Decimal\s+@db\.Decimal\(18, 8\)/);
  assert.match(block[0], /deletedAt\s+DateTime\?\s+@map\("deleted_at"\)/, "软删除列必须在");
  assert.match(block[0], /deletedBy\s+String\?\s+@map\("deleted_by"\) @db\.Uuid/);
});
