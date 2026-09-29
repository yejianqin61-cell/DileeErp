// 迁移守卫：`20260927180000_bom_item_supplier`。
//
// BOM 明细行加「默认供应商」。这条迁移最容易错的地方**不是**加了两列，而是外键动作：
// Prisma 对可选关系一律生成 `ON DELETE SET NULL ON UPDATE CASCADE`，
// 写错（或不写）会让 `prisma migrate diff` 长期报漂移 —— 漂移不报错，只是悄悄攒着，
// 本仓库已经因此有过 6 行漂移的教训。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const MIGRATIONS = path.join(__dirname, "..", "..", "prisma", "migrations");
const NAME = "20260927180000_bom_item_supplier";
const sql = fs.readFileSync(path.join(MIGRATIONS, NAME, "migration.sql"), "utf8");
const statements = sql.replace(/^--.*$/gm, "");
const schema = fs.readFileSync(path.join(__dirname, "..", "..", "prisma", "schema.prisma"), "utf8");
const service = fs.readFileSync(path.join(__dirname, "..", "..", "src", "modules", "sales", "boms.service.ts"), "utf8");

test("bom-item-supplier 迁移：只给 bom_items 加两列，别顺手改别的表", () => {
  assert.match(statements, /ALTER TABLE "bom_items"\s+ADD COLUMN "supplier_id" UUID,\s+ADD COLUMN "supplier_snapshot" JSONB;/);
  const targets = new Set([...statements.matchAll(/ALTER TABLE "([^"]+)"/g)].map((match) => match[1]));
  assert.deepEqual([...targets], ["bom_items"], "语句只能作用在 bom_items 上");
});

test("bom-item-supplier 迁移：两列都可空（历史 BOM 行没有供应商）", () => {
  assert.equal(/NOT NULL/i.test(statements), false, "加 NOT NULL 会让这条迁移在真实库上直接失败");
  assert.equal(/DEFAULT/i.test(statements), false, "没有合理的默认供应商");
});

test("bom-item-supplier 迁移：外键必须是 ON DELETE SET NULL（可选关系的既有口径）", () => {
  assert.match(statements, /ALTER TABLE "bom_items" ADD CONSTRAINT "bom_items_supplier_id_fkey" FOREIGN KEY \("supplier_id"\) REFERENCES "suppliers"\("id"\) ON DELETE SET NULL ON UPDATE CASCADE;/);
  assert.equal(/ON DELETE RESTRICT/.test(statements), false, "改回 RESTRICT 就会与 schema 漂移");
  assert.match(schema, /supplier\s+Supplier\?\s+@relation\(fields: \[supplierId\]/, "前提：schema 里这条关系确实是可选的");
});

test("bom-item-supplier 迁移：索引建在 supplier_id 上（「这个供应商供哪些部件」要能查）", () => {
  assert.match(statements, /CREATE INDEX "bom_items_supplier_id_idx" ON "bom_items"\("supplier_id"\);/);
  assert.match(schema, /@@index\(\[supplierId\]\)/, "索引必须声明在 schema 里，否则 migrate diff 会想把它 DROP 掉");
});

test("bom-item-supplier 迁移：schema 里有列、有快照、有反向关系", () => {
  assert.match(schema, /supplierId\s+String\?\s+@map\("supplier_id"\)\s+@db\.Uuid/);
  assert.match(schema, /supplierSnapshot\s+Json\?\s+@map\("supplier_snapshot"\)/);
  assert.match(schema, /bomItems\s+BomItem\[\]/, "Supplier 侧要有反向关系，否则 Prisma 校验不过");
});

test("bom-item-supplier 迁移：服务层真的校验并落库（列加了却没人写就是白加）", () => {
  assert.match(service, /BOM_SUPPLIER_NOT_FOUND/, "选了不存在/已停用的供应商必须被拒");
  assert.match(service, /supplierId: item\.supplier_id \?\? null/, "写入侧要落 supplier_id");
  assert.match(service, /supplierSnapshot: supplier \?/, "写入侧要落快照（供应商改名后 BOM 上仍看得见当时记的是哪家）");
});

test("bom-item-supplier 迁移：目录名带 14 位时间戳，且排在既有迁移之后", () => {
  assert.match(NAME, /^\d{14}_/);
  const names = fs.readdirSync(MIGRATIONS).filter((entry) => fs.statSync(path.join(MIGRATIONS, entry)).isDirectory()).sort();
  assert.ok(names.includes(NAME), "迁移目录必须在仓库里");
  assert.ok(names.indexOf(NAME) > names.indexOf("20260919140000_sales_order_spec_refinement"), "Prisma 按目录名顺序执行");
});
