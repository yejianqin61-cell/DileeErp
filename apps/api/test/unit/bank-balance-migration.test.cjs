// 银行余额与互转迁移的守卫（源码文本 + 常量一致性检查，不连数据库）。
//
// 为什么需要它：本机没有可用 PostgreSQL，迁移无法在真实库上跑。因此逐条断言的都是
// **可静态验证的性质**，其中两条是这类改动最容易踩的坑：
//   1. 可空关联（bank_id / cash_flow_item_id）必须 ON DELETE SET NULL —— 写成 RESTRICT/referential
//      会让 `migrate status` 认为库与 schema 有漂移（Prisma 对可选关联生成的就是 SET NULL）；
//   2. `banks.opening_balance` 必须 NOT NULL DEFAULT 0 —— 允许 NULL 的话，
//      「期初为零」与「没录期初」在库里无法区分，余额算出来是 NULL 还是 0 取决于实现。
const assert = require("node:assert/strict");
const test = require("node:test");
const { readdirSync, readFileSync, statSync } = require("node:fs");
const { join } = require("node:path");

const migrationsRoot = join(__dirname, "..", "..", "prisma", "migrations");
const folder = "20260915180000_bank_balances_and_transfers";
const sql = readFileSync(join(migrationsRoot, folder, "migration.sql"), "utf8");
const schema = readFileSync(join(migrationsRoot, "..", "schema.prisma"), "utf8");

test("银行余额迁移按时间戳排在凭证迁移之后（Prisma 按目录名顺序执行）", () => {
  const folders = readdirSync(migrationsRoot).filter((name) => statSync(join(migrationsRoot, name)).isDirectory()).sort();
  const index = folders.indexOf(folder);
  assert.ok(index >= 0, "银行余额迁移必须存在");
  assert.equal(folders[index - 1], "20260915170000_accounting_vouchers", "必须紧跟在凭证迁移之后，避免插队");
  for (const name of folders) assert.match(name.slice(0, 14), /^\d{14}$/, `迁移目录 ${name} 必须以 14 位时间戳开头`);
});

test("期初余额是非空默认 0 的列（不是 NULL：0 与「没录」必须可区分）", () => {
  assert.match(sql, /ALTER TABLE "banks" ADD COLUMN "opening_balance" DECIMAL\(18,4\) NOT NULL DEFAULT 0/);
});

test("流水与单据的 bank_id / cash_flow_item_id 是可空列（历史数据与「还没确定」的草稿）", () => {
  assert.match(sql, /ALTER TABLE "cash_flow_entries" ADD COLUMN "bank_id" UUID;/);
  for (const table of ["customer_payments", "supplier_payments", "receivable_reconciliations", "supplier_payable_reconciliations"]) {
    assert.match(sql, new RegExp(`ALTER TABLE "${table}" ADD COLUMN "cash_flow_item_id" UUID;`), `${table} 要加 cash_flow_item_id`);
  }
});

test("可空关联一律 ON DELETE SET NULL（写成 RESTRICT 会造成库与 schema 漂移）", () => {
  const optional = [
    ["cash_flow_entries", "bank_id", "banks"],
    ["customer_payments", "cash_flow_item_id", "dictionary_items"],
    ["supplier_payments", "cash_flow_item_id", "dictionary_items"],
    ["receivable_reconciliations", "cash_flow_item_id", "dictionary_items"],
    ["supplier_payable_reconciliations", "cash_flow_item_id", "dictionary_items"],
  ];
  for (const [table, column, target] of optional) {
    assert.match(
      sql,
      new RegExp(`CONSTRAINT "${table}_${column}_fkey" FOREIGN KEY \\("${column}"\\) REFERENCES "${target}"\\("id"\\) ON DELETE SET NULL ON UPDATE CASCADE`),
      `${table}.${column} 必须 SET NULL`,
    );
  }
  // 互转的两个账户是**必填**关联 → RESTRICT（账户只软删除，不会真删）。
  assert.match(sql, /CONSTRAINT "bank_transfers_from_bank_id_fkey" FOREIGN KEY \("from_bank_id"\) REFERENCES "banks"\("id"\) ON DELETE RESTRICT ON UPDATE CASCADE/);
  assert.match(sql, /CONSTRAINT "bank_transfers_to_bank_id_fkey" FOREIGN KEY \("to_bank_id"\) REFERENCES "banks"\("id"\) ON DELETE RESTRICT ON UPDATE CASCADE/);
});

test("bank_transfers 建表：唯一单号 + 期间/账户索引", () => {
  assert.match(sql, /CREATE TABLE "bank_transfers"/);
  assert.match(sql, /CREATE UNIQUE INDEX "bank_transfers_transfer_no_key"/);
  assert.match(sql, /CREATE INDEX "bank_transfers_transfer_date_status_idx"/);
  assert.match(sql, /CREATE INDEX "bank_transfers_from_bank_id_status_idx"/);
  assert.match(sql, /CREATE INDEX "bank_transfers_to_bank_id_status_idx"/);
  assert.match(sql, /CREATE INDEX "cash_flow_entries_bank_id_status_idx"/, "余额聚合按 (bank_id, status) 扫；缺索引会让每次算余额全表扫描流水");
});

test("库层兜底：金额为正、不能自己转给自己、状态只能是 posted/reversed", () => {
  assert.match(sql, /CONSTRAINT "bank_transfers_amount_positive_check" CHECK \("from_amount" > 0 AND "to_amount" > 0\)/);
  assert.match(sql, /CONSTRAINT "bank_transfers_distinct_banks_check" CHECK \("from_bank_id" <> "to_bank_id"\)/);
  assert.match(sql, /CONSTRAINT "bank_transfers_status_check" CHECK \("status" IN \('posted', 'reversed'\)\)/);
});

test("迁移只做加法、不删任何既有事实", () => {
  assert.equal(/DROP\s+(TABLE|COLUMN)/i.test(sql), false, "迁移只做加法：不允许 DROP 表或列");
});

test("schema 与迁移一一对应（改了 schema 就必须有对应的列/表）", () => {
  for (const column of ["openingBalance", "cashFlowItemId"]) assert.ok(schema.includes(column), `schema 必须有 ${column}`);
  assert.match(schema, /model BankTransfer \{/);
  assert.match(schema, /openingBalance Decimal\s+@default\(0\) @map\("opening_balance"\) @db\.Decimal\(18, 4\)/);
  assert.match(schema, /bankId\s+String\?\s+@map\("bank_id"\) @db\.Uuid/, "收支流水要能挂到具体银行账户上");
});
