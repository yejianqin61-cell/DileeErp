// 应收对账「客户 + 期间」迁移的守护（源码文本 + schema 一致性检查，不连数据库）。
//
// 背景：应收对账原先强制挂在单个订单号上（order_no NOT NULL），财务实际是按客户按月对账，
// 一个客户有多张订单就要建多张对账单。本次把 order_no 放宽为可空，客户 + 期间成为对账主键。
//
// 本文件只证明迁移「写了什么」，不证明它能在 PostgreSQL 上跑通 —— 开发机没有可用的
// PostgreSQL（Docker 未运行、5432 未监听），因此本迁移未在真实库上验证过，
// 只能靠静态检查 + 部署时的 `prisma migrate deploy`。这一点在 docs/log 里有记录。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { readdirSync, readFileSync, statSync } = require("node:fs");
const { join } = require("node:path");

const migrationsRoot = join(__dirname, "..", "..", "prisma", "migrations");
const folder = "20260914180000_receivable_reconciliation_customer_period";
const sql = readFileSync(join(migrationsRoot, folder, "migration.sql"), "utf8");
const schema = readFileSync(join(__dirname, "..", "..", "prisma", "schema.prisma"), "utf8");

function modelBlock(name) {
  const match = new RegExp(`model ${name} \\{[\\s\\S]*?\\n\\}`).exec(schema);
  assert.ok(match, `schema.prisma 必须存在 model ${name}`);
  return match[0];
}

test("应收对账迁移排在币种字典迁移之后，且目录名带 14 位时间戳", () => {
  const folders = readdirSync(migrationsRoot).filter((name) => statSync(join(migrationsRoot, name)).isDirectory()).sort();
  assert.ok(folders.includes(folder), "应收对账迁移必须存在");
  assert.match(folder.slice(0, 14), /^\d{14}$/);
  assert.ok(folder.slice(0, 14) > "20260913100000", "必须晚于币种字典迁移，否则已部署库的升级顺序会错位");
});

test("迁移只放宽 order_no 的 NOT NULL，不改写任何历史行", () => {
  assert.match(sql, /ALTER TABLE "receivable_reconciliations" ALTER COLUMN "order_no" DROP NOT NULL;/, "必须放宽 order_no 约束");
  assert.equal(/UPDATE|DELETE|INSERT/.test(sql), false, "迁移不得迁移或改写历史对账数据（宪法：保留历史事实）");
  assert.equal(/DROP COLUMN|DROP TABLE/.test(sql), false, "迁移不得删除任何列或表");
});

test("schema.prisma 的 ReceivableReconciliation.orderNo 与迁移一致地声明为可空", () => {
  const block = modelBlock("ReceivableReconciliation");
  assert.match(block, /orderNo\s+String\?\s+@map\("order_no"\)/, "orderNo 必须是 String?（可选订单号）");
  assert.match(block, /customerId\s+String\s+@map\("customer_id"\)/, "客户仍然必填：客户 + 期间才是对账主键");
  assert.match(block, /periodStart\s+DateTime\s+@map\("period_start"\)/, "期间开始必填");
  assert.match(block, /periodEnd\s+DateTime\s+@map\("period_end"\)/, "期间结束必填");
});
