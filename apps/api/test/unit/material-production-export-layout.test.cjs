// 生产进度表 / 「材料与车间生产对应表」下表的版式。
//
// 版式决策（客户按 A4 打印反馈后调整）：**列 = 工序，行 = 日期**。
// 原版是「行 = 工序、列 = 日期」：一个月 30+ 列，横向必然超出 A4；
// 换成工序做列后列数 = 工序数（本厂约 14 个），行数随日期纵向增长，整张表更容易落进一页 A4。
// 目标数量与加工地点保留为表头下两行标注，表尾一行按工序合计，出货数量作为单一数值放在表头上方。
//
// 2026-09-14 起「当日合计」列被业务方去掉：横排各工序相加没有业务含义（同一产品的不同工序会重复计数），
// 而且它会让 A4 版面多占一列。表尾仍按工序给出累计量。
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

/** 原始单元格表：用来断言单元格类型（t === "n" 才是数值型，t === "s" 是文本型）。 */
function sheetCells(buffer) {
  const book = XLSX.read(buffer, { type: "buffer" });
  return book.Sheets[book.SheetNames[0]];
}

function cellType(sheet, rowIndex, columnIndex) {
  const cell = sheet[XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex })];
  return cell ? cell.t : undefined;
}

/** 定位进度表表头（首列是「日期」）。 */
function headerIndex(rows) {
  return rows.findIndex((row) => String(row[0]) === "日期");
}

// ------------------------------------------------------------------ 工序列顺序（用户拖拽）

// 用户 2026-09-15 要求：导出生产进度表时允许拖拽调整工序排序，导出的工序 column 按这个顺序来。
// 顺序是**导出显示偏好**，不是 production_order_operations.sequence_no（那是车间实际生产顺序）。
test("生产进度表：按 operation_order 排列工序列，数量仍落在各自的工序列上", async () => {
  const buffer = await service().exportProductionProgress({ order_no: "SO-1", operation_order: "op-2,op-1" }, user);
  const rows = sheetRows(buffer);
  const index = headerIndex(rows);
  assert.deepEqual(rows[index].map((cell) => String(cell)), ["日期", "包装", "裁剪"], "列头按用户顺序：包装在前、裁剪在后");
  assert.deepEqual(rows[index + 1].map((cell) => String(cell)), ["目标数量", "100", "100"], "目标数量行跟着列一起换位");
  assert.deepEqual(rows[index + 2].map((cell) => String(cell)), ["加工地点", "一车间", "一车间"]);
  // 09-01 只有裁剪（op-1）报了 30：换位后 30 必须落在「裁剪」那一列，而不是错列到包装
  assert.deepEqual(rows[index + 3].map((cell) => String(cell)), ["2026-09-01", "", "30"]);
  // 09-02：裁剪 20、包装 50
  assert.deepEqual(rows[index + 4].map((cell) => String(cell)), ["2026-09-02", "50", "20"]);
  assert.deepEqual(rows[index + 5].map((cell) => String(cell)), ["合计", "50", "50"], "表尾合计仍按工序各自累计");
  // 换位只改列的先后，不能把数值格变成文本格（Excel 里要能直接求和）
  const sheet = sheetCells(buffer);
  assert.equal(cellType(sheet, index + 4, 1), "n", "包装列的数量仍是数值型");
  assert.equal(cellType(sheet, index + 4, 2), "n", "裁剪列的数量仍是数值型");
});

test("生产进度表：只给了部分工序时，没提到的按原相对顺序接在后面（不会丢列）", async () => {
  const rows = sheetRows(await service().exportProductionProgress({ order_no: "SO-1", operation_order: "op-2" }, user));
  const index = headerIndex(rows);
  assert.deepEqual(rows[index].map((cell) => String(cell)), ["日期", "包装", "裁剪"], "只提到包装：包装提前，裁剪跟在后面");
});

test("生产进度表：非法/未知的操作顺序不影响导出（未知 id 与空参数都退回默认顺序）", async () => {
  for (const operation_order of ["op-ghost", "", " , ,"]) {
    const rows = sheetRows(await service().exportProductionProgress({ order_no: "SO-1", operation_order }, user));
    const index = headerIndex(rows);
    assert.deepEqual(rows[index].map((cell) => String(cell)), ["日期", "裁剪", "包装"], `operation_order=${JSON.stringify(operation_order)} 时保持默认顺序`);
  }
});

// ------------------------------------------------------------------ 独立的生产进度表

test("生产进度表：列头是工序、行头是日期（横纵表头互换）", async () => {
  const rows = sheetRows(await service().exportProductionProgress({ order_no: "SO-1" }, user));
  const index = headerIndex(rows);
  assert.ok(index > 0, "必须能找到进度表表头");

  const header = rows[index].map((cell) => String(cell));
  assert.deepEqual(header, ["日期", "裁剪", "包装"], "第一列是日期，其余列是工序，最后一列不再是当日合计");
  assert.equal(header.includes("当日合计"), false, "业务方已要求去掉「当日合计」列");
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
  assert.deepEqual(rows[index + 1].map((cell) => String(cell)), ["目标数量", "100", "100"], "每个工序列填自己的计划数量");
  assert.deepEqual(rows[index + 2].map((cell) => String(cell)), ["加工地点", "一车间", "一车间"], "每个工序列填自己的执行地点");
});

test("生产进度表：单元格是当日该工序的完成数量，表尾按工序合计", async () => {
  const rows = sheetRows(await service().exportProductionProgress({ order_no: "SO-1" }, user));
  const index = headerIndex(rows);
  const [, , firstDateRow, secondDateRow, totalRow] = rows.slice(index + 1);

  assert.deepEqual(firstDateRow.map((cell) => String(cell)), ["2026-09-01", "30", ""], "9-01 只有裁剪报工");
  assert.deepEqual(secondDateRow.map((cell) => String(cell)), ["2026-09-02", "20", "50"], "9-02 裁剪 20 + 包装 50");
  assert.deepEqual(totalRow.map((cell) => String(cell)), ["合计", "50", "50"], "表尾按工序累计，不再有全部合计列");
});

test("生产进度表：出货数量作为单一数值出现在表头上方，不再逐工序重复", async () => {
  const rows = sheetRows(await service().exportProductionProgress({ order_no: "SO-1" }, user));
  const flat = rows.flat().map((cell) => String(cell));
  assert.equal(flat.filter((cell) => cell === "12").length, 1, "出货数量只出现一次");
  assert.ok(rows.some((row) => String(row[0]) === "出货数量" && String(row[1]) === "12"), "出货数量放在元信息里");
  const index = headerIndex(rows);
  assert.equal(rows[index].map((cell) => String(cell)).includes("出货"), false, "表头里不再有逐工序重复的「出货」列");
});

test("生产进度表：数字单元格必须是数值类型（Excel 里可求和/筛选/排序）", async () => {
  const buffer = await service().exportProductionProgress({ order_no: "SO-1" }, user);
  const rows = sheetRows(buffer);
  const index = headerIndex(rows);
  const sheet = sheetCells(buffer);
  for (const column of [1, 2]) {
    assert.equal(cellType(sheet, index + 1, column), "n", `目标数量第 ${column} 列必须是数值单元格`);
    assert.equal(cellType(sheet, index + 4, column), "n", `2026-09-02 行第 ${column} 列必须是数值单元格`);
    assert.equal(cellType(sheet, index + 5, column), "n", `合计行第 ${column} 列必须是数值单元格`);
  }
  // 9-01 只有裁剪报工：有值的那个单元格必须是数值，没报工的工序留空（空单元格而不是 "" 文本）
  assert.equal(cellType(sheet, index + 3, 1), "n", "2026-09-01 裁剪列必须是数值单元格");
  assert.equal(cellType(sheet, index + 3, 2), undefined, "未报工的工序应留空，而不是写一个空字符串");
  // 出货数量在元信息里，也必须是数值
  const shippedRow = rows.findIndex((row) => String(row[0]) === "出货数量");
  assert.ok(shippedRow > 0, "出货数量行必须存在");
  assert.equal(cellType(sheet, shippedRow, 1), "n", "出货数量必须是数值单元格");
  // 整表不允许出现「看起来是数字、类型却是文本」的单元格
  const offenders = [];
  for (const [address, cell] of Object.entries(sheet)) {
    if (address.startsWith("!")) continue;
    if (cell.t === "s" && typeof cell.v === "string" && /^-?\d+(\.\d+)?$/.test(cell.v.trim())) offenders.push(`${address}=${cell.v}`);
  }
  assert.deepEqual(offenders, [], "不允许把数字写成文本单元格");
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
  assert.deepEqual(rows[index + 3].map((cell) => String(cell)), ["合计", "0", "0"]);
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
  assert.deepEqual(header, ["日期", "裁剪（MO-1）", "裁剪（MO-2）"], "重名工序必须能区分");
  assert.equal(new Set(header).size, header.length, "列名不允许重复");
});

// ------------------------------------------------------------------ 兼容入口（合并工作表）

test("合并工作表的下表沿用新版式：日期做行头，工序做列头", async () => {
  const rows = sheetRows(await service().exportMaterialProduction({ order_no: "SO-1" }, user));
  const flat = rows.flat().map((cell) => String(cell));
  assert.ok(flat.some((cell) => cell.includes("下表：生产进度表") && cell.includes("每列为一个工序")), "下表标题要说明新的列含义");
  const index = headerIndex(rows);
  assert.ok(index > 0, "必须能找到下表表头");
  // 上表有 10 列，xlsx 会把表头行右侧补齐成空串，因此只比对新版式的前 3 列
  assert.deepEqual(rows[index].slice(0, 3).map((cell) => String(cell)), ["日期", "裁剪", "包装"]);
  assert.equal(rows[index].slice(3).every((cell) => String(cell) === ""), true, "表头右侧不应再有历史列名（当日合计/数量/加工地点/汇总/出货）");
  assert.equal(flat.filter((cell) => cell === "2026-09-01").length, 1, "日期 2026-09-01 只作为行头出现一次");
  assert.equal(flat.filter((cell) => cell === "2026-09-02").length, 1, "日期 2026-09-02 只作为行头出现一次");
});
