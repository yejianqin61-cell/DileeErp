// 迁移守卫：`20260920120000_purchase_order_item_supplier_nullable`。
//
// 这是本仓库少见的一条「把约束**放松**」的迁移，所以守卫要钉住的不是"加了什么"，
// 而是「只放松了该放松的两列，别的什么都没动」，以及"为什么可以放松"（下单门禁补上了）。
//   1. 只对 purchase_order_items 的 supplier_id / supplier_snapshot 做 DROP NOT NULL；
//   2. 不改写任何数据（草稿里没有供应商是**事实**，不该被迁移猜一个供应商填上）；
//   3. schema.prisma 与迁移一致；
//   4. 下单门禁确实还在：assertOrderableItems 仍然要求每行都有供应商
//      —— 可空只影响「还没定供应商的草稿」，有下游事实的单必然有供应商。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const MIGRATIONS = path.join(__dirname, "..", "..", "prisma", "migrations");
const NAME = "20260920120000_purchase_order_item_supplier_nullable";
const sql = fs.readFileSync(path.join(MIGRATIONS, NAME, "migration.sql"), "utf8");
/** 去掉注释后再看语句：注释里为了解释「为什么必须放松」会提到 UPDATE / NOT NULL 这些词。 */
const statements = sql.replace(/^--.*$/gm, "");
const schema = fs.readFileSync(path.join(__dirname, "..", "..", "prisma", "schema.prisma"), "utf8");
const service = fs.readFileSync(path.join(__dirname, "..", "..", "src", "modules", "procurement", "purchase-orders.service.ts"), "utf8");

test("supplier-nullable 迁移：只碰明细行的两列与外键动作，别顺手改别的表", () => {
  assert.match(statements, /ALTER TABLE "purchase_order_items" ALTER COLUMN "supplier_id" DROP NOT NULL;/);
  assert.match(statements, /ALTER TABLE "purchase_order_items" ALTER COLUMN "supplier_snapshot" DROP NOT NULL;/);
  // 4 条 ALTER TABLE = 两列 DROP NOT NULL + 外键 DROP/ADD CONSTRAINT（见下一条用例）。
  const alters = statements.match(/ALTER TABLE/g) ?? [];
  assert.equal(alters.length, 4, "只该改这两列与外键动作，别碰别的表或别的列");
  const targets = new Set([...statements.matchAll(/ALTER TABLE "([^"]+)"/g)].map((match) => match[1]));
  assert.deepEqual([...targets], ["purchase_order_items"], "全部语句只能作用在 purchase_order_items 上");
});

test("supplier-nullable 迁移：外键动作必须跟着关系一起改成 SET NULL（否则持续报 6 行漂移）", () => {
  // 这一条是本迁移最容易漏的地方，也是实测踩过的：关系从「必填」改成「可选」后，
  // 只做列上的 DROP NOT NULL 会让 Postgres 侧的 `ON DELETE RESTRICT` 与 Prisma 模型不一致
  // （Prisma 对可选关系一律生成 SET NULL），于是 `prisma migrate diff` 会**长期**报 6 行漂移：
  //   ALTER TABLE ... DROP CONSTRAINT purchase_order_items_supplier_id_fkey;
  //   ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY ... ON DELETE SET NULL ON UPDATE CASCADE;
  // 漂移不是报错而是"悄悄攒着"，所以必须由守卫钉住，而不是靠人每次去看漂移行数。
  assert.match(statements, /ALTER TABLE "purchase_order_items" DROP CONSTRAINT "purchase_order_items_supplier_id_fkey";/);
  assert.match(
    statements,
    /ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_supplier_id_fkey" FOREIGN KEY \("supplier_id"\) REFERENCES "suppliers"\("id"\) ON DELETE SET NULL ON UPDATE CASCADE;/,
    "可选关系的外键动作必须是 SET NULL（本仓库 8 条可选外键的既有口径）",
  );
  // 语义：供应商是可选引用，删供应商不该被一张「还没定供应商」的草稿行挡住。
  assert.equal(/ON DELETE RESTRICT/.test(statements), false, "改回 RESTRICT 就会与 schema 漂移");
  assert.match(schema, /supplier\s+Supplier\?\s+@relation\(fields: \[supplierId\]/, "前提：schema 里这条关系确实已经可选");
});

test("supplier-nullable 迁移：不改写数据、不删行、不加约束", () => {
  // 按**语句开头**判定，而不是整段文本里搜关键词：本迁移的外键动作里带着 `ON UPDATE CASCADE`，
  // 用 /UPDATE\s+/ 去搜会把外键子句误判成"在改写数据"。真正要禁的是以 UPDATE/DELETE/INSERT
  // 开头的**数据写入语句**。
  assert.equal(/^\s*UPDATE\b/im.test(statements), false, "草稿没有供应商是事实，不该被迁移猜一个填上");
  assert.equal(/^\s*DELETE\b/im.test(statements), false);
  assert.equal(/^\s*INSERT\b/im.test(statements), false);
  assert.equal(/DROP\s+(TABLE|COLUMN)/i.test(statements), false);
  assert.equal(/SET NOT NULL/i.test(statements), false);
});

test("supplier-nullable 迁移：schema.prisma 与迁移一致", () => {
  assert.match(schema, /supplierId\s+String\?\s+@map\("supplier_id"\)\s+@db\.Uuid/, "明细行供应商可空");
  assert.match(schema, /supplierSnapshot\s+Json\?\s+@map\("supplier_snapshot"\)/, "快照跟着可空（没有供应商就没有快照）");
  assert.match(schema, /supplier\s+Supplier\?\s+@relation\(fields: \[supplierId\]/, "可选外键的关系字段也必须可选，否则 Prisma 校验不过");
});

test("supplier-nullable 迁移：放松约束的同时，下单门禁仍然要求每行都有供应商", () => {
  // 「一个采购单只有一个供应商」没有丢，只是从数据库挪到了业务门禁。
  assert.match(service, /if \(!item\.supplierId\) reasons\.push\("供应商"\)/, "assertOrderableItems 必须仍然把缺供应商算作明细不完整");
  assert.match(service, /PURCHASE_ORDER_MULTIPLE_SUPPLIERS/, "写入门禁必须挡住「一张单两个供应商」");
  assert.equal(/PURCHASE_ITEM_SUPPLIER_REQUIRED/.test(service), false, "旧的「每行必须有供应商」已经从 refs() 移除（改由下单门禁负责）");
});

test("supplier-nullable 迁移：目录名带 14 位时间戳，且排在既有迁移之后", () => {
  assert.match(NAME, /^\d{14}_/);
  const names = fs.readdirSync(MIGRATIONS).filter((entry) => fs.statSync(path.join(MIGRATIONS, entry)).isDirectory()).sort();
  // 只断言「排在 BOM 行索引迁移之后」：后面还会有别的迁移加进来，把「最新」写死只会让守卫定期变红。
  assert.ok(names.indexOf(NAME) > names.indexOf("20260920100000_purchase_order_item_bom_item_index"), "Prisma 按目录名顺序执行，必须排在既有迁移之后");
  assert.ok(names.includes(NAME), "迁移目录必须在仓库里（否则 deploy 时不会执行）");
});
