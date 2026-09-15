// 记账凭证迁移的守护（源码文本 + schema 一致性检查，不连数据库）。
//
// 关键不变量：
//   1) (source_type, source_id) 唯一 —— 一条来源只能有一张凭证，生成接口的幂等就靠它；
//   2) 金额恒正、方向由 direction 决定（与 cash_flow_entries 同一约定，库层不存负数）；
//   3) 分录随凭证级联删除、来源流水删除只置空指针（凭证是独立事实，不能跟着流水消失）；
//   4) 科目名做快照（subject_label），字典改名后历史凭证仍显示记账当时的科目。
// 本文件只证明迁移「写了什么」，不证明它能在 PostgreSQL 上跑通（本机无可用库）。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { readdirSync, readFileSync, statSync } = require("node:fs");
const { join } = require("node:path");

const migrationsRoot = join(__dirname, "..", "..", "prisma", "migrations");
const folder = "20260915170000_accounting_vouchers";
const sql = readFileSync(join(migrationsRoot, folder, "migration.sql"), "utf8");
const schema = readFileSync(join(__dirname, "..", "..", "prisma", "schema.prisma"), "utf8");

function modelBlock(name) {
  const match = new RegExp(`model ${name} \\{[\\s\\S]*?\\n\\}`).exec(schema);
  assert.ok(match, `schema.prisma 必须存在 model ${name}`);
  return match[0];
}

test("凭证迁移排在收支流水/币种之后，且目录名带 14 位时间戳", () => {
  const folders = readdirSync(migrationsRoot).filter((name) => statSync(join(migrationsRoot, name)).isDirectory()).sort();
  assert.ok(folders.includes(folder), "凭证迁移必须存在");
  assert.match(folder.slice(0, 14), /^\d{14}$/);
  assert.ok(folder.slice(0, 14) > "20260915160000", "必须晚于应收选银行迁移，保证升级顺序确定");
});

test("迁移建两张表、一条来源一张凭证的唯一索引，且不改写历史数据", () => {
  assert.match(sql, /CREATE TABLE "vouchers" \(/);
  assert.match(sql, /CREATE TABLE "voucher_lines" \(/);
  assert.match(sql, /CREATE UNIQUE INDEX "vouchers_source_type_source_id_key" ON "vouchers"\("source_type", "source_id"\);/, "幂等根：一条来源只能有一张凭证");
  assert.match(sql, /CREATE UNIQUE INDEX "vouchers_voucher_no_key" ON "vouchers"\("voucher_no"\);/);
  assert.match(sql, /UNIQUE INDEX "voucher_lines_voucher_id_line_no_key"/, "同一凭证里行号唯一");
  assert.equal(/^\s*(UPDATE|DELETE|INSERT)\b/m.test(sql), false, "迁移不得改写历史数据（宪法：保留历史事实）");
  assert.equal(/DROP COLUMN|DROP TABLE/.test(sql), false, "迁移不得删除任何列或表");
});

test("外键语义：分录随凭证级联删除，来源流水删除只置空分录指针", () => {
  assert.match(sql, /FOREIGN KEY \("voucher_id"\) REFERENCES "vouchers"\("id"\) ON DELETE CASCADE/, "分录没有独立意义，随凭证删");
  assert.match(sql, /FOREIGN KEY \("cash_flow_entry_id"\) REFERENCES "cash_flow_entries"\("id"\) ON DELETE SET NULL/, "流水被删时凭证仍要留得住");
});

/**
 * Json 列必须写成 JSONB。
 *
 * 为什么单独立一条：Prisma 在 PostgreSQL 上把 schema 的 `Json` 映射成 **jsonb**，
 * 而手写迁移很容易写成 `JSON` —— 二者在 `prisma migrate diff` 里是**真实差异**，
 * 一应用就留下永久漂移（本迁移第一版就是这么写的），而且与仓库里其它 15 处
 * attachment 列口径不一致。断言全部 Json 列都是 JSONB，并禁止出现裸 `JSON`。
 */
test("迁移里的 Json 列必须写成 JSONB（与 Prisma 对 Json 的映射及其它 15 处 attachment 一致）", () => {
  assert.match(sql, /"attachment" JSONB NOT NULL DEFAULT '\[\]'/, "vouchers.attachment 必须是 JSONB（写成 JSON 会留下永久漂移）");
  const bareJson = sql.split("\n").filter((line) => /^\s*"[a-z_]+"\s+JSON[\s,]/.test(line));
  assert.deepEqual(bareJson, [], "迁移里不允许出现裸 JSON 列，Json 一律用 JSONB");
  assert.match(modelBlock("Voucher"), /attachment\s+Json\s+@default\("\[\]"\)/, "schema 侧声明 Json（映射到 jsonb）");
});

test("schema.prisma 的 Voucher / VoucherLine 与迁移一致", () => {  const voucher = modelBlock("Voucher");
  assert.match(voucher, /voucherNo\s+String\s+@unique\s+@map\("voucher_no"\)/, "凭证号唯一");
  assert.match(voucher, /@@unique\(\[sourceType, sourceId\]\)/, "幂等根同样声明在 schema 上（否则 migrate diff 会报漂移）");
  assert.match(voucher, /debitTotal\s+Decimal\s+@map\("debit_total"\)\s+@db\.Decimal\(18, 4\)/);
  assert.match(voucher, /status\s+String\s+@default\("draft"\)/, "默认草稿：生成后要人工过账");

  const line = modelBlock("VoucherLine");
  assert.match(line, /direction\s+String\s+@db\.VarChar\(10\)/, "方向只有 debit/credit（字符串，与收支流水一致）");
  assert.match(line, /subjectLabel\s+String\s+@map\("subject_label"\)/, "科目名快照：字典改名后历史凭证不变");
  assert.match(line, /voucher\s+Voucher\s+@relation\(fields: \[voucherId\], references: \[id\], onDelete: Cascade\)/);
  assert.match(line, /cashFlowEntry\s+CashFlowEntry\?\s+@relation\(fields: \[cashFlowEntryId\], references: \[id\]\)/);

  const entry = modelBlock("CashFlowEntry");
  assert.match(entry, /voucherLines\s+VoucherLine\[\]/, "CashFlowEntry 必须声明反向关系（否则 prisma 校验不过）");
});
