// 三期两张表（收支明细表 / 收支汇总表）的版式与口径测试。
//
// 三期特有的两件事：
//   1. 收支明细表的「收入 / 支出」是**两列**，没有的那一边写 0（照抄老表样本：收入 0 / 支出 2900）；
//   2. 收支汇总表**按币种分行、绝不跨币种相加**（R7）—— 老表样本把美元 5428 与人民币 2900
//      加在了同一列，那正是本轮要修掉的问题。因此本表没有「一行总计」，合计只在每个币种段末给出。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { Prisma } = require("@prisma/client");
const XLSX = require("xlsx");
const {
  CASH_FLOW_DETAIL_COLUMNS,
  CASH_FLOW_SUMMARY_COLUMNS,
  buildCashFlowDetailTable,
  buildCashFlowSummaryTable,
  reportTotalRow,
} = require("../../dist/modules/finance/finance-report.tables.js");
const { settlementText } = require("../../dist/modules/finance/cash-flow.domain.js");
const { renderReportWorkbook } = require("../../dist/modules/finance/finance-report-workbook.js");

const dec = (value) => new Prisma.Decimal(value);
const LABELS = new Map([["USD", "美元"], ["CNY", "人民币"]]);

function readSheet(buffer) {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const name = workbook.SheetNames[0];
  return { name, sheet: workbook.Sheets[name], rows: XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, raw: true, defval: null, blankrows: true }) };
}

function assertNoTextNumbers(sheet, label) {
  const offenders = [];
  for (const [address, cell] of Object.entries(sheet)) {
    if (address.startsWith("!")) continue;
    if (cell.t === "s" && typeof cell.v === "string" && /^-?\d+(\.\d+)?$/.test(cell.v.trim())) offenders.push(`${address}=${cell.v}`);
  }
  assert.deepEqual(offenders, [], `${label}：不允许把数字写成文本单元格`);
}

/* ------------------------------------------------------------ 结算方式 */

test("finance-report.cash-flow：结算方式把「方式 + 银行账户」合成一格（老表形如 转账--农业银行5706）", () => {
  assert.equal(settlementText("转账", "农业银行5706"), "转账--农业银行5706");
  assert.equal(settlementText("转账", null), "转账", "只填了方式也要出得来");
  assert.equal(settlementText(null, "农业银行5706"), "农业银行5706");
  assert.equal(settlementText(null, null), null, "两样都没有就留空，不写空字符串");
  assert.equal(settlementText("  ", "  "), null);
});

/* ------------------------------------------------------------ 收支明细表 */

function detailRows() {
  return [
    {
      date: new Date("2026-09-14T00:00:00.000Z"),
      counterpartyName: "兴田",
      currency: "CNY",
      direction: "expense",
      amount: dec("2900"),
      settlementMethod: "转账",
      settlementAccountLabel: "农业银行5706",
    },
    {
      date: new Date("2026-09-14T00:00:00.000Z"),
      counterpartyName: "中谷ZG",
      currency: "USD",
      direction: "income",
      amount: dec("1000"),
      settlementMethod: "转账",
      settlementAccountLabel: "中国银行（美元）7624",
    },
  ];
}

test("finance-report.cash-flow：收支明细表的表头与列序逐列照抄老表（6 列）", async () => {
  const table = buildCashFlowDetailTable(detailRows(), { currencyLabels: LABELS });
  const { name, rows } = readSheet(await renderReportWorkbook([table]));
  assert.equal(name, "收支明细");
  assert.deepEqual(rows[0], ["日期", "对方名称", "币种", "收入", "支出", "结算方式"]);
  assert.equal(CASH_FLOW_DETAIL_COLUMNS.length, 6);
});

test("finance-report.cash-flow：收入/支出分列，没有的那一边写 0（照抄老表样本）", async () => {
  const table = buildCashFlowDetailTable(detailRows(), { currencyLabels: LABELS });
  const { rows } = readSheet(await renderReportWorkbook([table]));
  assert.deepEqual(rows[1], ["2026-09-14", "兴田", "人民币", 0, 2900, "转账--农业银行5706"], "支出行：收入写 0");
  assert.deepEqual(rows[2], ["2026-09-14", "中谷ZG", "美元", 1000, 0, "转账--中国银行（美元）7624"], "收入行：支出写 0");
});

test("finance-report.cash-flow：收入/支出是数值类型，且全表没有文本型数字", async () => {
  const table = buildCashFlowDetailTable(detailRows(), { currencyLabels: LABELS });
  const { sheet } = readSheet(await renderReportWorkbook([table]));
  assertNoTextNumbers(sheet, "收支明细");
  assert.equal(sheet.D2.t, "n");
  assert.equal(sheet.E2.t, "n");
  assert.equal(sheet.D2.v, 0, "0 要落成数值 0，而不是空单元格（这里 0 是「确实为零」的事实）");
});

test("finance-report.cash-flow：收支明细表不给合计行（一行一个币种，跨币种相加没有意义）", async () => {
  const table = buildCashFlowDetailTable(detailRows(), { currencyLabels: LABELS });
  const { sheet } = readSheet(await renderReportWorkbook([table]));
  assert.equal(table.totalColumns, undefined);
  assert.equal(reportTotalRow(table), null);
  assert.equal(sheet.A4, undefined, "表尾不该多出一行「合计」");
});

/* ------------------------------------------------------------ 收支汇总表 */

const ITEMS = [
  { id: "item-1", label: "备用金" },
  { id: "item-2", label: "货款" },
  { id: "item-3", label: "房租支出" },
];

test("finance-report.cash-flow：收支汇总表按币种分行，段末给该币种合计（不跨币种相加）", async () => {
  const amounts = [
    { itemId: "item-2", currency: "CNY", income: dec("0"), expense: dec("2900") },
    { itemId: "item-2", currency: "USD", income: dec("5428"), expense: dec("0") },
  ];
  const table = buildCashFlowSummaryTable(ITEMS, amounts, ["CNY", "USD"], { currencyLabels: LABELS });
  const { name, rows } = readSheet(await renderReportWorkbook([table]));
  assert.equal(name, "收支汇总");
  assert.deepEqual(rows[0], ["项目", "币种", "收入", "支出"]);
  assert.equal(CASH_FLOW_SUMMARY_COLUMNS.length, 4, "比老表多一列「币种」——这是 R7 要求的分行维度");

  // 人民币段：备用金/房租支出 全 0，货款只有支出 2900
  assert.deepEqual(rows[1], ["备用金", "人民币", 0, 0]);
  assert.deepEqual(rows[2], ["货款", "人民币", 0, 2900]);
  assert.deepEqual(rows[4], ["合计", "人民币", 0, 2900]);
  // 美元段：货款只有收入 5428
  assert.deepEqual(rows[5], ["备用金", "美元", 0, 0]);
  assert.deepEqual(rows[6], ["货款", "美元", 5428, 0]);
  assert.deepEqual(rows[8], ["合计", "美元", 5428, 0]);
});

test("finance-report.cash-flow：老表样本的「收入 5428（美元）支出 2900（人民币）」不再被加到一起", async () => {
  const amounts = [
    { itemId: "item-2", currency: "CNY", income: dec("0"), expense: dec("2900") },
    { itemId: "item-2", currency: "USD", income: dec("5428"), expense: dec("0") },
  ];
  const table = buildCashFlowSummaryTable(ITEMS, amounts, ["CNY", "USD"], { currencyLabels: LABELS });
  const { rows } = readSheet(await renderReportWorkbook([table]));
  // 老表的「货款」行是 收入 5428 / 支出 2900 —— 两个不同币种被加在同一列。
  // 现在的分解：人民币段 0/2900，美元段 5428/0；两段的数字各自只统计本币种。
  const cny = rows.find((row) => row[0] === "合计" && row[1] === "人民币");
  const usd = rows.find((row) => row[0] === "合计" && row[1] === "美元");
  assert.deepEqual(cny, ["合计", "人民币", 0, 2900]);
  assert.deepEqual(usd, ["合计", "美元", 5428, 0]);
  assert.equal(rows.some((row) => row[2] === 5428 && row[3] === 2900), false, "不允许出现把两个币种相加的格子");
});

test("finance-report.cash-flow：本期没发生的项目照样列出（写 0），老表的项目清单形态得以保留", async () => {
  const table = buildCashFlowSummaryTable(ITEMS, [], ["CNY"], { currencyLabels: LABELS });
  const { rows } = readSheet(await renderReportWorkbook([table]));
  assert.deepEqual(rows[1], ["备用金", "人民币", 0, 0]);
  assert.deepEqual(rows[2], ["货款", "人民币", 0, 0]);
  assert.deepEqual(rows[3], ["房租支出", "人民币", 0, 0]);
  assert.deepEqual(rows[4], ["合计", "人民币", 0, 0]);
});

test("finance-report.cash-flow：收支汇总表的收入/支出是数值类型，且表尾说明写清「不跨币种相加」", async () => {
  const amounts = [{ itemId: "item-2", currency: "USD", income: dec("5428"), expense: dec("0") }];
  const table = buildCashFlowSummaryTable(ITEMS, amounts, ["USD"], { currencyLabels: LABELS });
  const { sheet } = readSheet(await renderReportWorkbook([table]));
  assertNoTextNumbers(sheet, "收支汇总");
  assert.equal(sheet.C2.t, "n");
  assert.equal(table.footnotes.length, 2);
  assert.match(table.footnotes[0], /不跨币种相加/);
  // 4 行数据（3 个项目 + 1 行合计）→ 表尾说明与正文空一行后落在第 7 行
  assert.match(sheet.A7.v, /不跨币种相加/, "表尾说明要落到导出文件里");
});
