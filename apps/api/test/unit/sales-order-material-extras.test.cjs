// 销售单「材料明细 → 其它」自定义类目行（用户 2026-10-08）。
//
// 用户原话：「材料明细最后还需要加一个『其它』，可以自行添加类目。有时候还需要别的物料。
// 允许用户增删改」。
//
// 七件事钉死：
//   ① 上限与长度上限（与前端 `apps/web/lib/sales-order-spec.ts` 同一组数字）；
//   ② 归一：去空格、丢整行空、补 sort_order；类目必填、内容与引用至少有一个、条数封顶，
//      各自的错误码要能点名（静默丢弃会让"点了保存却没存上"变成一个查不出来的问题）；
//   ③ 写入是**整块替换**：软删旧的 + 建新的；`undefined` = 不动、`[]` = 清空；
//   ④ 引用的物料必须真实存在且未删除，缺了**一个字节都不写**；
//   ⑤ 进版本快照；返单照抄来源单（物料被删掉时保留文字、只摘引用，并把这件事回报出来）；
//   ⑥ 工艺单：18 项之后印这些行，内容空时用引用物料的摘要兜底；
//   ⑦ 图片导出候选带 `extra:<行 id>` 键、排在 18 项之后；过期的键要报错（不能把图配到别的行上）。
//   ⑧ 迁移里两条外键的 `ON DELETE` 必须与 schema 声明的一致（见文件末尾那一节）。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const ExcelJS = require("exceljs");
const {
  MATERIAL_EXTRA_CONTENT_MAX_LENGTH,
  MATERIAL_EXTRA_LABEL_MAX_LENGTH,
  MATERIAL_EXTRA_LIMIT,
  SalesOrdersService,
  normalizeMaterialExtras,
} = require("../../dist/modules/sales/sales-orders.service.js");
const {
  SalesOrderExportService,
  materialExtraRefKey,
} = require("../../dist/modules/sales/sales-order-export.service.js");

const user = { id: "00000000-0000-0000-0000-0000000000aa", username: "sales", display_name: "张三" };
const audit = { create: () => ({ createdBy: user.id, updatedBy: user.id }), update: () => ({ updatedBy: user.id }), softDelete: () => ({ deletedAt: new Date(), deletedBy: user.id, updatedBy: user.id }), record: async () => {} };
const MATERIAL_A = "11111111-1111-1111-1111-111111111111";
const MATERIAL_B = "22222222-2222-2222-2222-222222222222";
const ORDER_ID = "33333333-3333-3333-3333-333333333333";
const EXTRA_ID = "55555555-5555-5555-5555-555555555555";
const EXTRA_ID_2 = "66666666-6666-6666-6666-666666666666";

/** 一个合法的 JPEG（只看头三个字节，Service 不解码；ExcelJS 也只看扩展名）。 */
const jpeg = (size = 64) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(Math.max(0, size - 4), 0x41)]);

// ------------------------------------------------------------------ ①② 清单与校验

test("「其它」的上限与长度上限：与前端 lib/sales-order-spec.ts 是同一组数字", () => {
  assert.equal(MATERIAL_EXTRA_LIMIT, 20);
  assert.equal(MATERIAL_EXTRA_LABEL_MAX_LENGTH, 50);
  assert.equal(MATERIAL_EXTRA_CONTENT_MAX_LENGTH, 1000);
});

test("归一：去空格、丢整行空、按剩余行的先后补 sort_order", () => {
  const rows = normalizeMaterialExtras([
    { label: "  弹簧  ", content: " 5cm 不锈钢 " },
    { label: "  ", content: "" }, // 整行空 = 加了行还没填 → 丢掉（不占行号，也不报错）
    { label: "胶袋", content: "", material_id: MATERIAL_A },
  ]);
  assert.deepEqual(rows, [
    { label: "弹簧", content: "5cm 不锈钢", materialId: null, sort_order: 0 },
    { label: "胶袋", content: null, materialId: MATERIAL_A, sort_order: 1 },
  ]);
});

test("校验：类目必填 / 内容与引用至少有一个 / 各自超长 / 条数封顶 —— 错误码要能点名", () => {
  const cases = [
    [[{ label: "  ", content: "有内容" }], "MATERIAL_EXTRA_LABEL_REQUIRED"],
    [[{ label: "弹".repeat(MATERIAL_EXTRA_LABEL_MAX_LENGTH + 1), content: "有内容" }], "MATERIAL_EXTRA_LABEL_TOO_LONG"],
    [[{ label: "弹簧", content: "x".repeat(MATERIAL_EXTRA_CONTENT_MAX_LENGTH + 1) }], "MATERIAL_EXTRA_CONTENT_TOO_LONG"],
    [[{ label: "弹簧" }], "MATERIAL_EXTRA_CONTENT_REQUIRED"],
    [Array.from({ length: MATERIAL_EXTRA_LIMIT + 1 }, (_value, index) => ({ label: `类目${index}`, content: "有内容" })), "MATERIAL_EXTRA_LIMIT_EXCEEDED"],
  ];
  for (const [input, code] of cases) {
    assert.throws(() => normalizeMaterialExtras(input), (error) => error.getResponse().code === code, `期望 ${code}`);
  }
  // 报错要带行号（逐行提示是界面上的表现方式），超行数那条还要说清"当前几行"。
  assert.throws(() => normalizeMaterialExtras([{ label: "弹簧" }]), (error) => error.getResponse().details[0].row === 1 && error.getResponse().message.includes("第 1 行"));
});

// ------------------------------------------------------------------ ③④⑤ 写入

/** 假 prisma：只实现「其它」行这条路要用的那几张表。 */
function writeHarness({ existing = [], materials = [{ id: MATERIAL_A }, { id: MATERIAL_B }], extras = [], status = "draft", itemNo = null } = {}) {
  const calls = { extraUpdateMany: [], extraCreateMany: [], versionCreate: [], materialFindMany: [] };
  const tx = {
    salesOrder: { create: async ({ data }) => ({ id: ORDER_ID, orderNo: "SO-1", ...data }), update: async ({ data }) => ({ id: ORDER_ID, orderNo: "SO-1", ...data }) },
    salesOrderVersion: { create: async ({ data }) => { calls.versionCreate.push(data); return data; } },
    salesOrderSpecDetail: { updateMany: async () => ({}), createMany: async () => ({}) },
    salesOrderMaterialRef: { findMany: async () => [], update: async () => ({}), createMany: async () => ({}) },
    salesOrderMaterialExtra: {
      updateMany: async (args) => { calls.extraUpdateMany.push(args); return { count: existing.length }; },
      createMany: async (args) => { calls.extraCreateMany.push(args); return { count: args.data.length }; },
    },
  };
  const prisma = {
    customer: { findFirst: async () => ({ id: "customer-1", customerCode: "CUS-1", name: "家百纳", isActive: true }) },
    customerContact: { findFirst: async () => null },
    material: { findMany: async (args) => { calls.materialFindMany.push(args); return materials; } },
    salesOrder: { findFirst: async () => ({ id: ORDER_ID, orderNo: "SO-1", itemNo, status, currentVersion: 1, customerId: "customer-1", customer: { id: "customer-1", name: "家百纳" }, contact: null, versions: [], boms: [], specDetails: [], materialRefs: [], materialExtras: extras, orderDate: new Date(), quantity: "10", unit: "支", currency: "USD", extensionData: {} }) },
    $transaction: async (fn) => fn(tx),
  };
  return { service: new SalesOrdersService(prisma, audit), calls };
}

const baseInput = { order_no: "SO-1", customer_id: "customer-1", order_date: "2026-10-08", product_name: "雨伞", quantity: "10", unit: "支", currency: "USD" };

test("新建：整块写进 sales_order_material_extras，并进版本快照", async () => {
  const { service, calls } = writeHarness();
  await service.create({ ...baseInput, material_extras: [{ label: "弹簧", content: "5cm 不锈钢" }, { label: "胶袋", material_id: MATERIAL_A }] }, user);

  const rows = calls.extraCreateMany[0].data;
  assert.deepEqual(rows.map((row) => [row.label, row.content, row.materialId, row.sortOrder]), [["弹簧", "5cm 不锈钢", null, 0], ["胶袋", null, MATERIAL_A, 1]]);
  assert.equal(rows[0].salesOrderId, ORDER_ID);
  assert.equal(rows[0].createdBy, user.id);
  assert.deepEqual(calls.versionCreate[0].snapshot.material_extras, [{ label: "弹簧", content: "5cm 不锈钢" }, { label: "胶袋", material_id: MATERIAL_A }], "快照要记住「这一版下给工厂的其它行是什么」");
});

test("替换：老的软删 + 新的建；没传 = 一块不动；空数组 = 全清", async () => {
  const replaced = writeHarness({ existing: [{ id: "e-1" }] });
  await replaced.service.update(ORDER_ID, { material_extras: [{ label: "弹簧", content: "x" }] }, user);
  assert.equal(replaced.calls.extraUpdateMany.length, 1);
  assert.equal(replaced.calls.extraUpdateMany[0].where.salesOrderId, ORDER_ID);
  assert.equal(replaced.calls.extraUpdateMany[0].where.deletedAt, null, "只软删还没删的行（已删的不重复写 deletedAt）");
  assert.ok(replaced.calls.extraUpdateMany[0].data.deletedAt instanceof Date);
  assert.equal(replaced.calls.extraUpdateMany[0].data.deletedBy, user.id);
  assert.equal(replaced.calls.extraCreateMany[0].data.length, 1);

  const untouched = writeHarness({ existing: [{ id: "e-1" }] });
  await untouched.service.update(ORDER_ID, { reason: "只改了别的字段" }, user);
  assert.deepEqual(untouched.calls.extraUpdateMany, [], "没提到「其它」就整块不动（连写都不写）");
  assert.deepEqual(untouched.calls.extraCreateMany, []);

  const cleared = writeHarness({ existing: [{ id: "e-1" }] });
  await cleared.service.update(ORDER_ID, { material_extras: [] }, user);
  assert.equal(cleared.calls.extraUpdateMany.length, 1, "空数组 = 清空（软删全部）");
  assert.deepEqual(cleared.calls.extraCreateMany, [], "清空不建新行");
});

test("引用不存在的物料：报 MATERIAL_NOT_FOUND，且一个字节都不写（连软删都不做）", async () => {
  const { service, calls } = writeHarness({ materials: [{ id: MATERIAL_A }] });
  await assert.rejects(
    () => service.update(ORDER_ID, { material_extras: [{ label: "弹簧", material_id: MATERIAL_B }] }, user),
    (error) => error.getResponse().code === "MATERIAL_NOT_FOUND" && error.getResponse().details[0].material_id === MATERIAL_B,
  );
  assert.deepEqual(calls.extraUpdateMany, []);
  assert.deepEqual(calls.extraCreateMany, []);
  assert.deepEqual(calls.materialFindMany[0].where, { id: { in: [MATERIAL_B] }, deletedAt: null });
});

test("返单：照抄来源单的「其它」行（预览与建单两处都带，含引用的物料摘要）", async () => {
  const sourceMaterial = { id: MATERIAL_A, materialCode: "MAT-1", name: "伞骨", specificationModel: "50cm", color: "黑", image: null };
  const extras = [{ id: EXTRA_ID, label: "弹簧", content: "5cm", sortOrder: 0, materialId: MATERIAL_A, material: sourceMaterial }];
  const harness = writeHarness({ extras, status: "confirmed", itemNo: "27621" });

  const preview = await harness.service.reorderPreview("SO-1");
  assert.deepEqual(preview.copy.material_extras, [{ label: "弹簧", content: "5cm", material_id: MATERIAL_A, sort_order: 0, material: sourceMaterial }], "预览要带上物料摘要：编辑器不依赖物料池请求成功也能显示芯片");

  await harness.service.create({ ...baseInput, reorder_from_order_no: "SO-1" }, user);
  assert.deepEqual(harness.calls.extraCreateMany[0].data.map((row) => [row.label, row.content, row.materialId]), [["弹簧", "5cm", MATERIAL_A]]);
});

test("返单：来源单「其它」行引用的物料已被删 —— 保留文字、只摘引用，并把这件事回报出来", async () => {
  const extras = [{ id: EXTRA_ID, label: "弹簧", content: "5cm 不锈钢", sortOrder: 0, materialId: MATERIAL_B, material: null }];
  const harness = writeHarness({ extras, materials: [], status: "confirmed", itemNo: "27621" });

  const created = await harness.service.create({ ...baseInput, reorder_from_order_no: "SO-1" }, user);
  assert.deepEqual(harness.calls.extraCreateMany[0].data.map((row) => [row.label, row.content, row.materialId]), [["弹簧", "5cm 不锈钢", null]], "文字留着，只摘掉引用");
  assert.equal(created.reorder_warnings.length, 1, "剔掉过引用要回报，不静默");
  assert.ok(created.reorder_warnings[0].includes("弹簧"));
});

test("返单：请求自己带了「其它」就按请求的（不再照抄来源单）", async () => {
  const extras = [{ id: EXTRA_ID, label: "来源单的类目", content: "来源单的内容", sortOrder: 0, materialId: null, material: null }];
  const harness = writeHarness({ extras, status: "confirmed", itemNo: "27621" });
  await harness.service.create({ ...baseInput, reorder_from_order_no: "SO-1", material_extras: [{ label: "我改的类目", content: "我写的内容" }] }, user);
  assert.deepEqual(harness.calls.extraCreateMany[0].data.map((row) => row.label), ["我改的类目"]);
});

// ------------------------------------------------------------------ ⑥⑦ 导出

const orderRow = (extra = {}) => ({
  id: ORDER_ID, orderNo: "DL260134", orderDate: new Date("2026-10-01T00:00:00.000Z"), deliveryDate: null,
  productName: "雨伞", productSpec: null, quantity: "10", unit: "支", createdBy: user.id, itemNo: null,
  customer: { name: "家百纳", countryRegion: "日本" }, specDetails: [],
  ribSpec: "50cm 碳纤骨",
  materialRefs: [],
  materialExtras: [
    { id: EXTRA_ID, label: "弹簧", content: "5cm 不锈钢", sortOrder: 0, material: null },
    { id: EXTRA_ID_2, label: "胶袋", content: "", sortOrder: 1, material: { id: MATERIAL_B, materialCode: "MAT-9", name: "胶袋", specificationModel: "200x300", color: null, image: { width: 400, height: 300, sha256: "sha-9" } } },
  ],
  ...extra,
});

const exportService = (row) => new SalesOrderExportService({ salesOrder: { findFirst: async () => row } }, { namesOf: async () => new Map([[user.id, "张三"]]) });

test("导出正文：「其它」行印在 18 项之后，类目名照用户起的字；内容空时用引用物料的摘要兜底", () => {
  const row = orderRow();
  const doc = exportService(row).document(row, "张三");
  assert.deepEqual(doc.materialLines.map((line) => line.label), ["伞骨（孔对孔）", "弹簧", "胶袋"], "固定项在前、「其它」接在最后（用户说的就是「材料明细最后」）");
  assert.equal(doc.materialLines[1].value, "5cm 不锈钢");
  assert.equal(doc.materialLines[2].value, "MAT-9 胶袋 200x300", "没写内容 → 用引用物料的摘要兜底（与 18 格同一条规则）");
});

test("导出正文：既没内容也没引用的「其它」行不印（「空盘位自动省略」没有被这次改动推翻）", () => {
  const row = orderRow({ materialExtras: [{ id: EXTRA_ID, label: "只有类目", content: "", sortOrder: 0, material: null }] });
  const doc = exportService(row).document(row, "张三");
  assert.equal(doc.materialLines.some((line) => line.label === "只有类目"), false);
});

test("导出落格：「其它」行在 Excel 里真的看得见", async () => {
  const row = orderRow();
  const { buffer } = await exportService(row).exportOrder(ORDER_ID);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const texts = [];
  workbook.worksheets[0].eachRow((line) => texts.push(line.values.join(" ")));
  assert.ok(texts.some((text) => text.includes("弹簧") && text.includes("5cm 不锈钢")), "类目与内容要在同一行上");
  assert.ok(texts.some((text) => text.includes("胶袋") && text.includes("MAT-9 胶袋 200x300")));
});

test("图片候选：「其它」行排在 18 项之后，键是 extra:<行 id>，标签用类目名", async () => {
  const row = orderRow({
    materialRefs: [{ specKey: "rib_spec", material: { id: MATERIAL_A, materialCode: "MAT-1", name: "伞骨", specificationModel: "50cm", color: "黑", image: null } }],
  });
  const candidates = await exportService(row).exportImageCandidates(ORDER_ID);
  assert.deepEqual(candidates.map((item) => item.spec_key), ["rib_spec", materialExtraRefKey(EXTRA_ID_2)], "只列「引用了物料」的行（弹簧那行没引用），顺序照印刷顺序（固定项 → 其它）");
  assert.deepEqual(candidates[1], { spec_key: materialExtraRefKey(EXTRA_ID_2), label: "胶袋", material_id: MATERIAL_B, material_code: "MAT-9", material_name: "胶袋 200x300", has_image: true, image_version: "sha-9" });
  assert.equal(materialExtraRefKey(EXTRA_ID), "extra:" + EXTRA_ID, "键里带的是行 id（不是序号）：候选过期时报错，而不是把图配到别的行上");
});

test("带图导出：「其它」行的图能勾选带出（标签用类目名），过期/不存在的键一律拒绝", async () => {
  const service = exportService(orderRow());
  const { buffer } = await service.exportOrderWithImages(ORDER_ID, [{ spec_key: materialExtraRefKey(EXTRA_ID_2), buffer: jpeg() }]);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  assert.equal(workbook.worksheets[0].getImages().length, 1);
  const texts = [];
  workbook.worksheets[0].eachRow((line) => texts.push(line.values.join(" ")));
  assert.ok(texts.some((text) => text.includes("胶袋：MAT-9 胶袋 200x300")), "图片区的标签要认得出是哪一行");

  await assert.rejects(
    () => service.exportOrderWithImages(ORDER_ID, [{ spec_key: materialExtraRefKey("77777777-7777-7777-7777-777777777777"), buffer: jpeg() }]),
    (error) => error.getResponse().code === "PRODUCTION_SHEET_IMAGE_UNSUPPORTED",
  );
  // 「弹簧」那一行没有引用物料：拿它的键来要图同样要拒（否则任意字节都能塞进导出件）。
  await assert.rejects(
    () => service.exportOrderWithImages(ORDER_ID, [{ spec_key: materialExtraRefKey(EXTRA_ID), buffer: jpeg() }]),
    (error) => error.getResponse().code === "PRODUCTION_SHEET_IMAGE_UNSUPPORTED",
  );
});

test("导出取数：物料摘要的 select 必须带 规格/颜色，而且两处（固定栏位 / 其它行）是同一份", async () => {
  // 2026-10-08 补的钉子：这份 select 曾经漏了 specificationModel/color，而**测试夹具带着这两个字段** ——
  // 于是单测全绿、真实导出里「引用了物料但没写字」的兜底文字只剩「MAT-1 伞骨」。夹具比真实查询更"全"
  // 是这类漏洞的温床，所以这里直接钉查询参数。
  let captured = null;
  const service = new SalesOrderExportService({ salesOrder: { findFirst: async (args) => { captured = args; return orderRow(); } } }, { namesOf: async () => new Map() });
  await service.exportImageCandidates(ORDER_ID);
  const fixed = captured.include.materialRefs.include.material.select;
  const extras = captured.include.materialExtras.include.material.select;
  assert.equal(fixed.specificationModel, true);
  assert.equal(fixed.color, true);
  assert.deepEqual(Object.keys(extras).sort(), Object.keys(fixed).sort(), "两处物料摘要必须是同一份 select（否则「其它」行的兜底文字会少字段）");
  assert.equal(captured.include.materialExtras.orderBy.sortOrder, "asc", "这些行是有序的（用户排的先后就是纸上的先后）");
});

// ------------------------------------------------------------------ ⑧ 迁移与 schema 的外键口径

/**
 * 2026-10-08 的漏洞（部署 agent 在影子库上发现，上线前修掉）：迁移把**两条**外键都写成了
 * `ON DELETE RESTRICT`（注释里写的是"外键一律 RESTRICT"），但 `material_id` 是**可空**的，
 * Prisma 对可空外键的默认是 `SET NULL` —— schema 与本文件不一致，`prisma migrate diff` 于是
 * 长期多出 6 行漂移（DROP 掉这条外键再按 `SET NULL` 建回来）。
 *
 * 为什么单测抓不到：单测用的是内存替身，**看不到迁移里的外键**（与 `employee-daily-report-migration-guards`
 * 同一条教训）。所以这里直接读 SQL 与 schema，把「两边一致」这件事钉死 —— 而且不是钉死某个字面值，
 * 是**按 schema 声明的可空性算出期望值再比**：以后谁把 `materialId` 改成不可空（或加了显式
 * `onDelete`），这条断言会跟着变，不会变成一个过期的副本。
 */
test("迁移：两条外键的 ON DELETE 必须与 schema 一致（可空 → SET NULL，不可空 → RESTRICT）", () => {
  const apiRoot = path.join(__dirname, "..", "..");
  const migrationSql = fs.readFileSync(path.join(apiRoot, "prisma", "migrations", "20261008110000_sales_order_material_extras", "migration.sql"), "utf8");
  const schema = fs.readFileSync(path.join(apiRoot, "prisma", "schema.prisma"), "utf8");
  const modelStart = schema.indexOf("model SalesOrderMaterialExtra {");
  assert.ok(modelStart > 0, "schema 里必须有这个模型");
  const model = schema.slice(modelStart, modelStart + schema.slice(modelStart).indexOf("\n}"));

  /** Prisma 的默认口径：不可空 = RESTRICT，可空 = SET NULL（显式写了就以显式为准）。 */
  const expectedOnDelete = (nullable, explicit) => explicit ?? (nullable ? "SET NULL" : "RESTRICT");
  const relationLine = (field) => model.split("\n").find((line) => new RegExp(`^\\s*${field}\\s`).test(line)) ?? "";
  const explicitOf = (line) => (/onDelete:\s*(\w+)/.exec(line)?.[1] ?? null)?.replace(/([a-z])([A-Z])/g, "$1 $2").toUpperCase() ?? null;
  const actualOf = (constraint) => {
    // 只认 `ADD CONSTRAINT "…" … ON DELETE X ON UPDATE …` 那一条语句（不能拿注释里的字样凑数）。
    const match = new RegExp(`ADD CONSTRAINT "${constraint}"[^;]*?ON DELETE ([A-Z ]+?) ON UPDATE`).exec(migrationSql);
    return match?.[1] ?? null;
  };

  // sales_order_id：不可空 → RESTRICT（删销售单不许把附表带走，整条销售链都不带 CASCADE）。
  const salesOrderIdNullable = /^\s*salesOrderId\s+String\?\s/m.test(model);
  assert.equal(
    actualOf("sales_order_material_extras_sales_order_id_fkey"),
    expectedOnDelete(salesOrderIdNullable, explicitOf(relationLine("salesOrder"))),
    "sales_order_id 的外键动作要与 schema 一致",
  );
  // material_id：**可空**（只填文字的行是正常状态）→ SET NULL，与 usableMaterialExtras 同一口径。
  const materialIdNullable = /^\s*materialId\s+String\?\s/m.test(model);
  assert.equal(materialIdNullable, true, "material_id 必须是可空的：那一行可以只填文字");
  assert.equal(
    actualOf("sales_order_material_extras_material_id_fkey"),
    expectedOnDelete(materialIdNullable, explicitOf(relationLine("material"))),
    "material_id 的外键动作要与 schema 一致（不一致就是 6 行永久漂移）",
  );
  assert.equal(actualOf("sales_order_material_extras_material_id_fkey"), "SET NULL", "可空的物料引用：物料被删时保留文字、只摘引用");
  assert.ok(!/ON DELETE CASCADE/.test(migrationSql), "这张表上不许出现 CASCADE（草稿删除是软删）");
});

