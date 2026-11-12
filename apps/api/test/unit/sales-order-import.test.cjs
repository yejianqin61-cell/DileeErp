// 销售单「Excel 补录」（用户 2026-11-02）。
//
// 用户原话：「针对销售模块，现在要加一个补录功能。用户上传销售单 excel，系统进行字段读取与匹配，
// 展示一份系统表单，让用户进行修改与确认。用户通过之后，再确认建立销售单。」
// 同日拍板：**两种版式都认**（我们自己的工艺单/生产单 + 客户发来的订单）、**一份文件 = 一张单**。
//
// 八件事钉死（每一条都对应一种"纸上看不出来、建单之后才发现"的错）：
//   ① 我们自己的工艺单**导回去能读回来**（导出 → 解析 → 逐格相等）：版式一改，这条先红；
//   ② 两张真实样本（`example/销售单/`）逐字段断言：客户单号/数量+单位/日期+完工备注/18 项材料/
//      工艺 9 条/明细表（含左右两块）/正唛侧唛/布量；
//   ③ 同一类目出现多行 → 「同类目再加一款」（2026-10-29 的口径），自由类目 → 「其它」行；
//   ④ 不认识的内容**如实上报**，不静默丢（`unrecognized`）；
//   ⑤ 明细表结束/材料区结束的判定：不能被紧随其后的材料行骗过去（第一版多读了 19 行）；
//   ⑥ 日期与数量的归一（`2026.7.30进仓`、`1960支`、`2505打`、Excel 序列号）；
//   ⑦ 预填载荷 = 建单载荷的形状：填上客户与币种后能过**真实 SalesOrderDto 校验**（否则"能填不能存"）；
//   ⑧ 源级守卫：路由/文件白名单/10MB 限制/模块注册 + 客户匹配只做唯一命中。
//
// 2026-11-12 补进第三份真实样本（`DL260003ZG-424038.xls`，「D生产单模板」B级单）：`区域：日本`、
// `伞头（螺丝配色）`、「其它」行别把工艺栏吞进来、`8：` 这种冒号式工艺编号、追加行的核对地址——
// 五处读错各有一条断言，见下面「④ 真实样本」与「材料类目」两处。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const XLSX = require("xlsx");
const { ValidationPipe } = require("@nestjs/common");

const { parseSalesOrderWorkbook, parseImportDate, parseQuantityCell } = require("../../dist/modules/sales/sales-order-import.js");
const { matchCustomer, SalesOrderImportService } = require("../../dist/modules/sales/sales-order-import.service.js");
const { SalesOrderExportService } = require("../../dist/modules/sales/sales-order-export.service.js");
const { SalesOrderDto } = require("../../dist/modules/sales/sales-orders.controller.js");

const ROOT = path.join(__dirname, "..", "..");
const user = { id: "00000000-0000-0000-0000-0000000000aa", username: "sales", display_name: "张三" };
const ORDER_ID = "33333333-3333-3333-3333-333333333333";

/** 内存里造一张 xlsx（`aoa` 0 起；`merges` 用 `[sr, sc, er, ec]`，与 `!merges` 同形状）。 */
function workbook(sheetName, rows, merges = []) {
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  if (merges.length) sheet["!merges"] = merges.map(([sr, sc, er, ec]) => ({ s: { r: sr, c: sc }, e: { r: er, c: ec } }));
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, sheetName);
  return XLSX.write(book, { type: "buffer", bookType: "xlsx" });
}

// ------------------------------------------------------------------ ① 版式一：样本1 的写法（标签：值 同格）

/**
 * 与 `DL260134 JBN生产单(1).xls` 同构的最小表：左栏「材料 + 明细」、右栏「工艺要求」、
 * **细分明细表嵌在材料区中间**（左右两块并排）、正唛/侧唛与布量在明细之后、末尾是到货状态勾选表。
 */
function sampleOneLayout() {
  const rows = [
    ["厦 门 迪 礼 伞 业 有 限 公 司"],
    ["工        厂", "", "客户单号：DL260134", "", "", "", "客户代码：家百纳", "", "下单日期：2026.6.18"],
    ["数    量", "1960支", "", "品名规格：50cm*5K 三折手开碳纤维伞", "", "", "地区：日本", "", "完工日期：2026.7.30进仓"],
    ["加大货样各1支"],
    ["注意：1、此订单共12款图案；2、此订单都需使用防水线"],
    ["材料", "明       细", "", "", "", "", "工艺要求"],
    ["伞骨\n（孔对孔）", "50cm*5K三折手开双碳纤骨", "", "", "", "", "1.大货样：每个设计各1支"],
    ["伞布规格", "30D全遮光黑涂层", "", "", "", "", "2.拉边要求：伞边普通三卷"],
    ["DL260134\n伞布明细\n（伞布到库后请通知跟单核对）", "品番/品名", "图片", "", "カラー\n（颜色）", "数量", "品番/品名", "图片", "カラー\n（颜色）", "数量"],
    ["", "27621 流水花扇PKGY", "", "", "PKGY", 100, "27621 花屋辻NV", "", "NV", 200],
    ["", "27621 花筏PK", "", "", "PK", 200, "27621 吉祥変わり檜垣OR", "", "OR", 100],
    ["伞头", "宇豪兴配套伞头", "", "", "", "", "4.小裁要求：4层"],
    ["伞头", "第二款：弯柄黑色", "", "", "", "", "5.合片要求：10针"],
    ["伞头带", "黑色圆形弹力伞头带", "", "木耳：", "本布木耳花+防水垫", "", "6.打顶要求：三圈"],
    ["布套", "本布袖口套+提耳", "", "", "", "", "7.缝伞要求：手缝三步"],
    ["正唛", "", "侧唛", "", "布量"],
    ["", "", "参考伞布规格对应的品番和颜色", "", "伞面（Y/DZ)"],
    ["", "", "", "", "伞带（Y/DZ)"],
    ["材料到货状态，所有注明B级单需验材料，是否到达仓库"],
    ["伞骨", "", "", "伞束"],
    ["伞布", "", "", "OPP套"],
  ];
  // B6:F6（明细那一格）是合并的：材料区的右边界靠它认（见 findLayout 的注释）。
  return workbook("DL250199", rows, [[5, 1, 5, 5]]);
}

test("版式一：表头字段按「标签：值」同格与右邻格读出", () => {
  const parsed = parseSalesOrderWorkbook(sampleOneLayout());
  assert.equal(parsed.fields.order_no, "DL260134");
  assert.equal(parsed.fields.customer_code, "家百纳");
  assert.equal(parsed.fields.order_date, "2026-06-18");
  assert.equal(parsed.fields.delivery_date, "2026-07-30");
  assert.equal(parsed.fields.completion_remark, "进仓", "「2026.7.30进仓」的尾巴是完工备注");
  assert.equal(parsed.fields.quantity, "1960");
  assert.equal(parsed.fields.unit, "支", "数量那一格写的是 1960支，单位要从这一格读出来");
  assert.equal(parsed.fields.product_name, "50cm*5K 三折手开碳纤维伞");
  assert.equal(parsed.fields.region, "日本");
  assert.match(parsed.fields.attention_note, /此订单共12款图案/, "注意：… 整行进注意事项");
});

test("版式一：材料区按类目认，同类目第二行收成「再加一款」", () => {
  const parsed = parseSalesOrderWorkbook(sampleOneLayout());
  assert.equal(parsed.fields.rib_spec, "50cm*5K三折手开双碳纤骨");
  assert.equal(parsed.fields.canopy_spec, "30D全遮光黑涂层");
  assert.equal(parsed.fields.handle_spec, "宇豪兴配套伞头");
  assert.equal(parsed.fields.handle_strap_spec, "黑色圆形弹力伞头带");
  assert.equal(parsed.fields.wood_ear_spec, "本布木耳花+防水垫", "木耳：在 D 列、值在 E 列，同一行里也要认");
  assert.equal(parsed.fields.bag_spec, "本布袖口套+提耳");
  const extra = parsed.extras.find((row) => row.spec_key === "handle_spec");
  assert.ok(extra, "第二行「伞头」要成为 handle_spec 的追加款");
  assert.equal(extra.content, "第二款：弯柄黑色");
  assert.equal(extra.label, "伞头", "追加款的类目名由类目键给（不许用纸上的字乱猜）");
});

test("版式一：明细表嵌在材料区中间也能读，并在正确的行停下", () => {
  const parsed = parseSalesOrderWorkbook(sampleOneLayout());
  assert.equal(parsed.details.length, 4, "左右两块并排 × 2 行 = 4 行；后面的材料行不能算明细");
  assert.deepEqual(parsed.details.map((row) => row.name), ["27621 流水花扇PKGY", "27621 花屋辻NV", "27621 花筏PK", "27621 吉祥変わり檜垣OR"]);
  assert.equal(parsed.details[0].group_name, "伞布明细", "分组名取自表头上方的横幅");
  assert.equal(parsed.details[0].color, "PKGY");
  assert.equal(parsed.details[0].quantity, "100");
});

test("版式一：正唛/侧唛的值在下一行、布量靠 Y/DZ 认、到货状态表不再往下读", () => {
  const parsed = parseSalesOrderWorkbook(sampleOneLayout());
  assert.equal(parsed.fields.shipping_mark_side, "参考伞布规格对应的品番和颜色");
  assert.equal(parsed.fields.shipping_mark_front, undefined, "样本1 的正唛本来就没内容");
  // 布量那一块只有标签没有值（样本1 就是这样），不能把「伞面（Y/DZ)」读成伞布规格。
  assert.equal(parsed.fields.fabric_usage_canopy, undefined);
  assert.equal(parsed.extras.filter((row) => !row.spec_key).length, 0, "到货状态勾选表里的「伞束/OPP套」不能被当成「其它」行");
  assert.equal(parsed.fields.runner_spec, undefined);
});

test("版式一：工艺要求按词认（编号是断的也认得出）", () => {
  const parsed = parseSalesOrderWorkbook(sampleOneLayout());
  assert.equal(parsed.fields.sample_requirement, "每个设计各1支");
  assert.equal(parsed.fields.edge_requirement, "伞边普通三卷");
  assert.equal(parsed.fields.cutting_requirement, "4层");
  assert.equal(parsed.fields.joining_requirement, "10针");
  assert.equal(parsed.fields.top_stitch_requirement, "三圈");
  assert.equal(parsed.fields.sewing_requirement, "手缝三步");
});

test("版式一：认不出的内容如实上报（不静默丢）", () => {
  const parsed = parseSalesOrderWorkbook(sampleOneLayout());
  const texts = parsed.unrecognized.map((item) => item.text);
  assert.ok(texts.includes("加大货样各1支"), "表头里游离的一行要上报");
  assert.ok(parsed.recognized.length > 20, "认出来的每一格都要能回查（核对清单）");
  assert.ok(parsed.recognized.every((item) => item.label && item.from), "核对清单要有中文名与单元格地址");
});

test("一份文件 = 一张单：多工作表与多处「单号」都如实上报，不静默只取第一个", () => {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([["客户单号：SO-1", "", "", "", "", "", "客户代码：家百纳"], ["数量", "1支", "", "品名规格：雨伞", "", "", "下单日期：2026.1.2"]]), "第一张");
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([["客户单号：SO-2"]]), "第二张");
  const parsed = parseSalesOrderWorkbook(XLSX.write(book, { type: "buffer", bookType: "xlsx" }));
  assert.equal(parsed.fields.order_no, "SO-1", "只读第一张有内容的表");
  assert.ok(parsed.warnings.some((message) => message.includes("还有 1 张有内容的表")), "剩下的表要上报，不能让人以为整本都补进去了");
  const twoLabels = workbook("单", [["客户单号：SO-1", "", "", "", "", "", "客户代码：家百纳"], ["订单号：SO-9", "", "", "", "", "", "下单日期：2026.1.2"], ["数量", "1支", "", "品名规格：雨伞"]]);
  const second = parseSalesOrderWorkbook(twoLabels);
  assert.ok(second.warnings.some((message) => message.includes("出现了 2 处「单号」字样")), "表里两个单号时要说出来，让人自己判断是不是多张单");
});

// ------------------------------------------------------------------ ② 版式二：样本2 的写法（标签与值分格）

/** 与 `DL260001-1 花色生产单-IS(FLOWER1 PO#32366-1).xlsx` 同构：表头分格、明细栏 B6:G6 合并、尾部伞头表。 */
function sampleTwoLayout() {
  const rows = [
    ["厦 门 迪 礼 伞 业 进 出 口 有 限 公 司"],
    [],
    ["工厂", "", "客户单号 DL260001-1 FLOWER1", "", "", "客户代码 IS（PO32366-1) ", "", "", "下单日期", "", "2025.12.15"],
    ["数量", "2505打", "", "品名规格", '21.5"X8K三折自动开双层伞', "", "", "", "完工日期"],
    [],
    ["材料", "明       细", "", "", "", "", "", "", "     工艺要求"],
    ["伞骨", '21.5"X8K三折自动伞，黑色电着铁中棒', "", "", "", "", "", "1.产前样：各色1支"],
    ["", "", "", "", "", "", "", "2.大裁开布要求：常规"],
    ["伞布", "双层：外层足178T碰击花布", "", "", "", "", "", ""],
    ["伞头", "共15款配色伞头", "", "", "", "", "", "6.伞带要求：常规"],
    ["内标", "4x18cm 对折条码内标", "", "", "", "", "", "吊牌图稿发客人确认"],
    ["", "", "", "", "", "", "", "包装明细"],
    ["", "", "", "", "", "", "", "1支/OPP袋；60支/外箱"],
    ["正           唛", "", "", "", " 侧           唛"],
    ["", "", "", "两正唛，其中一面封箱顶加印1面logo", "ORDER NO.:PO32366-1"],
    ["材料到货状态"],
    ["伞骨", "", "", "伞束", "", "", "粘扣"],
    ["Flower1 伞头英文名字 伞头图片", "", "", "", "伞头配色", "", "内标、吊牌、纸箱：条形码", "", "", "数量/打"],
    ["Eva 此款伞头待确认", "", "", "", "配色按图片", "", "4894300069470", "", "", 167],
    ["Hawái", "", "", "", "配色按图片", "", "4894300069500", "", "", 167],
  ];
  return workbook("32366-1 FLOWER1", rows, [[5, 1, 5, 6]]);
}

test("版式二：标签与值分格、数量带单位、包装明细的值在下一行", () => {
  const parsed = parseSalesOrderWorkbook(sampleTwoLayout());
  assert.equal(parsed.fields.order_no, "DL260001-1 FLOWER1");
  assert.equal(parsed.fields.customer_code, "IS（PO32366-1)");
  assert.equal(parsed.fields.order_date, "2025-12-15");
  assert.equal(parsed.fields.quantity, "2505");
  assert.equal(parsed.fields.unit, "打");
  assert.equal(parsed.fields.product_name, '21.5"X8K三折自动开双层伞');
  assert.equal(parsed.fields.packaging_spec, "1支/OPP袋；60支/外箱", "包装明细标签在 H 列、内容在下一行同一列");
  assert.equal(parsed.fields.shipping_mark_front, "两正唛，其中一面封箱顶加印1面logo");
  assert.equal(parsed.fields.shipping_mark_side, "ORDER NO.:PO32366-1");
});

test("版式二：尾部「伞头」表（英文名/配色/条码/数量打）收成细分明细", () => {
  const parsed = parseSalesOrderWorkbook(sampleTwoLayout());
  assert.equal(parsed.details.length, 2);
  assert.equal(parsed.details[0].group_name, "伞头明细", "没有横幅时按表头里的「伞头」叫一个可改的名字");
  assert.deepEqual(
    { name: parsed.details[0].name, color: parsed.details[0].color, barcode: parsed.details[0].barcode, quantity: parsed.details[0].quantity, unit: parsed.details[0].unit },
    { name: "Eva 此款伞头待确认", color: "配色按图片", barcode: "4894300069470", quantity: "167", unit: "打" },
  );
  assert.equal(parsed.fields.rib_spec, '21.5"X8K三折自动伞，黑色电着铁中棒', "右栏的工艺内容不能灌进左栏的材料值");
  assert.equal(parsed.fields.hang_tag_note, "发客人确认");
  assert.equal(parsed.fields.sample_requirement, "各色1支");
});

// ------------------------------------------------------------------ ③ 导出的工艺单能读回来

const EXPORT_MATERIALS = {
  rib_spec: "50cm 双碳纤骨", canopy_spec: "190T 素色黑", handle_spec: "直柄银色", handle_strap_spec: "黑色伞头带",
  tail_spec: "配套伞尾", runner_spec: "一体伞珠", strap_spec: "1.5cm 本布伞带", strap_fastener_spec: "黑色粘扣",
  inner_label_spec: "对折条码内标", woven_label_spec: "织标", hang_tag_spec: "双面吊牌", opp_spec: "一支一个",
  bag_spec: "本布袖口套", packaging_spec: "60支一箱", top_fabric_spec: "透明天布", wood_ear_spec: "海绵木耳花",
  keychain_spec: "钥匙扣", printing_spec: "伞面无印刷",
};
const EXPORT_PROCESSES = {
  sample_requirement: "每个设计各1支", cutting_requirement: "4层", edge_requirement: "普通三卷",
  joining_requirement: "10针", top_stitch_requirement: "三圈", sewing_requirement: "手缝三步",
  strap_requirement: "常规", hang_tag_note: "吊牌与布套提前出货", qc_requirement: "所有材料都要质检报告",
};

const exportOrderRow = (over = {}) => ({
  id: ORDER_ID, orderNo: "RT260001", orderDate: new Date("2026-08-01T00:00:00.000Z"), deliveryDate: new Date("2026-09-30T00:00:00.000Z"),
  productName: "21.5X8K 三折自动伞", productSpec: "黑色", quantity: "1200", unit: "支", itemNo: "HC-01", createdBy: user.id,
  customer: { name: "家百纳", countryRegion: "日本" },
  factory: "宇豪兴", completion_remark: "进仓", attention_note: "1、此订单都需使用防水线",
  shipping_mark_front: "两正唛", shipping_mark_side: "ORDER NO.:RT260001",
  fabric_usage_canopy: "12", fabric_usage_strap: "1.5", fabric_usage_wood_ear: "0.5", fabric_usage_top: "1", fabric_usage_bag: "1.2",
  ...EXPORT_MATERIALS, ...EXPORT_PROCESSES,
  specDetails: [
    { groupName: "伞布明细", name: "27621 流水花扇PKGY", color: "PKGY", barcode: null, quantity: "100", unit: "pcs", sortOrder: 0 },
    { groupName: "伞布明细", name: "27621 花屋辻NV", color: "NV", barcode: null, quantity: "200", unit: "pcs", sortOrder: 1 },
  ],
  materialExtras: [
    { id: "e1", label: "伞头", specKey: "handle_spec", content: "弯柄黑色", sortOrder: 0 },
    { id: "e2", label: "伞头", specKey: "handle_spec", content: "三折伞头（银）", sortOrder: 1 },
    { id: "e3", label: "弹簧", specKey: null, content: "开口弹簧 5cm", sortOrder: 2 },
  ],
  specDetailLabels: {},
  ...over,
});

const exportService = (row) => new SalesOrderExportService({ salesOrder: { findFirst: async () => row } }, { namesOf: async () => new Map([[user.id, "张三"]]) });

test("导出 → 解析：我们自己的工艺单能原样读回来（表头/布量/材质/工艺/明细/唛头）", async () => {
  const { buffer } = await exportService(exportOrderRow()).exportOrder(ORDER_ID);
  const parsed = parseSalesOrderWorkbook(buffer);
  assert.equal(parsed.fields.order_no, "RT260001");
  assert.equal(parsed.fields.item_no, "HC-01");
  assert.equal(parsed.fields.order_date, "2026-08-01");
  assert.equal(parsed.fields.delivery_date, "2026-09-30");
  assert.equal(parsed.fields.completion_remark, "进仓");
  assert.equal(parsed.fields.quantity, "1200");
  assert.equal(parsed.fields.unit, "支");
  assert.equal(parsed.fields.product_name, "21.5X8K 三折自动伞 黑色", "品名 + 规格是导出的合并文字，读回来是同一句");
  assert.equal(parsed.fields.fabric_usage_canopy, "12", "「12（Y/DZ)」里的 Y/DZ 是纸上的固定说明，不进字段");
  assert.equal(parsed.fields.fabric_usage_bag, "1.2");
  for (const [key, value] of Object.entries(EXPORT_MATERIALS)) assert.equal(parsed.fields[key], value, `材料明细 ${key} 要能读回来`);
  for (const [key, value] of Object.entries(EXPORT_PROCESSES)) assert.equal(parsed.fields[key], value, `工艺要求 ${key} 要能读回来`);
  assert.equal(parsed.fields.shipping_mark_front, "两正唛");
  assert.equal(parsed.fields.shipping_mark_side, "ORDER NO.:RT260001");
  assert.equal(parsed.fields.attention_note, "1、此订单都需使用防水线");
  assert.equal(parsed.fields.factory, "宇豪兴");
  assert.equal(parsed.fields.completion_remark, "进仓");
  assert.equal(parsed.details.length, 2, "导出的细分明细要能读回来");
  assert.equal(parsed.details[0].group_name, "伞布明细");
  assert.equal(parsed.details[1].name, "27621 花屋辻NV");
});

test("导出 → 解析：同类目多款（3 款伞头）读回来是「再加一款」，自由类目读回「其它」", async () => {
  const { buffer } = await exportService(exportOrderRow()).exportOrder(ORDER_ID);
  const parsed = parseSalesOrderWorkbook(buffer);
  assert.deepEqual(parsed.extras.map((row) => [row.spec_key, row.label, row.content]), [
    ["handle_spec", "伞头", "弯柄黑色"],
    ["handle_spec", "伞头", "三折伞头（银）"],
    [null, "弹簧", "开口弹簧 5cm"],
  ]);
});

// ------------------------------------------------------------------ ④ 真实样本（两块真文件在仓库里，存在就跑）

const SAMPLES = path.join(ROOT, "..", "..", "example", "销售单");
const sampleOne = path.join(SAMPLES, "DL260134 JBN生产单(1).xls");
const sampleTwo = path.join(SAMPLES, "DL260001-1 花色生产单-IS(FLOWER1 PO#32366-1).xlsx");
const sampleThree = path.join(SAMPLES, "DL260003ZG-424038.xls");

test("真实样本1（.xls）：表头/数量/18 项材料/9 条工艺/12 行伞布明细", { skip: fs.existsSync(sampleOne) ? false : "仓库里没有这份样本" }, () => {
  const parsed = parseSalesOrderWorkbook(fs.readFileSync(sampleOne));
  assert.equal(parsed.fields.order_no, "DL260134");
  assert.equal(parsed.fields.customer_code, "家百纳");
  assert.equal(parsed.fields.order_date, "2026-06-18");
  assert.equal(parsed.fields.delivery_date, "2026-07-30");
  assert.equal(parsed.fields.completion_remark, "进仓");
  assert.equal(parsed.fields.quantity, "1960");
  assert.equal(parsed.fields.unit, "支");
  assert.equal(parsed.fields.product_name, "50cm*5K 三折手开碳纤维伞");
  assert.equal(parsed.fields.rib_spec.startsWith("50cm*5K三折手开双碳纤骨"), true);
  assert.equal(parsed.fields.hang_tag_spec.startsWith("一张，正反面印刷"), true);
  assert.equal(parsed.fields.sample_requirement, "每个设计各1支");
  assert.equal(parsed.fields.qc_requirement, "所有材料和成品都要质检报告");
  assert.equal(parsed.details.length, 12);
  const total = parsed.details.reduce((sum, row) => sum + Number(row.quantity), 0);
  assert.equal(total, 1960, "伞布明细合计要等于标题数量（这条对不上就说明有行没读到）");
  assert.equal(parsed.details[0].group_name, "伞布明细");
  assert.equal(parsed.extras.length, 0, "这份表没有「其它」类目");
  assert.deepEqual(parsed.unrecognized.map((item) => item.text).sort(), ["加大货样各1支", "相关图片"].sort());
});

test("真实样本2（.xlsx）：尾部 15 行伞头明细 + 数量/打 + 正侧唛 + 包装明细", { skip: fs.existsSync(sampleTwo) ? false : "仓库里没有这份样本" }, () => {
  const parsed = parseSalesOrderWorkbook(fs.readFileSync(sampleTwo));
  assert.equal(parsed.fields.order_no, "DL260001-1 FLOWER1");
  assert.equal(parsed.fields.customer_code, "IS（PO32366-1)");
  assert.equal(parsed.fields.order_date, "2025-12-15");
  assert.equal(parsed.fields.quantity, "2505");
  assert.equal(parsed.fields.unit, "打");
  assert.equal(parsed.fields.packaging_spec.startsWith("1支/OPP袋"), true);
  assert.equal(parsed.fields.shipping_mark_front, "两正唛，其中一面封箱顶加印1面logo");
  assert.equal(parsed.fields.hang_tag_note, "发客人确认");
  assert.equal(parsed.details.length, 15, "伞头表 15 款");
  assert.equal(parsed.details.at(-1).name, "Alaya");
  assert.equal(parsed.details.reduce((sum, row) => sum + Number(row.quantity), 0), 2505);
  assert.equal(parsed.details[0].group_name, "伞头明细");
  assert.equal(parsed.unrecognized.length, 0, "这份表认不出来的是 0 处（认识的都已认走）");
});

/**
 * 第三份真实样本：`DL260003ZG-424038.xls`（「D生产单模板」，B级单）。
 *
 * 五处读错都出在这一份上，每一条都是「纸上有、解析器读歪了」（2026-11-12）：
 *   ① `区域：日本`（A3）不在地区别名表里 → 整格掉进 unrecognized，表单上看不到这条核对客户的线索；
 *   ② `伞头` + 换行 + `（螺丝配色）`（A9）：类目名后面那句括号备注让整格对不上「伞头」→ 落成「其它」行，
 *      真正的伞头规格（B9）反而没进 handle_spec；
 *   ③ `贴纸`（A18/B18）把右边工艺栏的 `贴纸位置`（H18）与 `无`（I18）一起并进 content → 「无 贴纸位置 无」；
 *   ④ 工艺编号写成 `8：缝伞要求：三步手缝，打蜡线`（H14）：冒号式编号没剥，值里带着「缝伞要求：」前缀，
 *      而同一栏的其它项（`10针`）都是干净的值；
 *   ⑤ 追加行的核对地址写死 `{row:0,col:0}` → 全部显示 A1（公司名那一格），回查不到纸上的行。
 */
test("真实样本3（D生产单模板 .xls）：区域 / 带括号备注的伞头 / 其它行不跨栏 / 冒号式编号 / 核对地址", { skip: fs.existsSync(sampleThree) ? false : "仓库里没有这份样本" }, () => {
  const parsed = parseSalesOrderWorkbook(fs.readFileSync(sampleThree));
  // 这一份本身要能读成一张单（后面的断言才有意义）
  assert.equal(parsed.fields.order_no, "DL260003ZG-424038");
  assert.equal(parsed.fields.quantity, "300");
  assert.equal(parsed.fields.unit, "打");
  assert.equal(parsed.fields.delivery_date, "2026-04-17");

  // ① 区域：日本（A3）
  assert.equal(parsed.fields.region, "日本");
  const region = parsed.recognized.find((item) => item.field === "region");
  assert.deepEqual({ value: region.value, from: region.from }, { value: "日本", from: "A3" });
  assert.equal(parsed.unrecognized.some((item) => item.where === "A3"), false, "认出来了就不该再进 unrecognized");

  // ② `伞头 （螺丝配色）`（A9）仍是「伞头」类目；「伞头带」不能被它顺带吞掉
  assert.equal(parsed.fields.handle_spec, "ABS料+PU棉，按钮开模");
  assert.equal(parsed.fields.handle_strap_spec, "黑色编织带伞头带，长10cm，宽0.8cm", "「伞头带」是另一个类目（长名字先认）");
  assert.deepEqual(parsed.extras.filter((row) => row.label.includes("伞头")), [], "括号备注不能让伞头变成「其它」行");

  // ③ 「贴纸」的内容只到 B18 为止，不跨进工艺栏（H18「贴纸位置」+ I18「无」）
  assert.deepEqual(parsed.extras.map((row) => [row.label, row.content]), [["贴纸", "无"], ["其他", "大货样1支，产前样1支"]]);

  // ④ `8：` 是编号不是标签：缝伞要求的值与其它项一样不带标签前缀
  assert.equal(parsed.fields.sewing_requirement, "三步手缝，打蜡线");
  assert.equal(parsed.fields.edge_requirement, "10针", "同一栏的其它项是干净的值，缝伞要求要对齐它");

  // ⑤ 追加行的 from 是纸上的真实地址（A18 / A22），不是 A1
  assert.deepEqual(
    parsed.recognized.filter((item) => item.field === "material_extra").map((item) => [item.label, item.from]),
    [["其它：贴纸", "A18"], ["其它：其他", "A22"]],
  );
  assert.equal(parsed.recognized.some((item) => item.from === "A1"), false, "A1 是公司名那一格，谁都不该从那里来");
  assert.equal(parsed.recognized.every((item) => /^[A-Z]{1,2}\d+$/.test(item.from)), true, "核对清单的每一行都要指得回纸上的格子");

  // 认不出的仍要如实上报（这一份有几条工艺栏里的自由条目没有对应栏位）
  const unknownTexts = parsed.unrecognized.map((item) => item.text);
  for (const text of ["贴纸位置", "质检报告", "织标位置", "2.大裁开布要求："]) {
    assert.ok(unknownTexts.includes(text), `「${text}」认不出就要上报，不能静默丢`);
  }
});

test("材料类目：末尾括号是备注，不是新类目；一句话（非备注）仍不按前缀认", () => {
  // 与「D生产单模板」同构的最小表：类目名 + 换行 + 括号备注，右边是「工艺要求」那一栏。
  const layout = workbook("模板", [
    ["材料", "明       细", "", "", "", "", "工艺要求"],
    ["伞头 （螺丝配色）", "ABS料+PU棉，按钮开模", "", "", "", "", ""],
    ["伞头带 （黑色）", "黑色编织带", "", "", "", "", ""],
    ["伞头需印 LOGO", "每款印在伞头顶部", "", "", "", "", ""],
  ], [[0, 1, 0, 5]]);
  const parsed = parseSalesOrderWorkbook(layout);
  assert.equal(parsed.fields.handle_spec, "ABS料+PU棉，按钮开模", "「伞头 （螺丝配色）」还是伞头");
  assert.equal(parsed.fields.handle_strap_spec, "黑色编织带", "「伞头带 （黑色）」剥完是「伞头带」，不能剥成「伞头」");
  assert.deepEqual(parsed.extras.filter((row) => row.spec_key === "handle_spec"), [], "不能被读成第二款伞头");
  assert.deepEqual(parsed.extras.map((row) => [row.label, row.content]), [["伞头需印 LOGO", "每款印在伞头顶部"]], "「伞头需印 LOGO」是一句话，不是类目名");
});

// ------------------------------------------------------------------ ⑤ 日期 / 数量归一

test("日期归一：点分/斜杠/中文/两位年份/Excel 序列号都认；认不出就不猜", () => {
  assert.equal(parseImportDate("", "2026.6.18"), "2026-06-18");
  assert.equal(parseImportDate("", "2026-06-18"), "2026-06-18");
  assert.equal(parseImportDate("", "2026/6/18"), "2026-06-18");
  assert.equal(parseImportDate("", "2026年6月18日"), "2026-06-18");
  assert.equal(parseImportDate("", "25.12.15"), "2025-12-15");
  assert.equal(parseImportDate("", "6/18/26"), "2026-06-18");
  assert.equal(parseImportDate(46191, ""), "2026-06-18", "Excel 日期序列号");
  assert.equal(parseImportDate("", "待定"), "", "认不出的日期必须留空（猜一个比空着危险）");
});

test("数量归一：带单位/千分位/纯数字", () => {
  assert.deepEqual(parseQuantityCell("1960支"), { quantity: "1960", unit: "支" });
  assert.deepEqual(parseQuantityCell("2505打"), { quantity: "2505", unit: "打" });
  assert.deepEqual(parseQuantityCell("1,960 PCS"), { quantity: "1960", unit: "PCS" });
  assert.deepEqual(parseQuantityCell("1200"), { quantity: "1200", unit: "" });
  assert.deepEqual(parseQuantityCell("—"), { quantity: "", unit: "" });
});

test("空表/坏文件：读不出任何字段（服务层据此回「这张表里没认出任何销售单字段」）", () => {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([[""]]), "空");
  const buffer = XLSX.write(book, { type: "buffer", bookType: "xlsx" });
  assert.equal(parseSalesOrderWorkbook(buffer).recognized.length, 0, "空表不猜任何字段");
  // xlsx 库会把「改了扩展名的纯文本」读成一张一行一列的表格，所以这里不要求抛错；
  // 该报错的是服务层（`SALES_ORDER_IMPORT_NOTHING_RECOGNIZED`），它才分得清「空表」与「坏文件」。
  assert.equal(parseSalesOrderWorkbook(Buffer.from("not an excel file")).recognized.length, 0);
});

// ------------------------------------------------------------------ ⑥ 预填载荷能直接提交

test("补录出来的 copy 载荷：补上客户与币种后能过真实 SalesOrderDto 校验", async () => {
  const parsed = parseSalesOrderWorkbook(sampleOneLayout());
  // 客户代码与地区是「对客户」的线索，不是销售单字段（服务层在组 copy 时会把它们摘掉）。
  const { customer_code, region, ...orderFields } = parsed.fields;
  assert.ok(customer_code && region);
  const body = {
    ...orderFields,
    spec_details: parsed.details.map((row, index) => ({ ...row, sort_order: index })),
    material_extras: parsed.extras,
    customer_id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
    currency: "USD",
  };
  for (const key of Object.keys(body)) if (body[key] === "" || body[key] === undefined) delete body[key];
  const pipe = new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true });
  const result = await pipe.transform(body, { type: "body", metatype: SalesOrderDto });
  assert.equal(result.order_no, "DL260134");
  assert.equal(result.spec_details.length, 4, "细分明细要能随同一份载荷提交");
  assert.equal(result.material_extras[0].spec_key, "handle_spec", "「再加一款」的归属类目要能随载荷提交");
  assert.equal(result.attention_note.startsWith("1、此订单共12款图案"), true);
});

// ------------------------------------------------------------------ ⑦ 客户匹配只做唯一命中

const CUSTOMERS = [
  { id: "c1", name: "家百纳", customerCode: "JBN", currency: "USD", isActive: true, countryRegion: "日本" },
  { id: "c2", name: "ISUZU", customerCode: "ISU", currency: "JPY", isActive: true, countryRegion: "日本" },
  { id: "c3", name: "IS", customerCode: "IS", currency: "USD", isActive: true, countryRegion: "日本" },
];

test("客户匹配：按名称 / 编码 / 去掉括号备注后的编码唯一命中；不做前缀模糊", () => {
  assert.equal(matchCustomer("家百纳", CUSTOMERS).id, "c1");
  assert.equal(matchCustomer("JBN", CUSTOMERS).id, "c1");
  assert.equal(matchCustomer("IS（PO32366-1)", CUSTOMERS).id, "c3", "样本2 的写法：括号里是客户自己的 PO");
  assert.equal(matchCustomer("ISU", CUSTOMERS).id, "c2");
  assert.equal(matchCustomer("I", CUSTOMERS), null, "前缀不能猜（IS / ISUZU 会串户）");
  assert.equal(matchCustomer("", CUSTOMERS), null);
});

// ------------------------------------------------------------------ ⑨ 服务层：把解析结果与库里的主数据对上

const DB_CUSTOMERS = [{ id: "c1", name: "家百纳", customerCode: "JBN", currency: "USD", isActive: true, countryRegion: "日本" }];
const DB_UNITS = [{ name: "支", isActive: true }, { name: "打", isActive: true }, { name: "pcs", isActive: true }];

/** 只实现预览用到的三条查询的假 prisma（与其它单测的"假 prisma"同形）。 */
function importHarness({ customers = DB_CUSTOMERS, units = DB_UNITS, orders = [] } = {}) {
  const prisma = {
    customer: { findMany: async () => customers },
    unit: { findMany: async () => units },
    salesOrder: { findFirst: async ({ where }) => orders.find((row) => row.orderNo === where.orderNo) ?? null },
  };
  return new SalesOrderImportService(prisma);
}

const previewOf = (service, buffer, name = "补录.xlsx") => service.preview({ buffer, originalname: name });

test("服务层：客户/单位/订单号都对得上时 status=ok，币种取客户的默认币种", async () => {
  const result = await previewOf(importHarness(), sampleOneLayout());
  assert.equal(result.status, "ok");
  assert.deepEqual(result.issues, [], "没有要改的东西时不能凭空冒出错误");
  assert.equal(result.customer_id, "c1");
  assert.equal(result.copy.customer_id, undefined, "客户 id 在顶层（与返单预览同形），copy 里是纯订单字段");
  assert.equal(result.copy.currency, "USD", "Excel 里没有币种 → 用客户的默认币种");
  assert.equal(result.copy.unit, "支");
  assert.equal(result.copy.product_name, "50cm*5K 三折手开碳纤维伞");
  assert.equal(result.copy.spec_details.length, 4);
  assert.equal(result.copy.material_extras.length, 1);
  assert.equal(result.summary.detail_rows, 4);
  assert.deepEqual(result.summary.missing, []);
});

test("服务层：订单号已被占用 → 必须改（报错要点出是哪个号、被谁占着）", async () => {
  const service = importHarness({ orders: [{ id: "o1", orderNo: "DL260134", status: "confirmed" }] });
  const result = await previewOf(service, sampleOneLayout());
  assert.equal(result.status, "partial");
  const error = result.issues.find((issue) => issue.field === "order_no");
  assert.match(error.message, /DL260134 在系统里已经有一张单了（状态：已确认）/);
});

test("服务层：客户没对上 → 报错并摆出表里的原文（不许自动新建客户，也不许猜一个最像的）", async () => {
  const result = await previewOf(importHarness({ customers: [] }), sampleOneLayout());
  assert.equal(result.customer_id, null);
  assert.equal(result.customer, null);
  const error = result.issues.find((issue) => issue.level === "error" && issue.field === "customer_id");
  assert.match(error.message, /客户「家百纳」在客户清单里没对上/);
  // 客户没对上 → 币种也就无从谈起：要提示用户自己选，而不是默认一个币种写进单里。
  assert.equal(result.copy.currency, undefined);
  assert.ok(result.issues.some((issue) => issue.level === "warning" && issue.field === "currency"));
});

test("服务层：单位按名字归一（pcs → PCS），清单里没有就只提醒、不拦", async () => {
  const service = importHarness({ units: [{ name: "PCS", isActive: true }] });
  const buffer = workbook("单", [["客户单号：SO-9", "", "", "", "", "", "客户代码：家百纳"], ["数量", "1200pcs", "", "品名规格：雨伞", "", "", "下单日期：2026.1.2"]]);
  const result = await previewOf(service, buffer);
  assert.equal(result.copy.unit, "PCS", "单位名称大小写不同要归一到清单里的写法");
  const missingUnit = await previewOf(importHarness({ units: [{ name: "打", isActive: true }] }), workbook("单", [["客户单号：SO-9", "", "", "", "", "", "客户代码：家百纳"], ["数量", "1200支", "", "品名规格：雨伞", "", "", "下单日期：2026.1.2"]]));
  assert.ok(missingUnit.issues.some((issue) => issue.field === "unit" && issue.level === "warning"));
});

test("服务层：文件不是 Excel / 读不出字段 → 422（不是静默返回一张空单）", async () => {
  const service = importHarness();
  await assert.rejects(() => previewOf(service, Buffer.from("x"), "订单.pdf"), (error) => error.getResponse().code === "SALES_ORDER_IMPORT_INVALID_FILE");
  const empty = workbook("空", [[""]]);
  await assert.rejects(() => previewOf(service, empty), (error) => error.getResponse().code === "SALES_ORDER_IMPORT_NOTHING_RECOGNIZED");
});

test("服务层：两份真实样本都能走到 status=ok（真实数据下的端到端补录）", { skip: fs.existsSync(sampleOne) ? false : "仓库里没有这份样本" }, async () => {
  const service = importHarness({ customers: [{ id: "c1", name: "家百纳", customerCode: "JBN", currency: "USD", isActive: true, countryRegion: "日本" }, { id: "c2", name: "IS", customerCode: "IS", currency: "JPY", isActive: true, countryRegion: "日本" }] });
  const first = await previewOf(service, fs.readFileSync(sampleOne), "DL260134 JBN生产单(1).xls");
  assert.equal(first.status, "ok");
  assert.equal(first.customer_id, "c1");
  assert.equal(first.copy.quantity, "1960");
  assert.equal(first.copy.spec_details.length, 12);
  assert.equal(first.summary.extra_rows, 0);
  const second = await previewOf(service, fs.readFileSync(sampleTwo), "DL260001-1 花色生产单.xlsx");
  assert.equal(second.status, "ok");
  assert.equal(second.customer_id, "c2", "「IS（PO32366-1)」去掉括号里的 PO 后对上客户编码 IS");
  assert.equal(second.copy.quantity, "2505");
  assert.equal(second.copy.spec_details.length, 15);
});

// ------------------------------------------------------------------ ⑩ 源级守卫

const controllerSource = fs.readFileSync(path.join(ROOT, "src", "modules", "sales", "sales-orders.controller.ts"), "utf8");
const moduleSource = fs.readFileSync(path.join(ROOT, "src", "modules", "sales", "sales.module.ts"), "utf8");
const parserSource = fs.readFileSync(path.join(ROOT, "src", "modules", "sales", "sales-order-import.ts"), "utf8");
const uploadLimits = require("../../dist/platform/http/upload-limits.js");

test("控制器：补录端点走 multipart + 10MB 上限 + 只放行 Excel", () => {
  assert.match(controllerSource, /@Post\("import-preview"\)/);
  // 上限不再写死在这个控制器里：全站文档导入共用一个数（platform/http/upload-limits），
  // 因为「同一个 10MB 在 5 处各写一遍」正是 2026-11-12 那次「应用 10MB、网关 1MB」的土壤。
  assert.match(controllerSource, /FileInterceptor\("file", \{ storage: memoryStorage\(\), limits: \{ fileSize: MULTER_DOCUMENT_FILE_SIZE_LIMIT \}, fileFilter: salesOrderImportFileFilter \}\)/);
  assert.match(controllerSource, /from "\.\.\/\.\.\/platform\/http\/upload-limits"/, "上限必须来自共享常量，不许再写一个裸数字");
  assert.match(controllerSource, /endsWith\("\.xlsx"\) \|\| name\.endsWith\("\.xls"\)/);
  assert.match(controllerSource, /salesOrderImport\.preview\(file\)/, "预览只调解析服务（不传 user，也就没有写库动作）");
});

test("上传体积口径：单文件 10MB 且「含 10MB」（Multer 到 >= 上限就拒，所以给它的数要 +1）", () => {
  // 实测（本地 API）：limit=10*1024*1024 时，正好 10,485,760 字节的文件被拒、10,485,759 能过。
  // 「单文件上限 10MB」若按字面理解必须成立，给 Multer 的数就得比承诺大 1 字节。
  assert.equal(uploadLimits.MAX_DOCUMENT_UPLOAD_BYTES, 10 * 1024 * 1024, "产品口径就是 10MB，不要偷偷改成别的数");
  assert.equal(uploadLimits.MULTER_DOCUMENT_FILE_SIZE_LIMIT, uploadLimits.MAX_DOCUMENT_UPLOAD_BYTES + 1, "给 Multer 的数必须是 上限+1（本来就是为了让「正好 10MB」能过）");
});

test("模块：SalesOrderImportService 已注册并导出", () => {
  assert.match(moduleSource, /providers: \[[^\]]*SalesOrderImportService/);
  assert.match(moduleSource, /exports: \[[^\]]*SalesOrderImportService/);
});

test("解析器：18 个类目名只有一份（复用 sales-material-labels，不另抄）", () => {
  assert.match(parserSource, /MATERIAL_CATEGORY_LABELS/);
  assert.equal(/\bribSpec\b|"伞骨（孔对孔）"\s*:\s*"rib_spec"/.test(parserSource), false, "不要把清单再抄一遍");
});

test("解析器：不写库（没有 prisma/audit 依赖）", () => {
  assert.equal(/prisma|AuditService|@nestjs/.test(parserSource), false, "解析器是纯函数，补录的第一步不许有副作用");
});
