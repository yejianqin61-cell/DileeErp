// 销售单下单口径细化的库级守卫（内存替身看不到列，只有迁移 SQL 能证明）。
//
// 迁移：apps/api/prisma/migrations/20260919140000_sales_order_spec_refinement/migration.sql
// 设计：docs/design/sales-order-spec-refinement-and-production-sheet-export-2026-09-16.md
//
// 守住四件事：
//   1. 37 个细化列真的建出来了，列名与长度固定（列名错了导出会整块空掉，而单元测试看不到）；
//   2. **全部可空、无默认值**：历史销售单没有这些字，加列不能变成「必须补填」，
//      否则升级后旧单一条都写不进去；
//   3. 细分明细表的结构：group_name 分组、sort_order 排序索引、外键指向 sales_orders；
//   4. 不加多余索引：这些字段只有填写、打印与人工查看，没有按它们筛选或去重的场景。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { migrationSql } = require("../helpers/migration-guards.cjs");

const sql = migrationSql();
const { SPEC_SCALAR_FIELDS } = require("../../dist/modules/sales/sales-orders.service.js");

const LENGTHS = {
  factory: 100, completion_remark: 100, attention_note: 2000, shipping_mark_front: 2000, shipping_mark_side: 2000,
};
const DECIMALS = ["fabric_usage_canopy", "fabric_usage_strap", "fabric_usage_wood_ear", "fabric_usage_top", "fabric_usage_bag"];

test("37 个细化列都在，长度与类型固定", () => {
  const columns = SPEC_SCALAR_FIELDS.map(([, column]) => column);
  assert.equal(columns.length, 37);
  for (const column of columns) {
    const snake = column.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
    if (DECIMALS.includes(snake)) {
      assert.match(sql, new RegExp(`ADD COLUMN "${snake}" DECIMAL\\(18,4\\)`, "i"), `${snake} 必须是 DECIMAL(18,4)`);
      continue;
    }
    const length = LENGTHS[snake] ?? 1000;
    assert.match(sql, new RegExp(`ADD COLUMN "${snake}" VARCHAR\\(${length}\\)`, "i"), `${snake} 必须是 VARCHAR(${length})`);
  }
});

test("细化列全部可空、无默认值（历史销售单没有这些字）", () => {
  for (const [, column] of SPEC_SCALAR_FIELDS) {
    const snake = column.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
    const added = new RegExp(`ADD COLUMN "${snake}" [^,;]*`, "i").exec(sql);
    assert.ok(added, `迁移里没有 ${snake}`);
    assert.equal(/NOT NULL/i.test(added[0]), false, `${snake} 必须可空`);
    assert.equal(/DEFAULT/i.test(added[0]), false, `${snake} 不该有默认值（空就是空，别塞 0 或空串）`);
  }
});

test("细分明细表：分组名 + 名称 + 颜色 + 条码 + 数量 + 单位 + 排序", () => {
  assert.match(sql, /CREATE TABLE "sales_order_spec_details" \(/i);
  for (const column of ['"group_name" VARCHAR(100) NOT NULL', '"name" VARCHAR(200) NOT NULL', '"color" VARCHAR(100)', '"barcode" VARCHAR(100)', '"quantity" DECIMAL(18,4)', '"unit" VARCHAR(30)', '"sort_order" INTEGER NOT NULL DEFAULT 0']) {
    assert.ok(sql.includes(column), `sales_order_spec_details 缺列或类型不符：${column}`);
  }
  // 只 name/group_name 必填，其余可空：样本1 的花色没有条码，样本2 的伞头没有颜色以外的字段
  assert.equal(/CREATE TABLE "sales_order_spec_details"[\s\S]*?"color" VARCHAR\(100\) NOT NULL/i.test(sql), false);
  assert.equal(/CREATE TABLE "sales_order_spec_details"[\s\S]*?"quantity" DECIMAL\(18,4\) NOT NULL/i.test(sql), false);
});

test("明细按 (销售单, 排序) 取，外键指向 sales_orders", () => {
  assert.match(sql, /CREATE INDEX "sales_order_spec_details_sales_order_id_sort_order_idx" ON "sales_order_spec_details"\("sales_order_id", "sort_order"\)/i);
  assert.match(sql, /ALTER TABLE "sales_order_spec_details" ADD CONSTRAINT "sales_order_spec_details_sales_order_id_fkey" FOREIGN KEY \("sales_order_id"\) REFERENCES "sales_orders"\("id"\) ON DELETE RESTRICT ON UPDATE CASCADE/i);
});

test("不给细化列加索引（只有填写、打印与人工查看）", () => {
  for (const [, column] of SPEC_SCALAR_FIELDS) {
    assert.equal(new RegExp(`CREATE (UNIQUE )?INDEX[^;]*"${column}"`, "i").test(sql), false, `${column} 不该建索引`);
  }
});

test("图片不落库：迁移里没有任何图片列（用户明确不导出、留空）", () => {
  for (const word of ["image", "picture", "photo", "图片"]) {
    assert.equal(new RegExp(`ADD COLUMN [^,;]*${word}`, "i").test(sql), false, `不该有图片列（${word}）`);
  }
});
