// 凭证分录引用银行账户 的迁移守卫（源码文本 + schema 一致性，不连数据库）。
//
// 为什么需要它：本机没有可用的 PostgreSQL，迁移无法在真实库上跑。这里逐条断言的是可静态验证的性质，
// 其中两条是这类改动最容易踩的坑：
//   1. `voucher_lines.bank_id` 是**可空**列 → 外键必须是 ON DELETE SET NULL
//      （写成 RESTRICT 会让 `migrate status` 认为库与 schema 有漂移）；
//   2. 用户要求的语义是「会计科目仍是银行存款，但**引用**具体账户」→ 断言 schema 里
//      subjectKey 没被改造成带账户的字符串，账户走独立的 bank_id 列（否则科目汇总会碎成一条条账户）。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { readdirSync, readFileSync, statSync } = require("node:fs");
const { join } = require("node:path");

const migrationsRoot = join(__dirname, "..", "..", "prisma", "migrations");
const folder = "20260916180000_voucher_line_bank_account";
const sql = readFileSync(join(migrationsRoot, folder, "migration.sql"), "utf8");
const schema = readFileSync(join(migrationsRoot, "..", "schema.prisma"), "utf8");

test("新迁移按时间戳排在既有迁移之后（Prisma 按目录名顺序执行）", () => {
  const folders = readdirSync(migrationsRoot).filter((name) => statSync(join(migrationsRoot, name)).isDirectory()).sort();
  const index = folders.indexOf(folder);
  assert.ok(index >= 0, "迁移必须存在");
  assert.equal(folders[index - 1], "20260916130000_salary_bank_and_material_outbound_confirm", "必须紧跟在此前最后一个迁移之后");
  for (const name of folders) assert.match(name.slice(0, 14), /^\d{14}$/, `迁移目录 ${name} 必须以 14 位时间戳开头`);
  for (const name of folders.slice(index + 1)) assert.ok(name.slice(0, 14) > folder.slice(0, 14), `迁移 ${name} 必须晚于本迁移`);
});

test("凭证分录加银行账户列，且外键是可空关联的 SET NULL", () => {
  assert.match(sql, /ALTER TABLE "voucher_lines" ADD COLUMN "bank_id" UUID;/);
  assert.match(
    sql,
    /CONSTRAINT "voucher_lines_bank_id_fkey"\s+FOREIGN KEY \("bank_id"\) REFERENCES "banks"\("id"\) ON DELETE SET NULL ON UPDATE CASCADE/,
    "可空关联必须 SET NULL；写成 RESTRICT 会造成库与 schema 漂移",
  );
  assert.match(sql, /CREATE INDEX "voucher_lines_bank_id_idx" ON "voucher_lines"\("bank_id"\)/, "按账户查分录（银行存款明细账）要有索引");
});

test("schema 一致：bankId 可空 + Bank 侧反向关系（否则 schema 不合法）", () => {
  assert.match(schema, /model VoucherLine \{[\s\S]*?bankId\s+String\?\s+@map\("bank_id"\) @db\.Uuid/, "schema 里 bankId 必须可空");
  assert.match(schema, /bank\s+Bank\?\s+@relation\(fields: \[bankId\], references: \[id\], onDelete: SetNull\)/);
  assert.match(schema, /voucherLines\s+VoucherLine\[\]/, "Bank 侧要有反向关系");
});

test("会计科目名没被改造成带账户的字符串：账户走独立的 bank_id 列", () => {
  // subject_key 依旧是「银行存款」这样的科目名；账户进 bank_id + subject_label 快照。
  assert.match(schema, /subjectKey\s+String\s+@map\("subject_key"\) @db\.VarChar\(200\)/, "subject_key 仍是科目名（不带账户）");
  assert.match(schema, /subjectLabel\s+String\s+@map\("subject_label"\) @db\.VarChar\(200\)/, "subject_label 是快照（可以是「银行存款—农业银行5706」）");
});
