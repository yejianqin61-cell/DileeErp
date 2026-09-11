const assert = require("node:assert/strict");
const { test } = require("node:test");
const { Prisma } = require("@prisma/client");
const ExcelJS = require("exceljs");
const { MaterialSlipExportService } = require("../dist/modules/production/material-slip-export.service.js");

// 领料单导出：模板字段 → 系统字段的映射与排版都必须可验证，
// 因此这里真的把生成的 xlsx 解析回来断言单元格内容，而不是只信任构造过程。
// 领料单样例单据 + 桩：prismaMock 暴露出来，便于与补料单组合成"混合批量导出"。
function issueFixture(overrides = {}) {
  const movement = {
    id: "movement-1",
    movementNo: "MI-20260910-ABCD1234",
    documentType: "issue",
    status: "posted",
    productionOrderId: "order-1",
    createdBy: "user-1",
    createdAt: new Date("2026-09-10T02:30:00Z"),
    reason: null,
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
    productionOrderOperation: null,
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
  return { movement, prisma };
}

function harness(overrides = {}) {
  const { prisma } = issueFixture(overrides);
  return new MaterialSlipExportService(prisma);
}

async function open(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  return workbook;
}

test("领料单导出包含模板要求的表头字段与明细列", async () => {
  const service = harness();
  const workbook = await open(await service.exportSlip("movement-1"));
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
  assert.equal(sheet.getCell("F4").value, "", "领料单不再绑定工序，该栏按模板保留但为空");
  assert.equal(sheet.getCell("H4").value, "一车间", "领料单位取执行地点");
  assert.equal(sheet.getCell("B5").value, "100 把");
  assert.equal(sheet.getCell("D5").value, "张三");
  // 明细表头
  assert.deepEqual(sheet.getRow(6).values.slice(1), ["序号", "产品名称", "产品代码", "规格型号", "颜色", "单位", "配料数量", "已领数量", "本次领料量", "余下数量"]);
});

test("明细行的数量口径：配料=BOM核定用量、已领=不含本单的已过账净领料、余下=配料−已领−本次", async () => {
  const service = harness();
  const sheet = (await open(await service.exportSlip("movement-1"))).getWorksheet("MI-20260910-ABCD1234");
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
  const sheet = (await open(await service.exportSlip("movement-1"))).getWorksheet("MI-20260910-ABCD1234");
  const subtotal = sheet.getRow(9);
  assert.equal(subtotal.getCell(1).value, "小计");
  assert.equal(subtotal.getCell(2).value, null);
  for (const column of [7, 8, 9, 10]) assert.match(String(subtotal.getCell(column).value.formula), /^SUM\(/, `第 ${column} 列应有求和公式`);
});

test("草稿领料单在标题上标注草稿", async () => {
  const service = harness({ status: "draft" });
  const sheet = (await open(await service.exportSlip("movement-1"))).getWorksheet("MI-20260910-ABCD1234");
  assert.equal(sheet.getCell("A1").value, "【领料单】（草稿）");
});

test("批量导出：每张领料单一个工作表，并打印设置为一页宽", async () => {
  const service = harness();
  const result = await service.exportSlips({ orderNo: "DL260001" });
  assert.equal(result.count, 1);
  const workbook = await open(result.buffer);
  assert.equal(workbook.worksheets.length, 1);
  const sheet = workbook.getWorksheet("MI-20260910-ABCD1234");
  assert.equal(sheet.pageSetup.paperSize, 9, "A4");
  assert.equal(sheet.pageSetup.orientation, "portrait");
  assert.equal(sheet.pageSetup.fitToWidth, 1);
  assert.match(sheet.headerFooter.oddFooter, /&P/, "页脚应带页码");
});

// ── 补料单（坏片/生产失误的补充领料）：版式与领料单不同，单独验证 ──
function replenishmentFixture(overrides = {}) {
  const movement = {
    id: "replenishment-1",
    movementNo: "MC-20260910-5B7C9D01",
    documentType: "replenishment",
    status: "posted",
    productionOrderId: "order-1",
    createdBy: "user-1",
    createdAt: new Date("2026-09-10T03:10:00Z"),
    reason: "伞布原始坏片",
    remark: null,
    productionOrder: {
      productionOrderNo: "MO-20260910-0001",
      orderNo: "DL260001",
      plannedQuantity: new Prisma.Decimal("500"),
      productSpecification: "22寸×8K",
      unit: { name: "把" },
      executionLocation: { name: "一车间" },
      salesOrder: { productName: "自动雨伞", productSpec: "22寸" },
      bom: { items: [{ materialId: "material-1", approvedUsage: new Prisma.Decimal("2500"), requiredQuantity: new Prisma.Decimal("2500"), specificationModel: "EVA", model: null, color: "透明" }] }
    },
    productionOrderOperation: null,
    lines: [
      { materialId: "material-1", unitId: "unit-1", quantity: new Prisma.Decimal("12"), bomReferenceQuantity: new Prisma.Decimal("2500"), material: { name: "伞布", materialCode: "M-002", specificationModel: null, color: null }, unit: { name: "米" } }
    ],
    ...overrides
  };
  const prisma = {
    rawMaterialMovement: { findFirst: async () => movement, findMany: async () => [movement] },
    user: { findFirst: async () => ({ displayName: "张三" }) },
    inventoryFact: { aggregate: async () => ({ _sum: { quantityDelta: new Prisma.Decimal("-12") } }) }
  };
  return { movement, prisma };
}

function replenishmentHarness(overrides = {}) {
  return new MaterialSlipExportService(replenishmentFixture(overrides).prisma);
}

test("补料单导出：标题、表头字段顺序、补料原因与 8 列明细（含预留图片列）", async () => {
  const sheet = (await open(await replenishmentHarness().exportSlip("replenishment-1"))).getWorksheet("MC-20260910-5B7C9D01");
  assert.ok(sheet, "工作表名应为补料单号");
  assert.equal(sheet.getCell("A2").value, "【补料单】");
  assert.equal(sheet.getCell("A2").font.bold, true);
  // 表头第 1 行
  assert.equal(sheet.getCell("A5").value, "生产单号：");
  assert.equal(sheet.getCell("B5").value, "MO-20260910-0001");
  assert.equal(sheet.getCell("D5").value, "自动雨伞");
  assert.equal(sheet.getCell("F5").value, "", "系统无成品代码，留空");
  assert.equal(sheet.getCell("H5").value, "22寸×8K");
  // 表头第 2 行：补料单模板是「单位」在前、「工序」在后（与领料单相反）
  assert.equal(sheet.getCell("C6").value, "领料单号：");
  assert.equal(sheet.getCell("D6").value, "MC-20260910-5B7C9D01", "该栏显示补料单自己的单号");
  assert.equal(sheet.getCell("E6").value, "领料单位：");
  assert.equal(sheet.getCell("F6").value, "一车间");
  assert.equal(sheet.getCell("G6").value, "领料工序：");
  assert.equal(sheet.getCell("H6").value, "", "单据不再绑定工序，该栏按模板保留但为空");
  // 表头第 3 行：操作人/操作时间 + 补料原因（模板空出的第 4 格）
  assert.equal(sheet.getCell("A7").value, "操作人：");
  assert.equal(sheet.getCell("B7").value, "张三");
  assert.equal(sheet.getCell("C7").value, "操作时间：");
  assert.equal(sheet.getCell("G7").value, "补料原因：");
  assert.equal(sheet.getCell("H7").value, "伞布原始坏片");
  // 明细表：8 列，第 2 列为图片（预留空列），末列为补领数量
  const headers = [];
  for (let column = 1; column <= 8; column += 1) headers.push(sheet.getRow(8).getCell(column).value);
  assert.deepEqual(headers, ["序号", "图片", "产品名称", "产品代码", "规格型号", "颜色", "单位", "补领数量"]);
  const first = sheet.getRow(9);
  assert.equal(first.getCell(1).value, 1);
  assert.equal(first.getCell(2).value, "", "图片列当前无数据源，保持空列");
  assert.equal(first.getCell(3).value, "伞布");
  assert.equal(first.getCell(4).value, "M-002");
  assert.equal(first.getCell(5).value, "EVA");
  assert.equal(first.getCell(6).value, "透明");
  assert.equal(first.getCell(7).value, "米");
  assert.equal(first.getCell(8).value, 12);
  // 小计只对补领数量求和
  const subtotal = sheet.getRow(10);
  assert.equal(subtotal.getCell(1).value, "小计");
  assert.match(String(subtotal.getCell(8).value.formula), /^SUM\(H9:H9\)$/);
  assert.equal(subtotal.getCell(3).value, null, "小计行其余列留空");
});

test("补料单草稿在标题标注草稿；批量导出按类型套用各自版式", async () => {
  const draft = (await open(await replenishmentHarness({ status: "draft" }).exportSlip("replenishment-1"))).getWorksheet("MC-20260910-5B7C9D01");
  assert.equal(draft.getCell("A2").value, "【补料单】（草稿）");

  // 同一批筛选里混有领料单与补料单时，每张单据用自己的模板版式
  const issue = issueFixture();
  const replenishment = replenishmentFixture();
  const mixed = new MaterialSlipExportService({
    rawMaterialMovement: { findFirst: async () => null, findMany: async () => [issue.movement, replenishment.movement] },
    user: { findFirst: async () => ({ displayName: "张三" }) },
    inventoryFact: { aggregate: async () => ({ _sum: { quantityDelta: new Prisma.Decimal(0) } }) }
  });
  const result = await mixed.exportSlips({});
  assert.equal(result.count, 2);
  const workbook = await open(result.buffer);
  const issueSheet = workbook.getWorksheet("MI-20260910-ABCD1234");
  assert.ok(issueSheet, "领料单按其版式生成");
  assert.equal(issueSheet.getRow(6).getCell(2).value, "产品名称", "领料单表头第 2 列是产品名称");
  const replenishmentSheet = workbook.getWorksheet("MC-20260910-5B7C9D01");
  assert.ok(replenishmentSheet, "补料单按其版式生成");
  assert.equal(replenishmentSheet.getRow(8).getCell(2).value, "图片", "补料单表头第 2 列是图片");
});

// 绑定关系验证：导出是按 movement_id 从系统领料单读取的，换一张单必须整表跟随变化，
// 而不是把模板套在某个固定数据源上（例如固定读 BOM 或固定读最近一张单）。
function multiHarness(movements) {
  const byId = new Map(movements.map((item) => [item.id, item]));
  const prisma = {
    rawMaterialMovement: { findFirst: async ({ where }) => byId.get(where.id) ?? null, findMany: async () => movements },
    user: { findFirst: async () => ({ displayName: "张三" }) },
    // 库存事实按"已过账单据的明细"派生：这样改动单据数量时，事实与单据保持一致，
    // 才能真实验证「已领数量 = 净领料 − 本单自身」。
    inventoryFact: {
      aggregate: async ({ where }) => ({
        _sum: { quantityDelta: movements.filter((item) => item.status === "posted").flatMap((item) => item.lines).filter((line) => line.materialId === where.materialId).reduce((sum, line) => sum.minus(line.quantity), new Prisma.Decimal(0)) }
      })
    }
  };
  return new MaterialSlipExportService(prisma);
}

function makeMovement(id, movementNo, materialName, materialCode, quantity) {
  return {
    id,
    movementNo,
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
      bom: { items: [{ materialId: `${id}-material`, approvedUsage: new Prisma.Decimal("10"), requiredQuantity: new Prisma.Decimal("10"), specificationModel: "58cm", model: null, color: "黑色" }] }
    },
    productionOrderOperation: null,
    lines: [{ materialId: `${id}-material`, unitId: "unit-1", quantity: new Prisma.Decimal(quantity), bomReferenceQuantity: new Prisma.Decimal("10"), material: { name: materialName, materialCode, specificationModel: "58cm", color: "黑色" }, unit: { name: "根" } }]
  };
}

test("导出绑定系统领料单：换一张 movement_id 就整表变化（单号/明细/数量都跟着变）", async () => {
  const first = makeMovement("movement-A", "MI-AAAA", "伞骨", "M-001", "2");
  const second = makeMovement("movement-B", "MI-BBBB", "手柄", "M-002", "7");
  const service = multiHarness([first, second]);

  const sheetA = (await open(await service.exportSlip("movement-A"))).getWorksheet("MI-AAAA");
  const sheetB = (await open(await service.exportSlip("movement-B"))).getWorksheet("MI-BBBB");

  assert.equal(sheetA.getCell("D4").value, "MI-AAAA", "领料单号必须是该单据的单号");
  assert.equal(sheetA.getRow(7).getCell(2).value, "伞骨");
  assert.equal(sheetA.getRow(7).getCell(9).value, 2);
  assert.equal(sheetB.getCell("D4").value, "MI-BBBB");
  assert.equal(sheetB.getRow(7).getCell(2).value, "手柄");
  assert.equal(sheetB.getRow(7).getCell(9).value, 7);
  assert.notEqual(sheetA.getRow(7).getCell(2).value, sheetB.getRow(7).getCell(2).value, "两张单的明细不得互相串");
});

test("口径差异实证：配料数量随 BOM 变化（活数据），本次领料量随单据变化（单据事实）", async () => {
  const movement = makeMovement("movement-A", "MI-AAAA", "伞骨", "M-001", "2");
  const service = multiHarness([movement]);
  const before = (await open(await service.exportSlip("movement-A"))).getWorksheet("MI-AAAA");
  assert.equal(before.getRow(7).getCell(7).value, 10, "配料数量 = BOM 核定用量");

  // 只改 BOM 核定用量（改物料单不变），配料数量随之变化，本次领料量不变。
  movement.productionOrder.bom.items[0].approvedUsage = new Prisma.Decimal("12");
  const afterBom = (await open(await service.exportSlip("movement-A"))).getWorksheet("MI-AAAA");
  assert.equal(afterBom.getRow(7).getCell(7).value, 12, "配料数量取自 BOM，属活数据");
  assert.equal(afterBom.getRow(7).getCell(9).value, 2, "本次领料量来自单据，不受 BOM 影响");

  // 只改单据明细数量，本次领料量与已领数量随之变化。
  movement.lines[0].quantity = new Prisma.Decimal("5");
  const afterLine = (await open(await service.exportSlip("movement-A"))).getWorksheet("MI-AAAA");
  assert.equal(afterLine.getRow(7).getCell(9).value, 5, "本次领料量取自单据明细");
  assert.equal(afterLine.getRow(7).getCell(8).value, 0, "已领数量 = 净领料 5 − 本单 5");
});

