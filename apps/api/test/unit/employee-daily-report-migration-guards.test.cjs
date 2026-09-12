const assert = require("node:assert/strict");
const { test } = require("node:test");
const { readdirSync, readFileSync, statSync } = require("node:fs");
const { join } = require("node:path");

// 这一条守卫专门防「数据库层约束与业务口径不一致」这类 bug：
// 单元测试用内存替身，看不到迁移里的部分唯一索引，历史上就因此漏掉了
// “同一员工同日同工序同计薪方式只能有一条”的库级限制（复选功能在真实库里直接 409）。
// 这里按迁移顺序推演两个索引的最终状态。
const migrationsRoot = join(__dirname, "..", "..", "prisma", "migrations");

function migrationSql() {
  return readdirSync(migrationsRoot)
    .filter((name) => statSync(join(migrationsRoot, name)).isDirectory())
    .sort()
    .map((name) => readFileSync(join(migrationsRoot, name, "migration.sql"), "utf8"))
    .join("\n");
}

/** 按出现顺序推演某个索引的最终状态：CREATE UNIQUE INDEX 置为 present，DROP INDEX 置为 absent。 */
function finalStateOf(sql, indexName) {
  const pattern = new RegExp(`(CREATE UNIQUE INDEX(?: IF NOT EXISTS)?\\s+"?${indexName}"?|DROP INDEX(?: IF EXISTS)?\\s+"?${indexName}"?)`, "g");
  let state = "absent";
  for (const match of sql.matchAll(pattern)) state = match[1].startsWith("CREATE") ? "present" : "absent";
  return state;
}

test("迁移最终状态下，员工日报不再有阻止复选的业务唯一索引", () => {
  const sql = migrationSql();
  assert.equal(
    finalStateOf(sql, "employee_daily_reports_active_business_key"),
    "absent",
    "必须有一条迁移 DROP 掉 employee_daily_reports_active_business_key，否则同一员工同日同工序同计薪方式的第二条日报会 409",
  );
});

test("工序日报的业务唯一索引保持不变（同工序同日期仍累加为一行）", () => {
  assert.equal(
    finalStateOf(migrationSql(), "operation_daily_reports_active_business_key"),
    "present",
    "工序日报的 (工序, 日期) 唯一索引是现行口径，不得被删除",
  );
});

test("幂等键唯一索引保持不变（同一提交重试仍然幂等）", () => {
  assert.equal(
    finalStateOf(migrationSql(), "employee_daily_reports_idempotency_key_key"),
    "present",
    "幂等键唯一性是批次重试不重复写库的基础，不得被删除",
  );
});
