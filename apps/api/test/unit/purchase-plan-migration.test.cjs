// 迁移守卫：`20260928090000_purchase_plan`（建表）与 `20260928100000_purchase_plan_backfill_drafts`（搬草稿）。
//
// 两条迁移各自有一处最容易写错、而且**错了不会报错**的地方：
//   · 建表那条：外键动作。可选关系必须是 `ON DELETE SET NULL`（Prisma 对可选关系的既定生成），
//     写成 RESTRICT 会让 `prisma migrate diff` 长期报漂移 —— 漂移不报错、只是悄悄攒着。
//     还有「一个 BOM 一份计划」必须是**部分**唯一索引：写成全量唯一索引，软删一份计划之后就再也
//     建不出第二份（而那正是口径允许的操作）。
//   · 搬草稿那条：它**动的是真实数据**，而本机没有 PostgreSQL、跑不了。所以这条测试只做静态审查：
//     幂等靠什么、什么不能被搬、采购员填过的字段有没有丢。真实执行只能等部署（见设计文档 §9）。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const API_ROOT = path.join(__dirname, "..", "..");
const MIGRATIONS = path.join(API_ROOT, "prisma", "migrations");
const DDL_NAME = "20260928090000_purchase_plan";
const BACKFILL_NAME = "20260928100000_purchase_plan_backfill_drafts";
const ddlRaw = fs.readFileSync(path.join(MIGRATIONS, DDL_NAME, "migration.sql"), "utf8");
const backfillRaw = fs.readFileSync(path.join(MIGRATIONS, BACKFILL_NAME, "migration.sql"), "utf8");
/** 去掉注释行再断言：注释里写了什么不算数（引用旧写法的注释不能让守卫变红）。 */
const ddl = ddlRaw.replace(/^--.*$/gm, "");
const backfill = backfillRaw.replace(/^--.*$/gm, "");
const schema = fs.readFileSync(path.join(API_ROOT, "prisma", "schema.prisma"), "utf8");
/** PurchasePlan 模型块（下一个模型的注释之前）。 */
const planModel = schema.slice(schema.indexOf("model PurchasePlan {"), schema.indexOf("/// 采购计划的一行"));

test("purchase-plan 迁移：建表那条只建这两张表，别顺手动别的表", () => {
  const created = [...ddl.matchAll(/CREATE TABLE "([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(created, ["purchase_plans", "purchase_plan_items"]);
  // ALTER TABLE 只用来加外键，且只加在这两张表上。
  const altered = new Set([...ddl.matchAll(/ALTER TABLE "([^"]+)"/g)].map((match) => match[1]));
  assert.deepEqual([...altered].sort(), ["purchase_plan_items", "purchase_plans"]);
});

test("purchase-plan 迁移：可选关系必须 ON DELETE SET NULL，必填关系必须 RESTRICT", () => {
  for (const [column, target] of [["supplier_id", "suppliers"], ["bom_item_id", "bom_items"], ["purchase_order_item_id", "purchase_order_items"]]) {
    assert.match(
      ddl,
      new RegExp(`ALTER TABLE "purchase_plan_items" ADD CONSTRAINT "purchase_plan_items_${column}_fkey" FOREIGN KEY \\("${column}"\\) REFERENCES "${target}"\\("id"\\) ON DELETE SET NULL ON UPDATE CASCADE;`),
      `${column} 是可选关系，RESTRICT 会与 schema 漂移`,
    );
  }
  for (const [column, target] of [["plan_id", "purchase_plans"], ["material_id", "materials"], ["unit_id", "units"]]) {
    assert.match(ddl, new RegExp(`"purchase_plan_items_${column}_fkey" FOREIGN KEY \\("${column}"\\) REFERENCES "${target}"\\("id"\\) ON DELETE RESTRICT ON UPDATE CASCADE;`), `${column} 是必填关系`);
  }
  assert.match(ddl, /"purchase_plans_sales_order_id_fkey" FOREIGN KEY \("sales_order_id"\) REFERENCES "sales_orders"\("id"\) ON DELETE RESTRICT ON UPDATE CASCADE;/);
  assert.match(ddl, /"purchase_plans_bom_id_fkey" FOREIGN KEY \("bom_id"\) REFERENCES "boms"\("id"\) ON DELETE RESTRICT ON UPDATE CASCADE;/);
  // 可选关系的三条里不能出现 RESTRICT（这就是"照抄上一行"会犯的错）。
  const optionalBlocks = ddl.match(/FOREIGN KEY \("(supplier_id|bom_item_id|purchase_order_item_id)"\)[^;]*;/g) ?? [];
  assert.equal(optionalBlocks.length, 3);
  assert.equal(optionalBlocks.some((block) => /RESTRICT/.test(block)), false, "可选关系写成 RESTRICT = 长期漂移");
  assert.match(schema, /supplier\s+Supplier\?\s+@relation\(fields: \[supplierId\]/, "前提：schema 里这三条关系确实是可选的");
  assert.match(schema, /bomItem\s+BomItem\?\s+@relation\(fields: \[bomItemId\]/, "前提：schema 里这三条关系确实是可选的");
  assert.match(schema, /purchaseOrderItem\s+PurchaseOrderItem\?\s+@relation\(fields: \[purchaseOrderItemId\]/, "前提：schema 里这三条关系确实是可选的");
});

test("purchase-plan 迁移：「一个 BOM 一份计划」必须是**部分**唯一索引，且 schema 里不能声明 @unique", () => {
  assert.match(
    ddl,
    /CREATE UNIQUE INDEX "purchase_plans_bom_id_active_key" ON "purchase_plans"\("bom_id"\) WHERE "deleted_at" IS NULL;/,
    "照抄 20260826100000_unique_editable_bom 对 boms 的做法",
  );
  // schema 里若写 @unique / @@unique([bomId])，生成的是**全量**唯一索引：
  // 软删一份计划之后就再也建不出第二份，而口径明确允许"删掉没下过单的计划再重来"。
  assert.equal(/bomId[^\n]*@unique/.test(planModel), false, "bomId 上不能声明 @unique（软删后会建不出第二份计划）");
  assert.equal(/@@unique\(\[bomId\]\)/.test(planModel), false, "同上；部分唯一索引只能用 SQL 建");
  assert.match(planModel, /@@index\(\[bomId\]\)/, "普通索引要声明在 schema 里，否则 migrate diff 会想把它 DROP 掉");
});

test("purchase-plan 迁移：计划行与采购明细是 1:1（一条采购明细只能被一行计划认领）", () => {
  assert.match(ddl, /CREATE UNIQUE INDEX "purchase_plan_items_purchase_order_item_id_key" ON "purchase_plan_items"\("purchase_order_item_id"\);/);
  assert.match(schema, /purchaseOrderItemId\s+String\?\s+@unique\s+@map\("purchase_order_item_id"\)/, "可空列上的唯一索引：Postgres 允许多个 NULL，未下单的行不会互相冲突");
  // 反向关系要有，否则 Prisma 校验不过。
  assert.match(schema, /purchasePlanItem\s+PurchasePlanItem\?/, "PurchaseOrderItem 侧要有反向关系");
});

test("purchase-plan 迁移：schema 的反向关系齐全（少一个 Prisma 就校验不过）", () => {
  assert.match(schema, /purchasePlans\s+PurchasePlan\[\]/, "SalesOrder 侧");
  assert.match(schema, /purchasePlanItems\s+PurchasePlanItem\[\]/, "Supplier / Material / Unit / BomItem 侧");
  assert.equal((schema.match(/purchasePlanItems\s+PurchasePlanItem\[\]/g) ?? []).length, 4, "Supplier / Material / Unit / BomItem 各一条");
});

test("purchase-plan 迁移：目录名带 14 位时间戳，且排在既有迁移之后、建表在搬数据之前", () => {
  const names = fs.readdirSync(MIGRATIONS).filter((entry) => fs.statSync(path.join(MIGRATIONS, entry)).isDirectory()).sort();
  for (const name of [DDL_NAME, BACKFILL_NAME]) {
    assert.match(name, /^\d{14}_/);
    assert.ok(names.includes(name), "迁移目录必须在仓库里");
    assert.ok(names.indexOf(name) > names.indexOf("20260927180000_bom_item_supplier"), "Prisma 按目录名顺序执行");
  }
  assert.ok(names.indexOf(DDL_NAME) < names.indexOf(BACKFILL_NAME), "先建表再搬数据");
});

test("backfill 迁移：幂等靠「软删」这个动作本身，不是靠 DELETE/TRUNCATE", () => {
  assert.equal(/\bDELETE\s+FROM\b/i.test(backfill), false, "只软删，不硬删（草稿也是记录）");
  assert.equal(/\bTRUNCATE\b/i.test(backfill), false);
  // 计划侧的 NOT EXISTS：该 BOM 已经有未删计划就跳过（不去动一份已经在用的计划）。
  assert.match(backfill, /AND NOT EXISTS \(\s*SELECT 1 FROM "purchase_plans" pp\s*WHERE pp\."bom_id" = po\."bom_id" AND pp\."deleted_at" IS NULL\s*\)/);
  // 被搬的草稿软删 → 第二遍跑时 status='draft' 已经查不到，什么都不做。
  assert.match(backfill, /UPDATE "purchase_orders" po\s*SET "deleted_at" = NOW\(\)/);
  assert.match(backfill, /UPDATE "purchase_order_items" poi\s*SET "deleted_at" = NOW\(\)/);
});

test("backfill 迁移：什么不搬 —— 没有明细的草稿、没有 bom_id 的草稿", () => {
  assert.match(backfill, /AND EXISTS \(\s*SELECT 1 FROM "purchase_order_items" poi\s*WHERE poi\."purchase_order_id" = po\."id" AND poi\."deleted_at" IS NULL\s*\)/, "一张明细都没有的草稿里没有任何信息，别搬成一份空计划");
  assert.match(backfill, /AND po\."bom_id" IS NOT NULL/, "没有 bom_id 的历史草稿画不出计划，原样留着");
});

test("backfill 迁移：采购员填过的字段一个都不能丢", () => {
  // 单价、数量、交期、供应商（含快照）、型号、物料/单位快照、行上的 extension_data（BOM 外新增原因在里面）。
  for (const column of ["material_snapshot", "unit_snapshot", "supplier_id", "supplier_snapshot", "model", "quantity", "unit_price", "expected_date", "extension_data"]) {
    assert.match(backfill, new RegExp(`poi\\."${column}"`), `${column} 必须原样搬过去`);
  }
  // 草稿从来没有下过单：这一列必须是 NULL，不是随手填一个。
  assert.match(backfill, /poi\."expected_date",\s*NULL,/, "purchase_order_item_id 留空 = 未下单");
});

test("backfill 迁移：三步共用同一份 BOM→计划 映射（不会各算一遍而对不上）", () => {
  assert.match(backfill, /CREATE TEMP TABLE "_purchase_plan_draft_migration"/);
  assert.match(backfill, /ON COMMIT DROP/);
  const uses = (backfill.match(/"_purchase_plan_draft_migration"/g) ?? []).length;
  assert.ok(uses >= 4, `建表 1 次 + 读 3 次（建计划/搬明细/软删），实际 ${uses}`);
  assert.match(backfill, /GROUP BY po\."bom_id"/, "一张 BOM 一行 = 一份计划（多张草稿合并）");
  assert.match(backfill, /ROW_NUMBER\(\) OVER \(PARTITION BY m\."plan_id"/, "合并后序号会重复，必须重排");
});

test("backfill 迁移：计划编号沿用采购单号格式，前缀 PP", () => {
  assert.match(backfill, /'PP-' \|\| to_char\(NOW\(\), 'YYYYMMDD'\)/);
  assert.match(backfill, /gen_random_uuid\(\)/, "主键与编号后缀都靠它");
  assert.match(backfill, /'migrated_from_draft_purchase_orders', true/, "留一条迁移痕迹：以后有人问「这份计划哪来的」，答案在数据里");
});
