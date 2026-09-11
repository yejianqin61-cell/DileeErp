const assert = require("node:assert/strict");
const { test } = require("node:test");
const { Prisma } = require("@prisma/client");
const ExcelJS = require("exceljs");
const { MaterialIssueExportService } = require("../dist/modules/production/material-issue-export.service.js");

// 领料单导出：模板字段 → 系统字段的映射与排版都必须可验证，
// 因此这里真的把生成的 xlsx 解析回来断言单元格内容，而不是只信任构造过程。
function harness(overrides = {}) {
  const movement = {
    id: "movement-1",
    movementNo: "MI-20260910-ABCD1234",
    status: "posted",
    productionOrderId: "order-1",
    createdBy: "user-1",
    createdAt: new Date("2026-09-10T02:30:00Z"),
    remark: null,
    productionOrder: {
      productionOrderNo: "MO-20260910-0001",
      orderNo: "DL260001",
      plannedQuantity: new Prisma.Decimal("100"),
      productSpecification: "22寸×8K",
      unit: { name: "把" },
      executionLocation: { name: "一车间" },
      salesOrder: { productName: "自动雨伞", productSpec: "22寸" },
      bom: { items: [{ materialId: "material-1", approvedUsage: new Prisma.Decimal("5"), requiredQuantity: new Prisma.Decimal("6"), specificationModel: "58cm", model: null, color: "黑色" }] }
    },
    productionOrderOperation: { operationNameSnapshot: "裁剪" },
    lines: [
      { materialId: "material-1", unitId: "unit-1", quantity: new Prisma.Decimal("2"), bomReferenceQuantity: new Prisma.Decimal("6"), material: { name: "伞骨", materialCode: "M-001", specificationModel: "58cm", color: "黑色" }, unit: { name: "根" } },
      { materialId: "material-2", unitId: "unit-2", quantity: new Prisma.Decimal("3"), bomReferenceQuantity: null, material: { name: "手柄", materialCode: "M-002", specificationModel: null, color: null }, unit: { name: "个" } }
    ],
    ...overrides
  };
  const facts = [
    { materialId: "material-1", unitId: "unit-1", quantityDelta: new Prisma.Decimal("-6") },
    { materialId: "material-2", unitId: "unit-2", quantityDelta: new Prisma.Decimal("-3") }
  ];
  const prisma = {
    rawMaterialMovement: { findFirst: async () => movement, findMany: async () => [movement] },
    user: { findFirst: async () => ({ displayName: "张三" }) },
    inventoryFact: {
      aggregate: async ({ where }) => ({ _sum: { quantityDelta: facts.filter((fact) => fact.materialId === where.materialId).reduce((sum, fact) => sum.plus(fact.quantityDelta), new Prisma.Decimal(0)) } })
    }
  };
  return new MaterialIssueExportService(prisma);
}

async function open(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  return workbook;
}

test("领料单导出包含模板要求的表头字段与明细列", async () => {
  const service = harness();
  const workbook = await open(await service.exportIssue("movement-1"));
  const sheet = workbook.getWorksheet("MI-20260910-ABCD1234");
  assert.ok(sheet, "工作表名应为领料单号");
  assert.equal(sheet.getCell("A1").value, "【领料单】");
  assert.equal(sheet.getCell("A1").font.bold, true);
  // 表头区：标签与取值
  assert.equal(sheet.getCell("A3").value, "生产单号：");
  assert.equal(sheet.getCell("B3").value, "MO-20260910-0001");
  assert.equal(sheet.getCell("C3").value, "成品名称：");
  assert.equal(sheet.getCell("D3").value, "自动雨伞");
  assert.equal(sheet.getCell("G3").value, "规格型号：");
  assert.equal(sheet.getCell("H3").value, "22寸×8K");
  assert.equal(sheet.getCell("A4").value, "颜色：");
  assert.equal(sheet.getCell("B4").value, "", "系统无成品颜色，按确认口径留空");
  assert.equal(sheet.getCell("D4").value, "MI-20260910-ABCD1234");
  assert.equal(sheet.getCell("F4").value, "裁剪", "领料工序取工序名称快照");
  assert.equal(sheet.getCell("H4").value, "一车间", "领料单位取执行地点");
  assert.equal(sheet.getCell("B5").value, "100 把");
  assert.equal(sheet.getCell("D5").value, "张三");
  // 明细表头
  assert.deepEqual(sheet.getRow(6).values.slice(1), ["序号", "产品名称", "产品代码", "规格型号", "颜色", "单位", "配料数量", "已领数量", "本次领料量", "余下数量"]);
});

test("明细行的数量口径：配料=BOM核定用量、已领=不含本单的已过账净领料、余下=配料−已领−本次", async () => {
  const service = harness();
  const sheet = (await open(await service.exportIssue("movement-1"))).getWorksheet("MI-20260910-ABCD1234");
  const first = sheet.getRow(7);
  assert.equal(first.getCell(2).value, "伞骨");
  assert.equal(first.getCell(3).value, "M-001");
  assert.equal(first.getCell(4).value, "58cm");
  assert.equal(first.getCell(5).value, "黑色");
  assert.equal(first.getCell(6).value, "根");
  assert.equal(first.getCell(7).value, 5, "配料数量取核定用量 5（而非 BOM 需求量 6）");
  assert.equal(first.getCell(8).value, 4, "已领数量 = 净领料 6 − 本单 2");
  assert.equal(first.getCell(9).value, 2);
  assert.equal(first.getCell(10).value, -1, "余下数量 = 5 − 4 − 2，负数表示超领");
  // 非 BOM 物料：配料与余下留空，已领仍按库存事实给出
  const second = sheet.getRow(8);
  assert.equal(second.getCell(2).value, "手柄");
  assert.equal(second.getCell(7).value, null);
  assert.equal(second.getCell(8).value, 0, "非 BOM 物料仍有 3 个已领，扣本单 3 后为 0");
  assert.equal(second.getCell(9).value, 3);
  assert.equal(second.getCell(10).value, null);
});

test("小计行对四个数量列求和，其余列留空", async () => {
  const service = harness();
  const sheet = (await open(await service.exportIssue("movement-1"))).getWorksheet("MI-20260910-ABCD1234");
  const subtotal = sheet.getRow(9);
  assert.equal(subtotal.getCell(1).value, "小计");
  assert.equal(subtotal.getCell(2).value, null);
  for (const column of [7, 8, 9, 10]) assert.match(String(subtotal.getCell(column).value.formula), /^SUM\(/, `第 ${column} 列应有求和公式`);
});

test("草稿领料单在标题上标注草稿", async () => {
  const service = harness({ status: "draft" });
  const sheet = (await open(await service.exportIssue("movement-1"))).getWorksheet("MI-20260910-ABCD1234");
  assert.equal(sheet.getCell("A1").value, "【领料单】（草稿）");
});

test("批量导出：每张领料单一个工作表，并打印设置为一页宽", async () => {
  const service = harness();
  const result = await service.exportIssues({ orderNo: "DL260001" });
  assert.equal(result.count, 1);
  const workbook = await open(result.buffer);
  assert.equal(workbook.worksheets.length, 1);
  const sheet = workbook.getWorksheet("MI-20260910-ABCD1234");
  assert.equal(sheet.pageSetup.paperSize, 9, "A4");
  assert.equal(sheet.pageSetup.orientation, "portrait");
  assert.equal(sheet.pageSetup.fitToWidth, 1);
  assert.match(sheet.headerFooter.oddFooter, /&P/, "页脚应带页码");
});
