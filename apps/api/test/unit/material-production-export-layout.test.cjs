const assert = require("node:assert/strict");
const { test } = require("node:test");
const XLSX = require("xlsx");
const { Prisma } = require("@prisma/client");
const { ProductionPayrollExportService } = require("../../dist/modules/production/production-payroll-export.service.js");

// 「材料与车间生产对应表」下表的版式：每一列是一个生产日期（日期只作为**列名**出现一次），
// 单元格是当天该工序的完成数量。
// 客户反馈：之前每行都在日期列里重复填一遍日期，等于把列名又抄进了数据区。
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
    finishedGoodsOutbound: { aggregate: async () => ({ _sum: { quantity: new Prisma.Decimal(0) } }) },
  };
  return new ProductionPayrollExportService(prisma, audit);
}

function sheetRows(buffer) {
  const book = XLSX.read(buffer, { type: "buffer" });
  const sheet = book.Sheets[book.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: true, defval: "" });
}

test("下表把日期作为列名：每个日期在整张表里只出现一次（不再逐行填充）", async () => {
  const rows = sheetRows(await service().exportMaterialProduction({ order_no: "SO-1" }, user));
  const flat = rows.flat().map((cell) => String(cell));
  assert.equal(flat.filter((cell) => cell === "2026-09-01").length, 1, "日期 2026-09-01 只应作为列名出现一次");
  assert.equal(flat.filter((cell) => cell === "2026-09-02").length, 1, "日期 2026-09-02 只应作为列名出现一次");
});

test("下表按日期列填当天完成数量，并保留汇总与出货列", async () => {
  const rows = sheetRows(await service().exportMaterialProduction({ order_no: "SO-1" }, user));
  const headerIndex = rows.findIndex((row) => row[0] === "工序" && row.includes("汇总"));
  assert.ok(headerIndex > 0, "必须能找到下表表头");
  const header = rows[headerIndex].map((cell) => String(cell));
  const firstDateColumn = header.indexOf("2026-09-01");
  const secondDateColumn = header.indexOf("2026-09-02");
  assert.ok(firstDateColumn > 0 && secondDateColumn > firstDateColumn, "日期列必须按顺序成为独立列名");
  const summaryColumn = header.indexOf("汇总");
  const shippedColumn = header.indexOf("出货");
  assert.ok(summaryColumn > secondDateColumn && shippedColumn === summaryColumn + 1, "汇总/出货必须紧跟在日期列之后");
  // 表头里不应再有旧的「日期 + 数量」成对结构。
  assert.equal(header.filter((cell) => cell === "数量").length, 1, "只保留工序目标数量那一列「数量」");

  const cutRow = rows[headerIndex + 1];
  assert.equal(String(cutRow[0]), "裁剪");
  assert.equal(String(cutRow[firstDateColumn]), "30", "2026-09-01 列应填当天完成数量");
  assert.equal(String(cutRow[secondDateColumn]), "20", "2026-09-02 列应填当天完成数量");
  assert.equal(String(cutRow[summaryColumn]), "50", "汇总 = 各日期之和");

  const packRow = rows[headerIndex + 2];
  assert.equal(String(packRow[firstDateColumn]), "", "当天没有报工的日期列留空");
  assert.equal(String(packRow[secondDateColumn]), "50");
});

test("下表标题说明每列是一个生产日期，避免读者误以为缺列", async () => {
  const rows = sheetRows(await service().exportMaterialProduction({ order_no: "SO-1" }, user));
  const flat = rows.flat().map((cell) => String(cell));
  assert.ok(flat.some((cell) => cell.includes("下表：生产进度表") && cell.includes("每列为一个生产日期")), "下表标题要说明列的含义");
});
