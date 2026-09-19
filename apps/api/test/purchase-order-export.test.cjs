const assert = require("node:assert/strict");
const { test } = require("node:test");
const { Prisma } = require("@prisma/client");
const ExcelJS = require("exceljs");
const { PurchaseOrderExportService, PURCHASE_TRADE_TERMS } = require("../dist/modules/procurement/purchase-order-export.service.js");

// 采购订单导出：模板字段 → 系统字段的映射、表头 12 项的顺序、明细 9 列列序、修正后的条款文字、
// 以及表尾三个大格子都必须可验证，因此这里把生成的 xlsx 解析回来逐格断言。
//
// 2026-09-16（用户要求）表头从 3 行 9 格扩到 4 行 12 格 + 两行整行（交货地址 / 交期条款），
// 于是**行号全部后移**。为了不再出现「加两行表头、测试全线错位」，本文件改成
// 按标签/表头名**定位**而不是写死行号（`findRow` / `headerFields`）。
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
    totalAmount: new Prisma.Decimal("3460.0000"),
    paymentTerms: "月结30天",
    deliveryTerms: "合同签订后 15 天内分批交货，首批不少于 500 根",
    deliveryAddress: "浙江省绍兴市柯桥区迪礼厂区 1 号仓",
    // 回签三格存了内容，但按用户口径**不回填打印**（导出仍留空手写）
    supplierReply: "同意按此价格与交期执行",
    supplierSigned: "李经理 2026-09-12",
    // 故意与「操作人」（赵主管）不同：这样「纸面是否出现过这一格」才是可判定的
    supervisorSignature: "钱主管 2026-09-13",
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
const sheetOf = async (service) => (await open(await service.exportOrder("po-1"))).getWorksheet("PO-20260910-1234ABCD");

/** 按某列的值定位行号（找不到返回 0）。 */
function findRow(sheet, column, expected) {
  let found = 0;
  sheet.eachRow((row, number) => { if (!found && row.getCell(column).value === expected) found = number; });
  return found;
}

/** 表头字段网格 → { 标签: 值 }：标签以「：」结尾，值在其右侧一格。 */
function headerFields(sheet) {
  const fields = new Map();
  sheet.eachRow((row) => row.eachCell((cell, column) => {
    const value = String(cell.value ?? "");
    if (!value.endsWith("：")) return;
    // 值格是合并区的左上格：label(A/D/G) 右边一格
    fields.set(value, row.getCell(column + 1).value ?? "");
  }));
  return fields;
}
const allText = (sheet) => { const values = []; sheet.eachRow((row) => row.eachCell((cell) => values.push(String(cell.value ?? "")))); return values; };

test("表头：用户点名的 12 项都在，且顺序与清单一致（外加原模板的电话与采购单号）", async () => {
  const { service } = fixture();
  const sheet = await sheetOf(service);

  assert.equal(sheet.getCell("A1").value, "【采购订单】");
  assert.equal(sheet.getCell("A1").font.bold, true);

  const fields = headerFields(sheet);
  assert.equal(fields.get("订单号："), "DL260001", "订单号显示销售订单号");
  assert.equal(fields.get("供应商名称："), "某某五金厂");
  assert.equal(fields.get("供应商联系人："), "李经理");
  assert.equal(fields.get("采购人："), "王采购", "采购人取创建人（用户选择保持自动）");
  assert.equal(fields.get("操作人："), "赵主管", "操作人取最后修改人");
  assert.match(String(fields.get("下单录入时间：")), /2026\/9\/10|2026-09-10/);
  assert.match(String(fields.get("操作时间：")), /2026\/9\/10|2026-09-10/);
  assert.equal(fields.get("总价："), 3460, "总价 = 单头含税总价（数字格）");
  assert.equal(fields.get("交货日期："), "2026-09-20", "交货日期 = 单头预计到货日");
  assert.equal(fields.get("付款方式："), "月结30天");
  // 原模板就有的两格保留（采购单号是厂商对账的唯一抓手）
  assert.equal(fields.get("电话："), "13800000000");
  assert.equal(fields.get("采购单号："), "PO-20260910-1234ABCD");
  // 两行长文本各占整行
  assert.equal(fields.get("交货地址："), "浙江省绍兴市柯桥区迪礼厂区 1 号仓");
  assert.match(String(fields.get("交期条款：")), /合同签订后 15 天内分批交货/);

  // 顺序 = 用户清单（订单号 → 供应商名称 → 供应商联系人 → 采购人 → 操作人 → 下单录入时间 →
  // 操作时间 → 总价 → 交货日期 → 付款方式），交货地址与交期条款各占整行。
  const labels = [];
  sheet.eachRow((row) => row.eachCell((cell) => { const value = String(cell.value ?? ""); if (value.endsWith("：") && !["备注：", "交易条款：", "交货地址：", "交期条款："].includes(value)) labels.push(value); }));
  assert.deepEqual(labels, ["订单号：", "供应商名称：", "供应商联系人：", "采购人：", "操作人：", "下单录入时间：", "操作时间：", "总价：", "交货日期：", "付款方式：", "电话：", "采购单号："]);
});

test("表头：新字段没填时格子留空，不印 null/undefined", async () => {
  const { service } = fixture({ paymentTerms: null, deliveryTerms: null, deliveryAddress: null, expectedDate: null });
  const sheet = await sheetOf(service);

  const fields = headerFields(sheet);
  assert.equal(fields.get("付款方式："), "");
  assert.equal(fields.get("交期条款："), "");
  assert.equal(fields.get("交货地址："), "");
  assert.equal(fields.get("交货日期："), "");
  const joined = allText(sheet).join("\n");
  assert.equal(/undefined|null|NaN/.test(joined), false, "空值不能打成 undefined/null/NaN");
});

test("明细 9 列列序：原模板 7 列顺序不变，仅插入「单位」与「供应商」；含税总价=系统金额", async () => {
  const { service } = fixture();
  const sheet = await sheetOf(service);
  const headerRow = findRow(sheet, 1, "序号");
  assert.ok(headerRow > 0, "应能找到明细表头行");

  const headers = [];
  for (let column = 1; column <= 9; column += 1) headers.push(sheet.getRow(headerRow).getCell(column).value);
  assert.deepEqual(headers, ["序号", "产品名称", "规格型号", "单位", "供应商", "含税单价", "数量", "含税总价", "交货日期"]);

  const first = sheet.getRow(headerRow + 1);
  assert.equal(first.getCell(1).value, 1);
  assert.equal(first.getCell(2).value, "伞骨");
  assert.equal(first.getCell(3).value, "58cm", "规格型号取采购明细的型号");
  assert.equal(first.getCell(4).value, "根");
  assert.equal(first.getCell(5).value, "某某五金厂");
  assert.equal(first.getCell(6).value, 1.25, "含税单价=系统单价");
  assert.equal(first.getCell(7).value, 1200);
  assert.equal(first.getCell(8).value, 1500, "含税总价=系统金额（数量×单价+附加费）");
  assert.equal(first.getCell(9).value, "2026-09-18", "交货日期取明细行日期");

  const second = sheet.getRow(headerRow + 2);
  assert.equal(second.getCell(3).value, "EVA 主数据", "型号为空时退回物料规格型号");
  assert.equal(second.getCell(4).value, "米");
  assert.equal(second.getCell(5).value, "另一家纺织厂", "同一采购单的不同供应商逐行显示");
  assert.equal(second.getCell(9).value, "2026-09-20", "明细无日期时退回单头预计到货日");
});

test("小计只对含税总价求和；备注照旧；表尾三个大格子留空供手写", async () => {
  const { service } = fixture();
  const sheet = await sheetOf(service);
  const headerRow = findRow(sheet, 1, "序号");
  const subtotal = sheet.getRow(findRow(sheet, 1, "小计"));
  assert.match(String(subtotal.getCell(8).value.formula), new RegExp(`^SUM\\(H${headerRow + 1}:H${headerRow + 2}\\)$`));
  assert.equal(subtotal.getCell(7).value, null, "数量跨单位不求和");

  const remarkRow = findRow(sheet, 1, `备注：${fixture().order.remark}`);
  assert.ok(remarkRow > 0, "备注区保留标签与内容");

  // 表尾三格：换成业务的说法（厂家回签意见 / 厂家回签 / 主管签字），且是「大格子」
  const values = allText(sheet);
  for (const label of ["厂家回签意见", "厂家回签", "主管签字"]) assert.ok(values.includes(label), `签署栏应包含「${label}」`);
  for (const label of ["厂商回复意见", "厂商回签", "主管"]) {
    assert.equal(values.includes(label), false, `旧标签「${label}」应已换成业务用语`);
  }
  const signatureRow = findRow(sheet, 1, "厂家回签意见");
  // 「大格子」= 跨 A:C 且 4 行高（标签写在左上角，其余留白供手写）
  assert.equal(sheet.getCell(`A${signatureRow}`).value, "厂家回签意见");
  assert.equal(sheet.getCell(`C${signatureRow + 3}`).master.address, `A${signatureRow}`, "回签意见格应为 A:C 跨 4 行");
  assert.equal(sheet.getCell(`C${signatureRow + 4}`).isMerged, false, "回签意见格不应超过 4 行");
});

test("回签三格存了内容也不回填打印（用户口径：导出留空手写）", async () => {
  const { service } = fixture();
  const sheet = await sheetOf(service);
  const joined = allText(sheet).join("\n");
  // fixture 里 supplierReply / supplierSigned / supervisorSignature 都填了字，但纸面不出现
  assert.equal(joined.includes("同意按此价格与交期执行"), false);
  assert.equal(joined.includes("李经理 2026-09-12"), false);
  assert.equal(joined.includes("钱主管 2026-09-13"), false);
});

test("交易条款按修正后的文字打印（4 处修正均已生效，原件错字不再出现）", async () => {
  const { service } = fixture();
  const sheet = await sheetOf(service);
  const values = allText(sheet);
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
  const draftSheet = await sheetOf(draftFixture.service);
  assert.equal(draftSheet.getCell("A1").value, "【采购订单】（草稿）", "草稿必须标注，避免误发厂商");
});
