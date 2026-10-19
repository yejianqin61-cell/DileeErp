const assert = require("node:assert/strict");
const { test } = require("node:test");
const { Prisma } = require("@prisma/client");
const ExcelJS = require("exceljs");
const { PurchaseOrderExportService, PURCHASE_TRADE_TERMS } = require("../dist/modules/procurement/purchase-order-export.service.js");
const { displayWidth, wrappedLines, LINE_HEIGHT } = require("../dist/platform/excel/row-height.js");

// 采购订单导出：模板字段 → 系统字段的映射、表头 11 项的顺序、明细 7 列列序、修正后的条款文字、
// 以及表尾三个大格子都必须可验证，因此这里把生成的 xlsx 解析回来逐格断言。
//
// 2026-09-16（用户要求）表头从 3 行 9 格扩到 4 行 12 格 + 两行整行（交货地址 / 交期条款），
// 于是**行号全部后移**。为了不再出现「加两行表头、测试全线错位」，本文件改成
// 按标签/表头名**定位**而不是写死行号（`findRow` / `headerFields`）。
//
// 2026-10-13（用户）：「采购订单导出时，那个 excel 表单里面，可以不用有供应商这一个 column。
// 采购单号这个字段也不需要导出。交货日期也不需要这个 column」
// —— 明细表 9 → 7 列、表头 11 格（少「采购单号」）。用户确认：**抬头的「供应商名称：」与
// 「交货日期：」保留**（只删明细里逐行重复的那两列）。下面这几条就是钉这个口径。
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

/**
 * 表头/整行字段 → { 标签: 值 }：2026-10-19 起「标签：值」写在同一格里（值不再在标签右边一格），
 * 所以按**第一个全角冒号**切开。只认「纯汉字 + ：」开头的格，避免把交易条款的「1：厂商交货…」
 * 当成字段。
 */
function headerFields(sheet) {
  const fields = new Map();
  sheet.eachRow((row) => row.eachCell((cell) => {
    const match = /^([\u4e00-\u9fff]+)：(.*)$/s.exec(typeof cell.value === "string" ? cell.value : "");
    if (match) fields.set(`${match[1]}：`, match[2]);
  }));
  return fields;
}
const allText = (sheet) => { const values = []; sheet.eachRow((row) => row.eachCell((cell) => values.push(String(cell.value ?? "")))); return values; };
/** 列宽（Excel 单位）。 */
const columnWidths = (sheet) => { const widths = []; for (let column = 1; column <= 7; column += 1) widths.push(sheet.getColumn(column).width); return widths; };
/** 合并区宽度表：主格地址 → 合并区总列宽（没合并的格 = 自己那一列）。 */
function mergedWidths(sheet) {
  const merged = new Map();
  for (const range of sheet.model.merges) {
    const [from, to] = String(range).split(":");
    const fromColumn = from.replace(/\d+/g, "");
    const toColumn = to.replace(/\d+/g, "");
    let width = 0;
    for (let code = fromColumn.charCodeAt(0); code <= toColumn.charCodeAt(0); code += 1) width += sheet.getColumn(String.fromCharCode(code)).width ?? 0;
    merged.set(from, width);
  }
  return merged;
}

// ------------------------------------------------------------------ 货号（2026-09-26）

test("货号：跟着「订单号」那一格印（采购单不存货号列，导出时 join 销售单）", async () => {
  const { service } = fixture({ salesOrder: { itemNo: "27621" } });
  const fields = headerFields(await sheetOf(service));
  assert.equal(fields.get("订单号："), "DL260001（货号 27621）", "货号与订单号读在一起：这一单是哪个货号");
});

test("货号：历史单（销售单没有货号）时那一格与改造前逐字相同", async () => {
  // 两种「没有货号」都要同一条路径：销售单没有该字段（老夹具）、以及字段为空。
  for (const overrides of [{}, { salesOrder: { itemNo: null } }, { salesOrder: null }]) {
    const { service } = fixture(overrides);
    const fields = headerFields(await sheetOf(service));
    assert.equal(fields.get("订单号："), "DL260001", `overrides=${JSON.stringify(overrides)}`);
    assert.equal(allText(await sheetOf(service)).some((value) => value.includes("货号")), false, "没有货号就不该出现「货号」字样");
  }
});

test("表头：用户点名的 10 项 + 电话都在，且顺序与清单一致（2026-10-13 起不再印采购单号）", async () => {
  const { service } = fixture();
  const sheet = await sheetOf(service);

  assert.equal(sheet.getCell("A1").value, "【采购订单】");
  assert.equal(sheet.getCell("A1").font.bold, true);

  const fields = headerFields(sheet);
  assert.equal(fields.get("订单号："), "DL260001", "订单号显示销售订单号");
  assert.equal(fields.get("供应商名称："), "某某五金厂", "抬头的供应商名称保留（厂商要知道这张单开给谁）");
  assert.equal(fields.get("供应商联系人："), "李经理");
  assert.equal(fields.get("采购人："), "王采购", "采购人取创建人（用户选择保持自动）");
  assert.equal(fields.get("操作人："), "赵主管", "操作人取最后修改人");
  assert.match(String(fields.get("下单录入时间：")), /2026\/9\/10|2026-09-10/);
  assert.match(String(fields.get("操作时间：")), /2026\/9\/10|2026-09-10/);
  assert.equal(fields.get("总价："), "3460.00", "总价：整单含税总价（与明细小计同口径，两位小数）");
  assert.equal(fields.get("交货日期："), "2026-09-20", "整单交期保留在抬头格里");
  assert.equal(fields.get("付款方式："), "月结30天");
  assert.equal(fields.get("电话："), "13800000000");
  // 两行长文本各占整行
  assert.equal(fields.get("交货地址："), "浙江省绍兴市柯桥区迪礼厂区 1 号仓");
  assert.match(String(fields.get("交期条款：")), /合同签订后 15 天内分批交货/);

  // 2026-10-13（用户）：「采购单号这个字段也不需要导出」—— 纸面上任何一格都不该再出现它。
  assert.equal(fields.has("采购单号："), false, "采购单号那一格已删");
  assert.equal(allText(sheet).includes("PO-20260910-1234ABCD"), false, "采购单号不该以任何形式印在纸面上");

  // 顺序 = 用户清单（订单号 → 供应商名称 → 供应商联系人 → 采购人 → 操作人 → 下单录入时间 →
  // 操作时间 → 总价 → 交货日期 → 付款方式），交货地址与交期条款各占整行。
  // 第 4 行第 3 组（原「采购单号」）留空，所以整张表只有 11 个字段标签。
  const labels = [];
  const seen = new Set();
  sheet.eachRow((row) => row.eachCell((cell) => {
    // 合并区里每个格都会返回主格的值 —— 用主格地址去重，否则每个字段会被数两三次
    if (seen.has(cell.master.address)) return;
    seen.add(cell.master.address);
    const match = /^([\u4e00-\u9fff]+)：/s.exec(typeof cell.value === "string" ? cell.value : "");
    if (match && !["备注", "交易条款", "交货地址", "交期条款"].includes(match[1])) labels.push(`${match[1]}：`);
  }));
  assert.deepEqual(labels, ["订单号：", "供应商名称：", "供应商联系人：", "采购人：", "操作人：", "下单录入时间：", "操作时间：", "总价：", "交货日期：", "付款方式：", "电话："]);
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

test("明细 7 列列序：模板 7 列顺序不变，仅在「规格型号」后插入「单位」；含税总价=系统金额", async () => {
  const { service } = fixture();
  const sheet = await sheetOf(service);
  const headerRow = findRow(sheet, 1, "序号");
  assert.ok(headerRow > 0, "应能找到明细表头行");

  const headers = [];
  for (let column = 1; column <= 7; column += 1) headers.push(sheet.getRow(headerRow).getCell(column).value);
  assert.deepEqual(headers, ["序号", "产品名称", "规格型号", "单位", "含税单价", "数量", "含税总价"]);

  const first = sheet.getRow(headerRow + 1);
  assert.equal(first.getCell(1).value, 1);
  assert.equal(first.getCell(2).value, "伞骨");
  assert.equal(first.getCell(3).value, "58cm", "规格型号取采购明细的型号");
  assert.equal(first.getCell(4).value, "根");
  assert.equal(first.getCell(5).value, 1.25, "含税单价=系统单价");
  assert.equal(first.getCell(6).value, 1200);
  assert.equal(first.getCell(7).value, 1500, "含税总价=系统金额（数量×单价+附加费）");

  const second = sheet.getRow(headerRow + 2);
  assert.equal(second.getCell(3).value, "EVA 主数据", "型号为空时退回物料规格型号");
  assert.equal(second.getCell(4).value, "米");
});

test("2026-10-13：明细不再印「供应商」与「交货日期」两列（抬头那两句仍在）", async () => {
  const { service } = fixture();
  const sheet = await sheetOf(service);
  const headerRow = findRow(sheet, 1, "序号");
  const headers = [];
  for (let column = 1; column <= 9; column += 1) headers.push(sheet.getRow(headerRow).getCell(column).value ?? null);

  assert.equal(headers.includes("供应商"), false, "「供应商」列已删");
  assert.equal(headers.includes("交货日期"), false, "「交货日期」列已删");
  assert.equal(headers[7], null, "第 8 列起应该是空的（表只剩 7 列，不是把内容留在原位置上）");

  // fixture 的明细行上仍有第二个供应商（某某五金厂 / 另一家纺织厂）与逐行日期：
  // 它们**不该**出现在纸面上 —— 逐行供应商是这次要删的东西（抬头已写明这张单开给谁）。
  const values = allText(sheet);
  assert.equal(values.includes("另一家纺织厂"), false, "明细行的供应商不该再印");
  assert.equal(values.some((value) => value.includes("2026-09-18")), false, "明细行的交货日期不该再印");
  // 抬头的两句照旧（用户确认保留）；2026-10-19 起值写在「标签：值」同一格里，所以用包含判断
  assert.equal(values.some((value) => value.includes("供应商名称：某某五金厂")), true, "抬头「供应商名称：」保留");
  assert.equal(values.some((value) => value.includes("交货日期：2026-09-20")), true, "抬头「交货日期：」保留整单交期");
});

test("小计只对含税总价求和；备注照旧；表尾三个大格子留空供手写", async () => {
  const { service } = fixture();
  const sheet = await sheetOf(service);
  const headerRow = findRow(sheet, 1, "序号");
  const subtotal = sheet.getRow(findRow(sheet, 1, "小计"));
  // 含税总价删列后是第 7 列（G）：公式跟着列走（写死 H 会指向一个空列，纸面上小计变 0）
  assert.match(String(subtotal.getCell(7).value.formula), new RegExp(`^SUM\\(G${headerRow + 1}:G${headerRow + 2}\\)$`));
  assert.equal(subtotal.getCell(6).value, null, "数量跨单位不求和");

  const remarkRow = findRow(sheet, 1, `备注：${fixture().order.remark}`);
  assert.ok(remarkRow > 0, "备注区保留标签与内容");

  // 表尾三格：换成业务的说法（厂家回签意见 / 厂家回签 / 主管签字），且是「大格子」
  const values = allText(sheet);
  for (const label of ["厂家回签意见", "厂家回签", "主管签字"]) assert.ok(values.includes(label), `签署栏应包含「${label}」`);
  for (const label of ["厂商回复意见", "厂商回签", "主管"]) {
    assert.equal(values.includes(label), false, `旧标签「${label}」应已换成业务用语`);
  }
  const signatureRow = findRow(sheet, 1, "厂家回签意见");
  // 「大格子」= 跨 A:B 且 4 行高（标签写在左上角，其余留白供手写）。
  // 2026-10-19 起版心是 A:G，三格按 36 / 32 / 33 个单位分（A:B / C:D / E:G）。
  assert.equal(sheet.getCell(`A${signatureRow}`).value, "厂家回签意见");
  assert.equal(sheet.getCell(`B${signatureRow + 3}`).master.address, `A${signatureRow}`, "回签意见格应为 A:B 跨 4 行");
  assert.equal(sheet.getCell(`C${signatureRow}`).value, "厂家回签", "第二格从 C 起");
  assert.equal(sheet.getCell(`B${signatureRow + 4}`).isMerged, false, "回签意见格不应超过 4 行");
});

test("2026-10-19 列宽：单位收窄、产品名称与规格型号加宽（用户点名的三列）", async () => {
  const { service } = fixture();
  const sheet = await sheetOf(service);
  const [sequence, productName, specification, unit, unitPrice, quantity, amount] = columnWidths(sheet);
  assert.equal(unit, 6, "单位：8 → 6（用户：这个 column 可以窄一点）");
  assert.equal(productName, 30, "产品名称：22 → 30（用户：一定要宽大一点）");
  assert.equal(specification, 26, "规格型号：16 → 26（用户：一定要宽大一点）");
  assert.ok(productName >= unit * 4 && specification >= unit * 4, "名称/规格要比单位宽出好几倍");
  assert.equal(sequence, 6);
  assert.deepEqual([unitPrice, quantity, amount], [11, 10, 13], "数字三列只做微调，别把宽度吃回去");
  // 版心总宽不许再涨：宽度一旦超过 A4 一页可印宽度，Excel 会把整页缩小，纸上的字反而更小。
  const total = sequence + productName + specification + unit + unitPrice + quantity + amount;
  assert.ok(total <= 112, `版心总宽 ${total} 不该超过改版前的 112（超了就说明是靠整页缩小塞进去的）`);
});

test("2026-10-19 表头：11 个字段分 4 行 × 3 格，标签与值写在同一格里", async () => {
  const { service } = fixture();
  const sheet = await sheetOf(service);
  const headerRow = findRow(sheet, 1, "序号");
  // 明细表头之上 7 行是「交期条款 / 4 行表头字段 / 交货地址 / 标题」中的 4 行字段网格
  const fieldsPerRow = [];
  for (let rowNumber = headerRow - 6; rowNumber <= headerRow - 3; rowNumber += 1) {
    const fields = new Set();
    sheet.getRow(rowNumber).eachCell((cell) => {
      if (typeof cell.value === "string" && cell.value.includes("：")) fields.add(cell.master.address);
    });
    fieldsPerRow.push(fields.size);
  }
  assert.deepEqual(fieldsPerRow, [3, 3, 3, 2], "4 行 3 组；最后一行只剩「付款方式 / 电话」（采购单号那格 2026-10-13 已删）");
  // 每一格都以「标签：」开头 —— 标签不会再单独占一列被截成半截字
  const firstFieldRow = headerRow - 6;
  assert.match(String(sheet.getRow(firstFieldRow).getCell(1).value), /^订单号：/);
});

/**
 * 版式守卫（2026-10-19）：整张单子上**没有任何一格的字是被截断的**。
 *
 * 这条是补 2026-09-16 的漏：表头标签当时放在 A/D/G 三列（宽度 6 / 8 / 12），而
 * 「供应商联系人：」要 14 个列宽单位 —— Excel 打印出来是「单号：」「购人：」「时间：」这种半截字，
 * 一直到 2026-10-19 用 Excel 导出 PDF 放大看才发现（此前只跑过单测，没人看过真正的纸面）。
 * 判据两条：放不下就得有 `wrapText`；折行的格子行高必须按折行数给够（写死行高会把第二行压掉）。
 */
test("版式守卫：没有一格的字被列宽/行高截断（标签、备注、条款都在）", async () => {
  const longRemark = "含税价；交期如有变动请在一天内回复。".repeat(8);
  const { service } = fixture({ remark: longRemark, deliveryAddress: "浙江省绍兴市柯桥区迪礼厂区 1 号仓库（东门进，靠近装卸平台，雨伞需防晒）" });
  const sheet = await sheetOf(service);
  const merged = mergedWidths(sheet);
  const widthOf = (address) => merged.get(address) ?? (sheet.getColumn(address.replace(/\d+/g, "")).width ?? 8.43);
  /** 左对齐的单格，右边一格为空时 Excel 会让文字溢出去显示 —— 那不算截断。 */
  const canOverflowRight = (cell, row) => {
    if (cell.isMerged || cell.alignment?.horizontal === "right") return false;
    const column = cell.master.address.replace(/\d+/g, "");
    const next = row.getCell(String.fromCharCode(column.charCodeAt(0) + 1)).value;
    return next === null || next === undefined || next === "";
  };

  const problems = new Set();
  sheet.eachRow((row) => row.eachCell({ includeEmpty: false }, (cell) => {
    // 合并区里每个格都会返回主格的值（ExcelJS 的 Merge 代理）—— 按主格去重
    if (cell.master.address !== cell.address) return;
    const text = typeof cell.value === "string" ? cell.value : "";
    if (!text) return; // 数字/公式格不参与（数字格宽了窄了 Excel 会自己显示 ####，不在这里管）
    const address = cell.master.address;
    const width = widthOf(address);
    if (displayWidth(text) <= width) return;
    if (cell.alignment?.wrapText === true) {
      const lines = wrappedLines(text, width);
      if ((row.height ?? 0) < lines * LINE_HEIGHT) problems.add(`${address} 折成 ${lines} 行，行高只有 ${row.height}：${text.slice(0, 16)}…`);
      return;
    }
    if (canOverflowRight(cell, row)) return;
    problems.add(`${address} 放不下又没开折行（要 ${displayWidth(text)}，列宽 ${width}）：${text.slice(0, 16)}…`);
  }));
  assert.deepEqual([...problems], []);
});

test("长产品名/长规格型号：折行 + 行高跟着长（写死 20 会把第二行压在行线上）", async () => {
  const longName = "手柄（加长款银色电镀带绳孔）带防滑纹";
  const longSpec = "直柄 22cm 银色 电镀三层 带绳孔";
  const item = {
    materialSnapshot: { name: longName },
    model: longSpec,
    quantity: new Prisma.Decimal("10"),
    unitPrice: new Prisma.Decimal("1"),
    amount: new Prisma.Decimal("10"),
    material: { name: longName, specificationModel: longSpec },
    unit: { name: "个" }
  };
  const { service } = fixture({ items: [item] });
  const sheet = await sheetOf(service);
  const headerRow = findRow(sheet, 1, "序号");
  const row = sheet.getRow(headerRow + 1);
  const lines = Math.max(wrappedLines(longName, sheet.getColumn(2).width), wrappedLines(longSpec, sheet.getColumn(3).width));
  assert.ok(lines >= 2, "夹具里的名称/规格本来就该折行");
  assert.equal(row.height, lines * LINE_HEIGHT, "行高 = 折行数 × 单行高度");
  assert.equal(row.getCell(2).alignment.wrapText, true, "折行必须真的开在单元格上");
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
