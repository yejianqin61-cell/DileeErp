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
//
// ⚠️ 2026-11-04 起：**行图落库**。2026-09-16 的旧契约「图片不落库、导出留空」已被本轮需求
// （用户：「销售订单要支持每个物料插入图片……一个生产单里有 5 种伞布、11 种伞头，能在每种里插入图片」）
// 推翻 —— 见 docs/design/sales-order-row-images-2026-11-04.md 与迁移
// 20261104180000_sales_order_row_images。文件末尾那条旧断言因此换成了**新结构**的断言：
// 独立的图片库两张表 + 两处可空 `image_id` 指针 + `SET NULL` 外键 + 18 格映射的唯一键。
// 这是有意的契约更新，不是「改测试迎合错误行为」。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
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
  // 只 name/group_name 必填，其余可空：样本1 的花色没有条码，样本2 的伞头没有颜色以外的字段。
  //
  // ⚠️ 断言必须**只看这张表自己的定义**。`migrationSql()` 把 prisma/migrations 下所有
  // migration.sql 拼成一份大字符串，而 `[\s\S]*?` 会一路跨到后面任意一张表去 ——
  // 2026-09-27 新增的 `purchase_plan_items`（同样是 `"quantity" DECIMAL(18,4) NOT NULL`）
  // 就让这条断言红了，而它盯的表其实完全正常。挪进 `CREATE TABLE ... );` 块里才钉得住本意。
  const tableBlock = /CREATE TABLE "sales_order_spec_details" \(([\s\S]*?)\n\);/i.exec(sql)?.[1] ?? "";
  assert.ok(tableBlock.length > 0, "没取到 sales_order_spec_details 的建表语句，正则可能已失效");
  assert.equal(/"color" VARCHAR\(100\) NOT NULL/i.test(tableBlock), false);
  assert.equal(/"quantity" DECIMAL\(18,4\) NOT NULL/i.test(tableBlock), false);
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

/**
 * 2026-11-04 行图落库的库级守卫（旧「图片不落库」断言由本轮需求推翻，见文件头注释）。
 *
 * 为什么必须钉 SQL 而不是只钉服务层：单测用内存替身，**看不到列、外键与唯一索引**——
 * 而本轮的行图不落库会表现成「界面上传了、保存后没了」「删一张单把另一张单的图带走」这类
 * 只在真实库上才炸的错误。所以这里直接读迁移文件，按 schema 声明的可空性算期望的外键动作。
 *
 * 断言要抓的是**真实结构**，不是「出现过 image 字样」：
 *   ① 图片是独立的库行（`sales_order_images.data BYTEA`），不是明细行上的字节列；
 *   ② 18 格映射表 + 唯一键 `(sales_order_id, spec_key)`（唯一索引不看 deleted_at，替换必须逐格对齐）；
 *   ③ 明细行 / 「其它」行的 `image_id` 是**可空、无默认值**的 UUID（历史行 = 没有图）；
 *   ④ 两条 image_id 外键是可空外键的默认口径 `ON DELETE SET NULL`（图片被硬删时那几行只是「没有图」）；
 *   ⑤ 本迁移不出现 `ON DELETE CASCADE`（销售链一律不 CASCADE，草稿删除是软删）。
 */
test("行图落库（2026-11-04）：图片库两张表 + 两处可空 image_id + SET NULL 外键 + 18 格唯一键", () => {
  const apiRoot = join(__dirname, "..", "..");
  const rowImagesSql = readFileSync(join(apiRoot, "prisma", "migrations", "20261104180000_sales_order_row_images", "migration.sql"), "utf8");

  // ① 独立图片库（按单隔离：sales_order_id 不可空）
  assert.match(rowImagesSql, /CREATE TABLE "sales_order_images" \(/i, "必须建 sales_order_images（字节进这张表，不进行表）");
  assert.match(rowImagesSql, /"data" BYTEA NOT NULL/i, "图片字节是 bytea 列（与 material_images 同一口径）");
  assert.match(rowImagesSql, /"sales_order_id" UUID NOT NULL/i, "图片按单隔离：sales_order_id 不可空");

  // ② 18 格映射表 + 唯一键（唯一索引不看 deleted_at → 服务层必须逐格 upsert/复活）
  assert.match(rowImagesSql, /CREATE TABLE "sales_order_slot_images" \(/i, "必须建 sales_order_slot_images（18 个标量格没有行可挂外键）");
  assert.match(
    rowImagesSql,
    /CREATE UNIQUE INDEX "sales_order_slot_images_sales_order_id_spec_key_key" ON "sales_order_slot_images"\("sales_order_id", "spec_key"\)/i,
    "18 格映射的唯一键必须是 (sales_order_id, spec_key)：删了再建会撞它",
  );

  // ③ 两处行级指针：可空、无默认值（历史行没有图是正常状态，加列不能变成「必须补填」）
  for (const table of ["sales_order_spec_details", "sales_order_material_extras"]) {
    const added = new RegExp(`ALTER TABLE "${table}" ADD COLUMN "image_id" UUID([^;]*)`, "i").exec(rowImagesSql)?.[1];
    assert.ok(added !== undefined, `${table} 必须加 image_id 列（本轮的行图落点）`);
    assert.equal(/NOT NULL/i.test(added), false, `${table}.image_id 必须可空（历史行没有图）`);
    assert.equal(/DEFAULT/i.test(added), false, `${table}.image_id 不该有默认值（空就是空）`);
  }

  // ④ 外键动作：可空外键的 Prisma 默认是 SET NULL（与另一张表的 material_id 踩过的「6 行永久漂移」同一个坑）
  for (const constraint of ["sales_order_spec_details_image_id_fkey", "sales_order_material_extras_image_id_fkey"]) {
    const action = new RegExp(`ADD CONSTRAINT "${constraint}"[^;]*?ON DELETE ([A-Z ]+?) ON UPDATE`).exec(rowImagesSql)?.[1] ?? null;
    assert.equal(action, "SET NULL", `${constraint} 必须是 ON DELETE SET NULL（图片被硬删时那几行只是「没有图」）`);
  }
  // ⑤ 销售链一律不 CASCADE：草稿删除是软删，删一张单不许把图片库或行一起带走
  assert.equal(/ON DELETE CASCADE/i.test(rowImagesSql), false, "销售单图片迁移里不许出现 ON DELETE CASCADE");
});
