const assert = require("node:assert/strict");
const { test } = require("node:test");
const { migrationSql, liveUniqueGuards, covers } = require("../helpers/migration-guards.cjs");

// 库存盘点的库级守卫（内存替身看不到唯一索引，所以直接推演迁移后的真实约束）。
//
// 用户 2026-09-16：「仓库模块增加一个盘点管理，可以将每月一次的盘点数据导入系统，
// 调整库存物料数量。物料的产品代码作为唯一性」。
//
// 这里要守住两件事：
//   1. 盘点单号唯一、单内行号唯一：重传同一份盘点表不会变成两张互相矛盾的单子/两行同一行号；
//   2. 库存事实能回指盘点行（stocktake_line_id）：否则「这笔库存变动是哪一行盘点造成的」
//      只能靠 source_id 约定去猜，冲销与对账都失去抓手。
const sql = migrationSql();

test("盘点单号全局唯一（单号是操作员对账时唯一的抓手）", () => {
  const guards = liveUniqueGuards(sql).filter((guard) => guard.table === "stocktakes");
  assert.equal(
    guards.some((guard) => covers(guard.columns, ["stocktake_no"])),
    true,
    `必须存在 stocktake_no 的唯一约束：${guards.map((guard) => `${guard.name}(${guard.columns.join(",")})`).join("; ")}`,
  );
});

test("一张盘点单内行号唯一（重传同一行应撞在这里，而不是产生两条矛盾的盘点行）", () => {
  const guards = liveUniqueGuards(sql).filter((guard) => guard.table === "stocktake_lines");
  assert.equal(
    guards.some((guard) => covers(guard.columns, ["stocktake_id", "line_no"])),
    true,
    `必须存在 (stocktake_id, line_no) 的唯一约束：${guards.map((guard) => `${guard.name}(${guard.columns.join(",")})`).join("; ")}`,
  );
});

test("inventory_facts 增加 stocktake_line_id 并带索引（按盘点行反查库存变动）", () => {
  assert.match(sql, /ALTER TABLE "inventory_facts" ADD COLUMN "stocktake_line_id" UUID/i, "库存事实必须能回指盘点行");
  assert.match(sql, /CREATE INDEX "inventory_facts_stocktake_line_id_idx" ON "inventory_facts"\("stocktake_line_id"\)/i, "按盘点行反查要有索引");
});

test("盘点明细的数量列都在库里，且只有「确认时」两列可空（草稿还没确认）", () => {
  for (const column of ["book_quantity_snapshot", "difference_snapshot", "book_quantity_at_confirm", "applied_quantity"]) {
    assert.match(sql, new RegExp(`"${column}" DECIMAL\\(18,4\\)`), `stocktake_lines 必须有 ${column}`);
  }
  // 只有导入/确认时账面数可以为空：草稿还没确认，没有「确认时账面」可言。
  assert.match(sql, /"book_quantity_snapshot" DECIMAL\(18,4\) NOT NULL/i);
  assert.match(sql, /"difference_snapshot" DECIMAL\(18,4\) NOT NULL/i);
  assert.match(sql, /"book_quantity_at_confirm" DECIMAL\(18,4\),/i);
  assert.match(sql, /"applied_quantity" DECIMAL\(18,4\),/i);
});

test("盘点确认与冲销都要能追溯（状态 + 确认/冲销人 + 时间 + 原因）", () => {
  for (const column of ["status", "confirmed_at", "confirmed_by", "reversed_at", "reversed_by", "reversal_reason"]) {
    assert.match(sql, new RegExp(`"${column}"`), `stocktakes 必须有 ${column}`);
  }
  // 默认草稿：导入只建草稿，确认才写库存调整（已确认口径 28：不直接改余额）
  assert.match(sql, /"status" VARCHAR\(30\) NOT NULL DEFAULT 'draft'/i);
});
