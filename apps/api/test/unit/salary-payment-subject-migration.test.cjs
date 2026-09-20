// 「工资付款会计科目 + 工资支付科目」迁移的守卫（静态读 SQL，不连数据库）。
//
// 由来：用户 2026-09-20「工资的确认支付也要加上会计科目，会计科目里面多加一个工资支付。
// 这样确认支付工资的时候就能归类到工资支付里面。好做账，好出表。」
//
// 为什么必须静态守：本机没有可用的 PostgreSQL，迁移无法在真实库上跑。而这条迁移有两处
// 「写错了要到生产库才发现」的地方：
//   1. `salary_payments.subject_id` 的外键行为 —— 科目是「只停用不删除」的配置数据，
//      写成 CASCADE 会在删科目时把付款单一起删掉（账没了）；
//   2. 科目插入的幂等性 —— 老库升级与 seed 都会执行，没有 ON CONFLICT 就会在第二次
//      撞 `accounting_subjects_category_name_key` 报错，整个迁移失败。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { readdirSync, readFileSync, statSync } = require("node:fs");
const { join } = require("node:path");
const {
  SUPPLEMENTARY_SUBJECTS,
  ACCOUNTING_SUBJECT_SEEDS,
} = require("../../dist/modules/finance/accounting-subject-catalog.js");

const migrationsRoot = join(__dirname, "..", "..", "prisma", "migrations");
const folder = "20260921120000_salary_payment_subject_and_wage_payment_subject";
const sql = readFileSync(join(migrationsRoot, folder, "migration.sql"), "utf8");
const schema = readFileSync(join(migrationsRoot, "..", "schema.prisma"), "utf8");

test("迁移目录在、且排在会计科目迁移之后（否则科目表还没建就插科目）", () => {
  const folders = readdirSync(migrationsRoot).filter((name) => statSync(join(migrationsRoot, name)).isDirectory()).sort();
  assert.ok(folders.includes(folder), `迁移目录 ${folder} 不存在`);
  assert.ok(folder.slice(0, 14) > "20260917120000", "必须晚于 20260917120000_accounting_subjects（那张表要先存在）");
});

test("salary_payments 加 subject_id：可空 + ON DELETE SET NULL，且形状与同类表一致（不多建索引）", () => {
  assert.match(sql, /ALTER TABLE "salary_payments" ADD COLUMN "subject_id" UUID;/);
  // 不允许 NOT NULL：历史付款单没有这个值。
  assert.equal(/ADD COLUMN "subject_id" UUID NOT NULL/i.test(sql), false, "历史单据没有科目，列必须可空");
  assert.match(
    sql,
    /ADD CONSTRAINT "salary_payments_subject_id_fkey"\s+FOREIGN KEY \("subject_id"\) REFERENCES "accounting_subjects"\("id"\) ON DELETE SET NULL ON UPDATE CASCADE/,
    "科目只停用不删除；真被删时应当把引用置空，而不是连带删掉付款单或直接报数据库约束错",
  );
  // 不建索引：customer_payments / supplier_payments 的 subject_id 也没有索引，
  // 而 schema.prisma 里没有 @@index([subjectId]) —— 多建一个 Prisma 不认识的对象就是 schema drift
  // （`prisma migrate dev` 会想 DROP 它）。同类表什么形状，工资付款就什么形状。
  assert.equal(/CREATE (UNIQUE )?INDEX[^;]*salary_payments[^;]*subject_id/i.test(sql), false, "不许为 subject_id 建索引（会造成 schema drift）");
  assert.equal(/@@index\(\[subjectId\]\)/.test(schema.split("model SalaryPayment")[1]?.split("model ")[0] ?? ""), false, "schema 里也不该有 subjectId 索引声明");
});

test("prisma schema 与迁移一致：字段、关系、以及科目侧的反向关系都在", () => {
  assert.match(schema, /subjectId\s+String\?\s+@map\("subject_id"\) @db\.Uuid/);
  assert.match(schema, /subject\s+AccountingSubject\?\s+@relation\(fields: \[subjectId\], references: \[id\]\)/, "SalaryPayment 必须有 subject 关系");
  assert.match(schema, /salaryPayments\s+SalaryPayment\[\]/, "AccountingSubject 必须有反向关系，否则 prisma 校验不过");
});

test("科目种入幂等：ON CONFLICT DO NOTHING + 空库直接返回 + 与补充清单同一份口径", () => {
  assert.match(sql, /ON CONFLICT \("category", "name"\) DO NOTHING/, "老库升级与 seed 都会执行，必须幂等");
  assert.match(sql, /SELECT "id" INTO actor_id FROM "users" ORDER BY "created_at" LIMIT 1;/);
  assert.match(sql, /IF actor_id IS NULL THEN\s+RETURN;\s+END IF;/, "空库没有 created_by 可用，直接返回（由 seed 负责初始化）");

  // 迁移里插入的科目必须与代码清单逐字对上：写错一个字就会种出一个财务看不懂的科目名。
  for (const subject of SUPPLEMENTARY_SUBJECTS) {
    assert.ok(
      sql.includes(`'${subject.category}', '${subject.name}', '${subject.balanceDirection}', ${subject.sortOrder}`),
      `迁移缺少补充科目「${subject.category}/${subject.name}」（sortOrder ${subject.sortOrder}）`,
    );
  }
  assert.equal((sql.match(/INSERT INTO "accounting_subjects"/g) ?? []).length, 1, "只插补充科目：121 条主表由 20260917120000 那条迁移负责");
  assert.equal(ACCOUNTING_SUBJECT_SEEDS.length, 122, "财务 121 条 + 补充 1 条");
});
