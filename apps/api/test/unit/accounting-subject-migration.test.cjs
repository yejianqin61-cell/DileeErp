// 会计科目迁移的守卫（源码文本 + 常量一致性检查，不连数据库）。
//
// 为什么需要它：这是 2026-09-17 唯一一个**改库**的改动，而且要动 5 张业务表的外键与列名，
// 而本机没有可用 PostgreSQL —— 迁移从未在真实库上执行过。因此这里把能静态验证的性质全部钉住：
//   1. 迁移排在既有迁移之后（Prisma 按目录名排序执行）；
//   2. 科目表 121 条与 37 条并入映射都真的写进了 SQL（漏一条 = 老库升级后那一类流水指向不存在的科目）；
//   3. 「沿用旧 id」与「改指」两套机制都在：一对一沿用主键、一对多必须显式改指（否则外键切换失败）；
//   4. 5 张表的 RENAME / DROP CONSTRAINT / ADD CONSTRAINT 一个不少，且可空性对应的
//      ON DELETE 语义正确（必填 RESTRICT、可空 SET NULL）—— 写错会让 `migrate status` 认为有漂移；
//   5. 未映射的自定义旧项目有「未分类」兜底与自检，绝不静默丢分类；
//   6. 审计事件与旧字典软删都在（宪法《Reversible Business Changes》要求保留前后值与原因）；
//   7. seed.ts 也种同一份科目表（新库初始化与老库升级必须得到同一份清单）。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { readdirSync, readFileSync, statSync } = require("node:fs");
const { join } = require("node:path");
const { ACCOUNTING_SUBJECTS, LEGACY_CASH_FLOW_ITEM_SUBJECTS, LEGACY_CASH_FLOW_ITEM_DICTIONARY_KEY } = require("../../dist/modules/finance/accounting-subject-catalog.js");

const migrationsRoot = join(__dirname, "..", "..", "prisma", "migrations");
const folder = "20260917120000_accounting_subjects";
const sql = readFileSync(join(migrationsRoot, folder, "migration.sql"), "utf8");
const seed = readFileSync(join(migrationsRoot, "..", "seed.ts"), "utf8");
const schema = readFileSync(join(migrationsRoot, "..", "schema.prisma"), "utf8");

/** 5 张被改指的表：`表名 → 旧列 → 是否必填`。 */
const TABLES = [
  { table: "cash_flow_entries", oldColumn: "item_id", oldConstraint: "cash_flow_entries_item_id_fkey", newConstraint: "cash_flow_entries_subject_id_fkey", required: true },
  { table: "customer_payments", oldColumn: "cash_flow_item_id", oldConstraint: "customer_payments_cash_flow_item_id_fkey", newConstraint: "customer_payments_subject_id_fkey", required: false },
  { table: "supplier_payments", oldColumn: "cash_flow_item_id", oldConstraint: "supplier_payments_cash_flow_item_id_fkey", newConstraint: "supplier_payments_subject_id_fkey", required: false },
  { table: "receivable_reconciliations", oldColumn: "cash_flow_item_id", oldConstraint: "receivable_reconciliations_cash_flow_item_id_fkey", newConstraint: "receivable_reconciliations_subject_id_fkey", required: false },
  { table: "supplier_payable_reconciliations", oldColumn: "cash_flow_item_id", oldConstraint: "supplier_payable_reconciliations_cash_flow_item_id_fkey", newConstraint: "supplier_payable_reconciliations_subject_id_fkey", required: false },
];

test("科目迁移存在、目录名带 14 位时间戳，且晚于收支流水迁移", () => {
  const folders = readdirSync(migrationsRoot).filter((name) => statSync(join(migrationsRoot, name)).isDirectory()).sort();
  assert.ok(folders.includes(folder), "会计科目迁移必须存在");
  assert.match(folder.slice(0, 14), /^\d{14}$/);
  assert.ok(folder.slice(0, 14) > "20260914190000", "必须晚于收支流水迁移（否则旧字典还没种就并入了）");
  for (const name of folders.filter((name) => name.slice(0, 14) > folder.slice(0, 14))) {
    assert.ok(name.slice(0, 14) > folder.slice(0, 14), `迁移 ${name} 必须晚于会计科目迁移`);
  }
  assert.equal(folders[folders.length - 1].slice(0, 14) >= folder.slice(0, 14), true);
});

test("建表语句与 schema 的列、唯一键、索引名逐项一致", () => {
  assert.match(sql, /CREATE TABLE "accounting_subjects"/);
  for (const column of ["id", "category", "name", "balance_direction", "sort_order", "is_active", "created_at", "updated_at", "created_by", "updated_by", "deleted_at", "deleted_by"]) {
    assert.ok(sql.includes(`"${column}"`), `建表语句必须包含列 ${column}`);
  }
  // 唯一键/索引名必须与 Prisma 从 @@unique / @@index 生成的默认名一致，否则 migrate status 会报漂移。
  assert.match(sql, /CREATE UNIQUE INDEX "accounting_subjects_category_name_key" ON "accounting_subjects"\("category", "name"\)/);
  assert.match(sql, /CREATE INDEX "accounting_subjects_category_sort_order_idx" ON "accounting_subjects"\("category", "sort_order"\)/);
  assert.match(schema, /@@unique\(\[category, name\]\)/, "schema 的唯一键必须与迁移一致");
  assert.match(schema, /@@map\("accounting_subjects"\)/);
  assert.match(schema, /model AccountingSubject \{/);
  assert.match(schema, /balanceDirection String\?\s+@map\("balance_direction"\) @db\.VarChar\(4\)/);
});

test("121 条科目全部写进迁移（漏一条就是老库升级后少一个科目）", () => {
  for (const subject of ACCOUNTING_SUBJECTS) {
    assert.ok(sql.includes(`('${subject.category}', '${subject.name}',`), `科目「${subject.category}/${subject.name}」必须写进迁移`);
  }
  assert.equal((sql.match(/^      \('/gm) ?? []).length >= ACCOUNTING_SUBJECTS.length, true, "VALUES 行数不能少于科目数");
});

test("37 条旧项目映射全部写进迁移，且旧字典 key 也带上", () => {
  for (const legacy of LEGACY_CASH_FLOW_ITEM_SUBJECTS) {
    // 映射表的三元组必须原样出现；旧 key 单独出现是因为它同时也是旧字典项的 key。
    assert.ok(sql.includes(`('${legacy.legacyKey}', '${legacy.category}', '${legacy.name}')`), `映射「${legacy.legacyKey}」必须写进迁移`);
  }
  assert.ok(sql.includes(LEGACY_CASH_FLOW_ITEM_DICTIONARY_KEY), "旧字典的类型 key 必须写进迁移（软删时要按它定位）");
});

test("一对一沿用旧字典项 id，一对多交给改指（两套机制都在）", () => {
  // 「沿用 id」让数据库自己保证历史外键的一致性；一对多的那几组沿用一个、另一个必须改指，
  // 否则 ADD CONSTRAINT 会直接失败（而不是静默出错 —— 但也不该让它失败）。
  assert.match(sql, /SELECT COALESCE\(mapped\.legacy_id, gen_random_uuid\(\)\)/, "科目种入必须优先沿用旧字典项 id");
  assert.match(sql, /\(array_agg\(d\."id"\)\)\[1\] AS legacy_id, count\(\*\) AS n/, "必须统计每个科目被几个旧项目映射，只有一对一才沿用 id");
  assert.match(sql, /AND mapped\.n = 1/, "一对多的科目不能沿用 id（否则另一个旧项目的引用无处可去）");
  for (const { table, oldColumn } of TABLES) {
    assert.match(
      sql,
      new RegExp(`UPDATE "${table}"[\\s\\S]{0,400}?SET "${oldColumn}" = s\\."id"`),
      `${table} 必须有一条改指语句（合并组的历史引用靠它）`,
    );
  }
  const updates = sql.match(/<> s\."id"/g) ?? [];
  assert.equal(updates.length, 5, "5 张表各一条改指语句，且都只改真正需要改的行");
});

test("改指用的旧项目映射只写一遍（抄多遍必然改漏一遍）", () => {
  const mapTable = sql.match(/CREATE TEMP TABLE "_legacy_cash_flow_item_map"/g) ?? [];
  assert.equal(mapTable.length, 1, "映射必须放进临时表，只写一遍");
  assert.match(sql, /DROP TABLE IF EXISTS "_legacy_cash_flow_item_map"/, "临时表用完必须删掉");
  const valueRows = (sql.match(/^\s{6}\('/gm) ?? []).length;
  assert.equal(valueRows, ACCOUNTING_SUBJECTS.length + LEGACY_CASH_FLOW_ITEM_SUBJECTS.length, "VALUES 行数应恰好是科目数 + 映射数，没有多余副本");
});

test("未写进对照表的自定义旧项目不丢：未分类兜底 + 改指前自检", () => {
  assert.match(sql, /'未分类', d\."label"/, "未映射的旧项目必须并入「未分类」，不能因为没写进对照表就丢掉");
  assert.match(sql, /RAISE EXCEPTION '收支项目字典里存在无法并入会计科目的项/, "落不下时必须显式报错中止，绝不静默丢分类");
  assert.match(sql, /IF legacy_type_id IS NOT NULL AND EXISTS/, "自检必须在改指前跑");
});

test("5 张表的外键从 dictionary_items 换到 accounting_subjects，列名一并改", () => {
  // 迁移只做加法：唯一的 DROP 是那张用完即弃的临时映射表 —— 业务表与列一律改名而不是重建，
  // 因为 DROP COLUMN 会连数据一起丢。
  const businessSql = sql.replace(/DROP TABLE IF EXISTS "_legacy_cash_flow_item_map";/g, "");
  assert.equal(/DROP\s+(TABLE|COLUMN)/i.test(businessSql), false, "迁移不允许删表或删列（唯一例外是临时映射表）");
  for (const { table, oldColumn, oldConstraint, newConstraint, required } of TABLES) {
    assert.ok(sql.includes(`ALTER TABLE "${table}" RENAME COLUMN "${oldColumn}" TO "subject_id";`), `${table} 必须把 ${oldColumn} 改名为 subject_id`);
    assert.ok(sql.includes(`DROP CONSTRAINT "${oldConstraint}"`), `${table} 必须丢掉指向 dictionary_items 的旧外键`);
    const onDelete = required ? "RESTRICT" : "SET NULL";
    assert.ok(
      sql.includes(`ADD CONSTRAINT "${newConstraint}" FOREIGN KEY ("subject_id") REFERENCES "accounting_subjects"("id") ON DELETE ${onDelete} ON UPDATE CASCADE`),
      `${table} 的新外键必须指向 accounting_subjects 且 ON DELETE ${onDelete}（必填 RESTRICT / 可空 SET NULL，写错会造成库与 schema 漂移）`,
    );
  }
  assert.ok(sql.includes('DROP INDEX "cash_flow_entries_item_id_direction_idx"'), "流水的旧索引名必须换掉");
  assert.ok(sql.includes('CREATE INDEX "cash_flow_entries_subject_id_direction_idx" ON "cash_flow_entries"("subject_id", "direction")'), "索引名要与 Prisma 从 @@index([subjectId, direction]) 生成的默认名一致");
  assert.match(schema, /@@index\(\[subjectId, direction\]\)/);
  for (const { table } of TABLES) {
    assert.match(schema, new RegExp(`subjectId\\s+String\\??\\s+@map\\("subject_id"\\) @db\\.Uuid`), `${table} 的 schema 字段必须是 subjectId`);
  }
});

test("可追溯性：审计事件 + 旧字典软删，一样都不能少", () => {
  assert.match(sql, /'accounting_subject\.merge_legacy_cash_flow_items'/, "必须写一条审计事件");
  assert.match(sql, /jsonb_build_object\([\s\S]{0,200}'reason'/, "审计事件必须写明原因");
  assert.match(sql, /'source', 'example\/财务\/科目表\(2\)\.xls'/, "审计事件必须写明口径来源");
  assert.match(sql, /'mapping', \(SELECT jsonb_agg/, "审计事件必须带上完整的前后值（37 条映射）");
  assert.match(sql, /UPDATE "dictionary_items"\s+SET "deleted_at" = CURRENT_TIMESTAMP/, "旧字典项必须软删而不是物理删除");
  assert.match(sql, /UPDATE "dictionary_types"\s+SET "deleted_at" = CURRENT_TIMESTAMP[\s\S]{0,200}WHERE "key" = 'cash_flow_item'/, "旧字典类型必须软删（留着可用的旧字典会让人在两张表之间选错）");
});

test("空库（无用户）时科目种入整段跳过，交给 seed.ts", () => {
  assert.match(sql, /SELECT "id" INTO actor_id FROM "users" ORDER BY "created_at" LIMIT 1;/);
  assert.match(sql, /IF actor_id IS NULL THEN\s+RETURN;\s+END IF;/, "空库直接返回，不写半份科目表");
  // 建表与外键切换是普通 DDL，空库也要执行（否则新库连表都没有，seed 也种不进去）。
  assert.match(sql, /CREATE TABLE "accounting_subjects"/);
  assert.match(sql, /ADD CONSTRAINT "cash_flow_entries_subject_id_fkey"/);
});

test("seed.ts 种同一份科目表（新库与老库升级必须得到同一份清单）", () => {
  assert.ok(seed.includes("ACCOUNTING_SUBJECTS"), "seed 必须种会计科目");
  assert.ok(seed.includes("accounting-subject-catalog"), "seed 从 accounting-subject-catalog 导入，与迁移共用一份清单");
  assert.ok(seed.includes("accountingSubject.upsert"), "seed 必须幂等（upsert）");
  assert.match(seed, /category_name: \{ category: subject\.category, name: subject\.name \}/, "幂等键必须与唯一键 @@unique([category, name]) 一致");
});
