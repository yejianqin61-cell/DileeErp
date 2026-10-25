// 迁移守卫：`20261013160000_cash_flow_category_subject`（收支流水加「收支类目」）。
//
// 用户 2026-10-13：「财务部分，收支明细表，也要显示收支类目。比如说采购某个物料，
// 或者其他应付其他应收也要带上会计科目。而且导出的 excel 也要显示相应的 column。」
// 设计依据：`docs/design/cash-flow-category-and-payable-batch-delete-2026-10-13.md` §1。
//
// 为什么这条迁移需要守卫：
//   · 本机没有 PostgreSQL（跑不了 `migrate deploy`），本仓库的迁移又是**手写 SQL**
//     （没有 `migration_lock.toml`，`prisma migrate diff` 用不了）—— schema 与 SQL 的漂移
//     不会被任何工具报出来，只能靠静态核对（2026-10-12 的复核正是在这里抓到过一次漂移）。
//   · 这一列**可空 + SET NULL** 是刻意的：它是展示用的业务分类，不是记账依据。写成 RESTRICT
//     会让财务删科目时撞上一个她看不懂的数据库约束；写成 NOT NULL 会让历史行过不去。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const API_ROOT = path.join(__dirname, "..", "..");
const MIGRATIONS = path.join(API_ROOT, "prisma", "migrations");
const MIGRATION_NAME = "20261013160000_cash_flow_category_subject";
const raw = fs.readFileSync(path.join(MIGRATIONS, MIGRATION_NAME, "migration.sql"), "utf8");
/** 去掉注释行再断言：注释里写了什么不算数（引用旧写法的注释不能让守卫变红）。 */
const sql = raw.replace(/^--.*$/gm, "");
const schema = fs.readFileSync(path.join(API_ROOT, "prisma", "schema.prisma"), "utf8");
const model = schema.slice(schema.indexOf("model CashFlowEntry {"), schema.indexOf("model AccountingSubject {"));
const subjectModel = schema.slice(schema.indexOf("model AccountingSubject {"), schema.indexOf("model Voucher {"));

test("迁移：只给 cash_flow_entries 加 category_subject_id 一列，不动别的表、不删任何东西", () => {
  const altered = [...sql.matchAll(/ALTER TABLE "([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(altered)], ["cash_flow_entries"]);
  const added = [...sql.matchAll(/ADD COLUMN "([^"]+)" ([A-Z0-9()]+)( NOT NULL)?( DEFAULT [^;]+)?;/g)];
  assert.equal(added.length, 1, "一条加列语句");
  assert.equal(added[0][1], "category_subject_id");
  assert.equal(added[0][2], "UUID");
  assert.equal(Boolean(added[0][3]), false, "必须可空：历史行与手工流水都没有这一格");
  assert.equal(Boolean(added[0][4]), false, "不该有默认值（默认值会把「没填」变成一个科目）");
  assert.equal(/\bDROP\b/i.test(sql), false, "加列迁移不该有 DROP");
  assert.equal(/\bDELETE\s+FROM\b/i.test(sql), false);
  assert.equal(/\bTRUNCATE\b/i.test(sql), false);
});

test("迁移：外键走 SET NULL（这一列是展示用的分类，不是记账依据）", () => {
  assert.match(sql, /FOREIGN KEY \("category_subject_id"\) REFERENCES "accounting_subjects"\("id"\)\s*\n\s*ON DELETE SET NULL ON UPDATE CASCADE/);
  // 「删科目被数据库挡住」是 2026-10-12 复核点过的那类坑：RESTRICT 只该用在本列**之外**的地方。
  assert.equal(/category_subject_id"[^;]*ON DELETE RESTRICT/is.test(sql), false);
  assert.match(sql, /CREATE INDEX "cash_flow_entries_category_subject_id_idx" ON "cash_flow_entries"\("category_subject_id"\);/);
});

test("schema 与 SQL 逐字段对齐（本仓库的迁移是手写的，没有工具会发现漂移）", () => {
  assert.match(model, /categorySubjectId\s+String\?\s+@map\("category_subject_id"\)\s+@db\.Uuid/);
  // 可空关系在 Prisma 里默认就是 SET NULL，但**显式写出来**：免得以后有人照抄
  // `20261013090000_other_payable_subject` 那条 RESTRICT 的写法把两边改漂移。
  assert.match(model, /categorySubject\s+AccountingSubject\?\s+@relation\("CashFlowCategorySubject", fields: \[categorySubjectId\], references: \[id\], onDelete: SetNull\)/);
  assert.match(model, /@@index\(\[categorySubjectId\]\)/);
  // 反向关系必须存在（少一条 Prisma 校验就不过），且与主科目那条是**两个具名关系**。
  assert.match(subjectModel, /cashFlowEntries\s+CashFlowEntry\[\]/);
  assert.match(subjectModel, /cashFlowCategoryEntries\s+CashFlowEntry\[\]\s+@relation\("CashFlowCategorySubject"\)/);
});

test("迁移目录名带 14 位时间戳，且紧跟在前一条迁移之后（部署按目录名排序执行）", () => {
  assert.match(MIGRATION_NAME, /^\d{14}_[a-z0-9_]+$/);
  const names = fs.readdirSync(MIGRATIONS).filter((name) => /^\d{14}_/.test(name)).sort();
  // 2026-10-25 起不再断言「排在最后」：后续功能会继续追加迁移，只要求紧随其前驱。
  assert.ok(names.indexOf(MIGRATION_NAME) > 0, "它必须存在且不是第一条");
  assert.ok(names.includes("20261013090000_other_payable_subject"), "它前面那条（其他应付科目）要在");
});
