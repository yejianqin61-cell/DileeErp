// 订单号唯一性的形状守卫（2026-10-08）。
//
// 用户 2026-10-08 拍板：「删除要释放订单号」—— 于是唯一性从「全表唯一」改成「**未删除行上唯一**」
// （部分唯一索引 `WHERE deleted_at IS NULL`），照抄 `boms` / `purchase_plans` 的先例。
//
// 为什么要单独钉住这类事实：单元测试用的是内存替身，**看不到迁移里的索引** ——
// 历史上就因此漏过一次（见 `employee-daily-report-migration-guards.test.cjs` 的注释）。
// 这里直接读 SQL 与 schema，把两件事钉死：
//   ① 迁移真的删掉旧的全量唯一索引、建了 partial unique，并且建之前挡了重复数据；
//   ② schema 里**不能**再出现 `@unique` —— 写了就又变回全量唯一索引，删除释放号这件事就废了。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const apiRoot = path.join(__dirname, "..", "..");
const migrationSql = fs.readFileSync(path.join(apiRoot, "prisma", "migrations", "20261008100000_sales_order_no_active_unique", "migration.sql"), "utf8");
const schema = fs.readFileSync(path.join(apiRoot, "prisma", "schema.prisma"), "utf8");
const salesOrderModel = schema.slice(schema.indexOf("model SalesOrder {"), schema.indexOf("model SalesOrder {") + schema.slice(schema.indexOf("model SalesOrder {")).indexOf("\n}"));

test("迁移：订单号唯一性改成「未删除行上唯一」，并先挡住重复数据", () => {
  assert.match(migrationSql, /DROP INDEX IF EXISTS "sales_orders_order_no_key";/, "旧的全量唯一索引必须删掉");
  assert.match(
    migrationSql,
    /CREATE UNIQUE INDEX "sales_orders_order_no_active_key" ON "sales_orders"\("order_no"\) WHERE "deleted_at" IS NULL;/,
    "必须建 `WHERE deleted_at IS NULL` 的部分唯一索引",
  );
  // 未删除行里已有重复号时，索引建不上 —— 迁移要在那之前显式失败，而不是留下半个状态。
  assert.match(migrationSql, /HAVING COUNT\(\*\) > 1/, "要先检出重复订单号");
  assert.match(migrationSql, /RAISE EXCEPTION/, "有重复数据就报错中止");
});

test("schema：SalesOrder.orderNo 不能带 @unique（那会让软删的号永远占着）", () => {
  assert.ok(!/@unique/.test(salesOrderModel.split("\n").find((line) => /orderNo\s+String/.test(line)) ?? ""), "orderNo 那一行不能再写 @unique");
  assert.match(salesOrderModel, /@@index\(\[orderNo\]\)/, "普通索引要声明：部分索引只覆盖带 deleted_at 条件的查询");
});
