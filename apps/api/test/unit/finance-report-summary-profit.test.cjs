// 二期两张表（销售对账汇总表 / 销售利润报表(毛利)）的版式与口径测试。
//
// 与一期同一套判据：列名与列序照抄老表、数值落数值类型、缺字段留空（不写 0）、
// 合计值等于逐行之量；另外二期特有的两件事：
//   - 欠款 = 应收合计 + 调整净额 − 已收合计（用老表口径核对）；
//   - 外币缺本币金额时，三列 (本) 留空，而不是拿原币冒充本币。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { Prisma } = require("@prisma/client");
const XLSX = require("xlsx");
const {
  SALES_RECONCILIATION_SUMMARY_COLUMNS,
  SALES_GROSS_PROFIT_COLUMNS,
  buildSalesReconciliationSummaryTable,
  buildSalesGrossProfitTable,
  footnoteLines,
  reportTotalRow,
} = require("../../dist/modules/finance/finance-report.tables.js");
const {
  materialCostOf,
  profitAmount,
  receivableOutstanding,
  salesAmountOf,
  unitUsagePerUnit,
} = require("../../dist/modules/finance/finance-report.domain.js");
const { renderReportWorkbook } = require("../../dist/modules/finance/finance-report-workbook.js");

const dec = (value) => new Prisma.Decimal(value);
const LABELS = new Map([["USD", "美元"], ["CNY", "人民币"]]);

function readSheet(buffer) {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const name = workbook.SheetNames[0];
  return { name, sheet: workbook.Sheets[name], rows: XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, raw: true, defval: null, blankrows: true }) };
}

/* ------------------------------------------------------------ 纯口径 */

test("finance-report.summary：欠款 = 应收合计 + 调整净额 − 已收合计", () => {
  const outstanding = receivableOutstanding(dec("24525"), dec("10000"), [
    { effect: "decrease", amount: dec("500") },
    { effect: "increase", amount: dec("200") },
  ]);
  assert.equal(outstanding.toString(), "14225", "24525 − 500 + 200 − 10000");
});

test("finance-report.summary：没有调整与收款时欠款等于应收", () => {
  assert.equal(receivableOutstanding(dec("9600"), null, []).toString(), "9600");
});

test("finance-report.profit：单件用量、物料成本、利润三段的边界", () => {
  assert.equal(unitUsagePerUnit({ approvedUsage: dec("100"), productionBatchBase: dec("1000") }).toString(), "0.1");
  assert.equal(unitUsagePerUnit({ approvedUsage: null, baseUsage: dec("3") }).toString(), "3");
  assert.equal(unitUsagePerUnit({ requiredQuantity: dec("7") }).toString(), "7");
  assert.equal(unitUsagePerUnit({}), null);

  assert.equal(materialCostOf(dec("2"), dec("100"), dec("5")).toString(), "1000");
  assert.equal(materialCostOf(dec("2"), dec("100"), null), null, "缺单价算不出成本，不能当 0");
  assert.equal(materialCostOf(null, dec("100"), dec("5")), null);

  assert.equal(profitAmount(dec("24525"), dec("10000")).toString(), "14525");
  assert.equal(profitAmount(dec("24525"), null).toString(), "24525", "成本缺失按 0 参与（缺价在表尾列出）");
  assert.equal(profitAmount(null, dec("100")), null, "没有销售额就算不出利润");
});

test("finance-report.profit：销售金额取销售单总额，缺失时退应收金额", () => {
  assert.equal(salesAmountOf({ totalAmount: dec("24525"), receivableAmount: dec("20000") }).toString(), "24525");
  assert.equal(salesAmountOf({ totalAmount: null, receivableAmount: dec("20000") }).toString(), "20000");
  assert.equal(salesAmountOf({}), null);
});

test("finance-report.footnotes：空列表不给表尾说明，长列表折行并给出未列出的条数", () => {
  assert.deepEqual(footnoteLines("缺采购价物料", []), []);
  assert.deepEqual(footnoteLines("缺采购价物料", ["A"]), ["缺采购价物料（1-1/1）：A"]);
  const many = Array.from({ length: 25 }, (_, index) => `M${index + 1}`);
  const lines = footnoteLines("缺采购价物料", many, 10, 2);
  assert.equal(lines.length, 3, "2 行列出 + 1 行「另有 N 项」");
  assert.match(lines[0], /（1-10\/25）/);
  assert.match(lines[1], /（11-20\/25）/);
  assert.match(lines[2], /另有 5 项未列出/);
});

/* ------------------------------------------------------------ 销售对账汇总表 */

function summaryRows() {
  return [
    {
      date: new Date("2026-09-30T00:00:00.000Z"),
      orderNo: "XSDD2026060500002",
      customerName: "中谷ZG",
      currency: "USD",
      salesAmount: dec("24525"),
      adjustmentNet: dec("-500"),
      paidAmount: dec("10000"),
      outstandingAmount: dec("14025"),
    },
    {
      date: new Date("2026-09-14T00:00:00.000Z"),
      orderNo: "XSDD2026091400001",
      customerName: "静心文化学会",
      currency: "CNY",
      salesAmount: dec("9600"),
      adjustmentNet: dec("0"),
      paidAmount: dec("0"),
      outstandingAmount: dec("9600"),
    },
  ];
}

test("finance-report.summary：表头与列序逐列照抄老表（10 列）", async () => {
  const table = buildSalesReconciliationSummaryTable(summaryRows(), { currencyLabels: LABELS });
  const { name, rows } = readSheet(await renderReportWorkbook([table]));
  assert.equal(name, "销售对账汇总");
  assert.deepEqual(rows[0], ["日期", "客户名称", "单号", "币种", "销售金额", "调整金额", "税额", "已收金额", "开票金额", "欠款"]);
  assert.equal(SALES_RECONCILIATION_SUMMARY_COLUMNS.length, 10);
});

test("finance-report.summary：单号是销售单号，取值为各列原值", async () => {
  const table = buildSalesReconciliationSummaryTable(summaryRows(), { currencyLabels: LABELS });
  const { rows } = readSheet(await renderReportWorkbook([table]));
  assert.deepEqual(rows[1].slice(0, 6), ["2026-09-30", "中谷ZG", "XSDD2026060500002", "美元", 24525, -500]);
  assert.equal(rows[1][7], 10000);
  assert.equal(rows[1][9], 14025);
});

test("finance-report.summary：税额与开票金额是空单元格（系统没有这两个字段）", async () => {
  const table = buildSalesReconciliationSummaryTable(summaryRows(), { currencyLabels: LABELS });
  const { sheet, rows } = readSheet(await renderReportWorkbook([table]));
  for (const column of ["G", "I"]) {
    assert.equal(rows[1][XLSX.utils.decode_col(column) - 0], null);
    assert.equal(sheet[`${column}2`]?.v ?? null, null, `${column}2 必须是空单元格，写 0 会被当成「确实为零」`);
  }
});

test("finance-report.summary：合计覆盖销售金额/调整/已收/欠款，税额与开票金额不参与", async () => {
  const table = buildSalesReconciliationSummaryTable(summaryRows(), { currencyLabels: LABELS });
  const { sheet } = readSheet(await renderReportWorkbook([table]));
  const totals = reportTotalRow(table);
  assert.equal(sheet.E4.f, "SUM(E2:E3)");
  assert.equal(sheet.F4.f, "SUM(F2:F3)");
  assert.equal(sheet.H4.f, "SUM(H2:H3)");
  assert.equal(sheet.J4.f, "SUM(J2:J3)");
  assert.equal(sheet.G4, undefined, "税额不合计");
  assert.equal(sheet.I4, undefined, "开票金额不合计");
  assert.equal(totals[4], 34125);
  assert.equal(totals[5], -500);
  assert.equal(totals[7], 10000);
  assert.equal(totals[9], 23625);
});

/* ------------------------------------------------------------ 销售利润报表(毛利) */

function profitRows() {
  return [
    {
      date: new Date("2026-06-05T00:00:00.000Z"),
      orderNo: "XSDD2026060500002",
      customerName: "中谷ZG",
      currency: "USD",
      salesAmount: dec("24525"),
      costAmount: dec("10000"),
      order: { currency: "USD", totalAmount: dec("24525"), receivableAmount: null, localCurrencyAmount: dec("164317.5") },
    },
    {
      date: new Date("2026-09-14T00:00:00.000Z"),
      orderNo: "XSDD2026091400001",
      customerName: "静心文化学会",
      currency: "CNY",
      salesAmount: dec("9600"),
      costAmount: dec("6000"),
      order: { currency: "CNY", totalAmount: dec("9600"), receivableAmount: null, localCurrencyAmount: null },
    },
    {
      date: new Date("2026-09-15T00:00:00.000Z"),
      orderNo: "XSDD2026091500001",
      customerName: "法国NA",
      currency: "EUR",
      salesAmount: dec("1000"),
      costAmount: dec("400"),
      // 外币且没填本币金额：汇率推不出来 → 三列 (本) 必须留空
      order: { currency: "EUR", totalAmount: dec("1000"), receivableAmount: null, localCurrencyAmount: null },
    },
  ];
}

test("finance-report.profit：表头与列序逐列照抄老表（10 列）", async () => {
  const table = buildSalesGrossProfitTable(profitRows(), { currencyLabels: LABELS });
  const { name, rows } = readSheet(await renderReportWorkbook([table]));
  assert.equal(name, "销售利润(毛利)");
  assert.deepEqual(rows[0], ["日期", "单号", "客户名称", "币种", "销售金额", "成本金额", "销售利润", "销售金额(本)", "成本金额(本)", "销售利润(本)"]);
  assert.equal(SALES_GROSS_PROFIT_COLUMNS.length, 10);
});

test("finance-report.profit：美元单据的利润与本币三列（老表样本 24525 → 本币 164317.5）", async () => {
  const table = buildSalesGrossProfitTable(profitRows(), { currencyLabels: LABELS });
  const { rows } = readSheet(await renderReportWorkbook([table]));
  const usd = rows[1];
  assert.equal(usd[1], "XSDD2026060500002");
  assert.equal(usd[3], "美元");
  assert.equal(usd[4], 24525);
  assert.equal(usd[5], 10000);
  assert.equal(usd[6], 14525, "销售利润 = 销售金额 − 成本金额");
  assert.equal(usd[7], 164317.5, "销售金额(本) 取销售单上权威的本币金额");
  assert.equal(Number(usd[8].toFixed(2)), 67000, "成本金额(本) = 成本 × 汇率 6.7");
  assert.equal(Number(usd[9].toFixed(2)), 97317.5);
});

test("finance-report.profit：人民币单据汇率为 1，本币列等于原币列", async () => {
  const table = buildSalesGrossProfitTable(profitRows(), { currencyLabels: LABELS });
  const { rows } = readSheet(await renderReportWorkbook([table]));
  const cny = rows[2];
  assert.equal(cny[7], 9600);
  assert.equal(cny[8], 6000);
  assert.equal(cny[9], 3600);
});

test("finance-report.profit：外币缺本币金额时三列 (本) 留空，不拿原币冒充本币", async () => {
  const table = buildSalesGrossProfitTable(profitRows(), { currencyLabels: LABELS });
  const { sheet, rows } = readSheet(await renderReportWorkbook([table]));
  const eur = rows[3];
  assert.equal(eur[4], 1000, "原币三列仍然有值");
  assert.equal(eur[5], 400);
  assert.equal(eur[6], 600);
  for (const column of ["H", "I", "J"]) {
    assert.equal(eur[XLSX.utils.decode_col(column)], null);
    assert.equal(sheet[`${column}4`]?.v ?? null, null);
  }
});

test("finance-report.profit：六个金额列都参与合计", async () => {
  const table = buildSalesGrossProfitTable(profitRows(), { currencyLabels: LABELS });
  const totals = reportTotalRow(table);
  assert.equal(totals[4], 35125);
  assert.equal(totals[5], 16400);
  assert.equal(totals[6], 18725);
  // 本币列只把「算得出来」的行加起来：164317.5 + 9600（欧元那行留空，不参与）
  assert.equal(Number(totals[7].toFixed(4)), 173917.5);
  assert.equal(Number(totals[8].toFixed(2)), 73000);
  assert.equal(Number(totals[9].toFixed(2)), 100917.5);
});

test("finance-report.profit：表尾说明（缺采购价物料 / 没有 BOM 的销售单）写在数据与合计之后并空一行", async () => {
  const footnotes = ["缺采购价物料（成本按 0 计入，毛利偏高）（1-1/1）：WPTM9 未知料", "没有 BOM 或 BOM 无明细的销售单（成本按 0 计入，毛利偏高）（1-1/1）：XSDD2026091500001"];
  const table = buildSalesGrossProfitTable(profitRows().slice(0, 1), { currencyLabels: LABELS, footnotes });
  const { sheet } = readSheet(await renderReportWorkbook([table]));
  assert.equal(sheet.A3.v, "合计");
  assert.equal(sheet.A3.f, undefined, "A 列不是金额列，不给公式");
  assert.equal(sheet.A5.v, footnotes[0], "合计之后空一行再写表尾说明");
  assert.equal(sheet.A6.v, footnotes[1]);
});

test("finance-report.profit：没有表尾说明时不留空白行", async () => {
  const table = buildSalesGrossProfitTable(profitRows().slice(0, 1), { currencyLabels: LABELS });
  const { sheet } = readSheet(await renderReportWorkbook([table]));
  assert.equal(sheet.A5, undefined);
});
