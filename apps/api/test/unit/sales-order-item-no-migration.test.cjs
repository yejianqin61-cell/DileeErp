// 迁移守卫：`20260927090000_sales_order_item_no`。
//
// 这条迁移只做三件事：给 sales_orders 加两列、建一个复合索引。守卫要钉住的不是"加了什么"
// （读 SQL 就知道），而是**设计里明确不做的那些事**，因为它们很容易被后来的人顺手补上：
//   1. 不加 NOT NULL —— 历史单没有货号，加了会让迁移在真实库上失败；
//   2. 不加唯一约束 —— 返单的本质就是同一货号多张单，唯一约束会把功能禁掉；
//   3. 不建外键 —— 返单来源存文本快照，返单链不该因老单被删而断裂；
//   4. 不碰下游表 —— 货号只活在 sales_orders 上（下游已冗余 order_no，货号走订单号反查）；
//   5. 不改写任何数据 —— 没有货号是**事实**，不该被迁移猜一个填上。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const MIGRATIONS = path.join(__dirname, "..", "..", "prisma", "migrations");
const NAME = "20260927090000_sales_order_item_no";
const sql = fs.readFileSync(path.join(MIGRATIONS, NAME, "migration.sql"), "utf8");
/** 去掉注释后再看语句：注释里为了解释取舍会提到 NOT NULL / 唯一约束这些词。 */
const statements = sql.replace(/^--.*$/gm, "");
const schema = fs.readFileSync(path.join(__dirname, "..", "..", "prisma", "schema.prisma"), "utf8");

test("item-no 迁移：只给 sales_orders 加两列，别顺手改别的表", () => {
  assert.match(statements, /ALTER TABLE "sales_orders"\s+ADD COLUMN "item_no" VARCHAR\(100\),\s+ADD COLUMN "reorder_from_order_no" VARCHAR\(100\);/);
  const alters = statements.match(/ALTER TABLE/g) ?? [];
  assert.equal(alters.length, 1, "只该有一条 ALTER TABLE");
  const targets = new Set([...statements.matchAll(/ALTER TABLE "([^"]+)"/g)].map((match) => match[1]));
  assert.deepEqual([...targets], ["sales_orders"], "语句只能作用在 sales_orders 上");
  // 货号不冗余到下游：这条断言是设计决策的守卫，不是凑数。
  for (const table of ["purchase_orders", "production_orders", "finished_goods_qc_records", "boms", "purchase_receipts", "incoming_inspections"]) {
    assert.equal(statements.includes(`"${table}"`), false, `货号不冗余到 ${table}：下游只保留 order_no，货号按订单号集合反查`);
  }
});

test("item-no 迁移：两列都可空、无默认值", () => {
  assert.equal(/NOT NULL/i.test(statements), false, "历史单没有货号，加 NOT NULL 会让迁移在真实库上失败");
  assert.equal(/DEFAULT/i.test(statements), false, "没有合理的默认货号：默认值等于替业务猜");
  assert.equal(/SET NOT NULL/i.test(statements), false);
});

test("item-no 迁移：不加唯一约束、不建外键（返单就是同一货号多张单）", () => {
  assert.equal(/UNIQUE/i.test(statements), false, "唯一约束会把「返单」这个功能本身禁掉");
  assert.equal(/FOREIGN KEY|REFERENCES/i.test(statements), false, "返单来源存文本快照，不建自引用外键");
  assert.equal(/DROP\s+(TABLE|COLUMN|CONSTRAINT)/i.test(statements), false, "只新增，不删除任何既有结构");
});

test("item-no 迁移：索引是 (item_no, order_date) 复合索引，且不是唯一索引", () => {
  assert.match(statements, /CREATE (?!UNIQUE )INDEX "sales_orders_item_no_order_date_idx" ON "sales_orders"\("item_no", "order_date"\);/);
  const creates = statements.match(/CREATE [A-Z ]*INDEX/g) ?? [];
  assert.equal(creates.length, 1, "只该建一个索引");
});

test("item-no 迁移：不改写数据", () => {
  // 按**语句开头**判定：注释里会出现"填上"这类词，整段搜关键词会误判。
  assert.equal(/^\s*UPDATE\b/im.test(statements), false, "没有货号是事实，不该被迁移猜一个填上");
  assert.equal(/^\s*DELETE\b/im.test(statements), false);
  assert.equal(/^\s*INSERT\b/im.test(statements), false);
});

test("item-no 迁移：schema.prisma 与迁移一致", () => {
  assert.match(schema, /itemNo\s+String\?\s+@map\("item_no"\)\s+@db\.VarChar\(100\)/, "货号可空、100 字");
  assert.match(schema, /reorderFromOrderNo\s+String\?\s+@map\("reorder_from_order_no"\)\s+@db\.VarChar\(100\)/, "返单来源单号可空、100 字");
  assert.match(schema, /@@index\(\[itemNo, orderDate\]\)/, "索引必须声明在 schema 里，否则 migrate diff 会长期报漂移");
  // 与列的可空性一致：两列都没有 `!`（Prisma 里 String? 才是可空）。
  assert.equal(/itemNo\s+String[^?]/.test(schema), false);
});

test("item-no 迁移：目录名带 14 位时间戳，且排在既有迁移之后", () => {
  assert.match(NAME, /^\d{14}_/);
  const names = fs.readdirSync(MIGRATIONS).filter((entry) => fs.statSync(path.join(MIGRATIONS, entry)).isDirectory()).sort();
  assert.ok(names.includes(NAME), "迁移目录必须在仓库里（否则 deploy 时不会执行）");
  // 只断言「排在销售单细化字段迁移之后」：后面还会有别的迁移加进来，把「最新」写死只会让守卫定期变红。
  assert.ok(names.indexOf(NAME) > names.indexOf("20260919140000_sales_order_spec_refinement"), "Prisma 按目录名顺序执行，必须排在既有迁移之后");
});
