// 回填迁移的守卫（源码文本检查，不连数据库）。
//
// 为什么需要它：这条迁移只在**别人环境里**跑一次（生产/客户现场），本机没有历史凭证与期初，
// 跑出来的效果看不出对错。所以把「回填判据」与「清单字段」这些能静态验证的性质全钉住：
//   1. 判据是**唯一同名**（HAVING count(*) = 1），同名跨分类必须留空 —— 猜错在报表上看不出来；
//   2. 判据与上一轮 20261109130000 对 `subject_id` 的写法一致（同一个名字不能两条迁移认成不同科目）；
//   3. 幂等：三个 UPDATE 都带 IS NULL，审计事件带 NOT EXISTS 去重；
//   4. 清单含四类计数，缺一类就等于「少算了一处没人知道」；
//   5. 期初的软删行同样参与回填（软删占位仍在唯一键里，跳过它会留下永远归不上的行）。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { readdirSync, readFileSync, statSync } = require("node:fs");
const { join } = require("node:path");

const migrationsRoot = join(__dirname, "..", "..", "prisma", "migrations");
const folder = "20261111160000_accounting_subject_backfill_report";
const sql = readFileSync(join(migrationsRoot, folder, "migration.sql"), "utf8");
const r3Sql = readFileSync(join(migrationsRoot, "20261109130000_finance_governance_r3", "migration.sql"), "utf8");
const codeMigration = readFileSync(join(migrationsRoot, "20261111120000_accounting_subject_code", "migration.sql"), "utf8");
const openingMigration = readFileSync(join(migrationsRoot, "20261111140000_accounting_opening_subject_id", "migration.sql"), "utf8");

test("回填迁移存在，且晚于编码迁移与期初落主键迁移", () => {
  const folders = readdirSync(migrationsRoot).filter((name) => statSync(join(migrationsRoot, name)).isDirectory()).sort();
  assert.ok(folders.includes(folder), "回填迁移必须存在");
  assert.match(folder.slice(0, 14), /^\d{14}$/, "目录名必须带 14 位时间戳，否则 Prisma 排序会乱");
  assert.ok(folder.slice(0, 14) > "20261111120000", "必须晚于编码迁移（先有编码，再谈回填）");
  assert.ok(folder.slice(0, 14) > "20261111140000", "必须晚于期初落主键迁移（否则期初那一列还不存在）");
});

test("判据是「唯一同名」：HAVING count(*) = 1，同名跨分类一律不归", () => {
  // 这一条是整个回填的正确性所在：`@@unique([category, name])` 允许同名跨分类，
  // 而回填只看名字。没有 HAVING 就会把一条分录归到「随便命中的某一个」科目上。
  assert.match(sql, /HAVING count\(\*\) = 1/, "回填必须只在恰好命中一个科目时才写");
  assert.match(sql, /WHERE l\."business_subject_id" IS NULL/, "只补空的，不覆盖已有值");
  assert.match(sql, /l\."business_subject_label" IS NOT NULL/, "没有文本可依据的行不该被扫进来");
});

test("回填判据与上一轮 20261109130000 对 subject_id 的写法一致", () => {
  // 同一个名字，两条迁移必须认成同一个科目。上一轮认三种写法（裸名 / 「分类 / 名称」/「分类/名称」），
  // 这一轮的业务科目只存裸名，所以只认裸名与「分类 / 名称」两种 —— 但匹配表达式必须逐字同源。
  assert.ok(r3Sql.includes('l."subject_label" = s."name"'), "上一轮的裸名判据应在 r3 里");
  assert.ok(sql.includes('l."business_subject_label" = s."name"'), "这一轮的裸名判据必须同形");
  assert.ok(
    r3Sql.includes(`s."category" || ' / ' || s."name"`) && sql.includes(`s."category" || ' / ' || s."name"`),
    "「分类 / 名称」的拼法必须与上一轮逐字一致（空格也不能差）",
  );
});

test("幂等：三个 UPDATE 都只碰空值，审计事件带 NOT EXISTS 去重", () => {
  // 重复执行不改变任何业务行，也不刷第二条清单。
  // 先去掉注释行再数：文件末尾的回滚说明里也写了 UPDATE，直接数会多数两条。
  const body = sql.split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n");
  const updates = body.match(/UPDATE "voucher_lines"|UPDATE "accounting_opening_balances"/g) ?? [];
  assert.equal(updates.length, 2, "两处 UPDATE：凭证辅助科目 + 期初余额");
  assert.equal((body.match(/WHERE [\s\S]*?"subject_id" IS NULL/g) ?? []).length >= 1, true);
  assert.match(sql, /WHERE NOT EXISTS \(\s*SELECT 1 FROM "audit_events" WHERE "action" = 'accounting_subject\.backfill_report'\s*\)/, "审计事件必须幂等");
});

test("未归位清单含四类计数", () => {
  // 缺一类 = 少算一处没人知道的缺口。四类分别对应：凭证记账科目、凭证辅助科目、收支类目、期初余额。
  for (const key of [
    "voucher_line_subject_missing",
    "voucher_line_business_missing",
    "cash_flow_category_missing",
    "opening_balance_subject_missing",
  ]) {
    assert.ok(sql.includes(key), `清单必须含 ${key}`);
  }
  assert.match(sql, /'accounting_subject\.backfill_report'/, "动作名要能一眼认出是回填报告");
});

test("期初回填也覆盖软删行（软删占位仍在唯一键里，跳过它会留下永远归不上的行）", () => {
  // 期初的唯一键不区分软删：软删行仍占着 (as_of_date, subject_key, currency)。
  // 若回填只处理 deleted_at IS NULL 的行，这些行就永远停在「只有文本」的状态。
  const openingSection = sql.split("期初余额：补回 T3 之后仍为空的行")[1] ?? "";
  assert.ok(openingSection.length > 0, "必须能定位到期初回填那一段");
  assert.doesNotMatch(openingSection, /o\."deleted_at" IS NULL/, "期初回填不能过滤软删行");
  assert.match(openingSection, /WHERE o\."subject_id" IS NULL/, "只补空的");
});

test("期初回填判据与 T3 的迁移逐字同源（否则同一条期初在两条迁移里会落到不同科目）", () => {
  const pick = (text) => (text.match(/p\.category <> ''/g) ?? []).length;
  assert.equal(pick(sql), pick(openingMigration), "带分类的分支必须与 T3 一致");
  assert.ok(sql.includes("cardinality(c.subject_ids) = 1"), "唯一性过滤必须与 T3 一致");
});

test("编码迁移的回填与 accountingSubjectCodeFor 同形（S + lpad 到 4 位）", () => {
  // 编码是身份。TS 与 SQL 一旦算出不同字符串，新库（seed）与老库（迁移）就会种出两套身份。
  assert.match(codeMigration, /'S' \|\| lpad\("sort_order"::text, 4, '0'\)/, "SQL 侧必须是 S + 4 位左补零");
  assert.match(codeMigration, /CREATE UNIQUE INDEX "accounting_subjects_code_key"/, "编码必须有唯一索引");
  assert.match(codeMigration, /ALTER COLUMN "code" SET NOT NULL/, "编码不允许为空");
});
