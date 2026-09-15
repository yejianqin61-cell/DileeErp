// 应收侧「选择银行」迁移的守护（源码文本 + schema 一致性检查，不连数据库）。
//
// 背景：银行账户池（banks）在 20260915120000 迁移里只接到了**应付**侧（付款登记、应付对账）。
// 用户 2026-09-15 的要求是「所有应收管理，都要选择银行，从银行池里选择」，
// 因此本次给收款单（customer_payments）与应收对账（receivable_reconciliations）各补一个可空的 bank_id。
//
// 本文件只证明迁移「写了什么」，不证明它能在 PostgreSQL 上跑通 —— 开发机没有可用的
// PostgreSQL，迁移不在真实库上验证，只能靠静态检查 + 部署时的 `prisma migrate deploy`。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { readdirSync, readFileSync, statSync } = require("node:fs");
const { join } = require("node:path");

const migrationsRoot = join(__dirname, "..", "..", "prisma", "migrations");
const folder = "20260915160000_receivable_bank_selection";
const sql = readFileSync(join(migrationsRoot, folder, "migration.sql"), "utf8");
const schema = readFileSync(join(__dirname, "..", "..", "prisma", "schema.prisma"), "utf8");

function modelBlock(name) {
  const match = new RegExp(`model ${name} \\{[\\s\\S]*?\\n\\}`).exec(schema);
  assert.ok(match, `schema.prisma 必须存在 model ${name}`);
  return match[0];
}

test("应收选银行迁移排在银行池迁移之后，且目录名带 14 位时间戳", () => {
  const folders = readdirSync(migrationsRoot).filter((name) => statSync(join(migrationsRoot, name)).isDirectory()).sort();
  assert.ok(folders.includes(folder), "应收选银行迁移必须存在");
  assert.match(folder.slice(0, 14), /^\d{14}$/);
  assert.ok(folder.slice(0, 14) > "20260915120000", "必须晚于银行池迁移（banks 表由它创建，否则外键建不起来）");
});

test("迁移给收款单与应收对账各加一个可空 bank_id，并指向 banks", () => {
  assert.match(sql, /ALTER TABLE "customer_payments" ADD COLUMN "bank_id" UUID;/, "收款单必须有 bank_id");
  assert.match(sql, /ALTER TABLE "receivable_reconciliations" ADD COLUMN "bank_id" UUID;/, "应收对账必须有 bank_id");
  assert.equal(/NOT NULL/.test(sql), false, "bank_id 必须可空：历史数据与「暂未确定账户」的草稿都要能存在");
  assert.match(sql, /FOREIGN KEY \("bank_id"\) REFERENCES "banks"\("id"\) ON DELETE SET NULL ON UPDATE CASCADE;/, "外键语义必须与应付侧一致（SET NULL / CASCADE），否则库与 schema 漂移");
  // 注意：外键子句里的 "ON UPDATE CASCADE" 不算数据改写，所以只匹配行首的 DML 语句。
  assert.equal(/^\s*(UPDATE|DELETE|INSERT)\b/m.test(sql), false, "迁移不得改写历史数据（宪法：保留历史事实）");
  assert.equal(/DROP COLUMN|DROP TABLE/.test(sql), false, "迁移不得删除任何列或表");
});

test("schema.prisma 的收款单与应收对账与迁移一致地声明 bankId 关联", () => {
  const payment = modelBlock("CustomerPayment");
  assert.match(payment, /bankId\s+String\?\s+@map\("bank_id"\)\s+@db\.Uuid/, "CustomerPayment.bankId 必须是可空 UUID");
  assert.match(payment, /bank\s+Bank\?\s+@relation\(fields: \[bankId\], references: \[id\]\)/, "CustomerPayment 必须有关联到 Bank");

  const reconciliation = modelBlock("ReceivableReconciliation");
  assert.match(reconciliation, /bankId\s+String\?\s+@map\("bank_id"\)\s+@db\.Uuid/, "ReceivableReconciliation.bankId 必须是可空 UUID");
  assert.match(reconciliation, /bank\s+Bank\?\s+@relation\(fields: \[bankId\], references: \[id\]\)/, "ReceivableReconciliation 必须有关联到 Bank");

  const bank = modelBlock("Bank");
  assert.match(bank, /customerPayments\s+CustomerPayment\[\]/, "Bank 必须声明反向关系 customerPayments（否则 prisma 校验不过）");
  assert.match(bank, /receivableReconciliations\s+ReceivableReconciliation\[\]/, "Bank 必须声明反向关系 receivableReconciliations");
});
