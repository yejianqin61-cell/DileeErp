// 迁移守卫：`20260920100000_purchase_order_item_bom_item_index`。
//
// 这一期只有一条索引，但守卫仍然要钉住三件事：
//   1. 只建索引，**不改任何数据、不加任何约束**（BOM 外的补料行本来就没有 bom_item_id，NOT NULL 会直接炸）；
//   2. 索引名与 schema.prisma 里 Prisma 默认命名一致（否则下次 `migrate diff` 会认成两条不同的索引）；
//   3. 目录名带 14 位时间戳且排在既有迁移之后（Prisma 按目录名顺序执行）。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const MIGRATIONS = path.join(__dirname, "..", "..", "prisma", "migrations");
const NAME = "20260920100000_purchase_order_item_bom_item_index";
const sql = fs.readFileSync(path.join(MIGRATIONS, NAME, "migration.sql"), "utf8");
/** 去掉注释后再看语句：注释里为了解释「为什么不能加 NOT NULL」会提到这个词。 */
const statements = sql.replace(/^--.*$/gm, "");
const schema = fs.readFileSync(path.join(__dirname, "..", "..", "prisma", "schema.prisma"), "utf8");

test("bom-item 索引迁移：按 purchase_order_items.bom_item_id 建索引", () => {
  assert.match(statements, /CREATE INDEX "purchase_order_items_bom_item_id_idx" ON "purchase_order_items"\("bom_item_id"\);/);
});

test("bom-item 索引迁移：不改写数据、不加约束", () => {
  assert.equal(/UPDATE\s+/i.test(statements), false);
  assert.equal(/DELETE\s+/i.test(statements), false);
  assert.equal(/INSERT\s+/i.test(statements), false);
  assert.equal(/ALTER TABLE/i.test(statements), false, "纯新增索引，不碰表结构");
  assert.equal(/NOT NULL/.test(statements), false, "BOM 外的补料行没有 bom_item_id，NOT NULL 会直接把历史数据炸掉");
});

test("bom-item 索引迁移：只有这一条语句，不会顺手删掉别的索引", () => {
  assert.equal(/DROP\s+/i.test(statements), false);
  const creates = statements.match(/CREATE INDEX/g) ?? [];
  assert.equal(creates.length, 1, "这条迁移只该建一个索引");
});

test("bom-item 索引迁移：schema.prisma 与迁移一致", () => {
  assert.match(schema, /bomItemId\s+String\?\s+@map\("bom_item_id"\)\s+@db\.Uuid/, "这一列仍可空：补料/替代料行没有 BOM 行号");
  assert.match(schema, /@@index\(\[bomItemId\]\)/, "索引要与迁移里的名字对得上（Prisma 默认命名）");
});

test("bom-item 索引迁移：目录名带 14 位时间戳，且排在既有迁移之后", () => {
  assert.match(NAME, /^\d{14}_/);
  const names = fs.readdirSync(MIGRATIONS).filter((entry) => fs.statSync(path.join(MIGRATIONS, entry)).isDirectory()).sort();
  // 只断言「排在权限角色迁移之后」而不是「是最新的一条」：后面还会有别的迁移加进来，
  // 把「最新」写死只会让这条守卫每隔几天就红一次，而它真正要防的是「跑在了依赖之前」。
  assert.ok(names.indexOf(NAME) > names.indexOf("20260919160000_surface_permission_roles"), "Prisma 按目录名顺序执行，必须排在既有迁移之后");
  assert.ok(names.includes(NAME), "迁移目录必须在仓库里（否则 deploy 时不会执行）");
});
