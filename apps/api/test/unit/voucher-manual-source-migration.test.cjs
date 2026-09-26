// 手工凭证迁移的守护（源码文本 + schema 一致性检查，不连数据库）。
//
// 2026-09-24：财务要录非现金分录（折旧/摊销/计提/结转），而凭证原先只能由收支流水生成
// （`source_id` NOT NULL）—— 那些分录在系统里没有落点，三大报表的固定资产/累计折旧/应付职工薪酬
// 等行永远填不上。这次迁移只做一件事：**让 source_id 可为空**。
//
// 三条不变量（都是「改坏了看不出来」的那种）：
//   1) 唯一索引 (source_type, source_id) 必须留着 —— 生成接口的幂等靠它（一条来源一张凭证）；
//      PostgreSQL 的唯一索引不约束 NULL，所以多张手工凭证 (manual, NULL) 可以共存；
//   2) 只放宽 NOT NULL，**不动任何历史数据**（宪法：保留历史事实）；
//   3) schema.prisma 必须与迁移一致（`sourceId String?`），否则生成出来的客户端类型与库对不上。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { readdirSync, readFileSync, statSync } = require("node:fs");
const { join } = require("node:path");

const migrationsRoot = join(__dirname, "..", "..", "prisma", "migrations");
const folder = "20260924100000_voucher_manual_source";
const sql = readFileSync(join(migrationsRoot, folder, "migration.sql"), "utf8");
const schema = readFileSync(join(__dirname, "..", "..", "prisma", "schema.prisma"), "utf8");

test("手工凭证迁移存在、目录名带 14 位时间戳、且排在凭证迁移之后", () => {
  const folders = readdirSync(migrationsRoot).filter((name) => statSync(join(migrationsRoot, name)).isDirectory()).sort();
  assert.ok(folders.includes(folder), "手工凭证迁移必须存在");
  assert.match(folder.slice(0, 14), /^\d{14}$/);
  assert.ok(folder.slice(0, 14) > "20260921120000", "必须晚于此前的迁移，保证升级顺序确定");
});

test("迁移只放宽 source_id 的 NOT NULL，不改写数据、不删列删表、不动唯一索引", () => {
  assert.match(sql, /ALTER TABLE "vouchers" ALTER COLUMN "source_id" DROP NOT NULL;/, "手工凭证没有来源单据，这一列必须可为空");
  assert.equal(/^\s*(UPDATE|DELETE|INSERT)\b/m.test(sql), false, "迁移不得改写历史数据");
  assert.equal(/DROP COLUMN|DROP TABLE|DROP INDEX/.test(sql), false, "不得删除任何列、表或索引");
  assert.equal(/ALTER COLUMN "source_id" SET NOT NULL/.test(sql), false, "反向操作绝不能出现");
});

test("唯一索引仍在（幂等根）：一条来源一张凭证，而 NULL 不受唯一约束", () => {
  // 索引在最初建表的迁移里；这里证明这次迁移没有把它删掉，并且 schema 里仍然声明着。
  const original = readFileSync(join(migrationsRoot, "20260915170000_accounting_vouchers", "migration.sql"), "utf8");
  assert.match(original, /CREATE UNIQUE INDEX "vouchers_source_type_source_id_key" ON "vouchers"\("source_type", "source_id"\);/);
  // 只允许在注释里提到它（说明为什么不用改），DDL 里一个字都不许碰。
  assert.doesNotMatch(sql, /(DROP|CREATE|ALTER)\s[^;]*vouchers_source_type_source_id_key/i, "本次迁移不应触碰这个索引");
  assert.match(schema, /@@unique\(\[sourceType, sourceId\]\)/, "schema 里必须仍然声明这条唯一约束");
});

test("schema.prisma 与迁移一致：sourceId 可空，且来源类型注释写明 manual", () => {
  assert.match(schema, /sourceId\s+String\?\s+@map\("source_id"\) @db\.Uuid/, "schema 必须与迁移一致（否则客户端类型与库对不上）");
  assert.match(schema, /manual（财务手工录入）/, "来源类型注释要写明 manual —— 半个系统靠它解释「这张凭证从哪来」");
});
