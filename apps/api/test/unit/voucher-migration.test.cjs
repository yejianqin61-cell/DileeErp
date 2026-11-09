// 记账凭证迁移的守护（源码文本 + schema 一致性检查，不连数据库）。
//
// 关键不变量：
//   1) (source_type, source_id) 上「一条来源只能有一张**有效**凭证」——生成接口的幂等就靠它。
//      注意：2026-11-09 R3 起这条不再由全局唯一键表达（红冲行会占键、挡住重算），
//      改成迁移里的**部分唯一索引** + schema 的普通 @@index（见本文件末尾的 R3 用例）；
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
/** 2026-11-09 R3 治理迁移：全局唯一键换成部分唯一索引、科目 id 列与发票类型。 */
const r3Folder = "20261109130000_finance_governance_r3";
const r3Sql = readFileSync(join(migrationsRoot, r3Folder, "migration.sql"), "utf8");
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
  // 2026-11-09 R3-4：全局唯一键 `@@unique([sourceType, sourceId])` 已不成立 ——
  // 红冲行也占着 (source_type, source_id)，会让「红冲后按来源重算」永远建不出第二张。
  // 现在换成分**部分唯一索引**（Prisma schema 表达不了部分索引，所以 schema 只留普通 @@index，
  // 唯一性由迁移 DDL 保证；两者的 WHERE 条件必须与 `VoucherService.activeVoucherOf` 逐字对应）。
  assert.match(voucher, /@@index\(\[sourceType, sourceId\]\)/, "按来源查凭证的普通索引仍声明在 schema 上");
  assert.doesNotMatch(voucher, /@@unique\(\[sourceType, sourceId\]\)/, "全局唯一键已被部分唯一索引取代，不能留在 schema 里");
  assert.match(voucher, /debitTotal\s+Decimal\s+@map\("debit_total"\)\s+@db\.Decimal\(18, 4\)/);
  assert.match(voucher, /status\s+String\s+@default\("draft"\)/, "默认草稿：手工凭证生成后要人工过账");

  const line = modelBlock("VoucherLine");
  assert.match(line, /direction\s+String\s+@db\.VarChar\(10\)/, "方向只有 debit/credit（字符串，与收支流水一致）");
  assert.match(line, /subjectLabel\s+String\s+@map\("subject_label"\)/, "科目名快照：字典改名后历史凭证不变");
  assert.match(line, /voucher\s+Voucher\s+@relation\(fields: \[voucherId\], references: \[id\], onDelete: Cascade\)/);
  assert.match(line, /cashFlowEntry\s+CashFlowEntry\?\s+@relation\(fields: \[cashFlowEntryId\], references: \[id\]\)/);

  const entry = modelBlock("CashFlowEntry");
  assert.match(entry, /voucherLines\s+VoucherLine\[\]/, "CashFlowEntry 必须声明反向关系（否则 prisma 校验不过）");
});

/**
 * 2026-11-09 R3 治理迁移：本文件其余用例钉的是**冻结的历史迁移** 20260915170000。
 * R3 改了其中两条「会随业务演进而过时」的声明（全局唯一键、只认两行分录），所以在这里
 * 用同一个文件守新口径：
 *   - 全局唯一键 → 部分唯一索引（红冲后可按来源重算）；
 *   - 分录加科目 id / 业务科目辅助维度 + 应付条目加发票类型（D5 / R3-1）。
 */
test("R3 治理迁移：部分唯一索引替换全局唯一键，且新列/新索引一个不少", () => {
  const folders = readdirSync(migrationsRoot).filter((name) => statSync(join(migrationsRoot, name)).isDirectory()).sort();
  assert.ok(folders.includes(r3Folder), "R3 治理迁移必须存在");

  // 1) 旧全局唯一键必须被显式替换（不是「schema 里不写就算了」——库里那个索引会挡住重算）。
  assert.match(r3Sql, /DROP INDEX IF EXISTS "vouchers_source_type_source_id_key"/, "必须删掉旧的全局唯一键");
  // 2) 部分唯一索引：只约束「未删 + 未红冲 + 有来源」的行。条件写错 = 红冲后仍建不出第二张（或双 active）。
  const partialIndex = r3Sql.match(/CREATE UNIQUE INDEX "vouchers_source_active_key"[\s\S]*?;/)?.[0] ?? "";
  assert.match(partialIndex, /ON "vouchers" \("source_type", "source_id"\)/, "部分唯一索引的键必须是 (source_type, source_id)");
  assert.match(partialIndex, /WHERE "deleted_at" IS NULL/, "条件必须排除软删行");
  assert.match(partialIndex, /"status" <> 'reversed'/, "条件必须排除已红冲行（否则红冲行仍占键）");
  assert.match(partialIndex, /"source_id" IS NOT NULL/, "手工凭证 source_id 为空，不进唯一约束");
  // 3) 普通索引保留：按来源查历史（含红冲行）仍要它。
  assert.match(r3Sql, /CREATE INDEX "vouchers_source_type_source_id_idx" ON "vouchers" \("source_type", "source_id"\)/, "按来源查历史需要普通索引");

  // 4) D5 发票类型落库（应付条目）。
  assert.match(r3Sql, /ALTER TABLE "supplier_payable_entries" ADD COLUMN "invoice_type" VARCHAR\(20\)/, "必须加 invoice_type 列（历史 = null = 未录）");
  const payable = modelBlock("SupplierPayableEntry");
  assert.match(payable, /invoiceType\s+String\?\s+@map\("invoice_type"\)\s+@db\.VarChar\(20\)/, "schema 里 invoiceType 与迁移一致且可空");

  // 5) R3-1：分录的记账科目 id 与业务科目辅助维度（可空 + SET NULL：科目只停用，物理清理时快照仍可读）。
  assert.match(r3Sql, /ALTER TABLE "voucher_lines" ADD COLUMN "subject_id" UUID/, "必须加 voucher_lines.subject_id");
  assert.match(r3Sql, /ALTER TABLE "voucher_lines" ADD COLUMN "business_subject_id" UUID/, "必须加 voucher_lines.business_subject_id");
  assert.match(r3Sql, /ALTER TABLE "voucher_lines" ADD COLUMN "business_subject_label" VARCHAR\(200\)/, "必须加业务科目名称快照");
  assert.match(r3Sql, /CREATE INDEX "voucher_lines_subject_id_idx" ON "voucher_lines"\s*\("subject_id"\)/, "报表按科目 id 归集需要索引");
  assert.match(r3Sql, /CREATE INDEX "voucher_lines_business_subject_id_idx" ON "voucher_lines"\s*\("business_subject_id"\)/, "辅助维度查询需要索引");
  assert.match(r3Sql, /CONSTRAINT "voucher_lines_subject_id_fkey"[\s\S]{0,160}?ON DELETE SET NULL/, "科目被物理清理时分录仍要留得住（SET NULL）");
  assert.match(r3Sql, /CONSTRAINT "voucher_lines_business_subject_id_fkey"[\s\S]{0,160}?ON DELETE SET NULL/, "业务科目同理");

  const line = modelBlock("VoucherLine");
  assert.match(line, /subjectId\s+String\?\s+@map\("subject_id"\) @db\.Uuid/, "schema 必须声明 voucher_lines.subjectId");
  assert.match(line, /businessSubjectId\s+String\?\s+@map\("business_subject_id"\) @db\.Uuid/, "schema 必须声明 businessSubjectId");
  assert.match(line, /businessSubjectLabel\s+String\?\s+@map\("business_subject_label"\) @db\.VarChar\(200\)/, "schema 必须声明 businessSubjectLabel");
  assert.match(line, /@@index\(\[subjectId\]\)/, "schema 的 @@index([subjectId]) 必须与迁移索引名一致");
  assert.match(line, /@@index\(\[businessSubjectId\]\)/, "schema 的 @@index([businessSubjectId]) 必须与迁移索引名一致");
});
