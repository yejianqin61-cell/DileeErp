// 工资台账新增类目迁移的守卫（源码文本 + schema 一致性检查，不连数据库）。
//
// 为什么需要它：本机没有可用 PostgreSQL，迁移无法在真实库上跑。这里断言的都是可静态验证的性质：
//   1. 迁移排在既有迁移之后（Prisma 按目录名排序执行）；
//   2. 四个新列都写进了迁移，列名/类型/默认值与 schema 逐字一致 —— 手工抄 DDL 最容易出的错，
//      就是类型写成 DECIMAL(18,2) 或忘了 NOT NULL DEFAULT 0（既有行会变成 NULL，
//      而 NULL 参与应发求和会得到 NULL，整张台账金额消失）；
//   3. 迁移只做加法：不改老列语义、不 DROP（历史工资不能被重新解释）；
//   4. seed / 既有迁移没有被顺手改掉（新库与老库升级必须得到同一套列）。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { readdirSync, readFileSync, statSync } = require("node:fs");
const { join } = require("node:path");

const migrationsRoot = join(__dirname, "..", "..", "prisma", "migrations");
const folder = "20260915140000_payroll_ledger_salary_categories";
const sql = readFileSync(join(migrationsRoot, folder, "migration.sql"), "utf8");
const schema = readFileSync(join(migrationsRoot, "..", "schema.prisma"), "utf8");
const payrollChain = readFileSync(join(migrationsRoot, "20260822200000_hr_payroll_chain", "migration.sql"), "utf8");

/** 新增的四个类目：列名 → Prisma 字段名。 */
const CATEGORIES = [
  { column: "late_deduction", field: "lateDeduction" },
  { column: "absence_deduction", field: "absenceDeduction" },
  { column: "early_leave_deduction", field: "earlyLeaveDeduction" },
  { column: "housing_allowance", field: "housingAllowance" },
];

test("工资类目迁移排在既有工资迁移之后，且目录名是 14 位时间戳", () => {
  const folders = readdirSync(migrationsRoot).filter((name) => statSync(join(migrationsRoot, name)).isDirectory()).sort();
  const index = folders.indexOf(folder);
  assert.ok(index >= 0, "工资类目迁移必须存在");
  assert.ok(folders.indexOf("20260822200000_hr_payroll_chain") < index, "必须晚于工资链路迁移");
  for (const name of folders) assert.match(name.slice(0, 14), /^\d{14}$/, `迁移目录 ${name} 必须以 14 位时间戳开头`);
});

test("四个新列都写进迁移，且类型/默认值与 schema 一致", () => {
  for (const { column } of CATEGORIES) {
    assert.match(
      sql,
      new RegExp(`ALTER TABLE "payroll_ledgers" ADD COLUMN "${column}" DECIMAL\\(18,4\\) NOT NULL DEFAULT 0;`),
      `列 ${column} 必须是 DECIMAL(18,4) NOT NULL DEFAULT 0 —— 声明成可空会让既有行的金额变成 NULL`,
    );
  }
});

test("schema 与迁移逐字段对齐：字段名、列名、精度、默认值", () => {
  const model = schema.slice(schema.indexOf("model PayrollLedger {"), schema.indexOf("model PayrollPayableEntry {"));
  for (const { column, field } of CATEGORIES) {
    assert.match(model, new RegExp(`${field}\\s+Decimal\\s+@default\\(0\\) @map\\("${column}"\\) @db\\.Decimal\\(18, 4\\)`), `schema 缺少 ${field} → ${column}`);
  }
});

test("迁移只做加法：不改老列语义、不 DROP 任何对象", () => {
  assert.equal(/DROP\s+(TABLE|COLUMN|CONSTRAINT)/i.test(sql), false, "工资类目只允许新增列");
  assert.equal(/ALTER COLUMN/i.test(sql), false, "不得改写老列（考勤扣款与补贴保持原语义）");
  // 老列必须原样保留在最初的工资链路迁移里：新列不是它们的替代品。
  for (const legacy of ["attendance_deduction", "allowance_amount"]) {
    assert.ok(payrollChain.includes(`"${legacy}" DECIMAL(18,4) NOT NULL DEFAULT 0`), `老列 ${legacy} 必须保持原样`);
    assert.equal(sql.includes(`"${legacy}"`), false, `新迁移不得触碰老列 ${legacy}`);
  }
});

test("四个新列都默认 0，不会让既有台账的应发变成 NULL", () => {
  // 统计前先去掉注释：注释里也写了「NOT NULL DEFAULT 0」，直接数会被注释带偏。
  const statements = sql.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
  const defaults = statements.match(/NOT NULL DEFAULT 0/g) ?? [];
  assert.equal(defaults.length, CATEGORIES.length, "四个新列都必须有 NOT NULL DEFAULT 0");
  const nullables = statements.match(/ADD COLUMN "[a-z_]+" DECIMAL\(18,4\)(?! NOT NULL)/g) ?? [];
  assert.deepEqual(nullables, [], "不允许出现可空的新金额列");
});
