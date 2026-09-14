const assert = require("node:assert/strict");
const { test } = require("node:test");
const { Prisma } = require("@prisma/client");
const XLSX = require("xlsx");
const { ProductionPayrollExportService } = require("../dist/modules/production/production-payroll-export.service.js");

// 全站计时单位统一为小时：生产薪资导出（工序盘点表/当月工序明细总表/订单号盘点表）
// 的表头、明细与汇总都必须是小时，且明细与汇总不能一个按小时、一个按分钟。
//
// 2026-09-14 起这些数字还必须是 **Excel 数值单元格**（不是文本）：读取时 raw: true 直接拿到 number，
// 因此本文件的断言从 "1.5" 改成 1.5。文本型数字在 Excel 里不能求和/筛选/排序。

function reportRow(overrides = {}) {
  return {
    id: "report-1",
    orderNo: "DL260001",
    productionOrderNoSnapshot: "MO-260001",
    operationNameSnapshot: "缝制",
    reportDate: new Date("2026-09-03T00:00:00.000Z"),
    wageMode: "time_rate",
    quantity: new Prisma.Decimal("0"),
    durationMinutes: new Prisma.Decimal("90"),
    unitPrice: new Prisma.Decimal("40"),
    calculatedAmount: new Prisma.Decimal("60"),
    remark: "上午班",
    employeeNameSnapshot: "张三",
    employee: { employeeNo: "E001", employeeType: "workshop", department: { name: "车间" } },
    productionOrderOperation: { id: "operation-1", targetQuantity: new Prisma.Decimal("500") },
    ...overrides,
  };
}

function build(rows) {
  const prisma = {
    employeeDailyReport: { findMany: async () => rows, groupBy: async () => [] },
    operationCatalog: { findFirst: async () => ({ operationName: "缝制" }) },
  };
  const audit = { record: async () => undefined };
  return new ProductionPayrollExportService(prisma, audit);
}

function sheetRows(buffer) {
  const book = XLSX.read(buffer, { type: "buffer" });
  const sheet = book.Sheets[book.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null });
}

/** 原始单元格表：用来断言单元格类型（t === "n" 才是数值型，t === "s" 是文本型）。 */
function sheetCells(buffer) {
  const book = XLSX.read(buffer, { type: "buffer" });
  return book.Sheets[book.SheetNames[0]];
}

function cellType(sheet, rowIndex, columnIndex) {
  const cell = sheet[XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex })];
  return cell ? cell.t : undefined;
}

function rowContaining(rows, label) {
  return rows.find((row) => Array.isArray(row) && row.includes(label));
}

/** 汇总行：首列为空、标签列等于 label 的那一行。 */
function summaryRow(rows, label) {
  return rows.find((row) => Array.isArray(row) && row[0] === null && row[1] === label);
}

test("工序盘点表：明细与汇总都按小时展示（90 分钟 => 1.5 小时）", async () => {
  const service = build([reportRow(), reportRow({ id: "report-2", durationMinutes: new Prisma.Decimal("120"), calculatedAmount: new Prisma.Decimal("80") })]);
  const rows = sheetRows(await service.exportOperation({ operation_id: "operation-1", month: "2026-09" }, { id: "user-1", username: "admin" }));
  const detailHeader = rowContaining(rows, "时长（小时）");
  assert.ok(detailHeader, "明细表头必须是时长（小时）");
  assert.equal(rows.some((row) => Array.isArray(row) && row.includes("时长（分钟）")), false, "不得再出现分钟口径表头");
  const detailRows = rows.filter((row) => Array.isArray(row) && row[0] === "DL260001");
  assert.equal(detailRows.length, 2);
  // 明细列：0 订单号、9 计件数量、10 时长（小时）、11 单价
  assert.equal(detailRows[0][10], 1.5, "90 分钟应展示为 1.5 小时");
  assert.equal(detailRows[1][10], 2, "120 分钟应展示为 2 小时");
  assert.ok(rowContaining(rows, "时长（小时）合计"), "汇总表头必须是时长（小时）合计");
  const summary = summaryRow(rows, "DL260001");
  assert.ok(summary, "汇总行必须存在");
  // 汇总列：0 空、1 订单号、2 生产单号、3 件数合计、4 其中计件、5 其中计时、6 时长（小时）合计
  assert.equal(summary[6], 3.5, "汇总时长必须是小时（1.5 + 2），不能是分钟合计 210");
  assert.equal(summary[3], 0, "计时行的件数为 0（本用例计时工人未填报件数）");
  assert.equal(summary[4], 0, "其中计件 = 0");
  assert.equal(summary[5], 0, "其中计时 = 0");
});

test("汇总的件数合计包含计时工人的计件数量，并给出计件/计时拆分（客户要求）", async () => {
  const piece = reportRow({ id: "report-piece", wageMode: "piece_rate", quantity: new Prisma.Decimal("30"), durationMinutes: null, calculatedAmount: new Prisma.Decimal("90"), unitPrice: new Prisma.Decimal("3") });
  const timedWithQuantity = reportRow({ id: "report-time", wageMode: "time_rate", quantity: new Prisma.Decimal("12"), durationMinutes: new Prisma.Decimal("90") });
  const service = build([piece, timedWithQuantity]);
  const rows = sheetRows(await service.exportOperation({ operation_id: "operation-1", month: "2026-09" }, { id: "user-1", username: "admin" }));
  const summary = summaryRow(rows, "DL260001");
  assert.equal(summary[3], 42, "件数合计 = 计件 30 + 计时工人填报的 12");
  assert.equal(summary[4], 30, "其中计件 = 30");
  assert.equal(summary[5], 12, "其中计时 = 12");
  const timedDetail = rows.find((row) => Array.isArray(row) && row[0] === "DL260001" && row[8] === "计时");
  assert.equal(timedDetail[9], 12, "计时行的计件数量也要输出（以前是空）");
  assert.equal(timedDetail[10], 1.5, "计时行同时给出时长（小时）");
});

test("当月工序明细总表：汇总时长与明细同口径（回归：曾出现表头小时、汇总分钟）", async () => {
  const service = build([reportRow()]);
  const rows = sheetRows(await service.exportMonthlyOperations({ month: "2026-09" }, { id: "user-1", username: "admin" }));
  assert.ok(rowContaining(rows, "时长（小时）合计"), "汇总表头必须是时长（小时）合计");
  const summary = summaryRow(rows, "缝制");
  assert.ok(summary, "工序汇总行必须存在");
  // 汇总列：0 空、1 工序、2 件数合计、3 其中计件、4 其中计时、5 时长（小时）合计
  assert.equal(summary[5], 1.5, "汇总时长必须是 1.5 小时而不是 90 分钟");
});

test("订单号盘点表：计时行展示小时，备注列原样输出", async () => {
  const service = build([reportRow()]);
  const rows = sheetRows(await service.exportOrder({ order_no: "DL260001" }, { id: "user-1", username: "admin" }));
  const detailRow = rows.find((row) => Array.isArray(row) && row[0] === "DL260001" && row.length > 13);
  assert.ok(detailRow, "明细行必须存在");
  assert.equal(detailRow[10], 1.5);
  assert.equal(detailRow[13], "上午班", "备注列必须输出日报备注");
  assert.equal(detailRow[11], 40, "单价为 元/小时");
});

test("计件行时长留空（只有计时行才输出小时数）", async () => {
  const piece = reportRow({ wageMode: "piece_rate", quantity: new Prisma.Decimal("30"), durationMinutes: null, calculatedAmount: new Prisma.Decimal("90"), unitPrice: new Prisma.Decimal("3") });
  const service = build([piece]);
  const rows = sheetRows(await service.exportOrder({ order_no: "DL260001" }, { id: "user-1", username: "admin" }));
  const detailRow = rows.find((row) => Array.isArray(row) && row[0] === "DL260001" && row.length > 13);
  assert.equal(detailRow[9], 30);
  assert.equal(detailRow[10], null, "计件行不得输出时长");
});

test("极小非零时长不会被显示成 0（历史分钟兼容数据）", async () => {
  const service = build([reportRow({ durationMinutes: new Prisma.Decimal("0.0001"), calculatedAmount: new Prisma.Decimal("0") })]);
  const rows = sheetRows(await service.exportOrder({ order_no: "DL260001" }, { id: "user-1", username: "admin" }));
  const detailRow = rows.find((row) => Array.isArray(row) && row[0] === "DL260001" && row.length > 13);
  assert.equal(detailRow[10], 0.00000167, "0.0001 分钟应提升精度展示，而不是显示 0");
});

// ------------------------------------------------------------------ 数字单元格必须是数值类型

/**
 * 不变量：任何“看起来是数字”的单元格都必须是数值型（t === "n"）。
 *
 * 文本型数字在 Excel 里是一格文字：SUM 得 0、筛选分不出区间、排序按字典序（"100" < "20"）。
 * 这条断言覆盖整张表，新增列只要写成字符串就会被抓住。
 */
function assertNoTextNumbers(buffer, label) {
  const sheet = sheetCells(buffer);
  const offenders = [];
  for (const [address, cell] of Object.entries(sheet)) {
    if (address.startsWith("!")) continue;
    if (cell.t === "s" && typeof cell.v === "string" && /^-?\d+(\.\d+)?$/.test(cell.v.trim())) offenders.push(`${address}=${cell.v}`);
  }
  assert.deepEqual(offenders, [], `${label}：不允许把数字写成文本单元格（Excel 里无法求和/筛选/排序）`);
}

test("工序盘点表：明细的数字列必须是数值单元格，整表不允许出现文本型数字", async () => {
  const service = build([reportRow()]);
  const buffer = await service.exportOperation({ operation_id: "operation-1", month: "2026-09" }, { id: "user-1", username: "admin" });
  const rows = sheetRows(buffer);
  const detailIndex = rows.findIndex((row) => Array.isArray(row) && row.includes("时长（小时）"));
  const sheet = sheetCells(buffer);
  for (const column of [9, 10, 11, 12]) {
    assert.equal(cellType(sheet, detailIndex + 1, column), "n", `明细第 ${column} 列必须是数值单元格`);
  }
  assertNoTextNumbers(buffer, "工序盘点表");
});

test("当月工序明细总表 / 订单号盘点表：汇总与明细的数字列都是数值单元格", async () => {
  const service = build([reportRow()]);
  const monthly = await service.exportMonthlyOperations({ month: "2026-09" }, { id: "user-1", username: "admin" });
  assertNoTextNumbers(monthly, "当月工序明细总表");
  const order = await service.exportOrder({ order_no: "DL260001" }, { id: "user-1", username: "admin" });
  const rows = sheetRows(order);
  const headerIndex = rows.findIndex((row) => Array.isArray(row) && row.includes("时长（小时）"));
  const sheet = sheetCells(order);
  for (const column of [9, 10, 11, 12]) {
    assert.equal(cellType(sheet, headerIndex + 1, column), "n", `订单号盘点表明细第 ${column} 列必须是数值单元格`);
  }
  assertNoTextNumbers(order, "订单号盘点表");
});
