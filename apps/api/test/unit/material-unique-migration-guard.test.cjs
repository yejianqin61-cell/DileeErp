const assert = require("node:assert/strict");
const { test } = require("node:test");
const { migrationSql, liveUniqueGuards, covers } = require("../helpers/migration-guards.cjs");

// 物料唯一性口径守卫（客户反馈：新建物料只要名字一样就不能保存）。
// 口径：名称 + 规格型号 + 颜色 组合唯一；同名不同规格/颜色必须能并存。
// 内存替身看不到库级唯一索引，所以这里直接推演迁移后的真实约束。
const MATERIAL_KEY = ["name", "specification_model", "color"];

test("迁移后物料的唯一约束是 名称+规格型号+颜色 组合（不限索引名）", () => {
  const guards = liveUniqueGuards(migrationSql()).filter((guard) => guard.table === "materials");
  assert.equal(
    guards.some((guard) => covers(guard.columns, MATERIAL_KEY)),
    true,
    `必须存在覆盖 ${MATERIAL_KEY.join("+")} 的唯一约束，否则同名不同规格的物料会重复落库：${guards.map((guard) => `${guard.name}(${guard.columns.join(",")})`).join("; ")}`,
  );
});

test("只按名称的唯一约束必须被删除（否则同名不同规格/颜色仍然保存失败）", () => {
  const guards = liveUniqueGuards(migrationSql()).filter((guard) => guard.table === "materials");
  const nameOnly = guards.filter((guard) => guard.columns.length === 1 && guard.columns[0] === "name");
  assert.deepEqual(
    nameOnly.map((guard) => guard.name),
    [],
    `不得残留只按 name 的唯一约束：${nameOnly.map((guard) => guard.name).join("; ")}`,
  );
});

test("迁移会把 NULL 规格/颜色归一成空串（PostgreSQL 唯一索引里 NULL 互不相等，留 NULL 等于索引失效）", () => {
  const sql = migrationSql();
  assert.match(sql, /UPDATE\s+materials\s+SET\s+specification_model\s*=\s*''\s+WHERE\s+specification_model\s+IS\s+NULL/i, "规格型号 NULL 必须归一为空串");
  assert.match(sql, /UPDATE\s+materials\s+SET\s+color\s*=\s*''\s+WHERE\s+color\s+IS\s+NULL/i, "颜色 NULL 必须归一为空串");
});

test("迁移在建立唯一索引前会先报出历史重复组合（避免迁移失败后留下半成品状态）", () => {
  assert.match(migrationSql(), /RAISE EXCEPTION '存在 % 组「名称\+规格型号\+颜色」完全相同的物料/, "迁移必须先给出可执行的重复数据提示");
});
