// 会计科目类目迁移的守卫（源码文本 + 常量一致性，不连数据库）。
//
// 为什么需要它：2026-11-07 这次改库的迁移在本机**没有真实 PostgreSQL 可跑**（开发机无 docker），
// 所以把能静态验证的性质全部钉住（与 20260917 会计科目迁移守卫同一思路）：
//   1. 迁移目录名带 14 位时间戳、排在既有迁移之后（Prisma 按目录名排序执行）；
//   2. 建表列、主键、唯一索引、sort_order 索引的名字与 schema 的默认生成名逐项一致
//      （名字写错 = `migrate status` 说库与 schema 有漂移）；
//   3. 5 个内置类目名与顺序与 `ACCOUNTING_SUBJECT_CATEGORIES` 逐字一致（手抄漂移不会报错，
//      只会让三大报表按名字匹配不到科目、整张表变空 —— 最难查的一类问题）；
//   4. `SELECT DISTINCT category` 回填历史类目、sort_order 从 60 起 +10；空库（无 users）整段跳过；
//   5. `prisma/seed.ts` 在种科目**之前**先种 5 个内置类目（否则新库的科目写入口校验会失败）。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { readdirSync, readFileSync, statSync } = require("node:fs");
const { join } = require("node:path");
const { ACCOUNTING_SUBJECT_CATEGORIES } = require("../../dist/modules/finance/accounting-subject-catalog.js");

const migrationsRoot = join(__dirname, "..", "..", "prisma", "migrations");
const folder = "20261107200000_accounting_subject_categories";
const sql = readFileSync(join(migrationsRoot, folder, "migration.sql"), "utf8");
const seed = readFileSync(join(migrationsRoot, "..", "seed.ts"), "utf8");
const schema = readFileSync(join(migrationsRoot, "..", "schema.prisma"), "utf8");

test("迁移存在、目录名带 14 位时间戳，且排在既有会计科目迁移之后", () => {
  const folders = readdirSync(migrationsRoot).filter((name) => statSync(join(migrationsRoot, name)).isDirectory()).sort();
  assert.ok(folders.includes(folder), "会计科目类目迁移必须存在");
  assert.match(folder.slice(0, 14), /^\d{14}$/);
  // 必须晚于 20260917 会计科目迁移（它建了 accounting_subjects，本迁移要回填它的 DISTINCT category）
  // 以及最近一次既有迁移；否则 migrate deploy 会在表还不存在时执行回填。
  assert.ok(folder.slice(0, 14) > "20260917120000", "必须晚于建 accounting_subjects 的迁移");
  assert.ok(folder.slice(0, 14) > "20261105103000", "必须晚于本任务之前的最新迁移");
  assert.equal(folders.filter((name) => name.startsWith("20261107200000")).length, 1, "同一时间戳只能有一个迁移目录");
});

test("建表 DDL：列、主键、唯一索引、sort_order 索引名与 Prisma 默认名逐项一致", () => {
  assert.match(sql, /CREATE TABLE "accounting_subject_categories"/);
  for (const column of ["id", "name", "sort_order", "is_system", "created_at", "updated_at", "created_by", "updated_by"]) {
    assert.ok(sql.includes(`"${column}"`), `建表语句必须包含列 ${column}`);
  }
  // 类目行不承载业务事实，删除是物理删除：**不能**有 deleted_at/deleted_by（软删 + 唯一索引会让同名重建永远做不到）。
  assert.equal(sql.includes('"deleted_at"'), false, "类目表不设软删列（设计文档 §3.4）");
  assert.equal(sql.includes('"deleted_by"'), false);
  // 唯一键/索引名必须与 Prisma 从 @unique / @@index 生成的默认名一致，否则 migrate status 会报漂移。
  assert.match(sql, /CONSTRAINT "accounting_subject_categories_pkey" PRIMARY KEY \("id"\)/);
  assert.match(sql, /CREATE UNIQUE INDEX "accounting_subject_categories_name_key" ON "accounting_subject_categories"\("name"\)/);
  assert.match(sql, /CREATE INDEX "accounting_subject_categories_sort_order_idx" ON "accounting_subject_categories"\("sort_order"\)/);
  // 只建一张表；迁移里不允许删表/删列/删索引（本任务是纯加法）。
  assert.equal((sql.match(/CREATE TABLE/g) ?? []).length, 1);
  assert.equal(/DROP\s+(TABLE|COLUMN|INDEX)/i.test(sql), false, "本迁移只加表，不删任何东西");
  // 回填只读 accounting_subjects，绝不改科目行（改名级联是运行时服务层的事）。
  assert.equal(/UPDATE\s+"accounting_subjects"/.test(sql), false, "迁移不得改写科目行");
});

test("schema.prisma：新增 AccountingSubjectCategory 模型，字段/唯一键/索引与迁移一致", () => {
  assert.match(schema, /model AccountingSubjectCategory \{/);
  assert.match(schema, /name\s+String\s+@unique @db\.VarChar\(30\)/, "类目名全表唯一且限长 30（与迁移的 VARCHAR(30) 唯一索引一致）");
  assert.match(schema, /sortOrder\s+Int\s+@default\(0\) @map\("sort_order"\)/);
  assert.match(schema, /isSystem\s+Boolean\s+@default\(false\) @map\("is_system"\)/);
  assert.match(schema, /@@index\(\[sortOrder\]\)/, "索引必须与迁移的 accounting_subject_categories_sort_order_idx 对应");
  assert.match(schema, /@@map\("accounting_subject_categories"\)/);
  assert.match(schema, /createdBy\s+String\s+@map\("created_by"\) @db\.Uuid/, "审计列与全站一致");
  assert.match(schema, /updatedBy\s+String\s+@map\("updated_by"\) @db\.Uuid/);
});

test("5 个内置类目名与顺序与 ACCOUNTING_SUBJECT_CATEGORIES 逐字一致（防手抄漂移）", () => {
  const names = ACCOUNTING_SUBJECT_CATEGORIES.map((name) => `'${name}'`).join(", ");
  assert.ok(sql.includes(`ARRAY[${names}]`), "迁移里的内置类目数组必须与常量文件逐字相同（顺序也一致）");
  assert.ok(sql.includes("ARRAY[10, 20, 30, 40, 50]"), "内置类目排序权重必须是 10/20/30/40/50");
  assert.match(sql, /FROM unnest\(system_names, system_sort\) AS system\(name, sort_order\)/, "名字与权重必须成对插入（不能各写一份 VALUES 再靠顺序对齐）");
  assert.match(sql, /true, CURRENT_TIMESTAMP, actor_id, actor_id/, "内置类目 is_system 必须是 true");
  assert.match(sql, /ON CONFLICT \("name"\) DO NOTHING/, "重复执行必须幂等");
});

test("历史类目回填：DISTINCT category、sort_order 从 60 起 +10、只补类目表没有的取值", () => {
  assert.match(sql, /SELECT DISTINCT "category" FROM "accounting_subjects"/, "回填来源必须是科目表里实际出现过的分类");
  assert.match(sql, /row_number\(\) OVER \(ORDER BY legacy\.category\)/, "自建类目排序按名称稳定编号（每次执行顺序一致）");
  assert.match(sql, /60 \+ \(row_number\(\) OVER \(ORDER BY legacy\.category\) - 1\) \* 10/, "sort_order 从 60 起、每行 +10（接在内置 50 之后）");
  assert.match(sql, /false,/, "回填出来的历史类目 is_system 必须是 false");
  assert.match(sql, /WHERE NOT EXISTS \(\s*SELECT 1 FROM "accounting_subject_categories" existing WHERE existing\."name" = legacy\.category\s*\)/, "已经登记过的类目不能重复插入");
});

test("空库（无用户）时种入整段跳过，交给 seed.ts", () => {
  assert.ok(sql.indexOf('CREATE TABLE "accounting_subject_categories"') < sql.indexOf("DO $$"), "建表是普通 DDL，空库也要执行");
  assert.match(sql, /SELECT "id" INTO actor_id FROM "users" ORDER BY "created_at" LIMIT 1;/, "审计列 created_by 取最早创建的用户（与 20260917 迁移同一写法）");
  assert.match(sql, /IF actor_id IS NULL THEN\s+RETURN;\s+END IF;/, "无 users → 整段返回：新库由 seed.ts 先建类目再种科目");
  assert.ok(sql.indexOf('SELECT "id" INTO actor_id') < sql.indexOf('INSERT INTO "accounting_subject_categories"'), "必须先判空库，再插类目");
});

test("seed.ts：在种科目之前 upsert 5 个内置类目（幂等、顺序与迁移一致）", () => {
  assert.ok(seed.includes("ACCOUNTING_SUBJECT_CATEGORIES"), "seed 从 accounting-subject-catalog 导入内置类目，与迁移共用一份清单");
  assert.match(seed, /tx\.accountingSubjectCategory\.upsert/, "seed 必须幂等（upsert）");
  assert.match(seed, /where: \{ name \}/, "幂等键必须与唯一索引 name 一致");
  assert.match(seed, /isSystem: true/, "种子建的是内置类目");
  assert.match(seed, /sortOrder: \(index \+ 1\) \* 10/, "排序权重 (下标+1)*10 → 10/20/30/40/50");
  assert.ok(
    seed.indexOf("accountingSubjectCategory.upsert") < seed.indexOf("for (const subject of ACCOUNTING_SUBJECT_SEEDS)"),
    "类目必须种在科目之前：科目写入口校验分类存在，顺序反了新库连科目都种不进去",
  );
});
