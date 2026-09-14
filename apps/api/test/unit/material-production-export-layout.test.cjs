// 生产进度表 / 「材料与车间生产对应表」下表的版式。
//
// 版式决策（客户按 A4 打印反馈后调整）：**列 = 工序，行 = 日期**。
// 原版是「行 = 工序、列 = 日期」：一个月 30+ 列，横向必然超出 A4；
// 换成工序做列后列数 = 工序数（本厂约 14 个），行数随日期纵向增长，整张表更容易落进一页 A4。
// 目标数量与加工地点保留为表头下两行标注，表尾一行合计，出货数量作为单一数值放在表头上方。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const XLSX = require("xlsx");
const { Prisma } = require("@prisma/client");
const { ProductionPayrollExportService } = require("../../dist/modules/production/production-payroll-export.service.js");

const user = { id: "00000000-0000-0000-0000-000000000001", username: "tester" };
const audit = { record: async () => undefined };

function service() {
  const prisma = {
    salesOrder: { findFirst: async () => ({ quantity: new Prisma.Decimal(100), productName: "折叠伞" }) },
    purchaseOrder: { findMany: async () => [] },
    productionOrder: {
      findMany: async () => [
        {
          id: "po-1",
          orderNo: "SO-1",
          productionOrderNo: "MO-1",
          executionLocation: { name: "一车间" },
          operations: [
            { id: "op-1", operationNameSnapshot: "裁剪", targetQuantity: new Prisma.Decimal(100) },
            { id: "op-2", operationNameSnapshot: "包装", targetQuantity: new Prisma.Decimal(100) },
          ],
        },
      ],
    },
    employeeDailyReport: {
      groupBy: async () => [
        { productionOrderOperationId: "op-1", reportDate: new Date("2026-09-01T00:00:00.000Z"), _sum: { quantity: new Prisma.Decimal(30) } },
        { productionOrderOperationId: "op-1", reportDate: new Date("2026-09-02T00:00:00.000Z"), _sum: { quantity: new Prisma.Decimal(20) } },
        { productionOrderOperationId: "op-2", reportDate: new Date("2026-09-02T00:00:00.000Z"), _sum: { quantity: new Prisma.Decimal(50) } },
      ],
    },
    finishedGoodsOutbound: { aggregate: async () => ({ _sum: { quantity: new Prisma.Decimal(12) } }) },
  };
  return new ProductionPayrollExportService(prisma, audit);
}

function sheetRows(buffer) {
  const book = XLSX.read(buffer, { type: "buffer" });
  const sheet = book.Sheets[book.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: true, defval: "" });
}

/** 定位进度表表头（首列是「日期」且含「当日合计」）。 */
function headerIndex(rows) {
  return rows.findIndex((row) => String(row[0]) === "日期" && row.map((cell) => String(cell)).includes("当日合计"));
}

// ------------------------------------------------------------------ 独立的生产进度表

test("生产进度表：列头是工序、行头是日期（横纵表头互换）", async () => {
  const rows = sheetRows(await service().exportProductionProgress({ order_no: "SO-1" }, user));
  const index = headerIndex(rows);
  assert.ok(index > 0, "必须能找到进度表表头");

  const header = rows[index].map((cell) => String(cell));
  assert.deepEqual(header, ["日期", "裁剪", "包装", "当日合计"], "第一列是日期，其余列是工序，最后一列是当日合计");
  assert.equal(header.filter((cell) => /^\d{4}-\d{2}-\d{2}$/.test(cell)).length, 0, "日期不允许出现在列头里");

  // 日期成为行头，且只作为行头出现一次
  const dateColumn = rows.slice(index + 1).map((row) => String(row[0]));
  assert.deepEqual(dateColumn, ["目标数量", "加工地点", "2026-09-01", "2026-09-02", "合计"], "行头依次是两行标注、日期行与合计行");
  const flat = rows.flat().map((cell) => String(cell));
  assert.equal(flat.filter((cell) => cell === "2026-09-01").length, 1, "日期只作为行头出现一次");
  assert.equal(flat.filter((cell) => cell === "2026-09-02").length, 1);
});

test("生产进度表：目标数量与加工地点保留为表头下两行标注", async () => {
  const rows = sheetRows(await service().exportProductionProgress({ order_no: "SO-1" }, user));
  const index = headerIndex(rows);
  assert.deepEqual(rows[index + 1].map((cell) => String(cell)), ["目标数量", "100", "100", ""], "每个工序列填自己的计划数量");
  assert.deepEqual(rows[index + 2].map((cell) => String(cell)), ["加工地点", "一车间", "一车间", ""], "每个工序列填自己的执行地点");
});

test("生产进度表：单元格是当日该工序的完成数量，当日合计与表尾合计都对", async () => {
  const rows = sheetRows(await service().exportProductionProgress({ order_no: "SO-1" }, user));
  const index = headerIndex(rows);
  const [, , firstDateRow, secondDateRow, totalRow] = rows.slice(index + 1);

  assert.deepEqual(firstDateRow.map((cell) => String(cell)), ["2026-09-01", "30", "", "30"], "9-01 只有裁剪报工");
  assert.deepEqual(secondDateRow.map((cell) => String(cell)), ["2026-09-02", "20", "50", "70"], "9-02 裁剪 20 + 包装 50");
  assert.deepEqual(totalRow.map((cell) => String(cell)), ["合计", "50", "50", "100"], "表尾按工序累计，并给出全部合计");
});

test("生产进度表：出货数量作为单一数值出现在表头上方，不再逐工序重复", async () => {
  const rows = sheetRows(await service().exportProductionProgress({ order_no: "SO-1" }, user));
  const flat = rows.flat().map((cell) => String(cell));
  assert.equal(flat.filter((cell) => cell === "12").length, 1, "出货数量只出现一次");
  assert.ok(rows.some((row) => String(row[0]) === "出货数量" && String(row[1]) === "12"), "出货数量放在元信息里");
  const index = headerIndex(rows);
  assert.equal(rows[index].map((cell) => String(cell)).includes("出货"), false, "表头里不再有逐工序重复的「出货」列");
});

test("生产进度表：表头说明改成「每列为一个工序」", async () => {
  const rows = sheetRows(await service().exportProductionProgress({ order_no: "SO-1" }, user));
  const flat = rows.flat().map((cell) => String(cell));
  assert.ok(flat.some((cell) => cell.includes("每列为一个工序") && cell.includes("行为生产日期")), "说明文字必须与新版式一致");
});

test("生产进度表：没有日报时仍输出表头、两行标注与合计行（合计为 0 而不是缺行）", async () => {
  const base = service();
  base.prisma.employeeDailyReport = { groupBy: async () => [] };
  const rows = sheetRows(await base.exportProductionProgress({ order_no: "SO-1" }, user));
  const index = headerIndex(rows);
  assert.deepEqual(rows.slice(index + 1).map((row) => String(row[0])), ["目标数量", "加工地点", "合计"]);
  assert.deepEqual(rows[index + 3].map((cell) => String(cell)), ["合计", "0", "0", "0"]);
});

test("生产进度表：同一工序名出现多次时补生产单号，列名不重复", async () => {
  const base = service();
  base.prisma.productionOrder = {
    findMany: async () => [
      { id: "po-1", orderNo: "SO-1", productionOrderNo: "MO-1", executionLocation: { name: "一车间" }, operations: [{ id: "op-1", operationNameSnapshot: "裁剪", targetQuantity: new Prisma.Decimal(100) }] },
      { id: "po-2", orderNo: "SO-1", productionOrderNo: "MO-2", executionLocation: { name: "二车间" }, operations: [{ id: "op-2", operationNameSnapshot: "裁剪", targetQuantity: new Prisma.Decimal(50) }] },
    ],
  };
  base.prisma.employeeDailyReport = { groupBy: async () => [] };
  const rows = sheetRows(await base.exportProductionProgress({ order_no: "SO-1" }, user));
  const header = rows[headerIndex(rows)].map((cell) => String(cell));
  assert.deepEqual(header, ["日期", "裁剪（MO-1）", "裁剪（MO-2）", "当日合计"], "重名工序必须能区分");
  assert.equal(new Set(header).size, header.length, "列名不允许重复");
});

// ------------------------------------------------------------------ 兼容入口（合并工作表）

test("合并工作表的下表沿用新版式：日期做行头，工序做列头", async () => {
  const rows = sheetRows(await service().exportMaterialProduction({ order_no: "SO-1" }, user));
  const flat = rows.flat().map((cell) => String(cell));
  assert.ok(flat.some((cell) => cell.includes("下表：生产进度表") && cell.includes("每列为一个工序")), "下表标题要说明新的列含义");
  const index = headerIndex(rows);
  assert.ok(index > 0, "必须能找到下表表头");
  // 上表有 10 列，xlsx 会把表头行右侧补齐成空串，因此只比对新版式的前 4 列
  assert.deepEqual(rows[index].slice(0, 4).map((cell) => String(cell)), ["日期", "裁剪", "包装", "当日合计"]);
  assert.equal(rows[index].slice(4).every((cell) => String(cell) === ""), true, "表头右侧不应再有历史列名（数量/加工地点/汇总/出货）");
  assert.equal(flat.filter((cell) => cell === "2026-09-01").length, 1, "日期 2026-09-01 只作为行头出现一次");
  assert.equal(flat.filter((cell) => cell === "2026-09-02").length, 1, "日期 2026-09-02 只作为行头出现一次");
});
