// 成品出库单「导出 Excel / 打印」（用户 2026-11-02）。
//
// 用户原话：「针对系统中的出库单，要支持导出 excel，支持打印」。
//
// 六件事钉死：
//   ① 打印件数据（`buildDocument`）与导出件（`exportDocument`）是**同一份**组装结果；
//   ② 单头/客户/订单/生产单/数量/发货/签收/制单都进纸上，空值落空串（留格手写）；
//   ③ 草稿/已取消/已冲销的状态**印在标题上**（一张"待出库"被当成发货凭据比没有单子更糟）；
//   ④ 数量去尾零（`1200.0000` → `1200`）；
//   ⑤ xlsx 是 A4 竖版、列名与纸面版式一致；
//   ⑥ 源级守卫：路由两段（不被 `outbounds/:id` 吃掉）、模块注册、导出文件名带单号。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const ExcelJS = require("exceljs");
const {
  FinishedGoodsOutboundExportService, finishedGoodsOutboundDocument, outboundLines, OUTBOUND_STATUS_LABELS,
} = require("../../dist/modules/warehouse/finished-goods-outbound-export.service.js");

const ROOT = path.join(__dirname, "..", "..");
const ACTOR = "00000000-0000-0000-0000-0000000000aa";

/** 假 prisma：只实现 `findFirst`（导出服务只查这一条）。 */
const outboundRow = (over = {}) => ({
  outboundNo: "FGO-20261102-0001",
  status: "draft",
  orderNo: "DL260134",
  productNameSnapshot: "50cm*5K 三折手开碳纤维伞",
  productSpecificationSnapshot: "50cm*5K",
  quantity: "1200.0000",
  createdAt: new Date("2026-11-02T02:03:04.000Z"),
  shipmentDate: new Date("2026-11-03T00:00:00.000Z"),
  carrier: "顺丰",
  trackingNo: "SF123",
  packingListNo: "PL-1",
  invoiceNo: "INV-1",
  signedAt: null,
  signatureReference: null,
  remark: "分两车",
  riskReason: "",
  createdBy: ACTOR,
  unit: { name: "支" },
  salesOrder: { customer: { name: "家百纳" } },
  productionOrder: { productionOrderNo: "MO-20261102-0001" },
  outboundNotice: { noticeNo: "OGN-0001" },
  ...over,
});

const harness = (row) => new FinishedGoodsOutboundExportService({ finishedGoodsOutbound: { findFirst: async () => row } }, { namesOf: async () => new Map([[ACTOR, "张三"]]) });

/** 读回工作表：稠密行数组（与其它导出布局测试同一口径）。 */
async function readSheet(service, id = "ob-1") {
  const { buffer, outboundNo } = await service.exportDocument(id);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.worksheets[0];
  const rows = [];
  sheet.eachRow((line) => {
    const values = [];
    line.eachCell({ includeEmpty: true }, (cell) => values.push(cell.value));
    rows.push(values);
  });
  return { rows, sheet, outboundNo };
}

const flat = (rows) => rows.flat().map((value) => (value === null || value === undefined ? "" : String(value)));

test("打印件数据：单头字段齐全、空值落空串（留格手写）、制单人印姓名", () => {
  const document = finishedGoodsOutboundDocument(outboundRow(), "张三", new Date("2026-11-02T10:00:00.000Z"));
  assert.equal(document.outboundNo, "FGO-20261102-0001");
  assert.equal(document.statusLabel, "待出库");
  assert.equal(document.customerName, "家百纳");
  assert.equal(document.orderNo, "DL260134");
  assert.equal(document.implementationOrderNo, "MO-20261102-0001", "生产单号要和订单号分开印，仓库据此回查批次");
  assert.equal(document.outboundNoticeNo, "OGN-0001");
  assert.equal(document.quantity, "1200", "1200.0000 去尾零，纸上不印四位小数");
  assert.equal(document.unitName, "支");
  assert.equal(document.outboundDate, "2026-11-02");
  assert.equal(document.shipmentDate, "2026-11-03");
  assert.equal(document.signedDate, "", "没签收就是空串（纸上的空格子留给手写）");
  assert.equal(document.signatureReference, "");
  assert.equal(document.makerName, "张三");
  assert.match(document.printedAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
});

test("打印件明细：一行（一次出库 = 一个产品的一批数量），备注与风险原因合在一起", () => {
  const lines = outboundLines(finishedGoodsOutboundDocument(outboundRow({ riskReason: "超出计划量，客户确认" }), "张三"));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].sequence, 1);
  assert.equal(lines[0].productName, "50cm*5K 三折手开碳纤维伞");
  assert.equal(lines[0].unit, "支");
  assert.equal(lines[0].quantity, "1200");
  assert.match(lines[0].remark, /分两车/);
  assert.match(lines[0].remark, /风险原因：超出计划量，客户确认/);
});

test("状态：六个状态都有中文；草稿/已取消/已冲销要印在标题上", async () => {
  assert.deepEqual(OUTBOUND_STATUS_LABELS, { draft: "待出库", posted: "已出库", shipped: "已发出", signed: "已签收", reversed: "已冲销", cancelled: "已取消" });
  for (const [status, suffix] of [["draft", "（待出库）"], ["cancelled", "（已取消）"], ["reversed", "（已冲销）"]]) {
    const { rows } = await readSheet(harness(outboundRow({ status })));
    const title = String(rows[0][0]);
    assert.ok(title.includes("【成品出库单】") && title.includes(suffix), `${status} 的标题必须写状态，实际：${title}`);
  }
  for (const status of ["posted", "shipped", "signed"]) {
    const { rows } = await readSheet(harness(outboundRow({ status })));
    assert.ok(!String(rows[0][0]).includes("（"), `${status} 是正常状态，标题不应带括号后缀`);
  }
});

test("xlsx：A4 竖版、列名与打印件一致、单号/客户/数量/签字行/页脚都在", async () => {
  const { rows, sheet, outboundNo } = await readSheet(harness(outboundRow()));
  assert.equal(outboundNo, "FGO-20261102-0001", "导出文件名用单号（不用 UUID）");
  assert.equal(sheet.pageSetup.paperSize, 9, "A4");
  assert.equal(sheet.pageSetup.orientation, "portrait");
  assert.equal(sheet.pageSetup.fitToWidth, 1, "纸面版式要能一页宽印下");
  const text = flat(rows).join(" | ");
  for (const expected of ["FGO-20261102-0001", "家百纳", "DL260134", "MO-20261102-0001", "OGN-0001", "1200", "支", "顺丰", "SF123", "PL-1", "INV-1", "分两车", "仓库经办", "客户签收", "制单：张三"]) {
    assert.ok(text.includes(expected), `纸上少了「${expected}」`);
  }
  const headerRow = rows.find((line) => line[0] === "序号");
  assert.ok(headerRow, "必须有明细表头（序号开头）");
  // 明细表在 8 列上合并（序号 A / 产品名称 B / 规格型号 C:D / 单位 E / 数量 F / 备注 G:H），
  // ExcelJS 读回时合并区每一格都会带同一个值，所以按「去重后的列名」比较。
  assert.deepEqual([...new Set(headerRow.filter((value) => value !== null && value !== undefined && value !== ""))], ["序号", "产品名称", "规格型号", "单位", "数量", "备注"]);
  const totalRow = rows.find((line) => line[0] === "合计");
  assert.ok(totalRow, "必须有合计行");
  assert.equal(totalRow[5], 1200, "合计 = 本批数量（在「数量」那一列）");
});

test("取不到单据：404 FINISHED_GOODS_OUTBOUND_NOT_FOUND（不是导出一张空纸）", async () => {
  await assert.rejects(() => harness(null).exportDocument("missing"), (error) => {
    assert.equal(error.getStatus(), 404);
    assert.equal(error.getResponse().code, "FINISHED_GOODS_OUTBOUND_NOT_FOUND");
    return true;
  });
  await assert.rejects(() => harness(null).buildDocument("missing"), (error) => error.getResponse().code === "FINISHED_GOODS_OUTBOUND_NOT_FOUND");
});

// ------------------------------------------------------------------ 源级守卫

const controllerSource = fs.readFileSync(path.join(ROOT, "src", "modules", "warehouse", "finished-goods-outbound.controller.ts"), "utf8");
const moduleSource = fs.readFileSync(path.join(ROOT, "src", "modules", "production", "production.module.ts"), "utf8");

test("控制器：打印数据与导出两条路由都在，且导出文件名带单号", () => {
  assert.match(controllerSource, /@Get\("outbounds\/:id\/slip-document"\)/);
  assert.match(controllerSource, /@Get\("outbounds\/:id\/export\.xlsx"\)/);
  assert.match(controllerSource, /filename\*=UTF-8''\$\{encodeURIComponent\(`迪礼ERP-成品出库单-\$\{outboundNo\}\.xlsx`\)\}/);
  // 两段路由必须声明在单段的 @Get("outbounds/:id") 之前（Nest 按声明顺序匹配，仓库模块踩过这个坑）
  assert.ok(controllerSource.indexOf('@Get("outbounds/:id/slip-document")') < controllerSource.indexOf('@Get("outbounds/:id") async getOutbound'), "打印路由要排在 :id 之前");
  assert.ok(controllerSource.indexOf('@Get("outbounds/:id/export.xlsx")') < controllerSource.indexOf('@Get("outbounds/:id") async getOutbound'), "导出路由要排在 :id 之前");
});

test("模块：FinishedGoodsOutboundExportService 已注册", () => {
  assert.match(moduleSource, /providers: \[[^\]]*FinishedGoodsOutboundExportService/);
});
