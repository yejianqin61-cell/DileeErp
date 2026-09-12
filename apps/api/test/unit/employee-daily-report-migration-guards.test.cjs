const assert = require("node:assert/strict");
const { test } = require("node:test");
const { migrationSql, liveUniqueGuards, covers } = require("../helpers/migration-guards.cjs");

// 这一条守卫专门防「数据库层约束与业务口径不一致」这类 bug：
// 单元测试用内存替身，看不到迁移里的部分唯一索引，历史上就因此漏掉了
// “同一员工同日同工序同计薪方式只能有一条”的库级限制（复选功能在真实库里直接 409）。
//
// 守卫按迁移顺序推演「活着的唯一约束」集合，并且不只看索引名——
// 任何名字的 CREATE UNIQUE INDEX / ADD CONSTRAINT ... UNIQUE 只要覆盖了同一组业务列，
// 都会让复选再次失效，必须被这条测试挡住。
// 推演逻辑提取到 test/helpers/migration-guards.cjs，物料组合唯一守卫复用同一份实现。
const BUSINESS_KEY = ["production_order_operation_id", "employee_id", "report_date", "wage_mode"];

test("迁移最终状态下，员工日报不再有阻止复选的业务唯一约束（不限索引名与创建方式）", () => {
  const guards = liveUniqueGuards(migrationSql()).filter((guard) => guard.table === "employee_daily_reports");
  assert.equal(
    guards.some((guard) => guard.name === "employee_daily_reports_active_business_key"),
    false,
    "必须有一条迁移 DROP 掉 employee_daily_reports_active_business_key，否则同一员工同日同工序同计薪方式的第二条日报会 409",
  );
  // 名称无关的兜底：任何覆盖 (工序, 员工, 日期, 计薪方式) 的唯一约束都会让复选失效。
  const blocking = guards.filter((guard) => covers(guard.columns, BUSINESS_KEY));
  assert.deepEqual(
    blocking.map((guard) => guard.name),
    [],
    `不得存在覆盖 工序/员工/日期/计薪方式 的唯一约束（可能通过 ALTER TABLE ADD CONSTRAINT 或改名索引重新加回）：${blocking.map((guard) => `${guard.name}(${guard.columns.join(",")})`).join("; ")}`,
  );
});

test("幂等键唯一索引保持不变（同一提交重试仍然幂等）", () => {
  const guards = liveUniqueGuards(migrationSql()).filter((guard) => guard.table === "employee_daily_reports");
  assert.equal(
    guards.some((guard) => guard.columns.includes("idempotency_key")),
    true,
    "幂等键唯一性是批次重试不重复写库的基础，不得被删除",
  );
});

test("工序日报的业务唯一索引保持不变（同工序同日期仍累加为一行）", () => {
  const guards = liveUniqueGuards(migrationSql()).filter((guard) => guard.table === "operation_daily_reports");
  assert.equal(
    guards.some((guard) => covers(guard.columns, ["production_order_operation_id", "report_date"])),
    true,
    "工序日报的 (工序, 日期) 唯一约束是现行口径，不得被删除",
  );
});
