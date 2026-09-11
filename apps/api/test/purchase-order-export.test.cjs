const assert = require("node:assert/strict");
const { test } = require("node:test");
const { Prisma } = require("@prisma/client");
const ExcelJS = require("exceljs");
const { PurchaseOrderExportService, PURCHASE_TRADE_TERMS } = require("../dist/modules/procurement/purchase-order-export.service.js");

// 采购订单导出：模板字段 → 系统字段的映射、9 列列序与修正后的条款文字都必须可验证，
// 因此这里把生成的 xlsx 解析回来逐格断言。
function fixture(overrides = {}) {
  const order = {
    id: "po-1",
    purchaseOrderNo: "PO-20260910-1234ABCD",
    orderNo: "DL260001",
    status: "ordered",
    createdAt: new Date("2026-09-10T01:20:00Z"),
    updatedAt: new Date("2026-09-10T02:40:00Z"),
    createdBy: "user-1",
    updatedBy: "user-2",
    remark: "含税价，逾期按合同处理",
    expectedDate: new Date("2026-09-20T00:00:00Z"),
    supplier: { name: "某某五金厂", contactName: "李经理", phone: "13800000000" },
    items: [
      {
        materialSnapshot: { name: "伞骨", specificationModel: "主数据规格" },
        model: "58cm",
        quantity: new Prisma.Decimal("1200"),
        unitPrice: new Prisma.Decimal("1.25"),
        amount: new Prisma.Decimal("1500.0000"),
        expectedDate: new Date("2026-09-18T00:00:00Z"),
        material: { name: "伞骨", specificationModel: "主数据规格" },
        unit: { name: "根" },
        supplier: { name: "某某五金厂" }
      },
      {
        materialSnapshot: { name: "伞布", specificationModel: null },
        model: null,
        quantity: new Prisma.Decimal("300"),
        unitPrice: new Prisma.Decimal("6.5"),
        amount: new Prisma.Decimal("1960.0000"),
        expectedDate: null,
        material: { name: "伞布", specificationModel: "EVA 主数据" },
        unit: { name: "米" },
        supplier: { name: "另一家纺织厂" }
      }
    ],
    ...overrides
  };
  const prisma = {
    purchaseOrder: { findFirst: async () => order, findMany: async () => [order] },
    user: { findMany: async () => [{ id: "user-1", displayName: "王采购" }, { id: "user-2", displayName: "赵主管" }] }
  };
  return { order, prisma, service: new PurchaseOrderExportService(prisma) };
}

async function open(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  return workbook;
}

test("表头：订单单号=销售订单号、采购单号另占一格、交货地址留空、采购人/操作人取创建人/最后修改人", async () => {
  const { service } = fixture();
  const sheet = (await open(await service.exportOrder("po-1"))).getWorksheet("PO-20260910-1234ABCD");
  assert.ok(sheet, "工作表名应为采购单号");
  assert.equal(sheet.getCell("A1").value, "【采购订单】");
  assert.equal(sheet.getCell("A1").font.bold, true);
  assert.equal(sheet.getCell("A2").value, "交货地址：");
  assert.equal(sheet.getCell("B2").value, "", "系统无交货地址字段，留空手填");
  // 第 1 组表头行
  assert.equal(sheet.getCell("A3").value, "订单单号：");
  assert.equal(sheet.getCell("B3").value, "DL260001", "订单单号显示销售订单号");
  assert.equal(sheet.getCell("D3").value, "供应商名称：");
  assert.equal(sheet.getCell("E3").value, "某某五金厂");
  assert.equal(sheet.getCell("G3").value, "联系人：");
  assert.equal(sheet.getCell("H3").value, "李经理");
  // 第 2 组：合同号已按业务要求去掉，该格改放采购单号
  assert.equal(sheet.getCell("A4").value, "电话：");
  assert.equal(sheet.getCell("B4").value, "13800000000");
  assert.equal(sheet.getCell("D4").value, "采购人：");
  assert.equal(sheet.getCell("E4").value, "王采购", "采购人取创建人");
  assert.equal(sheet.getCell("G4").value, "采购单号：");
  assert.equal(sheet.getCell("H4").value, "PO-20260910-1234ABCD");
  // 第 3 组：录入时间/操作人/操作时间
  assert.equal(sheet.getCell("A5").value, "录入时间：");
  assert.equal(sheet.getCell("D5").value, "操作人：");
  assert.equal(sheet.getCell("E5").value, "赵主管", "操作人取最后修改人");
  assert.equal(sheet.getCell("G5").value, "操作时间：");
});

test("明细 9 列列序：原模板 7 列顺序不变，仅插入「单位」与「供应商」；含税总价=系统金额", async () => {
  const { service } = fixture();
  const sheet = (await open(await service.exportOrder("po-1"))).getWorksheet("PO-20260910-1234ABCD");
  const headers = [];
  for (let column = 1; column <= 9; column += 1) headers.push(sheet.getRow(6).getCell(column).value);
  assert.deepEqual(headers, ["序号", "产品名称", "规格型号", "单位", "供应商", "含税单价", "数量", "含税总价", "交货日期"]);

  const first = sheet.getRow(7);
  assert.equal(first.getCell(1).value, 1);
  assert.equal(first.getCell(2).value, "伞骨");
  assert.equal(first.getCell(3).value, "58cm", "规格型号取采购明细的型号");
  assert.equal(first.getCell(4).value, "根");
  assert.equal(first.getCell(5).value, "某某五金厂");
  assert.equal(first.getCell(6).value, 1.25, "含税单价=系统单价");
  assert.equal(first.getCell(7).value, 1200);
  assert.equal(first.getCell(8).value, 1500, "含税总价=系统金额（数量×单价+附加费）");
  assert.equal(first.getCell(9).value, "2026-09-18", "交货日期取明细行日期");

  const second = sheet.getRow(8);
  assert.equal(second.getCell(3).value, "EVA 主数据", "型号为空时退回物料规格型号");
  assert.equal(second.getCell(4).value, "米");
  assert.equal(second.getCell(5).value, "另一家纺织厂", "同一采购单的不同供应商逐行显示");
  assert.equal(second.getCell(9).value, "2026-09-20", "明细无日期时退回单头预计到货日");
});

test("小计只对含税总价求和；备注与签署栏照模板留位", async () => {
  const { service } = fixture();
  const sheet = (await open(await service.exportOrder("po-1"))).getWorksheet("PO-20260910-1234ABCD");
  const subtotal = sheet.getRow(9);
  assert.equal(subtotal.getCell(1).value, "小计");
  assert.match(String(subtotal.getCell(8).value.formula), /^SUM\(H7:H8\)$/);
  assert.equal(subtotal.getCell(7).value, null, "数量跨单位不求和");

  const remark = sheet.getCell("A10");
  assert.match(String(remark.value), /^备注：/, "备注区保留标签");
  assert.match(String(remark.value), /逾期按合同处理/);

  const values = [];
  sheet.eachRow((row) => row.eachCell((cell) => values.push(String(cell.value ?? ""))));
  for (const label of ["厂商回复意见", "厂商回签", "主管"]) assert.ok(values.includes(label), `签署栏应包含「${label}」`);
});

test("交易条款按修正后的文字打印（4 处修正均已生效，原件错字不再出现）", async () => {
  const { service } = fixture();
  const sheet = (await open(await service.exportOrder("po-1"))).getWorksheet("PO-20260910-1234ABCD");
  const values = [];
  sheet.eachRow((row) => row.eachCell((cell) => values.push(String(cell.value ?? ""))));
  assert.ok(values.includes("交易条款："));
  for (const term of PURCHASE_TRADE_TERMS) assert.ok(values.includes(term), `条款应打印：${term.slice(0, 12)}…`);
  const joined = values.join("\n");
  assert.equal(joined.includes("厂商就赔偿"), false, "「厂商就赔偿」应已修正");
  assert.equal(joined.includes("明细。标准"), false, "「明细。标准」应已修正为顿号");
  assert.match(joined, /厂商应赔偿因此而造成的经济损失/);
  assert.match(joined, /要有千分之二的备品和维修配件/);
  assert.match(joined, /^4：要有千分之二/m, "第 4 条应使用全角冒号");
});

test("批量导出：每张采购单一个工作表，并输出草稿标注", async () => {
  const { service } = fixture();
  const result = await service.exportOrders({ orderNo: "DL260001" });
  assert.equal(result.count, 1);
  const workbook = await open(result.buffer);
  assert.equal(workbook.worksheets.length, 1);
  const sheet = workbook.getWorksheet("PO-20260910-1234ABCD");
  assert.equal(sheet.pageSetup.paperSize, 9, "A4");
  assert.match(sheet.headerFooter.oddFooter, /&P/);

  const draftFixture = fixture({ status: "draft" });
  const draftSheet = (await open(await draftFixture.service.exportOrder("po-1"))).getWorksheet("PO-20260910-1234ABCD");
  assert.equal(draftSheet.getCell("A1").value, "【采购订单】（草稿）", "草稿必须标注，避免误发厂商");
});
