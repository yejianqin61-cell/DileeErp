// 迁移守卫：`20260917140000_cash_flow_payment_nature`。
//
// 这一期只有两个可空列 + 一条索引，但守卫仍然要钉住三件事：
//   1. 迁移**只加列、不改写历史数据**（老流水没有款项性质是事实，不该被编一个值出来）；
//   2. 两列都可空（房租水电没有订单号、历史流水没有性质，NOT NULL 会逼出一堆假数据）；
//   3. 目录名带 14 位时间戳且排在会计科目迁移之后（Prisma 按目录名顺序执行）。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const MIGRATIONS = path.join(__dirname, "..", "..", "prisma", "migrations");
const NAME = "20260917140000_cash_flow_payment_nature";
const sql = fs.readFileSync(path.join(MIGRATIONS, NAME, "migration.sql"), "utf8");
/** 去掉注释后再看语句：注释里为了解释「为什么不能 NOT NULL」会提到这个词。 */
const statements = sql.replace(/^--.*$/gm, "");
const schema = fs.readFileSync(path.join(__dirname, "..", "..", "prisma", "schema.prisma"), "utf8");

test("payment-nature 迁移：给 cash_flow_entries 加两个可空列", () => {
  assert.match(statements, /ALTER TABLE "cash_flow_entries" ADD COLUMN "payment_nature" VARCHAR\(20\);/);
  assert.match(statements, /ALTER TABLE "cash_flow_entries" ADD COLUMN "order_no" VARCHAR\(100\);/);
  assert.equal(/NOT NULL/.test(statements), false, "老流水里这两列没有值，NOT NULL 会逼出一堆假数据");
});

test("payment-nature 迁移：不改写任何历史数据（只加列 + 建索引）", () => {
  assert.equal(/UPDATE\s+/i.test(statements), false, "老流水的「没标注款项性质」是事实，不该被迁移猜一个值填上");
  assert.equal(/DELETE\s+/i.test(statements), false);
  assert.equal(/INSERT\s+/i.test(statements), false);
});

test("payment-nature 迁移：按订单号建索引（外汇一览表按订单归集收款走它）", () => {
  assert.match(sql, /CREATE INDEX "cash_flow_entries_order_no_idx" ON "cash_flow_entries"\("order_no"\);/);
});

test("payment-nature 迁移：schema.prisma 与迁移一致", () => {
  assert.match(schema, /paymentNature\s+String\?\s+@map\("payment_nature"\)\s+@db\.VarChar\(20\)/, "款项性质：可空、20 字符（存 key 而不是中文）");
  assert.match(schema, /orderNo\s+String\?\s+@map\("order_no"\)\s+@db\.VarChar\(100\)/, "订单号：可空，与 sales_orders.order_no 同宽");
  assert.match(schema, /@@index\(\[orderNo\]\)/, "索引要与迁移里的名字对得上（Prisma 默认命名）");
});

test("payment-nature 迁移：目录名带 14 位时间戳，且排在会计科目迁移之后", () => {
  assert.match(NAME, /^\d{14}_/);
  const names = fs.readdirSync(MIGRATIONS).filter((entry) => fs.statSync(path.join(MIGRATIONS, entry)).isDirectory()).sort();
  // Prisma 按目录名顺序执行。只断言「排在会计科目迁移之后」而不是「是最新的一条」：
  // 后面还会有别的迁移加进来，把「最新」写死只会让这条守卫每隔几天就红一次，
  // 而它真正要防的是「这条迁移跑在了它依赖的列/表之前」。
  assert.ok(names.indexOf(NAME) > names.indexOf("20260917120000_accounting_subjects"), "Prisma 按目录名顺序执行，必须排在既有迁移之后");
  assert.ok(names.includes(NAME), "迁移目录必须在仓库里（否则 deploy 时不会执行）");
});
