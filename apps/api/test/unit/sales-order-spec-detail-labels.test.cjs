// 细分明细的自定义列名（2026-09-30，用户原话：「细分明细那边，可以改成自定义字段名称」）。
//
// 这个功能只有一条真规则：**列名是显示名，数据形状一个字都不许动**。
// 所以这份测试钉四层：
//   ① 迁移：一个 JSON 列、NOT NULL DEFAULT '{}'、不动别的表、不改写数据；
//   ② 归一：只认 6 个列键、去空格、空值 = 用默认名、不认识/太长的键当场报错（不静默忽略）；
//   ③ 存：创建写入、更新整块替换（`{}` = 全部恢复默认）、没传 = 不动、返单从来源单沿用；
//   ④ 印：导出件用这一单改过的名字（含版本快照那种请求键形状），没改的列仍用默认名。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const ExcelJS = require("exceljs");
const {
  SPEC_DETAIL_LABELS,
  SPEC_DETAIL_LABEL_MAX_LENGTH,
  SalesOrdersService,
  normalizeSpecDetailLabels,
  specDetailLabelsWithDefaults,
} = require("../../dist/modules/sales/sales-orders.service.js");
const { SalesOrderExportService, specDetailLabelsOf } = require("../../dist/modules/sales/sales-order-export.service.js");

const MIGRATIONS = path.join(__dirname, "..", "..", "prisma", "migrations");
const NAME = "20260930120000_sales_order_spec_detail_labels";
const migrationSql = fs.readFileSync(path.join(MIGRATIONS, NAME, "migration.sql"), "utf8");
/** 去掉注释后再看语句：注释里为了解释取舍会提到 NOT NULL / 索引这些词。 */
const statements = migrationSql.replace(/^--.*$/gm, "");
const schema = fs.readFileSync(path.join(__dirname, "..", "..", "prisma", "schema.prisma"), "utf8");

const user = { id: "00000000-0000-0000-0000-0000000000aa", username: "sales", display_name: "张三" };
const audit = { create: () => ({ createdBy: user.id, updatedBy: user.id }), update: () => ({ updatedBy: user.id }), softDelete: () => ({ deletedAt: new Date(), deletedBy: user.id, updatedBy: user.id }), record: async () => {} };
const ORDER_ID = "33333333-3333-4333-8333-333333333333";
const CUSTOMER_ID = "11111111-1111-4111-8111-111111111111";
/** 返单来源单（必须有货号：老单没货号不能返单，那是既有的业务规则）。 */
const sourceRow = (extra = {}) => ({ id: ORDER_ID, orderNo: "SO-1", status: "confirmed", currentVersion: 1, customerId: CUSTOMER_ID, customer: { id: CUSTOMER_ID, name: "家百纳" }, contact: null, versions: [], boms: [], specDetails: [], materialRefs: [], materialExtras: [], specDetailLabels: { name: "伞头英文名" }, itemNo: "27621", orderDate: new Date(), quantity: "10", unit: "支", currency: "USD", extensionData: {}, ...extra });

// ------------------------------------------------------------------ ① 迁移

test("迁移：只给 sales_orders 加一个 JSON 列（NOT NULL DEFAULT '{}'），别顺手改别的表", () => {
  assert.match(statements, /ALTER TABLE "sales_orders"\s+ADD COLUMN "spec_detail_labels" JSONB NOT NULL DEFAULT '\{\}';/);
  assert.equal((statements.match(/ALTER TABLE/g) ?? []).length, 1, "只该有一条 ALTER TABLE");
  assert.deepEqual([...new Set([...statements.matchAll(/ALTER TABLE "([^"]+)"/g)].map((match) => match[1]))], ["sales_orders"]);
  for (const table of ["sales_order_spec_details", "sales_order_material_refs", "purchase_orders", "production_orders"]) {
    assert.equal(statements.includes(`"${table}"`), false, `列名只是显示名，不该碰到 ${table}`);
  }
});

test("迁移：NOT NULL + 默认空对象（读侧不必处理两种空），且不建索引、不删任何东西、不改写数据", () => {
  assert.match(statements, /NOT NULL DEFAULT '\{\}'/, "空对象 = 全部用默认列名；这样读侧不用区分 SQL NULL 与 JSON null");
  assert.equal(/CREATE .*INDEX/i.test(statements), false, "这一列只随行读，从不做查询条件");
  assert.equal(/UNIQUE/i.test(statements), false);
  assert.equal(/FOREIGN KEY|REFERENCES/i.test(statements), false);
  assert.equal(/DROP\s+(TABLE|COLUMN|CONSTRAINT)/i.test(statements), false, "只新增，不删除既有结构");
  assert.equal(/^\s*(UPDATE|DELETE|INSERT)\b/im.test(statements), false, "结构迁移，不改写数据");
});

test("迁移：schema.prisma 与迁移一致（Json + 默认空对象 + @map）", () => {
  assert.match(schema, /specDetailLabels\s+Json\s+@default\("\{\}"\)\s+@map\("spec_detail_labels"\)/);
});

test("迁移：目录名带 14 位时间戳，且排在销售单细化迁移与货号迁移之后", () => {
  assert.match(NAME, /^\d{14}_/);
  const names = fs.readdirSync(MIGRATIONS).filter((entry) => fs.statSync(path.join(MIGRATIONS, entry)).isDirectory()).sort();
  assert.ok(names.includes(NAME), "迁移目录必须在仓库里（否则 deploy 时不会执行）");
  assert.ok(names.indexOf(NAME) > names.indexOf("20260919140000_sales_order_spec_refinement"));
  assert.ok(names.indexOf(NAME) > names.indexOf("20260927090000_sales_order_item_no"));
});

// ------------------------------------------------------------------ ② 归一

test("归一：去空格、丢空值（空 = 用默认名），只保留 6 个已知列键", () => {
  assert.deepEqual(normalizeSpecDetailLabels({ name: "  品名  ", color: "配色", barcode: "", quantity: "   " }), { name: "品名", color: "配色" });
  assert.deepEqual(normalizeSpecDetailLabels({}), {});
  assert.deepEqual(normalizeSpecDetailLabels(null), {});
  assert.deepEqual(normalizeSpecDetailLabels(undefined), {});
  assert.equal(SPEC_DETAIL_LABELS.length, 6, "可自定义的列就是细分明细那 6 列");
});

test("归一：不认识的列键当场报错（静默忽略的表现是「改了名、导出还是老名」，那种错查不出来）", () => {
  assert.throws(
    () => normalizeSpecDetailLabels({ price: "单价" }),
    (error) => error.getResponse().code === "SPEC_DETAIL_LABEL_KEY_UNSUPPORTED" && error.getResponse().message.includes("price"),
  );
});

test("归一：列名超长报错，消息里说清上限", () => {
  assert.throws(
    () => normalizeSpecDetailLabels({ name: "名".repeat(SPEC_DETAIL_LABEL_MAX_LENGTH + 1) }),
    (error) => error.getResponse().code === "SPEC_DETAIL_LABEL_TOO_LONG" && error.getResponse().details[0].max === SPEC_DETAIL_LABEL_MAX_LENGTH,
  );
  assert.equal(normalizeSpecDetailLabels({ name: "名".repeat(SPEC_DETAIL_LABEL_MAX_LENGTH) }).name.length, SPEC_DETAIL_LABEL_MAX_LENGTH, "正好等于上限要放行");
});

test("默认名与覆盖合并：没改的列用默认名，空覆盖回落默认名，不认识的值当没填", () => {
  const merged = specDetailLabelsWithDefaults({ name: "品名", quantity: "   " , price: "单价" });
  assert.equal(merged.name, "品名");
  assert.equal(merged.quantity, "数量", "空覆盖 = 默认名");
  assert.equal(merged.group_name, "分组名");
  assert.equal(merged.unit, "单位");
  assert.equal(Object.keys(merged).length, 6, "不认识的值不产生第 7 个键");
  assert.deepEqual(specDetailLabelsWithDefaults(null), { group_name: "分组名", name: "品番/品名", color: "颜色/配色", barcode: "条码", quantity: "数量", unit: "单位" });
});

// ------------------------------------------------------------------ ③ 存

/** 假 prisma：只实现 create / update 两条路要用的那几张表（与 material-refs 那份同形）。 */
function writeHarness({ sourceRow = null } = {}) {
  const calls = { create: [], update: [] };
  const emptyRow = { id: ORDER_ID, orderNo: "SO-1", status: "draft", currentVersion: 1, customerId: CUSTOMER_ID, customer: { id: CUSTOMER_ID, name: "家百纳" }, contact: null, versions: [], boms: [], specDetails: [], materialRefs: [], materialExtras: [], specDetailLabels: {}, orderDate: new Date(), quantity: "10", unit: "支", currency: "USD", extensionData: {} };
  const tx = {
    salesOrder: {
      create: async ({ data }) => { calls.create.push(data); return { id: ORDER_ID, orderNo: "SO-1", ...data }; },
      update: async ({ data }) => { calls.update.push(data); return { id: ORDER_ID, orderNo: "SO-1", ...data }; },
    },
    salesOrderVersion: { create: async ({ data }) => data },
    salesOrderSpecDetail: { updateMany: async () => ({}), createMany: async () => ({}) },
    salesOrderMaterialRef: { findMany: async () => [], update: async (args) => args.data, createMany: async () => ({ count: 1 }) },
    // 「其它」行（2026-10-08）：返单会把来源单的空列表照抄过来（= 显式清空），所以这条路真的会写一次。
    salesOrderMaterialExtra: { updateMany: async () => ({ count: 0 }), createMany: async ({ data }) => ({ count: data.length }) },
  };
  const prisma = {
    customer: { findFirst: async () => ({ id: CUSTOMER_ID, customerCode: "CUS-1", name: "家百纳", isActive: true }) },
    customerContact: { findFirst: async () => null },
    material: { findMany: async () => [] },
    salesOrder: { findFirst: async () => sourceRow ?? emptyRow },
    $transaction: async (fn) => fn(tx),
  };
  return { service: new SalesOrdersService(prisma, audit), calls };
}

const baseInput = { order_no: "SO-1", customer_id: CUSTOMER_ID, order_date: "2026-09-30", product_name: "雨伞", quantity: "10", unit: "支", currency: "USD" };

test("创建：列名（归一后）落进 spec_detail_labels 这一列", async () => {
  const { service, calls } = writeHarness();
  await service.create({ ...baseInput, spec_detail_labels: { name: "品名", color: " 配色 ", barcode: "" } }, user);
  assert.deepEqual(calls.create[0].specDetailLabels, { name: "品名", color: "配色" }, "空值不进库（空 = 用默认名）");
});

test("创建：没传这一块时落空对象（不是 undefined —— 列是 NOT NULL）", async () => {
  const { service, calls } = writeHarness();
  await service.create(baseInput, user);
  assert.deepEqual(calls.create[0].specDetailLabels, {});
});

test("更新：整块替换 —— 传 {} 就是把列名全部恢复默认", async () => {
  const { service, calls } = writeHarness();
  await service.update(ORDER_ID, { spec_detail_labels: {} }, user);
  assert.deepEqual(calls.update[0].specDetailLabels, {});
});

test("更新：没传这一块 = 不动（既不覆盖也不清空）", async () => {
  const { service, calls } = writeHarness();
  await service.update(ORDER_ID, { product_name: "雨伞2" }, user);
  assert.equal("specDetailLabels" in calls.update[0], false);
});

test("返单：请求没带列名时沿用来源单的（列名属于「上一批的工艺口径」）", async () => {
  const { service, calls } = writeHarness({ sourceRow: sourceRow() });
  await service.create({ ...baseInput, order_no: "SO-2", reorder_from_order_no: "SO-1" }, user);
  assert.deepEqual(calls.create[0].specDetailLabels, { name: "伞头英文名" });
});

test("返单：请求自己带了列名就按请求的（用户当场改了就以他改的为准）", async () => {
  const { service, calls } = writeHarness({ sourceRow: sourceRow() });
  await service.create({ ...baseInput, order_no: "SO-2", reorder_from_order_no: "SO-1", spec_detail_labels: { name: "品名" } }, user);
  assert.deepEqual(calls.create[0].specDetailLabels, { name: "品名" });
});

// ------------------------------------------------------------------ ④ 印

const detailOrder = (extra = {}) => ({
  id: ORDER_ID, orderNo: "DL260134", orderDate: new Date("2026-09-01T00:00:00.000Z"), deliveryDate: null,
  productName: "雨伞", productSpec: null, quantity: "10", unit: "支", createdBy: user.id,
  customer: { name: "家百纳", countryRegion: "日本" },
  specDetails: [{ groupName: "伞头配色", name: "Hawái", color: "配色按图片", barcode: "4894300069470", quantity: "167", unit: "打", sortOrder: 0 }],
  specDetailLabels: {},
  ...extra,
});

const exportService = (row) => new SalesOrderExportService({ salesOrder: { findFirst: async () => row } }, { namesOf: async () => new Map([[user.id, "张三"]]) });

/**
 * 读回工作表：行数组 + 明细表头那一行。
 *
 * 行是**稠密 0 起数组**（与 `sales-order-production-sheet.test.cjs` 的 `readSheet` 同一口径）：
 * A=0 / B=1 / C=2 / D=3 / E=4 / F=5 / G=6 —— 表头行认「图片」那一格（C 列，固定列名）。
 */
async function readDetailHeader(row) {
  const { buffer } = await exportService(row).exportOrder(ORDER_ID);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const rows = [];
  workbook.worksheets[0].eachRow((line) => {
    const values = [];
    line.eachCell({ includeEmpty: true }, (cell) => values.push(cell.value));
    rows.push(values);
  });
  const headerIndex = rows.findIndex((line) => line[2] === "图片");
  assert.ok(headerIndex > 0, "明细表头行必须能按「图片」这一格找到（否则后面的断言都是在空数组上比）");
  return { rows, header: rows[headerIndex], headerIndex };
}

test("导出：没改过列名的单子印默认 6 个名字", async () => {
  const doc = exportService(detailOrder()).document(detailOrder(), "张三");
  assert.deepEqual(doc.detailLabels, { group_name: "分组名", name: "品番/品名", color: "颜色/配色", barcode: "条码", quantity: "数量", unit: "单位" });
  const { header } = await readDetailHeader(detailOrder());
  assert.equal(header[0], "品番/品名");
  assert.equal(header[2], "图片", "「图片」不是明细字段，列名固定");
  assert.equal(header[3], "颜色/配色");
  assert.equal(header[4], "条码");
  assert.equal(header[5], "数量");
  assert.equal(header[6], "单位");
});

test("导出：改过列名的单子按改过的印，没改的列仍用默认名", async () => {
  const row = detailOrder({ specDetailLabels: { name: "伞头英文名字", quantity: "数量/打" } });
  const doc = exportService(row).document(row, "张三");
  assert.equal(doc.detailLabels.name, "伞头英文名字");
  assert.equal(doc.detailLabels.quantity, "数量/打");
  assert.equal(doc.detailLabels.color, "颜色/配色", "没改的列回落默认");

  const { header, rows } = await readDetailHeader(row);
  assert.equal(header[0], "伞头英文名字");
  assert.equal(header[5], "数量/打");
  assert.equal(header[3], "颜色/配色");
  // 数据行仍然落在原来的列上（改了名字，数据形状不许动）
  const dataRow = rows[rows.findIndex((line) => line[2] === "图片") + 1];
  assert.equal(dataRow[0], "Hawái");
  assert.equal(dataRow[5], 167, "数量仍是数值单元格");
});

test("导出：版本快照那种请求键形状（spec_detail_labels）也认得", async () => {
  const snapshotShaped = { ...detailOrder(), spec_detail_labels: { name: "品名（快照）" } };
  delete snapshotShaped.specDetailLabels;
  assert.deepEqual(specDetailLabelsOf(snapshotShaped), { name: "品名（快照）" });
  const doc = exportService(snapshotShaped).document(snapshotShaped, "张三");
  assert.equal(doc.detailLabels.name, "品名（快照）");
  const { header } = await readDetailHeader(snapshotShaped);
  assert.equal(header[0], "品名（快照）");
});

test("导出：列名里的脏数据（非字符串、空串）一律回落默认名，不会印出 undefined", async () => {
  const row = detailOrder({ specDetailLabels: { name: 42, color: "   ", unit: "打" } });
  const doc = exportService(row).document(row, "张三");
  assert.equal(doc.detailLabels.name, "品番/品名");
  assert.equal(doc.detailLabels.color, "颜色/配色");
  assert.equal(doc.detailLabels.unit, "打");
  assert.equal(Object.values(doc.detailLabels).includes(undefined), false);
});
