// 销售单「材料明细引用物料」与「工艺单带图片导出」的单元测试（用户 2026-09-24）。
//
// 用户原话：「销售板块，在编辑销售单的时候，每个部件，既支持填空，也支持从现有的物料清单中引用。
// 同时要体现对应的物料的图片。导出销售单的时候，每个有图片的物料允许用户勾选是否 excel 中一并
// 导出这个图片。excel 中图片我们就单独排成一排放在底下的一个图片区。然后让用户自行拖拽就好了」。
//
// 六件事钉死：
//   ① 「能引用物料的栏位」就是材料明细那 18 项（与 SPEC_SCALAR_FIELDS 里那一段逐字一致）；
//   ② 引用是**整块替换**，而且同一个栏位只有一行记录（唯一键不看 deletedAt，所以换引用必须是
//      「改这一行」而不是「删了再建」—— 删了再建会撞唯一索引，改一次引用就 500）；
//   ③ 引用必须是真实存在且未删除的物料，缺了要**一次点名**是哪几个栏位；
//   ④ 引用进版本快照（物料会被改名/换图，只看当前值答不了「当时引用的是谁」）；
//   ⑤ 导出候选只列**这一单引用过**的物料，顺序照材料明细的印刷顺序；
//   ⑥ 带图导出：只接受这一单引用过、且那个物料确实有图的栏位，字节必须是 JPEG（Excel 不认 WebP），
//      图片落在表尾图片区并按 `IMAGES_PER_ROW` 排成排。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const ExcelJS = require("exceljs");
const {
  SPEC_MATERIAL_KEYS,
  SPEC_SCALAR_FIELDS,
  SalesOrdersService,
} = require("../../dist/modules/sales/sales-orders.service.js");
const {
  SalesOrderExportService,
  imageBoxFor,
  materialRefText,
} = require("../../dist/modules/sales/sales-order-export.service.js");

const user = { id: "00000000-0000-0000-0000-0000000000aa", username: "sales", display_name: "张三" };
const audit = { create: () => ({ createdBy: user.id, updatedBy: user.id }), update: () => ({ updatedBy: user.id }), softDelete: () => ({ deletedAt: new Date(), deletedBy: user.id, updatedBy: user.id }), record: async () => {} };
const MATERIAL_A = "11111111-1111-1111-1111-111111111111";
const MATERIAL_B = "22222222-2222-2222-2222-222222222222";
const ORDER_ID = "33333333-3333-3333-3333-333333333333";

/** 一个合法的 JPEG（只看头三个字节，Service 不解码；ExcelJS 也只看扩展名）。 */
const jpeg = (size = 64) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(Math.max(0, size - 4), 0x41)]);

// ------------------------------------------------------------------ ① 清单

test("SPEC_MATERIAL_KEYS 就是 SPEC_SCALAR_FIELDS 里的材料那一段（错位会让引用落到别的栏位上）", () => {
  const keys = SPEC_SCALAR_FIELDS.map(([key]) => key);
  const from = keys.indexOf("rib_spec");
  const to = keys.indexOf("printing_spec");
  assert.deepEqual([...SPEC_MATERIAL_KEYS], keys.slice(from, to + 1), "材料明细 18 项必须逐字一致且连续");
  assert.equal(SPEC_MATERIAL_KEYS.length, 18);
  // 工艺要求与布量这些栏位不该混进来（它们不是「部件」）。
  for (const forbidden of ["sample_requirement", "qc_requirement", "fabric_usage_canopy", "factory"]) {
    assert.equal(SPEC_MATERIAL_KEYS.includes(forbidden), false, `${forbidden} 不是材料明细栏位`);
  }
});

// ------------------------------------------------------------------ ②③④ 写入

/** 假 prisma：只实现 create / update 两条路要用的那几张表。 */
function writeHarness({ existing = [], materials = [{ id: MATERIAL_A }, { id: MATERIAL_B }] } = {}) {
  const calls = { refFindMany: [], refUpdate: [], refCreateMany: [], versionCreate: [], materialFindMany: [] };
  const tx = {
    salesOrder: { create: async ({ data }) => ({ id: ORDER_ID, orderNo: "SO-1", ...data }), update: async ({ data }) => ({ id: ORDER_ID, orderNo: "SO-1", ...data }) },
    salesOrderVersion: { create: async ({ data }) => { calls.versionCreate.push(data); return data; } },
    salesOrderSpecDetail: { updateMany: async () => ({}), createMany: async () => ({}) },
    salesOrderMaterialRef: {
      findMany: async (args) => { calls.refFindMany.push(args); return existing; },
      update: async (args) => { calls.refUpdate.push(args); return args.data; },
      createMany: async (args) => { calls.refCreateMany.push(args); return { count: args.data.length }; },
    },
  };
  const prisma = {
    customer: { findFirst: async () => ({ id: "customer-1", customerCode: "CUS-1", name: "家百纳", isActive: true }) },
    customerContact: { findFirst: async () => null },
    material: { findMany: async (args) => { calls.materialFindMany.push(args); return materials; } },
    salesOrder: { findFirst: async () => ({ id: ORDER_ID, orderNo: "SO-1", status: "draft", currentVersion: 1, customerId: "customer-1", customer: { id: "customer-1", name: "家百纳" }, contact: null, versions: [], boms: [], specDetails: [], materialRefs: [], materialExtras: [], orderDate: new Date(), quantity: "10", unit: "支", currency: "USD", extensionData: {} }) },
    $transaction: async (fn) => fn(tx),
  };
  return { service: new SalesOrdersService(prisma, audit), calls };
}

const baseInput = { order_no: "SO-1", customer_id: "customer-1", order_date: "2026-09-24", product_name: "雨伞", quantity: "10", unit: "支", currency: "USD" };

test("新建销售单：引用落库（一行一栏位），并且进版本快照", async () => {
  const { service, calls } = writeHarness();
  await service.create({ ...baseInput, rib_spec: "50cm 碳纤骨", material_refs: [{ spec_key: "rib_spec", material_id: MATERIAL_A }, { spec_key: "canopy_spec", material_id: MATERIAL_B }] }, user);

  assert.deepEqual(calls.refCreateMany[0].data.map((row) => [row.specKey, row.materialId]), [["rib_spec", MATERIAL_A], ["canopy_spec", MATERIAL_B]]);
  assert.equal(calls.refCreateMany[0].data[0].salesOrderId, ORDER_ID);
  assert.equal(calls.refCreateMany[0].data[0].createdBy, user.id);
  assert.deepEqual(calls.versionCreate[0].snapshot.material_refs, [{ spec_key: "rib_spec", material_id: MATERIAL_A }, { spec_key: "canopy_spec", material_id: MATERIAL_B }], "快照要记住「当时引用的是谁」");
});

test("引用是整块替换：变了的改这一行、没提到的软删、新出现的才插入", async () => {
  const existing = [
    { id: "ref-1", specKey: "rib_spec", materialId: MATERIAL_A, deletedAt: null },
    { id: "ref-2", specKey: "canopy_spec", materialId: MATERIAL_A, deletedAt: null },
    { id: "ref-3", specKey: "tail_spec", materialId: MATERIAL_B, deletedAt: null },
  ];
  const { service, calls } = writeHarness({ existing });
  await service.update(ORDER_ID, { material_refs: [
    { spec_key: "rib_spec", material_id: MATERIAL_A },   // 没变 → 一个字都不写
    { spec_key: "canopy_spec", material_id: MATERIAL_B }, // 换物料 → 改这一行
    { spec_key: "handle_spec", material_id: MATERIAL_B }, // 新增 → 插入
    // tail_spec 没提到 → 软删
  ] }, user);

  const updated = calls.refUpdate.map((call) => [call.where.id, call.data]);
  assert.deepEqual(updated.map(([id]) => id).sort(), ["ref-2", "ref-3"], "只有「换了物料」与「取消引用」两行被改");
  assert.equal(updated.find(([id]) => id === "ref-2")[1].materialId, MATERIAL_B);
  assert.equal(updated.find(([id]) => id === "ref-2")[1].deletedAt, null, "换引用不该顺手把行删掉");
  assert.ok(updated.find(([id]) => id === "ref-3")[1].deletedAt instanceof Date, "没提到的栏位是软删");
  assert.deepEqual(calls.refCreateMany[0].data.map((row) => row.specKey), ["handle_spec"]);
  assert.equal([...calls.refUpdate, ...calls.refCreateMany].length, 3, "没变的那个栏位不许被写（写了就白更新一次 updatedAt）");
});

test("复活一条曾经取消过的引用：改这一行而不是插新行（唯一键不看 deletedAt，插了就撞）", async () => {
  const existing = [{ id: "ref-1", specKey: "rib_spec", materialId: MATERIAL_A, deletedAt: new Date("2026-01-01") }];
  const { service, calls } = writeHarness({ existing });
  await service.update(ORDER_ID, { material_refs: [{ spec_key: "rib_spec", material_id: MATERIAL_A }] }, user);
  assert.deepEqual(calls.refUpdate.map((call) => call.where.id), ["ref-1"]);
  assert.equal(calls.refUpdate[0].data.deletedAt, null);
  assert.equal(calls.refUpdate[0].data.deletedBy, null);
  assert.equal(calls.refCreateMany.length, 0, "复活走 update，绝不能插一行新的");
});

test("空数组 = 全部取消引用（不是「不动」）；没传 = 不动", async () => {
  const existing = [{ id: "ref-1", specKey: "rib_spec", materialId: MATERIAL_A, deletedAt: null }];
  const cleared = writeHarness({ existing });
  await cleared.service.update(ORDER_ID, { material_refs: [] }, user);
  assert.equal(cleared.calls.refUpdate.length, 1);
  assert.ok(cleared.calls.refUpdate[0].data.deletedAt instanceof Date);

  const untouched = writeHarness({ existing });
  await untouched.service.update(ORDER_ID, { material_refs: undefined }, user);
  assert.deepEqual(untouched.calls.refFindMany, [], "没提到引用就整块不动，连查都不查");
});

test("不是材料明细的栏位不能挂引用（工艺要求/布量/表头都要拒，不许静默忽略）", async () => {
  const { service, calls } = writeHarness();
  await assert.rejects(
    () => service.update(ORDER_ID, { material_refs: [{ spec_key: "qc_requirement", material_id: MATERIAL_A }] }, user),
    (error) => error.getResponse().code === "MATERIAL_REF_KEY_UNSUPPORTED" && error.getResponse().message.includes("qc_requirement"),
  );
  assert.equal(calls.refCreateMany.length, 0);
  assert.equal(calls.refUpdate.length, 0);
});

test("引用不存在的物料：一次点名是哪几个，且一个字节都不写", async () => {
  const { service, calls } = writeHarness({ materials: [{ id: MATERIAL_A }] });
  await assert.rejects(
    () => service.update(ORDER_ID, { material_refs: [{ spec_key: "rib_spec", material_id: MATERIAL_B }] }, user),
    (error) => {
      assert.equal(error.getResponse().code, "MATERIAL_NOT_FOUND");
      assert.deepEqual(error.getResponse().details, [{ material_id: MATERIAL_B }]);
      return true;
    },
  );
  assert.equal(calls.refCreateMany.length, 0);
  // 查重是按 id 一次查完（18 个引用不该变成 18 次往返）
  assert.deepEqual(calls.materialFindMany[0].where, { id: { in: [MATERIAL_B] }, deletedAt: null });
});

// ------------------------------------------------------------------ ⑤⑥ 导出

const orderRow = (extra = {}) => ({
  id: ORDER_ID, orderNo: "DL260134", orderDate: new Date("2026-09-01T00:00:00.000Z"), deliveryDate: null,
  productName: "雨伞", productSpec: null, quantity: "10", unit: "支", createdBy: user.id,
  customer: { name: "家百纳", countryRegion: "日本" }, specDetails: [],
  materialRefs: [
    { specKey: "canopy_spec", material: { id: MATERIAL_B, materialCode: "MAT-2", name: "伞布", specificationModel: "190T", color: "藏青", image: { width: 400, height: 300, sha256: "sha-b" } } },
    { specKey: "rib_spec", material: { id: MATERIAL_A, materialCode: "MAT-1", name: "伞骨", specificationModel: "50cm", color: "黑", image: null } },
    { specKey: "handle_spec", material: { id: "44444444-4444-4444-4444-444444444444", materialCode: "MAT-3", name: "伞头", specificationModel: null, color: null, image: { width: 100, height: 100, sha256: "sha-c" } } },
  ],
  ...extra,
});

const exportService = (row) => new SalesOrderExportService({ salesOrder: { findFirst: async () => row } }, { namesOf: async () => new Map([[user.id, "张三"]]) });

test("导出候选：只列这一单引用过**且有图**的物料，按材料明细的印刷顺序排", async () => {
  const candidates = await exportService(orderRow()).exportImageCandidates(ORDER_ID);
  // 2026-11-04 起候选**只列有图的**（设计 §2.4）：没有图的列出来只会让人以为勾了就有图，
  // 而勾了之后导出那一步必然报「这一格没有可导出的图片」——所以 rib_spec（物料没图）不进候选。
  assert.deepEqual(candidates.map((item) => item.spec_key), ["canopy_spec", "handle_spec"], "顺序照 SPEC_MATERIAL_KEYS，不照数据库返回顺序");
  assert.deepEqual(candidates[0], {
    spec_key: "canopy_spec",
    label: "伞布规格",
    kind: "material",
    material_id: MATERIAL_B,
    material_code: "MAT-2",
    material_name: "伞布 190T 藏青",
    has_image: true,
    image_version: "sha-b",
    image_source: "material",
    image_id: null,
    image_url: `/api/v1/materials/${MATERIAL_B}/image?v=sha-b`,
  });
  assert.equal(candidates[0].label, "伞布规格");
  assert.equal(candidates[1].material_name, "伞头", "规格/颜色为空时不留多余空格");
  assert.equal(candidates[1].image_source, "material", "没有行图时回退物料清单那张");
});

test("带图导出：图片排进表尾图片区，每张一行标签，勾了几张就有几张", async () => {
  const service = exportService(orderRow());
  const { buffer, orderNo } = await service.exportOrderWithImages(ORDER_ID, [
    { spec_key: "handle_spec", buffer: jpeg() },
    { spec_key: "canopy_spec", buffer: jpeg(2048) },
  ]);
  assert.equal(orderNo, "DL260134");

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.worksheets[0];
  const images = sheet.getImages();
  assert.equal(images.length, 2, "勾了两张就嵌两张");
  // 每张图都有像素尺寸（ExcelJS 用 ext 写 oneCellAnchor），且不超过图片区的方框
  for (const image of images) {
    assert.ok(image.range.ext.width > 0 && image.range.ext.height > 0);
    assert.ok(image.range.ext.width <= 130 && image.range.ext.height <= 130, `图片不该超出 130px 的方框，实际 ${image.range.ext.width}×${image.range.ext.height}`);
  }
  const rows = [];
  sheet.eachRow((row) => rows.push(row.values.join(" ")));
  const areaHeader = rows.findIndex((text) => text.includes("图片区"));
  assert.ok(areaHeader >= 0, "要有图片区标题");
  assert.ok(rows.some((text) => text.includes("1. 伞头：MAT-3 伞头")), "序号 + 栏位名 + 物料编码/名称，拖走之后还认得出来是哪一格");
  assert.ok(rows.some((text) => text.includes("2. 伞布规格：MAT-2 伞布 190T 藏青")));
  // 图片锚在图片区**下方**（标题行是 0 起的话，第一张图的 row 必须 ≥ 标题行）
  for (const image of images) assert.ok(image.range.tl.row >= areaHeader, "图片必须落在表尾图片区里，不能盖到正文上");
});

test("带图导出：没勾任何图 = 与普通工艺单同一份内容（一条导出路径，不会分叉成两份版式）", async () => {
  const service = exportService(orderRow());
  const plain = await service.exportOrder(ORDER_ID);
  const none = await service.exportOrderWithImages(ORDER_ID, []);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(none.buffer);
  assert.equal(workbook.worksheets[0].getImages().length, 0);
  const rows = [];
  workbook.worksheets[0].eachRow((row) => rows.push(row.values.join(" ")));
  assert.equal(rows.some((text) => text.includes("图片区")), false, "没有图就不该留一块空的图片区");
  assert.equal(plain.orderNo, none.orderNo);
});

test("带图导出：没引用过的栏位、或引用的物料没有图 —— 一律拒绝（否则任意字节都能塞进导出件）", async () => {
  const service = exportService(orderRow());
  await assert.rejects(
    () => service.exportOrderWithImages(ORDER_ID, [{ spec_key: "printing_spec", buffer: jpeg() }]),
    (error) => error.getResponse().code === "PRODUCTION_SHEET_IMAGE_UNSUPPORTED",
  );
  await assert.rejects(
    () => service.exportOrderWithImages(ORDER_ID, [{ spec_key: "rib_spec", buffer: jpeg() }]),
    (error) => error.getResponse().code === "PRODUCTION_SHEET_IMAGE_UNSUPPORTED" && error.getResponse().message.includes("没有可导出的物料图片"),
  );
});

test("带图导出：字节必须是 JPEG（Excel 不认 WebP，写进去是一个红叉）", async () => {
  const service = exportService(orderRow());
  await assert.rejects(
    () => service.exportOrderWithImages(ORDER_ID, [{ spec_key: "canopy_spec", buffer: Buffer.from("RIFF....WEBP") }]),
    (error) => error.getResponse().code === "PRODUCTION_SHEET_IMAGE_INVALID" && error.getResponse().message.includes("不是 JPEG"),
  );
  await assert.rejects(
    () => service.exportOrderWithImages(ORDER_ID, [{ spec_key: "canopy_spec", buffer: Buffer.alloc(0) }]),
    (error) => error.getResponse().code === "PRODUCTION_SHEET_IMAGE_INVALID",
  );
  await assert.rejects(
    () => service.exportOrderWithImages(ORDER_ID, [{ spec_key: "canopy_spec", buffer: jpeg(2 * 1024 * 1024 + 1) }]),
    (error) => error.getResponse().code === "PRODUCTION_SHEET_IMAGE_INVALID" && error.getResponse().message.includes("单张图片超过"),
  );
});

test("imageBoxFor：等比缩进方框，小图不放大，坏尺寸不炸", () => {
  assert.deepEqual(imageBoxFor({ width: 400, height: 300 }), { width: 130, height: 98 });
  assert.deepEqual(imageBoxFor({ width: 300, height: 400 }), { width: 98, height: 130 });
  assert.deepEqual(imageBoxFor({ width: 100, height: 100 }), { width: 100, height: 100 }, "本来就小的图不放大");
  assert.deepEqual(imageBoxFor({ width: 0, height: 0 }), { width: 130, height: 130 }, "读不出尺寸时给一个方图，不能给 0（Excel 会画不出来）");
  assert.deepEqual(imageBoxFor({ width: Number.NaN, height: 10 }), { width: 130, height: 130 });
});

// ------------------------------------------------------------------ 导出：引用了物料但格子里没有字（2026-09-26）

/**
 * 用户 2026-09-26 现场问题：「新建销售单，材料明细那边，如果是使用引用的资料，在导出的 excel 中无法显示」。
 *
 * 根因是**两条记录可以不同步**：格子的文字是 `sales_orders.rib_spec` 那种标量列，
 * 「引用了哪个物料」是 `sales_order_material_refs` 一行。文字为空时，早先的导出会把这一格
 * 当「空盘位自动省略」整行不印 —— 于是"引用了物料"这件事在纸上彻底消失。
 */
test("导出：格子空但引用了物料 —— 用引用的物料兜底印出来（编码 + 名称 + 规格 + 颜色）", () => {
  const row = orderRow({ ribSpec: null, canopySpec: null, handleSpec: null });
  const doc = exportService(row).document(row, "张三");
  assert.equal(doc.materialLines.find((line) => line.label === "伞骨（孔对孔）").value, "MAT-1 伞骨 50cm 黑");
  assert.equal(doc.materialLines.find((line) => line.label === "伞布规格").value, "MAT-2 伞布 190T 藏青");
  assert.equal(doc.materialLines.find((line) => line.label === "伞头").value, "MAT-3 伞头", "规格/颜色为空时不留多余空格");
  // 既没文字也没引用的栏位仍然整行不印（「空盘位自动省略」没有被这次改动推翻）
  assert.equal(doc.materialLines.some((line) => line.label === "印刷"), false);
  assert.equal(doc.materialLines.length, 3);
});

test("导出：格子里有字时**以字为准**（人对着这一单写的话优先于物料摘要）", () => {
  const row = orderRow({ ribSpec: "50cm 碳纤骨（师傅按样品改）" });
  const doc = exportService(row).document(row, "张三");
  assert.equal(doc.materialLines.find((line) => line.label === "伞骨（孔对孔）").value, "50cm 碳纤骨（师傅按样品改）");
});

test("materialRefText：只拼有值的段，全空时是空串（不会印出一串空格）", () => {
  assert.equal(materialRefText({ materialCode: "MAT-1", name: "伞骨", specificationModel: "50cm", color: "黑" }), "MAT-1 伞骨 50cm 黑");
  assert.equal(materialRefText({ materialCode: "MAT-1", name: "伞骨", specificationModel: null, color: "" }), "MAT-1 伞骨");
  assert.equal(materialRefText({}), "");
});

test("导出落格：引用了物料但格子里没有字的行，必须在 Excel 里看得见", async () => {
  const row = orderRow({ ribSpec: null, canopySpec: null, handleSpec: null });
  const { buffer } = await exportService(row).exportOrder(ORDER_ID);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const texts = [];
  workbook.worksheets[0].eachRow((line) => texts.push(line.values.join(" ")));
  assert.ok(texts.some((text) => text.includes("伞骨（孔对孔）") && text.includes("MAT-1 伞骨 50cm 黑")), "材料行与兜底文字要在同一行上");
  assert.ok(texts.some((text) => text.includes("MAT-2 伞布 190T 藏青")));
});
