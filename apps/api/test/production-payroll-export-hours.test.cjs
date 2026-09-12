const assert = require("node:assert/strict");
const { test } = require("node:test");
const { Prisma } = require("@prisma/client");
const XLSX = require("xlsx");
const { ProductionPayrollExportService } = require("../dist/modules/production/production-payroll-export.service.js");

// 全站计时单位统一为小时：生产薪资导出（工序盘点表/当月工序明细总表/订单号盘点表）
// 的表头、明细与汇总都必须是小时，且明细与汇总不能一个按小时、一个按分钟。

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
  assert.equal(detailRows[0][10], "1.5", "90 分钟应展示为 1.5 小时");
  assert.equal(detailRows[1][10], "2", "120 分钟应展示为 2 小时");
  assert.ok(rowContaining(rows, "时长（小时）合计"), "汇总表头必须是时长（小时）合计");
  const summary = summaryRow(rows, "DL260001");
  assert.ok(summary, "汇总行必须存在");
  assert.equal(summary[4], "3.5", "汇总时长必须是小时（1.5 + 2），不能是分钟合计 210");
});

test("当月工序明细总表：汇总时长与明细同口径（回归：曾出现表头小时、汇总分钟）", async () => {
  const service = build([reportRow()]);
  const rows = sheetRows(await service.exportMonthlyOperations({ month: "2026-09" }, { id: "user-1", username: "admin" }));
  assert.ok(rowContaining(rows, "时长（小时）合计"), "汇总表头必须是时长（小时）合计");
  const summary = summaryRow(rows, "缝制");
  assert.ok(summary, "工序汇总行必须存在");
  assert.equal(summary[3], "1.5", "汇总时长必须是 1.5 小时而不是 90 分钟");
});

test("订单号盘点表：计时行展示小时，备注列原样输出", async () => {
  const service = build([reportRow()]);
  const rows = sheetRows(await service.exportOrder({ order_no: "DL260001" }, { id: "user-1", username: "admin" }));
  const detailRow = rows.find((row) => Array.isArray(row) && row[0] === "DL260001" && row.length > 13);
  assert.ok(detailRow, "明细行必须存在");
  assert.equal(detailRow[10], "1.5");
  assert.equal(detailRow[13], "上午班", "备注列必须输出日报备注");
  assert.equal(detailRow[11], "40", "单价为 元/小时");
});

test("计件行时长留空（只有计时行才输出小时数）", async () => {
  const piece = reportRow({ wageMode: "piece_rate", quantity: new Prisma.Decimal("30"), durationMinutes: null, calculatedAmount: new Prisma.Decimal("90"), unitPrice: new Prisma.Decimal("3") });
  const service = build([piece]);
  const rows = sheetRows(await service.exportOrder({ order_no: "DL260001" }, { id: "user-1", username: "admin" }));
  const detailRow = rows.find((row) => Array.isArray(row) && row[0] === "DL260001" && row.length > 13);
  assert.equal(detailRow[9], "30");
  assert.equal(detailRow[10], "", "计件行不得输出时长");
});
