// 销售单「明细行 / 材料行插图」的**导出**（2026-11-04）。
//
// 用户要求原话：「导出的销售单里，明细行的图印在该行「图片」列，材料行的图仍排表单底部图片区」。
// 设计：docs/design/sales-order-row-images-2026-11-04.md §2.4（导出候选契约）、§3（导出件）、§5（测试）。
//
// 这份测试钉七件事：
//   ① 候选：三类键（18 格 / `extra:<行 id>` / `detail:<行 id>`）、顺序照印刷顺序、**只列有图的**；
//   ② 行图优先于物料图：`image_source` / `image_id` / `image_version` 说得清这份图是谁的；
//   ③ `image_url` 自带 `/api/v1` 前缀并指向对的读接口（行图走本单，物料图走物料清单）；
//   ④ `detail:<行 id>` 的图真的锚在该明细行的 **C 列**（ExcelJS 读回锚点），行高 ≥ 44 磅；
//   ⑤ 没有图的明细行不印图（C 列仍空），伪造/过期/无图的 detail 键 422；JPEG 闸门仍然在；
//   ⑥ 底部图片区只含**材料行**图，明细图不进；分组横幅文案跟着图数变（无图时整段不写）；
//   ⑦ `loadOrder` 的 include：行图摘要只取 id/宽高/字节数/sha（与编辑页 `SALES_ORDER_IMAGE_SUMMARY` 同口径），
//      **绝不取 `data`**。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const ExcelJS = require("exceljs");
const {
  SalesOrderExportService,
  DETAIL_IMAGE_BOX,
  DETAIL_IMAGE_ROW_HEIGHT,
  detailImageBoxFor,
  detailImageRefKey,
  materialExtraRefKey,
} = require("../../dist/modules/sales/sales-order-export.service.js");

const user = { id: "00000000-0000-0000-0000-0000000000aa", username: "sales", display_name: "张三" };
const ORDER_ID = "33333333-3333-3333-3333-333333333333";
const MATERIAL_A = "11111111-1111-1111-1111-111111111111"; // 伞布：有物料图
const MATERIAL_B = "22222222-2222-2222-2222-222222222222"; // 伞骨：没有物料图
const SLOT_IMAGE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; // 18 格自己的图
const EXTRA_IMAGE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"; // 行自己的图
const DETAIL_IMAGE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"; // 明细行自己的图
const DETAIL_IMAGE_2 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const DETAIL_1 = "e1111111-1111-4111-8111-111111111111";
const DETAIL_2 = "e2222222-2222-4222-8222-222222222222"; // 这一行**没有图**
const DETAIL_3 = "e3333333-3333-4333-8333-333333333333";
const EXTRA_1 = "f1111111-1111-4111-8111-111111111111";
const EXTRA_2 = "f2222222-2222-4222-8222-222222222222";

/** 一个合法的 JPEG（只看头三个字节，Service 不解码；ExcelJS 也只看扩展名）。 */
const jpeg = (size = 64) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(Math.max(0, size - 4), 0x41)]);

/** 物料清单里那张图（`EXPORT_MATERIAL_SELECT` 只取宽高/sha，没有 id）。 */
const materialImage = (sha, width = 400, height = 300) => ({ width, height, sha256: sha });
/** 行自己的图（`sales_order_images` 的摘要：与编辑页 `SALES_ORDER_IMAGE_SUMMARY` 同一口径，多一个 id）。 */
const rowImage = (id, sha, width = 800, height = 600) => ({ id, width, height, byteSize: 51234, sha256: sha });

/**
 * 一张单的完整夹具：两条材料引用、一格自己的图、两条「其它/再加一款」行、三条明细行
 * （两个分组、其中一条没有图）。`orderRow({...})` 按需覆盖任何一块。
 */
const orderRow = (extra = {}) => ({
  id: ORDER_ID,
  orderNo: "DL260134",
  itemNo: null,
  orderDate: new Date("2026-11-01T00:00:00.000Z"),
  deliveryDate: null,
  productName: "雨伞",
  productSpec: null,
  quantity: "10",
  unit: "支",
  createdBy: user.id,
  customer: { name: "家百纳", countryRegion: "日本" },
  canopySpec: "190T 素色黑",
  handleSpec: "直柄银色",
  materialRefs: [
    { specKey: "canopy_spec", material: { id: MATERIAL_A, materialCode: "MAT-2", name: "伞布", specificationModel: "190T", color: "藏青", image: materialImage("sha-mat") } },
    { specKey: "rib_spec", material: { id: MATERIAL_B, materialCode: "MAT-1", name: "伞骨", specificationModel: "50cm", color: "黑", image: null } },
  ],
  slotImages: [{ specKey: "handle_spec", image: rowImage(SLOT_IMAGE, "sha-slot", 200, 100) }],
  materialExtras: [
    { id: EXTRA_1, label: "伞头", content: "直柄银色", sortOrder: 0, specKey: "handle_spec", image: rowImage(EXTRA_IMAGE, "sha-extra", 300, 500), material: null },
    { id: EXTRA_2, label: "弹簧", content: "5cm 不锈钢", sortOrder: 1, specKey: null, image: null, material: null },
  ],
  specDetails: [
    { id: DETAIL_1, groupName: "伞布明细", name: "27621 流水花扇PKGY", color: "PKGY", barcode: "", quantity: "100", unit: "pcs", image: rowImage(DETAIL_IMAGE, "sha-d1", 100, 100) },
    { id: DETAIL_2, groupName: "伞布明细", name: "27621 花屋辻NV", color: "NV", barcode: "", quantity: "200", unit: "pcs", image: null },
    { id: DETAIL_3, groupName: "伞头配色", name: "Hawái", color: "配色按图片", barcode: "4894300069470", quantity: "167", unit: "打", image: rowImage(DETAIL_IMAGE_2, "sha-d3", 300, 400) },
  ],
  ...extra,
});

const exportService = (row) => new SalesOrderExportService({ salesOrder: { findFirst: async () => row } }, { namesOf: async () => new Map([[user.id, "张三"]]) });

/** 读回工作表：稠密 0 起行数组（A=0 / B=1 / C=2 / D=3 …，与既有导出测试同一口径）+ 工作表本体。 */
async function readSheet(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.worksheets[0];
  const rows = [];
  sheet.eachRow((line) => {
    const values = [];
    line.eachCell({ includeEmpty: true }, (cell) => values.push(cell.value));
    rows.push(values);
  });
  return { sheet, rows };
}

/** 一行里的全部文字（合并单元格只有一个值，拼起来够做 includes 判断）。 */
const rowText = (row) => (row ?? []).map((value) => (value === null || value === undefined ? "" : String(value))).join(" ");

/** 图片锚点（0 起）：`tl.col` 是 0 起的列号（A=0、C=2），`tl.row` 是 0 起的行号（Excel 第 1 行 = 0）。 */
const anchorOf = (image) => ({ col: Math.floor(image.range.tl.col), row: Math.floor(image.range.tl.row) });

// ------------------------------------------------------------------ ①②③ 候选

test("候选：三类键都有，顺序照印刷顺序（18 格 → 类目追加款 → 自由其它 → 明细行），且只列有图的", async () => {
  const candidates = await exportService(orderRow()).exportImageCandidates(ORDER_ID);

  assert.deepEqual(
    candidates.map((item) => item.spec_key),
    ["canopy_spec", "handle_spec", materialExtraRefKey(EXTRA_1), detailImageRefKey(DETAIL_1), detailImageRefKey(DETAIL_3)],
    "rib_spec 的物料没图 → 不进候选；EXTRA_2 / DETAIL_2 自己没图 → 也不进；明细排最后",
  );
  assert.equal(candidates.every((item) => item.has_image === true), true, "候选里不该出现 has_image=false 的项");
  assert.deepEqual(candidates.map((item) => item.kind), ["material", "material", "extra", "detail", "detail"]);
  for (const item of candidates) assert.ok(item.image_url.startsWith("/api/v1/"), `image_url 必须自带 /api/v1 前缀：${item.image_url}`);

  // 18 格 + 物料图：kind=material，image_source=material，image_id=null（图不是行自己的）。
  assert.deepEqual(candidates[0], {
    spec_key: "canopy_spec",
    label: "伞布规格",
    kind: "material",
    material_id: MATERIAL_A,
    material_code: "MAT-2",
    material_name: "伞布 190T 藏青",
    has_image: true,
    image_version: "sha-mat",
    image_source: "material",
    image_id: null,
    image_url: `/api/v1/materials/${MATERIAL_A}/image?v=sha-mat`,
  });

  // 18 格 + 格自己的图（这一格没有引用物料）：image_source=row，image_id=那张行图。
  assert.deepEqual(candidates[1], {
    spec_key: "handle_spec",
    label: "伞头",
    kind: "material",
    material_id: null,
    material_code: null,
    material_name: null,
    has_image: true,
    image_version: "sha-slot",
    image_source: "row",
    image_id: SLOT_IMAGE,
    image_url: `/api/v1/sales-orders/${ORDER_ID}/images/${SLOT_IMAGE}?v=sha-slot`,
  });

  // 「再加一款」行：键带行 id，标签用类目名，图是这一行自己的。
  assert.deepEqual(candidates[2], {
    spec_key: materialExtraRefKey(EXTRA_1),
    label: "伞头",
    kind: "extra",
    material_id: null,
    material_code: null,
    material_name: null,
    has_image: true,
    image_version: "sha-extra",
    image_source: "row",
    image_id: EXTRA_IMAGE,
    image_url: `/api/v1/sales-orders/${ORDER_ID}/images/${EXTRA_IMAGE}?v=sha-extra`,
  });

  // 明细行：标签带分组名（弹窗里两条明细同名时也分得清是哪一组），图走本单的图片读接口。
  assert.deepEqual(candidates[3], {
    spec_key: detailImageRefKey(DETAIL_1),
    label: "伞布明细：27621 流水花扇PKGY",
    kind: "detail",
    material_id: null,
    material_code: null,
    material_name: null,
    has_image: true,
    image_version: "sha-d1",
    image_source: "row",
    image_id: DETAIL_IMAGE,
    image_url: `/api/v1/sales-orders/${ORDER_ID}/images/${DETAIL_IMAGE}?v=sha-d1`,
  });
  assert.equal(candidates[4].label, "伞头配色：Hawái", "明细候选的标签要带分组名");
});

test("行图优先于物料图：同一格既有 slot 图又引用了有图的物料 —— 候选与嵌图都用行图", async () => {
  const row = orderRow({
    slotImages: [{ specKey: "canopy_spec", image: rowImage(SLOT_IMAGE, "sha-slot", 200, 100) }],
    materialExtras: [
      {
        id: EXTRA_1,
        label: "伞头",
        content: "直柄银色",
        sortOrder: 0,
        specKey: null,
        image: rowImage(EXTRA_IMAGE, "sha-extra", 300, 500),
        material: { id: MATERIAL_B, materialCode: "MAT-1", name: "伞骨", specificationModel: "50cm", color: "黑", image: materialImage("sha-mat-2") },
      },
    ],
  });
  const candidates = await exportService(row).exportImageCandidates(ORDER_ID);
  const canopy = candidates.find((item) => item.spec_key === "canopy_spec");
  const extra = candidates.find((item) => item.spec_key === materialExtraRefKey(EXTRA_1));
  assert.equal(canopy.image_source, "row");
  assert.equal(canopy.image_id, SLOT_IMAGE);
  assert.equal(canopy.image_version, "sha-slot");
  assert.equal(canopy.image_url, `/api/v1/sales-orders/${ORDER_ID}/images/${SLOT_IMAGE}?v=sha-slot`);
  assert.equal(extra.image_source, "row", "行自己的图优先于它引用的物料图");
  assert.equal(extra.image_id, EXTRA_IMAGE);
  assert.equal(extra.material_id, MATERIAL_B, "物料引用本身仍在（标签上还印物料编码）");

  // 端到端：底部图片区那张图的**像素尺寸**用的是行图的比例（200×100 → 130×65），不是物料图的 400×300（130×98）。
  const { buffer } = await exportService(row).exportOrderWithImages(ORDER_ID, [{ spec_key: "canopy_spec", buffer: jpeg() }]);
  const { sheet } = await readSheet(buffer);
  const images = sheet.getImages();
  assert.equal(images.length, 1);
  assert.deepEqual(
    { width: images[0].range.ext.width, height: images[0].range.ext.height },
    { width: 130, height: 65 },
    "宽高取自**行图**（200×100）而不是物料图（400×300）",
  );
});

test("detail 键导出：图锚在该明细行的 C 列，行高 ≥ 44 磅，等比缩进 56×56", async () => {
  const service = exportService(orderRow());
  const { buffer } = await service.exportOrderWithImages(ORDER_ID, [
    { spec_key: detailImageRefKey(DETAIL_1), buffer: jpeg() },
    { spec_key: detailImageRefKey(DETAIL_3), buffer: jpeg() },
  ]);
  const { sheet, rows } = await readSheet(buffer);
  const images = sheet.getImages();
  assert.equal(images.length, 2, "勾了两条明细行就嵌两张");

  const rowOf = (text) => {
    const index = rows.findIndex((line) => rowText(line).includes(text));
    assert.ok(index >= 0, `找不到明细行「${text}」`);
    return index;
  };
  const first = rowOf("27621 流水花扇PKGY");
  const second = rowOf("27621 花屋辻NV");
  const third = rowOf("Hawái");

  // 绘制顺序 = 勾选顺序（DETAIL_1、DETAIL_3）。
  assert.deepEqual(anchorOf(images[0]), { col: 2, row: first }, "第一张图锚在第一行明细的 C 列（col index 2）");
  assert.deepEqual(anchorOf(images[1]), { col: 2, row: third }, "第二张图锚在第三行明细（中间那行没有图，不能串行）");
  assert.equal(anchorOf(images[0]).row, first, "锚点行必须是这条明细自己的那一行");

  // 等比缩进 56×56（100×100 → 56×56；300×400 → 42×56），且不超过方框。
  assert.deepEqual({ width: images[0].range.ext.width, height: images[0].range.ext.height }, detailImageBoxFor({ width: 100, height: 100 }));
  assert.deepEqual({ width: images[1].range.ext.width, height: images[1].range.ext.height }, detailImageBoxFor({ width: 300, height: 400 }));
  for (const image of images) {
    assert.ok(image.range.ext.width <= DETAIL_IMAGE_BOX && image.range.ext.height <= DETAIL_IMAGE_BOX);
  }

  // 行高：带图的三行都至少 44 磅（不然图会压到下一行）；没图的那一行不受影响。
  for (const index of [first, third]) assert.ok(sheet.getRow(index + 1).height >= DETAIL_IMAGE_ROW_HEIGHT, `第 ${index + 1} 行行高不足 44 磅`);
  assert.equal(rows[second][2] ?? "", "", "没有图的明细行：C 列仍空");

  // 分组横幅：这一组有图就报张数；只有一张也说「共 1 张」。
  assert.ok(rows.some((line) => rowText(line).includes("共 1 张图，印在下方「图片」列")), "有图的分组横幅要写张数与位置");
  assert.equal(rows.some((line) => rowText(line).includes("图片见客户原稿")), false, "旧文案必须消失");
  // 只勾了明细图：底部图片区不该出现（明细图不进那里）。
  assert.equal(rows.some((line) => rowText(line).includes("图片区")), false, "没有材料行图就不留空的图片区");
});

test("明细图按分组/行序对上：sortOrder 交错的同组行不会串到别的组/别的行上", async () => {
  const line = (id, groupName, name, image) => ({ id, groupName, name, color: null, barcode: null, quantity: null, unit: null, image });
  const row = orderRow({
    materialRefs: [],
    slotImages: [],
    materialExtras: [],
    specDetails: [
      line("a1", "甲组", "甲一", rowImage(DETAIL_IMAGE, "sha-a1", 100, 100)),
      line("b1", "乙组", "乙一", rowImage(EXTRA_IMAGE, "sha-b1", 200, 100)),
      line("a2", "甲组", "甲二", rowImage(SLOT_IMAGE, "sha-a2", 100, 200)),
    ],
  });
  const service = exportService(row);
  // 候选顺序照**导出件上的分组/行序**：甲组两行在前、乙组一行在后。
  assert.deepEqual((await service.exportImageCandidates(ORDER_ID)).map((item) => item.spec_key), [detailImageRefKey("a1"), detailImageRefKey("a2"), detailImageRefKey("b1")]);

  const { buffer } = await service.exportOrderWithImages(ORDER_ID, [
    { spec_key: detailImageRefKey("a2"), buffer: jpeg() },
    { spec_key: detailImageRefKey("b1"), buffer: jpeg() },
  ]);
  const { sheet, rows } = await readSheet(buffer);
  const rowOf = (text) => rows.findIndex((line2) => rowText(line2).includes(text));
  const images = sheet.getImages();
  assert.deepEqual(anchorOf(images[0]), { col: 2, row: rowOf("甲二") }, "甲二那张图不能落到甲一/乙一上");
  assert.deepEqual(anchorOf(images[1]), { col: 2, row: rowOf("乙一") });
});

test("伪造 / 过期 / 无图的 detail 键一律 422；JPEG 闸门仍然在（明细图也不例外）", async () => {
  const service = exportService(orderRow());
  // ① 伪造：随机 UUID 不在这一单里。
  await assert.rejects(
    () => service.exportOrderWithImages(ORDER_ID, [{ spec_key: detailImageRefKey("77777777-7777-4777-8777-777777777777"), buffer: jpeg() }]),
    (error) => error.getResponse().code === "PRODUCTION_SHEET_IMAGE_UNSUPPORTED" && error.getResponse().details[0].spec_key === detailImageRefKey("77777777-7777-4777-8777-777777777777"),
  );
  // ② 这一行真的存在，但这一行没有图。
  await assert.rejects(
    () => service.exportOrderWithImages(ORDER_ID, [{ spec_key: detailImageRefKey(DETAIL_2), buffer: jpeg() }]),
    (error) => error.getResponse().code === "PRODUCTION_SHEET_IMAGE_UNSUPPORTED" && error.getResponse().message.includes("没有可导出的图片"),
  );
  // ③ 字节必须是 JPEG（Excel 不认 WebP）—— 行图这一路没有放开任何闸门。
  await assert.rejects(
    () => service.exportOrderWithImages(ORDER_ID, [{ spec_key: detailImageRefKey(DETAIL_1), buffer: Buffer.from("RIFF....WEBP") }]),
    (error) => error.getResponse().code === "PRODUCTION_SHEET_IMAGE_INVALID" && error.getResponse().message.includes("不是 JPEG"),
  );
  // ④ 单张上限也还在（与材料图同一个闸门）。
  await assert.rejects(
    () => service.exportOrderWithImages(ORDER_ID, [{ spec_key: detailImageRefKey(DETAIL_1), buffer: jpeg(2 * 1024 * 1024 + 1) }]),
    (error) => error.getResponse().code === "PRODUCTION_SHEET_IMAGE_INVALID",
  );
});

// ------------------------------------------------------------------ ⑥ 底部图片区

test("底部图片区只含材料行图：明细图印在 C 列、材料图排在表尾，分组横幅按图数说话", async () => {
  const service = exportService(orderRow());
  const { buffer } = await service.exportOrderWithImages(ORDER_ID, [
    { spec_key: "canopy_spec", buffer: jpeg() }, // 物料图（400×300）
    { spec_key: "handle_spec", buffer: jpeg() }, // 18 格自己的图（200×100）
    { spec_key: detailImageRefKey(DETAIL_1), buffer: jpeg() }, // 明细行图
  ]);
  const { sheet, rows } = await readSheet(buffer);
  const images = sheet.getImages();
  assert.equal(images.length, 3, "两张材料图 + 一张明细图");

  const areaHeader = rows.findIndex((line) => rowText(line).includes("图片区"));
  assert.ok(areaHeader > 0, "有两张材料图 → 必须有底部图片区");
  assert.ok(rowText(rows[areaHeader]).includes("2 张"), "图片区标题报的是**材料行图**张数（不含明细图）");

  const detailRow = rows.findIndex((line) => rowText(line).includes("27621 流水花扇PKGY"));
  const anchors = images.map(anchorOf);
  const inArea = anchors.filter((anchor) => anchor.row >= areaHeader);
  const atDetail = anchors.filter((anchor) => anchor.col === 2 && anchor.row === detailRow);
  assert.equal(inArea.length, 2, "底部图片区只有材料行图（明细图不许进去）");
  assert.equal(atDetail.length, 1, "明细图锚在明细行的 C 列");

  // 标签：物料行用「栏位名：物料编码 名称」；只有行图的格子用该行填的内容摘要。
  assert.ok(rows.some((line) => rowText(line).includes("1. 伞布规格：MAT-2 伞布 190T 藏青")), "物料行标签沿用 2026-09-24 的写法");
  assert.ok(rows.some((line) => rowText(line).includes("2. 伞头：直柄银色")), "行图没有物料 → 用该行内容摘要当标签");
});

test("无图的单（不勾任何图）：横幅不写图片段、C 列留空、也没有空的图片区", async () => {
  const { buffer } = await exportService(orderRow()).exportOrder(ORDER_ID);
  const { rows } = await readSheet(buffer);
  assert.equal(rows.some((line) => rowText(line).includes("图片见客户原稿")), false);
  assert.equal(rows.some((line) => rowText(line).includes("共 ")), false, "没图时不该出现「共 N 张图」这一段");
  assert.equal(rows.some((line) => rowText(line).includes("图片区")), false);
  const header = rows.findIndex((line) => rowText(line).includes("品番/品名") && rowText(line).includes("图片"));
  assert.ok(header > 0);
  assert.equal(rows[header + 1][2] ?? "", "", "第一条明细的 C 列留空");
});

// ------------------------------------------------------------------ ⑦ 取数与纯函数

test("导出取数：行图摘要只取 id/宽高/字节数/sha（与编辑页同一口径），绝不取 data（三个 include 都钉住）", async () => {
  let captured = null;
  const service = new SalesOrderExportService({ salesOrder: { findFirst: async (args) => { captured = args; return orderRow(); } } }, { namesOf: async () => new Map() });
  await service.exportImageCandidates(ORDER_ID);

  // 与 `sales-orders.service.ts` 的 `SALES_ORDER_IMAGE_SUMMARY` 同一份字段：id/width/height/byteSize/sha256。
  const expectedKeys = ["byteSize", "height", "id", "sha256", "width"];
  const selectOf = (entry) => Object.keys(entry.include.image.select).sort();
  assert.deepEqual(selectOf(captured.include.specDetails), expectedKeys, "细分明细行图的摘要 select");
  assert.deepEqual(selectOf(captured.include.materialExtras), expectedKeys, "「其它」/「再加一款」行图的摘要 select");
  assert.deepEqual(selectOf(captured.include.slotImages), expectedKeys, "18 格行图的摘要 select");
  assert.equal("data" in captured.include.specDetails.include.image.select, false, "绝不取字节");
  assert.equal(captured.include.specDetails.where.deletedAt, null, "只要未删的明细行");
  assert.equal(captured.include.slotImages.where.deletedAt, null, "只要未删的格图");
  assert.equal(captured.include.specDetails.orderBy.sortOrder, "asc", "明细行按用户排的先后");
  assert.equal(captured.include.materialExtras.orderBy.sortOrder, "asc");
  // 物料摘要那份 select 不能被这次改动顺手动过（既有钉子）。
  assert.equal(captured.include.materialExtras.include.material.select.specificationModel, true);
  assert.equal(captured.include.materialExtras.include.material.select.color, true);
});

test("detailImageBoxFor：等比缩进 56×56，小图不放大，坏尺寸给方图", () => {
  assert.equal(DETAIL_IMAGE_BOX, 56);
  assert.equal(DETAIL_IMAGE_ROW_HEIGHT, 44);
  assert.deepEqual(detailImageBoxFor({ width: 400, height: 300 }), { width: 56, height: 42 });
  assert.deepEqual(detailImageBoxFor({ width: 300, height: 400 }), { width: 42, height: 56 });
  assert.deepEqual(detailImageBoxFor({ width: 40, height: 50 }), { width: 40, height: 50 }, "本来就小的图不放大");
  assert.deepEqual(detailImageBoxFor({ width: 0, height: 0 }), { width: 56, height: 56 }, "读不出尺寸时给方图（不能给 0，Excel 画不出来）");
  assert.deepEqual(detailImageBoxFor({ width: Number.NaN, height: 10 }), { width: 56, height: 56 });
});
