// 财务对账导出的工作簿测试。
//
// 最要紧的一条：**数字必须落成 Excel 数值类型**（用户明确要求）。
// 老表（example/财务/*.xls）里所有数据单元格都是文本型（BIFF 格式 z="@"），
// 文本型数字在 Excel 里 SUM 得 0、筛选分不出数值区间、排序按字典序。
// 这里既逐格断言数值单元格，也做「全表不允许存在文本型数字」的不变量扫描。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { Prisma } = require("@prisma/client");
const XLSX = require("xlsx");
const {
  SALES_RECONCILIATION_DETAIL_COLUMNS,
  PURCHASE_RECONCILIATION_DETAIL_COLUMNS,
  buildPurchaseReconciliationDetailTable,
  buildSalesReconciliationDetailTable,
  reportTotalRow,
} = require("../../dist/modules/finance/finance-report.tables.js");
const { renderReportWorkbook } = require("../../dist/modules/finance/finance-report-workbook.js");

const dec = (value) => new Prisma.Decimal(value);
const LABELS = new Map([["USD", "美元"], ["CNY", "人民币"]]);

/** 两张表各一行、且数值取自老表样本：销售行=销售对账明细表第一行，人民币行=第二行。 */
function salesRows() {
  const usdOrder = { currency: "USD", totalAmount: dec("1862.024"), receivableAmount: null, localCurrencyAmount: dec("12475.56") };
  const cnyOrder = { currency: "CNY", totalAmount: dec("9600"), receivableAmount: null, localCurrencyAmount: null };
  return [
    {
      date: new Date("2026-09-07T00:00:00.000Z"),
      orderNo: "XSDD2026090700001",
      customerName: "Matthew Jackson",
      productName: "DL260173-23寸*10K三折自开收伞",
      productSpecification: null,
      unit: "打",
      currency: "USD",
      unitPrice: dec("44.685"),
      quantity: dec("41.67"),
      amount: dec("1862.024"),
      order: usdOrder,
    },
    {
      date: new Date("2026-09-14T00:00:00.000Z"),
      orderNo: "XSDD2026091400001",
      customerName: "静心文化学会",
      productName: "DL260172-30寸*8K 自动直骨伞",
      productSpecification: null,
      unit: "打",
      currency: "CNY",
      unitPrice: dec("384"),
      quantity: dec("25"),
      amount: dec("9600"),
      order: cnyOrder,
    },
  ];
}

/** 采购对账明细表样本行（含税单价=单价、含税金额=金额）。 */
function purchaseRows() {
  return [
    {
      date: new Date("2026-09-08T00:00:00.000Z"),
      purchaseOrderNo: "CGDH1319",
      supplierName: "碧江",
      productName: "23寸*10K 三折自开收",
      materialCode: "WPTM2026090700003",
      specification: "黑色电着铁中棒",
      unit: "打",
      currency: "CNY",
      unitPrice: dec("99"),
      quantity: dec("42"),
      amount: dec("4158"),
    },
  ];
}

function readSheet(buffer) {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const name = workbook.SheetNames[0];
  const sheet = workbook.Sheets[name];
  return { name, sheet, rows: XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null, blankrows: true }) };
}

/** 全表扫描：不允许存在「看起来是数字却写成文本」的单元格。 */
function assertNoTextNumbers(sheet, label) {
  const offenders = [];
  for (const [address, cell] of Object.entries(sheet)) {
    if (address.startsWith("!")) continue;
    if (cell.t === "s" && typeof cell.v === "string" && /^-?\d+(\.\d+)?$/.test(cell.v.trim())) {
      offenders.push(`${address}=${cell.v}`);
    }
  }
  assert.deepEqual(offenders, [], `${label}：不允许把数字写成文本单元格（Excel 里无法求和/筛选/排序）`);
}

test("finance-report.workbook：销售对账明细表的表头与列序逐列照抄老表（23 列）", async () => {
  const table = buildSalesReconciliationDetailTable(salesRows(), { currencyLabels: LABELS });
  const { name, rows } = readSheet(await renderReportWorkbook([table]));
  assert.equal(name, "销售对账明细", "sheet 名用规范中文，不照抄老系统带拼写错误的 sheet 名");
  assert.deepEqual(rows[0], [
    "日期", "销售单号", "客户名称", "产品名称", "产品代码", "规格型号", "单位", "币种",
    "单价", "含税单价", "税额", "调整金额", "折扣", "数量", "金额", "含税金额",
    "汇率", "单价(本)", "含税单价(本)", "税额(本)", "调整金额(本)", "金额(本)", "含税金额(本)",
  ]);
  assert.equal(SALES_RECONCILIATION_DETAIL_COLUMNS.length, 23);
});

test("finance-report.workbook：销售对账明细表的直取列与派生列取值正确", async () => {
  const table = buildSalesReconciliationDetailTable(salesRows(), { currencyLabels: LABELS });
  const { rows } = readSheet(await renderReportWorkbook([table]));
  const usd = rows[1];
  assert.equal(usd[0], "2026-09-07", "日期取销售单日期（与单号内嵌日期一致），写成 YYYY-MM-DD 文本");
  assert.equal(usd[1], "XSDD2026090700001");
  assert.equal(usd[2], "Matthew Jackson");
  assert.equal(usd[7], "美元", "币种把库里的 USD 转成老表用的中文标签");
  assert.equal(usd[8], 44.685);
  assert.equal(usd[13], 41.67);
  assert.equal(usd[14], 1862.024);
  assert.equal(usd[16], 6.7, "汇率由「本币金额 ÷ 原币金额」派生");
  assert.equal(usd[21], 12475.56, "金额(本) 等于销售单上的本币金额");
  assert.equal(Number(usd[17].toFixed(3)), 299.389, "单价(本) 与老表样本一致");
  const cny = rows[2];
  assert.equal(cny[7], "人民币");
  assert.equal(cny[16], 1, "人民币单据汇率为 1");
  assert.equal(cny[21], 9600);
  assert.equal(cny[17], 384);
});

test("finance-report.workbook：销售对账明细表缺字段的列是空单元格（不是 0、不是空字符串）", async () => {
  const table = buildSalesReconciliationDetailTable(salesRows(), { currencyLabels: LABELS });
  const { sheet, rows } = readSheet(await renderReportWorkbook([table]));
  // 产品代码(4) / 含税单价(9) / 税额(10) / 调整金额(11) / 折扣(12) / 含税金额(15) + 三个 (本) 列(18,19,20)
  for (const index of [4, 9, 10, 11, 12, 15, 18, 19, 20]) {
    assert.equal(rows[1][index], null, `第 ${index} 列应为空（R2：系统没有该字段，留空）`);
    const cell = sheet[`${XLSX.utils.encode_col(index)}2`];
    assert.equal(cell?.v ?? null, null, `第 ${index} 列必须是真正的空单元格：写 0 会被当成「确实为零」的事实`);
  }
});

test("finance-report.workbook：数值列全部是 Excel 数值类型，且全表没有文本型数字", async () => {
  const sales = buildSalesReconciliationDetailTable(salesRows(), { currencyLabels: LABELS });
  const purchase = buildPurchaseReconciliationDetailTable(purchaseRows(), { currencyLabels: LABELS });
  const buffer = await renderReportWorkbook([sales, purchase]);
  const workbook = XLSX.read(buffer, { type: "buffer" });

  for (const sheetName of ["销售对账明细", "采购对账明细"]) {
    const sheet = workbook.Sheets[sheetName];
    assertNoTextNumbers(sheet, sheetName);
    const columns = sheetName === "销售对账明细" ? SALES_RECONCILIATION_DETAIL_COLUMNS : PURCHASE_RECONCILIATION_DETAIL_COLUMNS;
    const range = XLSX.utils.decode_range(sheet["!ref"]);
    for (let column = range.s.c; column <= range.e.c; column += 1) {
      const definition = columns[column];
      for (let row = 1; row <= range.e.r; row += 1) {
        const cell = sheet[XLSX.utils.encode_cell({ r: row, c: column })];
        if (!cell) continue;
        if (definition.numFmt) {
          // 合计行是公式单元格（无缓存值时 t 可能不是 'n'），它的数值性由 f 保证。
          assert.ok(
            cell.t === "n" || cell.f,
            `${sheetName}!${XLSX.utils.encode_cell({ r: row, c: column })}（${definition.header}）必须是数值单元格`,
          );
        } else {
          assert.notEqual(cell.t, "n", `${sheetName} 的文本列「${definition.header}」不应出现数值单元格`);
        }
      }
    }
  }
});

test("finance-report.workbook：合计行只对声明的金额列写 SUM 公式，合计值等于各行之量", async () => {
  const table = buildSalesReconciliationDetailTable(salesRows(), { currencyLabels: LABELS });
  const { sheet } = readSheet(await renderReportWorkbook([table]));
  assert.equal(sheet.A4.v, "合计", "合计行紧跟数据行（数据在 2~3 行，合计在第 4 行）");
  assert.equal(sheet.O4.f, "SUM(O2:O3)", "金额列求和的区间必须只覆盖数据行");
  assert.equal(sheet.V4.f, "SUM(V2:V3)", "金额(本) 列同样求和");

  const totals = reportTotalRow(table);
  assert.equal(sheet.O4.v, 11462.024, "公式必须带缓存结果，否则不重算公式的读取器读到的是空格子");
  assert.equal(sheet.V4.v, 22075.56);
  // 「页面上的合计」与「导出的合计」必须同值：导出直接复用 reportTotalRow 的结果。
  assert.equal(sheet.O4.v, totals[14]);
  assert.equal(sheet.V4.v, totals[21]);
  assert.equal(totals[14], 11462.024, "页面预览的合计（9600 + 1862.024）");
  assert.equal(totals[21], 22075.56);
  assert.equal(totals[0], "合计");
  assert.equal(totals[8], null, "单价跨行相加没有意义，不给合计");
  assert.equal(totals[13], null, "数量跨单位相加没有意义，不给合计");
});

test("finance-report.workbook：空数据时不写合计行（不能凭空给一个 0 的合计）", async () => {
  const table = buildSalesReconciliationDetailTable([], { currencyLabels: LABELS });
  const { sheet, rows } = readSheet(await renderReportWorkbook([table]));
  assert.equal(rows.length, 1, "只有表头");
  assert.equal(sheet.A2, undefined);
  assert.equal(reportTotalRow(table), null);
});

test("finance-report.workbook：采购对账明细表 16 列，产品名称在采购单号之前，含税列等于不含税列", async () => {
  const table = buildPurchaseReconciliationDetailTable(purchaseRows(), { currencyLabels: LABELS });
  const { name, rows } = readSheet(await renderReportWorkbook([table]));
  assert.equal(name, "采购对账明细");
  // 唯一与老表不同的一处：产品名称提到采购单号前面（用户 2026-09-17 要求，理由见列定义注释）。
  assert.deepEqual(rows[0], [
    "日期", "产品名称", "采购单号", "供应商名称", "产品代码", "规格型号", "单位", "币种",
    "单价", "含税单价", "数量", "折扣", "税额", "调整金额", "金额", "含税金额",
  ]);
  const row = rows[1];
  assert.equal(row[0], "2026-09-08");
  assert.equal(row[1], "23寸*10K 三折自开收", "第 2 列是产品名称");
  assert.equal(row[2], "CGDH1319", "第 3 列才是采购单号");
  assert.equal(row[3], "碧江");
  assert.equal(row[4], "WPTM2026090700003", "产品代码取物料编码");
  assert.equal(row[8], 99);
  assert.equal(row[9], 99, "R3：系统采购单价即含税价，含税单价 = 单价");
  assert.equal(row[10], 42);
  assert.equal(row[14], 4158);
  assert.equal(row[15], 4158, "R3：含税金额 = 金额");
  for (const index of [11, 12, 13]) assert.equal(row[index], null, "折扣/税额/调整金额系统没有字段，留空");
  // 合计列下标与列序调整无关（金额/含税金额仍在最后两列），但也一起钉住，
  // 免得以后有人再把产品名称往后挪时忘了跟着改下标，合计就悄悄落到别的列上。
  assert.deepEqual(table.totalColumns, [14, 15], "合计列仍是金额与含税金额");
});

test("finance-report.workbook：数值列被写入字符串时直接抛错（防止文本型数字回归）", async () => {
  const table = { sheetName: "回归", columns: [{ header: "金额", width: 10, numFmt: "0.####" }], rows: [["1862.024"]] };
  await assert.rejects(
    () => renderReportWorkbook([table]),
    /数值列「金额」收到非数值/,
    "数值列写字符串型数字正是老表的毛病，必须在渲染层拦住而不是悄悄写出去",
  );
});

test("finance-report.workbook：工作表名去非法字符并截断到 31 字符，重名自动加序号", async () => {
  const table = { sheetName: "销售/对账:明细*表?名[称]", columns: [{ header: "列", width: 10 }], rows: [["值"]] };
  const buffer = await renderReportWorkbook([table, table]);
  const workbook = XLSX.read(buffer, { type: "buffer" });
  assert.equal(workbook.SheetNames.length, 2, "同名工作表必须能并存");
  for (const name of workbook.SheetNames) {
    assert.ok(name.length <= 31, `工作表名不能超过 31 字符：${name}`);
    assert.equal(/[\\/*?:[\]]/.test(name), false, `工作表名不能含 Excel 禁用字符：${name}`);
  }
});

test("finance-report.workbook：表尾说明行（如缺采购价物料）写入工作表末尾", async () => {
  const table = {
    sheetName: "利润",
    columns: [{ header: "单号", width: 20 }, { header: "成本金额", width: 12, numFmt: "0.####" }],
    rows: [["SO-1", 0]],
    footnotes: ["缺采购价物料：WPTM0001 无采购价", "缺采购价物料：WPTM0002 无采购价"],
  };
  const { sheet } = readSheet(await renderReportWorkbook([table]));
  assert.equal(sheet.A4.v, "缺采购价物料：WPTM0001 无采购价", "缺价物料必须显式列出，不能静默按 0 算完");
  assert.equal(sheet.A5.v, "缺采购价物料：WPTM0002 无采购价");
});
