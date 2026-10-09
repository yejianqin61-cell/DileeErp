// BOM 行「参考单价 + 币种」的迁移守卫与写入行为（用户 2026-10-08）。
//
// 用户原话：「1.采购计划要下单需要填写单价，但是BOM表没办法填写单价，检查一下这条链路。尤其是前端。」
// 排查结论：前端的单价输入框本来就有（采购计划 → 打开计划），缺的是"价格从哪来"——
// 从 BOM 新建的计划行单价写死 0，采购员只能凭记忆逐行打。用户选定：BOM 行上手填参考单价（含币种），
// 新建采购计划时预填到计划行（仍可改）。
//
// 与「默认供应商」那条迁移（`bom-item-supplier-migration.test.cjs`）同一种写法：
// 迁移守卫（列/可空/不加外键）+ schema 声明 + 服务层真的校验并落库。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { Prisma } = require("@prisma/client");
const { BomsService } = require("../../dist/modules/sales/boms.service.js");

const API_ROOT = path.join(__dirname, "..", "..");
const MIGRATIONS = path.join(API_ROOT, "prisma", "migrations");
const NAME = "20261008150000_bom_item_reference_price";
const sql = fs.readFileSync(path.join(MIGRATIONS, NAME, "migration.sql"), "utf8");
const statements = sql.replace(/^--.*$/gm, "");
const schema = fs.readFileSync(path.join(API_ROOT, "prisma", "schema.prisma"), "utf8");
const service = fs.readFileSync(path.join(API_ROOT, "src", "modules", "sales", "boms.service.ts"), "utf8");
const controller = fs.readFileSync(path.join(API_ROOT, "src", "modules", "sales", "boms.controller.ts"), "utf8");

/* ------------------------------------------------------------ 一、迁移 */

test("参考单价迁移：只给 bom_items 加两列，别顺手改别的表", () => {
  assert.match(statements, /ALTER TABLE "bom_items"\s+ADD COLUMN "reference_unit_price" DECIMAL\(18,4\),\s+ADD COLUMN "reference_currency" VARCHAR\(10\);/);
  const targets = new Set([...statements.matchAll(/ALTER TABLE "([^"]+)"/g)].map((match) => match[1]));
  assert.deepEqual([...targets], ["bom_items"], "语句只能作用在 bom_items 上");
});

test("参考单价迁移：两列都可空、无默认值（历史 BOM 行没有价，「没填」不等于 0）", () => {
  assert.equal(/NOT NULL/i.test(statements), false, "加 NOT NULL 会让这条迁移在真实库上直接失败");
  assert.equal(/DEFAULT/i.test(statements), false, "`NULL` = 没填，与「填了 0」不是一件事，不该给默认值");
  assert.equal(/FOREIGN KEY/i.test(statements), false, "这两列没有引用别的表");
  assert.equal(/CREATE INDEX/i.test(statements), false, "参考单价不参与任何查询过滤，不需要索引");
});

test("参考单价迁移：schema 里有列、类型与映射名都对", () => {
  assert.match(schema, /referenceUnitPrice\s+Decimal\?\s+@map\("reference_unit_price"\)\s+@db\.Decimal\(18, 4\)/);
  assert.match(schema, /referenceCurrency\s+String\?\s+@map\("reference_currency"\)\s+@db\.VarChar\(10\)/);
});

test("参考单价迁移：目录名带 14 位时间戳，且排在既有迁移之后", () => {
  assert.match(NAME, /^\d{14}_/);
  const names = fs.readdirSync(MIGRATIONS).filter((entry) => fs.statSync(path.join(MIGRATIONS, entry)).isDirectory()).sort();
  assert.ok(names.includes(NAME), "迁移目录必须在仓库里");
  assert.ok(names.indexOf(NAME) > names.indexOf("20260927180000_bom_item_supplier"), "Prisma 按目录名顺序执行");
});

test("参考单价：DTO 收这两个字段（币种限长 10，与销售单/采购单的 currency 同一口径）", () => {
  assert.match(controller, /@IsOptional\(\) @IsString\(\) reference_unit_price\?: string;/);
  assert.match(controller, /@IsOptional\(\) @IsString\(\) @MaxLength\(10\) reference_currency\?: string;/);
});

/* ------------------------------------------------------------ 二、写入行为 */

const user = { id: "00000000-0000-0000-0000-000000000001", username: "operator" };
const audit = { create: () => ({}), update: () => ({ updatedBy: user.id }), record: async () => undefined };

/** 假 Prisma：`boms.findFirst` 给一张空 BOM，`bomItem.createMany` 把落库数据记下来。 */
function harness() {
  const writes = [];
  const bom = { id: "bom-1", status: "draft", orderNo: "SO-1", version: 1, salesOrderId: "order-1", items: [], updatedAt: new Date("2026-10-08T02:00:00.000Z") };
  const tx = {
    async $queryRaw() { return [{ id: "bom-1" }]; },
    bom: { findFirst: async () => ({ updatedAt: bom.updatedAt }), update: async () => bom },
    bomItem: {
      updateMany: async (args) => { writes.push({ kind: "softDelete", args }); },
      createMany: async ({ data }) => { writes.push({ kind: "createMany", data }); },
    },
  };
  const prisma = { bom: { findFirst: async () => bom }, $transaction: async (fn) => fn(tx) };
  return { service: new BomsService(prisma, audit), writes, row: () => writes.find((write) => write.kind === "createMany")?.data?.[0] };
}

const item = (overrides = {}) => ({ material_id: "material-1", material_name: "面料", material_snapshot: { name: "面料" }, required_quantity: "2", unit: "米", ...overrides });

test("参考单价：填了就落库（Decimal + 币种原样存）", async () => {
  const { service: boms, row } = harness();
  await boms.replaceItems("bom-1", [item({ reference_unit_price: "12.5000", reference_currency: "USD" })], user);
  assert.equal(row().referenceUnitPrice.toString(), "12.5", "按四位小数的 Decimal 落库");
  assert.equal(row().referenceCurrency, "USD", "币种不能丢：丢了计划合计就把美元当人民币");
});

test("参考单价：空串 = 没填（存 NULL，不是 0）", async () => {
  const { service: boms, row } = harness();
  await boms.replaceItems("bom-1", [item({ reference_unit_price: "", reference_currency: "" })], user);
  assert.equal(row().referenceUnitPrice, null, "空串必须变成 SQL NULL —— 0 会被读成「这个部件 0 元」");
  assert.equal(row().referenceCurrency, null, "没填价时币种也留空");
});

test("参考单价：不传这两个字段与传空串同解（老前端照旧能保存）", async () => {
  const { service: boms, row } = harness();
  await boms.replaceItems("bom-1", [item()], user);
  assert.equal(row().referenceUnitPrice, null);
  assert.equal(row().referenceCurrency, null);
});

test("参考单价：负数被拒（整表不写），错误码与既有明细校验同一个", async () => {
  const { service: boms, writes } = harness();
  await assert.rejects(
    () => boms.replaceItems("bom-1", [item({ reference_unit_price: "-1" })], user),
    (error) => error.getResponse().code === "INVALID_BOM_ITEM" && /参考单价/.test(error.getResponse().message),
  );
  assert.deepEqual(writes, [], "一行不合法就一个字节都不写");
});

test("参考单价：允许 0（0 = 还没谈价，与没填同解，但库里如实存着用户填过的值）", async () => {
  const { service: boms, row } = harness();
  await boms.replaceItems("bom-1", [item({ reference_unit_price: "0" })], user);
  assert.equal(row().referenceUnitPrice.toString(), "0");
});

test("参考单价：币种单独存在时不报错（所见即所存：选了 USD 没填价，就存 USD）", async () => {
  const { service: boms, row } = harness();
  await boms.replaceItems("bom-1", [item({ reference_currency: "USD" })], user);
  assert.equal(row().referenceUnitPrice, null);
  assert.equal(row().referenceCurrency, "USD");
});

test("参考单价：服务层确实把它写进 createMany 的数据（列加了却没人写就是白加）", () => {
  assert.match(service, /referenceUnitPrice: \(item\.reference_unit_price \?\? ""\)\.trim\(\) === "" \? null : new Prisma\.Decimal\(/);
  assert.match(service, /referenceCurrency: \(item\.reference_currency \?\? ""\)\.trim\(\) \|\| null/);
  assert.equal(new Prisma.Decimal("12.5000").toFixed(4), "12.5000", "前提：Prisma Decimal 的 toFixed(4) 是计划预填用到的口径");
});
