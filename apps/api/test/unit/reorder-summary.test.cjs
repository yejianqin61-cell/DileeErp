// 复盘增强（T14）：交期达成、合格率趋势、毛利（复用财务口径）与总结表导出。
//
// 设计：docs/design/reorder-item-no-and-summary-2026-09-26.md §七（P4）
// 三条要点：未出货/无交期**不算准时**；一批没有"趋势"可言；毛利**不在这里算成本**。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { Prisma } = require("@prisma/client");
const ExcelJS = require("exceljs");
const { ReorderService } = require("../../dist/modules/reorder/reorder.service.js");
const { ReorderExportService } = require("../../dist/modules/reorder/reorder-export.service.js");
const { deliveryVerdict, deliverySummary, qualityTrend, DELIVERY_VERDICT_LABELS } = require("../../dist/modules/reorder/reorder.domain.js");

const decimal = (value) => new Prisma.Decimal(value);

const orderRow = (overrides = {}) => ({
  id: `order-${overrides.orderNo ?? "X"}`, orderNo: "DL260001-1", itemNo: "27621 流水花扇",
  orderDate: new Date("2026-06-18T00:00:00.000Z"), deliveryDate: new Date("2026-07-30T00:00:00.000Z"),
  status: "closed", currentVersion: 1, quantity: decimal("1960"), unit: "支", currency: "USD",
  productName: "三折伞", customerId: "customer-1", customerSnapshot: { name: "FLOWER1" }, reorderFromOrderNo: null,
  ...overrides,
});

function fakePrisma(rows = {}) {
  const table = (name) => ({ findMany: async () => rows[name] ?? [] });
  return {
    salesOrder: { findFirst: async () => ("order" in rows ? rows.order : null), findMany: async () => rows.orders ?? [] },
    bom: table("boms"), purchaseOrder: table("purchases"), receivableSource: table("receivables"),
    finishedGoodsQcRecord: table("qc"), productionOrder: table("production"),
    finishedGoodsInbound: table("inbounds"), finishedGoodsOutbound: table("outbounds"),
  };
}

/** 财务侧的桩：只实现 `salesGrossProfit`（T14 只从财务模块借这一个口径）。 */
const financeStub = (rowsByOrder = {}) => ({
  salesGrossProfit: async ({ orderNo }) => rowsByOrder[orderNo] ?? { rows: [], footnotes: [] },
});

// ------------------------------------------------------------------ 纯函数

test("交期结论：未出货与无交期都**不算准时**（算成准时会让「这个货交期很稳」变成假结论）", () => {
  assert.deepEqual(deliveryVerdict(null, new Date("2026-07-01")), { verdict: "no_promise", days_delta: null });
  assert.deepEqual(deliveryVerdict(new Date("2026-07-30"), null), { verdict: "not_shipped", days_delta: null });
  assert.deepEqual(deliveryVerdict(new Date("2026-07-30"), new Date("2026-07-20")), { verdict: "early", days_delta: -10 });
  assert.deepEqual(deliveryVerdict(new Date("2026-07-30"), new Date("2026-07-30T18:00:00Z")), { verdict: "on_time", days_delta: 0 }, "同一天的不同时刻算准时");
  assert.deepEqual(deliveryVerdict(new Date("2026-07-30"), new Date("2026-08-02")), { verdict: "late", days_delta: 3 });
  assert.equal(DELIVERY_VERDICT_LABELS.late, "逾期");
});

test("交期汇总：五档都要出现（缺档会让人以为没算）", () => {
  assert.deepEqual(deliverySummary(["early", "late", "late", "not_shipped"]), { early: 1, on_time: 0, late: 2, not_shipped: 1, no_promise: 0 });
});

test("合格率趋势：**至少两批**有质检事实才给；分母为 0 的批次不进趋势", () => {
  const points = (rows) => qualityTrend(rows);
  const row = (orderNo, inspected, qualified) => ({ orderNo, orderDate: new Date("2026-06-01"), inspected: decimal(inspected), qualified: decimal(qualified) });
  assert.deepEqual(points([row("A", 100, 95), row("B", 200, 180)]), [
    { order_no: "A", order_date: "2026-06-01T00:00:00.000Z", inspected: "100", qualified: "95", qualified_rate: "0.95" },
    { order_no: "B", order_date: "2026-06-01T00:00:00.000Z", inspected: "200", qualified: "180", qualified_rate: "0.9" },
  ]);
  assert.deepEqual(points([row("A", 100, 95)]), [], "一批没有趋势可言：硬画一个点比不画更误导");
  assert.deepEqual(points([row("A", 100, 95), row("B", 0, 0)]), [], "只有一批有事实 → 仍然不给趋势");
});

// ------------------------------------------------------------------ 详情里的三块

test("详情：每批给交期结论，取**最早一次真正发出**的出库（分批出货看第一批）", async () => {
  const service = new ReorderService(fakePrisma({
    orders: [orderRow({ orderNo: "A-1", deliveryDate: new Date("2026-07-30") }), orderRow({ orderNo: "A-2", deliveryDate: null, orderDate: new Date("2026-07-01") })],
    outbounds: [
      { orderNo: "A-1", quantity: decimal("1000"), status: "posted", shipmentDate: new Date("2026-08-02"), createdAt: new Date("2026-08-02") },
      { orderNo: "A-1", quantity: decimal("900"), status: "posted", shipmentDate: new Date("2026-07-20"), createdAt: new Date("2026-07-20") },
      { orderNo: "A-1", quantity: decimal("500"), status: "draft", shipmentDate: new Date("2026-09-09"), createdAt: new Date("2026-09-09") },
    ],
  }));
  const detail = await service.articleDetail("27621 流水花扇");
  const first = detail.orders.find((order) => order.order_no === "A-1");
  assert.equal(first.delivery.actual_date, "2026-07-20T00:00:00.000Z", "最早的一次发出（草稿不算）");
  assert.equal(first.delivery.verdict, "early");
  assert.equal(first.delivery.verdict_label, "提前");
  assert.equal(first.outbound_quantity, "1900", "已出库仍是所有已发出批次之和");
  const second = detail.orders.find((order) => order.order_no === "A-2");
  assert.equal(second.delivery.verdict, "no_promise");
  assert.deepEqual(detail.delivery_summary, { early: 1, on_time: 0, late: 0, not_shipped: 0, no_promise: 1 });
});

test("详情：拿到财务模块时给毛利（含缺价警告），拿不到就是 null（不自己写第二套成本口径）", async () => {
  const orders = [orderRow({ orderNo: "A-1", quantity: decimal("1960"), currency: "USD" }), orderRow({ orderNo: "A-2", quantity: decimal("500"), currency: "USD", status: "draft" })];
  const prisma = fakePrisma({ orders });
  const finance = financeStub({
    "A-1": { rows: [{ orderNo: "A-1", currency: "USD", salesAmount: decimal("2352"), costAmount: decimal("1200") }], footnotes: ["缺采购价物料（成本按 0 计入，毛利偏高）：MAT-9 伞骨"] },
    // A-2 是草稿：利润报表按已确认/已关闭取数，所以它的行集是空的
  });
  const detail = await new ReorderService(prisma, finance).articleDetail("27621 流水花扇");
  const first = detail.gross_margin.batches.find((batch) => batch.order_no === "A-1");
  assert.equal(first.included, true);
  assert.equal(first.sales_amount, "2352");
  assert.equal(first.cost_amount, "1200");
  assert.equal(first.gross_profit, "1152", "毛利 = 销售金额 − BOM 原料成本");
  assert.equal(first.cost_caveat, true, "缺采购价必须标出来：否则毛利虚高且从表上看不出来");
  const draft = detail.gross_margin.batches.find((batch) => batch.order_no === "A-2");
  assert.equal(draft.included, false, "草稿单不在利润报表行集里");
  assert.equal(draft.gross_profit, null, "给 null，不是 0");
  assert.deepEqual(detail.gross_margin.totals, [{ currency: "USD", order_count: 1, sales_amount: "2352", cost_amount: "1200", gross_profit: "1152" }], "合计只算纳入的批次");
  assert.ok(detail.gross_margin.footnotes.some((note) => note.includes("缺采购价")));

  const withoutFinance = await new ReorderService(prisma).articleDetail("27621 流水花扇");
  assert.equal(withoutFinance.gross_margin, null, "财务模块不可用就整块不给，而不是自己算一个");
});

// ------------------------------------------------------------------ 导出

test("导出：总结表含订单号/交期结论/毛利数值/表尾口径说明，且口径与页面同源", async () => {
  const orders = [orderRow({ orderNo: "A-1", quantity: decimal("1960") })];
  const service = new ReorderService(fakePrisma({
    orders,
    qc: [{ orderNo: "A-1", inspectedQuantity: decimal("1960"), qualifiedQuantity: decimal("1930"), conditionalAcceptQuantity: decimal("0"), rejectedQuantity: decimal("30") }],
    outbounds: [{ orderNo: "A-1", quantity: decimal("1900"), status: "signed", shipmentDate: new Date("2026-07-25"), createdAt: new Date("2026-07-25") }],
  }), financeStub({ "A-1": { rows: [{ orderNo: "A-1", currency: "USD", salesAmount: decimal("2352"), costAmount: decimal("1200") }], footnotes: [] } }));
  const exporter = new ReorderExportService(service);
  const { buffer, fileName } = await exporter.articleSummary("27621 流水花扇");

  assert.match(fileName, /^迪礼ERP-货号总结-27621 流水花扇\.xlsx$/);
  assert.equal(ReorderExportService.fileName("27621/2 测试"), "迪礼ERP-货号总结-27621_2 测试.xlsx", "文件名里的非法字符要洗掉（否则落盘失败）");

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.worksheets[0];
  const all = [];
  sheet.eachRow((row) => row.eachCell((cell) => all.push(cell.value)));
  assert.ok(all.includes("货号总结：27621 流水花扇"));
  assert.ok(all.includes("A-1"));
  assert.ok(all.includes("提前"), "交期结论要出现在表里");
  const grossCell = sheet.getRow(4).getCell(10);
  assert.equal(grossCell.value, 1152, "毛利是**数值**格（能直接参与计算）");
  assert.equal(grossCell.numFmt, "0.00##");
  assert.equal(sheet.getRow(4).getCell(11).value, 1930 / 1960, "合格率是比例数值");
  assert.ok(all.some((value) => typeof value === "string" && value.includes("只算材料")), "表尾要写清毛利口径（不含人工/外加工）");
  assert.ok(all.some((value) => typeof value === "string" && value.includes("未出货与无交期都不算准时")), "交期口径要写清");
});

test("导出：没有财务口径时表尾说明「本表不含毛利」，而不是留一片空白让人以为毛利为 0", async () => {
  const service = new ReorderService(fakePrisma({ orders: [orderRow({ orderNo: "A-1" })] }));
  const workbook = new ReorderExportService(service).workbook(await service.articleDetail("27621 流水花扇"), "27621 流水花扇");
  const sheet = workbook.worksheets[0];
  const all = [];
  sheet.eachRow((row) => row.eachCell((cell) => all.push(cell.value)));
  assert.ok(all.some((value) => typeof value === "string" && value.includes("本表不含毛利")));
  assert.equal(sheet.getRow(4).getCell(10).value, null, "没有毛利时那一格是空的（不是 0）");
});
