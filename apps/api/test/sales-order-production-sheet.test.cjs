// 销售单「工艺单」导出的单元测试（手写假 Prisma + 真实 ExcelJS 读回）。
//
// 版式依据：example/销售单 里的两张样本。本文件**用样本的真实数字**来验：
//   样本1 DL260134 JBN：数量 1960支，12 款花色（pcs）合计正好 1960，完工日期「2026.7.30进仓」；
//   样本2 DL260001-1 FLOWER1：数量 2505打，15 款伞头 × 167打 = 2505，无布量区。
//
// 钉住四件事：
//   1. 空盘位自动省略（样本2 没有布量区就不印，不是印一片空白）；
//   2. 工艺要求重新编号，跳过的条目不能留出断号；
//   3. **图片格留空**：明细的「图片」列保留列位但单元格为空；
//   4. 全表不出现 UUID（制单人写姓名）。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { Prisma } = require("@prisma/client");
const ExcelJS = require("exceljs");
const { SalesOrderExportService, dotDate, trimDecimal } = require("../dist/modules/sales/sales-order-export.service.js");

const user = { id: "u-1", username: "sales", display_name: "张三" };

/** 样本1 的 12 款花色（品番/品名 + 颜色 + 数量），合计 1960。 */
const SAMPLE1_DETAILS = [
  ["27621 流水花扇PKGY", "PKGY", "100"], ["27621 花屋辻NV", "NV", "200"],
  ["27621 花筏PK", "PK", "200"], ["27621 吉祥変わり檜垣OR", "OR", "100"],
  ["27621 波笹梅紅葉BE", "BE", "120"], ["27621 藤花模様 BL", "BL", "120"],
  ["27621 菱繋ぎ NVMT", "NVMT", "200"], ["27621 宝相華文 NVRD", "NVRD", "200"],
  ["27621 菊牡丹 SV", "SV", "120"], ["27621 薄紅牡丹 SVPK", "SVPK", "200"],
  ["27621 松葉 BK", "BK", "200"], ["27621 亀甲梅扇 PU", "PU", "200"],
].map(([name, color, quantity], index) => ({ groupName: "伞布明细", name, color, quantity: new Prisma.Decimal(quantity), unit: "pcs", barcode: null, sortOrder: index }));

/** 样本2 的 15 款伞头（伞头英文名 + 条码 + 167打）。 */
const SAMPLE2_DETAILS = ["Eva", "Hawái", "Dalila", "Kassem", "Fares", "Kalili", "Abdala", "Sari", "Amaya", "Zainab fares", "Asía fares", "Fátima ale", "Afef Kassem", "Salim", "Alaya"]
  .map((name, index) => ({ groupName: "伞头配色", name, color: "配色按图片", quantity: new Prisma.Decimal("167"), unit: "打", barcode: `4894300069470`, sortOrder: index }));

/**
 * ⚠️ 形状 = **真实 Prisma 行**：`prisma.salesOrder.findFirst()` 返回的字段名是 schema 里的
 * `camelCase` 列名（`@map("rib_spec")` 只改数据库列名，不改客户端字段名）。
 *
 * 这里以前写的是**请求键**（`rib_spec`），也就是 `POST /sales-orders` 的 body 形状——不是读出来的
 * 形状。于是「按请求键去索引 camelCase 行」这个错在测试里永远读得到值、全绿，而真实导出
 * 除了 `factory`（键名与列名恰好相同）之外一个字都印不出来。用户 2026-09-20 的
 * 「材料明细写了、保存了，再打开就又没有了」与这是同一个根因，所以这份夹具必须一直保持
 * **Prisma 行形状**，不许再退回请求键。
 */
const sample1 = () => ({
  id: "order-1", orderNo: "DL260134", orderDate: new Date("2026-06-18T00:00:00.000Z"), deliveryDate: new Date("2026-07-30T00:00:00.000Z"),
  productName: "50cm*5K 三折手开碳纤维伞", productSpec: null, quantity: new Prisma.Decimal("1960"), unit: "支", createdBy: user.id,
  customer: { name: "家百纳", countryRegion: "日本" }, specDetails: SAMPLE1_DETAILS,
  factory: "JBN", completionRemark: "进仓",
  attentionNote: "1、此订单共12款图案，对应数量请参考伞布规格；2、布套、吊牌、吊牌绳7月24日提前出货，越快越好；3、此订单都需使用防水线；4、魔术贴颜色统一用黑色",
  ribSpec: "50cm*5K三折手开双碳纤骨双黑铝骨;7.6三折黑铝圆形顺杆中棒，配伞头尾",
  canopySpec: "30D全遮光黑涂层（30D贴膜），数码印刷，共12款设计图案",
  handleSpec: "宇豪兴配套伞头（薄型黑色成型把手+黑色圆形弹力伞带）",
  handleStrapSpec: "黑色圆形弹力伞头带", tailSpec: "宇豪兴配套伞尾", runnerSpec: "配套黑色一体伞珠",
  strapSpec: "1.5cm本布伞带+魔术贴", strapFastenerSpec: "黑色粘扣", innerLabelSpec: "无", wovenLabelSpec: "无",
  hangTagSpec: "一张，正反面印刷", oppSpec: "一支一个（厚度：4C）", bagSpec: "本布袖口套+提耳",
  packagingSpec: "1支一个opp袋，60支一个外箱+内围，无内盒",
  sampleRequirement: "大货样：每个设计各1支", cuttingRequirement: "小裁要求：4层",
  edgeRequirement: "伞边普通三卷，伞带缝合用产品相同布料", joiningRequirement: "10针（此订单都需使用防水线！）",
  topStitchRequirement: "三圈，缝线不外露", sewingRequirement: "手缝三步",
  hangTagNote: "吊牌与布套都需提前出货，布套每捆需要标明数量", qcRequirement: "所有材料和成品都要质检报告",
  shippingMarkFront: "（正唛图稿）", shippingMarkSide: "参考伞布规格对应的品番和颜色",
  fabricUsageCanopy: new Prisma.Decimal("1.2"), fabricUsageStrap: new Prisma.Decimal("0.3"),
});

const sample2 = () => ({
  id: "order-2", orderNo: "DL260001-1 FLOWER1", orderDate: new Date("2025-12-15T00:00:00.000Z"), deliveryDate: null,
  productName: "21.5\"X8K三折自动开双层伞", productSpec: null, quantity: new Prisma.Decimal("2505"), unit: "打", createdBy: "u-2",
  customer: { name: "IS", countryRegion: null }, specDetails: SAMPLE2_DETAILS,
  ribSpec: "21.5\"X8K三折自动伞，黑色电着铁中棒", canopySpec: "双层：外层足178T碰击花布，内层足155T涤纶素色布",
  tailSpec: "配色喷PU棉塑料伞尾", runnerSpec: "黑镍色西德珠", strapSpec: "本布伞带，足3.3CM",
  innerLabelSpec: "4x18cm 对折条码内标", hangTagSpec: "5.5x11.5cm 新款红色双面吊牌",
  keychainSpec: "1支一个钥匙扣，挂在伞头带上", oppSpec: "一支一个OPP袋,印刷白色LOGO",
  bagSpec: "本布斜切口布套加卡其色F9097包边", printingSpec: "伞面和布套无印刷", topFabricSpec: "透明天布", woodEarSpec: "黑色海绵木耳花",
  sampleRequirement: "产前样：各色1支", topStitchRequirement: "三圈", sewingRequirement: "枪打两步",
  hangTagNote: "吊牌图稿发客人确认", qcRequirement: "出货前发给客人质量检测报告",
  // 样本2 没有布量区
});

function fakeService(row, names = new Map([[user.id, "张三"], ["u-2", "李四"]])) {
  const prisma = { salesOrder: { findFirst: async () => row } };
  return new SalesOrderExportService(prisma, { namesOf: async () => names });
}

/** 读回工作表：返回 { rows, all }，all 是所有非空单元格的值。 */
async function readSheet(service, id) {
  const { buffer, orderNo } = await service.exportOrder(id);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.worksheets[0];
  const rows = [];
  const all = [];
  sheet.eachRow((row) => {
    const values = [];
    row.eachCell({ includeEmpty: true }, (cell) => {
      const value = cell.value;
      const text = value === null || value === undefined ? "" : typeof value === "object" && "result" in value ? value.result : value;
      values.push(text);
      if (text !== "" && text !== null && text !== undefined) all.push(text);
    });
    rows.push(values);
  });
  return { sheet, rows, all, orderNo, workbook };
}

const rowWith = (rows, label) => rows.find((row) => row.includes(label));

// ------------------------------------------------------------------ 纯文档

test("dotDate / trimDecimal：模板的日期与数量写法", () => {
  assert.equal(dotDate("2026-06-18T00:00:00.000Z"), "2026.6.18", "模板是不补零的 2026.6.18");
  assert.equal(dotDate("2025-12-15T00:00:00.000Z"), "2025.12.15");
  assert.equal(dotDate(null), "");
  assert.equal(trimDecimal("1960.0000"), "1960");
  assert.equal(trimDecimal("2505"), "2505");
  assert.equal(trimDecimal("1.2000"), "1.2");
});

test("样本1：表头、材料行、工艺条目重新编号、明细分组都对", () => {
  const doc = fakeService(sample1()).document(sample1(), "张三", new Date("2026-09-16T06:30:05.000Z"));

  assert.equal(doc.orderNo, "DL260134");
  assert.equal(doc.quantityText, "1960支");
  assert.equal(doc.orderDate, "2026.6.18");
  assert.equal(doc.completionText, "2026.7.30进仓", "完工日期带模板里的「进仓」后缀");
  assert.equal(doc.productSpecText, "50cm*5K 三折手开碳纤维伞");
  assert.equal(doc.region, "日本");
  assert.match(doc.attentionNote, /^1、此订单共12款图案/);

  // 材料行：只印有值的，按模板顺序（伞骨第一、包装明细在 OPP/布套之后）
  assert.deepEqual(doc.materialLines.map((line) => line.label), ["伞骨（孔对孔）", "伞布规格", "伞头", "伞头带", "伞尾、笠", "伞束、珠", "伞带", "伞带粘扣", "内标", "织标", "吊牌", "OPP", "布套", "包装明细"]);
  assert.equal(doc.materialLines.find((line) => line.label === "伞骨（孔对孔）").value.startsWith("50cm*5K三折手开双碳纤骨"), true);

  // 工艺要求：编号从 1 连续
  assert.deepEqual(doc.processLines.map((line) => line.slice(0, 2)), ["1.", "2.", "3.", "4.", "5.", "6.", "7.", "8."]);
  assert.equal(doc.processLines[0], "1.大货样：每个设计各1支");

  // 明细：一组 12 行，图片不在文档里（留空由落格处理）
  assert.equal(doc.detailGroups.length, 1);
  assert.equal(doc.detailGroups[0].groupName, "伞布明细");
  assert.equal(doc.detailGroups[0].lines.length, 12);
  assert.deepEqual(doc.detailGroups[0].lines[0], { name: "27621 流水花扇PKGY", color: "PKGY", barcode: "", quantity: "100", unit: "pcs" });

  assert.equal(doc.madeAt, "2026-09-16 14:30:05", "制表时间固定北京时间到秒");
});

test("样本1：明细合计 1960 = 单头数量，不提示；制单人写姓名", () => {
  const doc = fakeService(sample1()).document(sample1(), "张三");
  assert.equal(doc.quantityNotice, null);
  assert.equal(doc.makerName, "张三");
});

test("样本2：没有布量区（整块不印），伞头配色带条码，15×167=2505打不提示", () => {
  const doc = fakeService(sample2()).document(sample2(), "李四");
  assert.deepEqual(doc.fabricUsage, [], "样本2 没有布量区 → 整块为空");
  assert.equal(doc.shippingMarkFront, "");
  assert.equal(doc.shippingMarkSide, "");
  assert.equal(doc.materialLines.some((line) => line.label === "天布"), true);
  assert.equal(doc.materialLines.some((line) => line.label === "伞头带"), false, "样本2 没有伞头带这一行");
  assert.equal(doc.detailGroups[0].groupName, "伞头配色");
  assert.equal(doc.detailGroups[0].lines.length, 15);
  assert.equal(doc.detailGroups[0].lines[0].barcode, "4894300069470");
  assert.equal(doc.quantityText, "2505打");
  assert.equal(doc.quantityNotice, null);
  assert.equal(doc.completionText, "", "样本2 没有完工日期");
});

test("工艺要求跳号要重排：只填打顶与质检时是 1./2.，不能出现 5./9.", () => {
  const order = { ...sample1(), ribSpec: null, canopySpec: null, handleSpec: null, handleStrapSpec: null, tailSpec: null, runnerSpec: null, strapSpec: null, strapFastenerSpec: null, innerLabelSpec: null, wovenLabelSpec: null, hangTagSpec: null, oppSpec: null, bagSpec: null, packagingSpec: null, sampleRequirement: null, cuttingRequirement: null, edgeRequirement: null, joiningRequirement: null, sewingRequirement: null, hangTagNote: null };
  const doc = fakeService(order).document(order, "张三");
  assert.deepEqual(doc.processLines, ["1.三圈，缝线不外露", "2.所有材料和成品都要质检报告"]);
  assert.deepEqual(doc.materialLines, [], "材料全空时整块为空");
});

test("回归 2026-09-20：Prisma 行（camelCase 列名）必须读得出——材料/工艺/布量/注意事项都不许是空的", () => {
  // 这条用例是那次「材料明细写了、保存了、再打开就又没有了」的回归钉子。
  // 修之前：`materialLines` 是 0 行、`processLines` 是 0 条、`fabricUsage` 是空数组、
  // `attentionNote` 是空串——工艺单要发给工厂，材料那一整块是空白的。
  const doc = fakeService(sample1()).document(sample1(), "张三");
  assert.equal(doc.factory, "JBN", "factory 的键名与列名恰好相同，所以它以前是唯一「碰巧没坏」的一个");
  assert.match(doc.attentionNote, /^1、此订单共12款图案/);
  assert.equal(doc.completionText, "2026.7.30进仓", "完工日期后缀也要读到，不能只剩日期");
  assert.equal(doc.materialLines.length, 14, "材料明细整块要在（修之前是 0 行）");
  assert.equal(doc.processLines.length, 8, "工艺要求整块要在（修之前是 0 条）");
  assert.deepEqual(doc.fabricUsage.map((line) => line.value), ["1.2", "0.3"], "布量是 Decimal 列，也要读成文本");
  assert.equal(doc.shippingMarkFront, "（正唛图稿）");
});

test("回归：版本快照形状（请求键 snake_case）也读得出——读侧两种键名都认", () => {
  // `sales_order_versions.snapshot` 存的是**请求键**（v1 快照就是它把用户填的值留下来的）。
  // 读侧如果只认列名，从快照渲染的路径又会断一次。
  const snapshotShaped = { ...sample1(), rib_spec: "快照里的伞骨", attention_note: "快照里的注意事项" };
  delete snapshotShaped.ribSpec;
  delete snapshotShaped.attentionNote;
  const doc = fakeService(snapshotShaped).document(snapshotShaped, "张三");
  assert.equal(doc.materialLines.find((line) => line.label === "伞骨（孔对孔）").value, "快照里的伞骨");
  assert.equal(doc.attentionNote, "快照里的注意事项");
});

test("明细合计与单头数量不一致时给出核对提示", () => {
  const order = { ...sample1(), quantity: new Prisma.Decimal("1000") };
  const doc = fakeService(order).document(order, "张三");
  assert.match(doc.quantityNotice, /明细数量合计 1960 与单头数量 1000 支 不一致/);
});

// -------------------------------------------------------------------- 落格

test("样本1 落格：表头/材料/工艺/明细/布量/表尾都在，且**图片格为空**", async () => {
  const { rows, all, orderNo, sheet } = await readSheet(fakeService(sample1()), "order-1");
  assert.equal(orderNo, "DL260134");

  assert.equal(rows[0][0], "厦 门 迪 礼 伞 业 有 限 公 司");
  assert.ok(rowWith(rows, "工　厂")?.includes("JBN"));
  assert.ok(rowWith(rows, "客户单号")?.includes("DL260134"));
  assert.ok(rowWith(rows, "数　量")?.includes("1960支"));
  assert.ok(rowWith(rows, "品名规格")?.includes("50cm*5K 三折手开碳纤维伞"));
  assert.ok(rowWith(rows, "完工日期")?.includes("2026.7.30进仓"));
  assert.ok(rows.some((row) => String(row[0]).startsWith("注意：")));
  assert.ok(rowWith(rows, "明　细") !== undefined, "有材料明细就有「明细」栏头");
  assert.ok(rowWith(rows, "工艺要求") !== undefined);

  // 材料行与工艺条目并排
  const ribRow = rowWith(rows, "伞骨（孔对孔）");
  assert.ok(String(ribRow?.join(" ")).includes("50cm*5K三折手开双碳纤骨"));
  assert.ok(String(ribRow?.join(" ")).includes("1.大货样：每个设计各1支"), "同一行右侧是第 1 条工艺要求");

  // 明细块：12 行花色 + 图片列留空
  assert.ok(rows.some((row) => String(row[0]).includes("伞布明细")));
  const headerIndex = rows.findIndex((row) => row.includes("品番/品名") && row.includes("图片"));
  assert.ok(headerIndex > 0, "明细表头要有「图片」列");
  assert.equal(rows[headerIndex].includes("颜色") && rows[headerIndex].includes("数量"), true);
  assert.equal(rows[headerIndex][2], "图片", "表头第 3 列是「图片」");
  const firstDetail = rows[headerIndex + 1];
  const dataRow = rows[headerIndex + 2];
  assert.equal(firstDetail[0], "27621 流水花扇PKGY");
  assert.equal(dataRow[0], "27621 花屋辻NV");
  // 图片列（第 3 列，index 2）在**数据行**上必须是空的
  assert.equal(firstDetail[2] ?? "", "", "图片格必须留空（用户要求不导出图片）");
  assert.equal(dataRow[2] ?? "", "", "图片格必须留空（用户要求不导出图片）");
  assert.equal(dataRow[3], "NV", "颜色在第 4 列");
  assert.equal(dataRow[5], 200, "数量写成数值单元格");

  // 布量（样本1 有）与表尾
  assert.ok(rows.some((row) => row.includes("伞面") && String(row.join(" ")).includes("1.2（Y/DZ)")), "布量只在样本1出现");
  const footer = rows.find((row) => String(row[0]).startsWith("制单："));
  assert.ok(footer, "表尾要有制单行");
  assert.match(String(footer[0]), /制单：张三/);
  assert.match(String(footer[0]), /审核：/, "审核留白供手签");
  assert.match(String(footer[0]), /制表时间：\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}（北京时间）/);

  // 全表不得出现 UUID（制单人是姓名）
  for (const value of all) {
    assert.equal(typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(value), false, `单元格里出现了 UUID：${String(value)}`);
  }
  assert.equal(Boolean(sheet), true);
});

test("样本2 落格：没有布量区就不印那块，明细换成伞头配色带条码", async () => {
  const { rows } = await readSheet(fakeService(sample2()), "order-2");

  assert.equal(rows.some((row) => row.includes("伞面")), false, "样本2 没有布量 → 整块不印，不留空白");
  assert.equal(rows.some((row) => row.includes("正　唛")), false, "正唛/侧唛都空 → 也不印");
  assert.ok(rows.some((row) => String(row[0]).includes("伞头配色")));

  const headerIndex = rows.findIndex((row) => row.includes("品番/品名") && row.includes("条码"));
  assert.ok(headerIndex > 0);
  const dataRow = rows[headerIndex + 1];
  assert.equal(dataRow[0], "Eva");
  assert.equal(dataRow[2] ?? "", "", "图片格留空");
  assert.equal(dataRow[3], "配色按图片");
  assert.equal(dataRow[4], "4894300069470");
  assert.equal(dataRow[5], 167, "数量写成数值单元格");
  assert.equal(dataRow[6], "打");
});

test("老销售单（全空）也能导出：不报错、不留空区块、表尾照样有制单人", async () => {
  const legacy = {
    id: "order-3", orderNo: "DL250199", orderDate: new Date("2026-01-05T00:00:00.000Z"), deliveryDate: null,
    productName: "雨伞", productSpec: null, quantity: new Prisma.Decimal("10"), unit: "支", createdBy: user.id,
    customer: { name: "老客户", countryRegion: null }, specDetails: [],
  };
  const { rows, all } = await readSheet(fakeService(legacy), "order-3");

  assert.equal(rows.some((row) => String(row[0]).startsWith("注意：")), false);
  assert.equal(rows.some((row) => row.includes("品番/品名")), false, "没有明细就不印明细块");
  assert.equal(rows.some((row) => row.includes("伞面")), false);
  assert.ok(rows.some((row) => String(row[0]).startsWith("制单：张三")));
  assert.ok(all.includes("10支"));
});

test("核对提示会印在表尾（不一致时必须让工厂看到）", async () => {
  const order = { ...sample1(), quantity: new Prisma.Decimal("2000") };
  const { rows } = await readSheet(fakeService(order), "order-1");
  const notice = rows.find((row) => String(row[0]).startsWith("核对提示："));
  assert.ok(notice, "不一致时要有核对提示行");
  assert.match(String(notice[0]), /明细数量合计 1960 与单头数量 2000 支 不一致/);
});
