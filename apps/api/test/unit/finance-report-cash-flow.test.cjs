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
      category: "损益类",
      subjectName: "主营业务成本",
      bankLabel: "农业银行5706",
      settlementMethod: "转账",
      settlementAccountLabel: "农业银行5706",
    },
    {
      date: new Date("2026-09-14T00:00:00.000Z"),
      counterpartyName: "中谷ZG",
      currency: "USD",
      direction: "income",
      amount: dec("1000"),
      category: "损益类",
      subjectName: "主营业务收入",
      bankLabel: "中国银行7624",
      settlementMethod: "转账",
      settlementAccountLabel: "中国银行（美元）7624",
    },
  ];
}

// 2026-09-17（用户交付科目表）：明细表要能看出「这笔钱算什么科目、走的哪个账户」。
// 所以列从老表的 6 列扩到 9 列（新增「分类」「项目」「银行账户」）——这是**有意偏离**老表版式，
// 不是抄错：只按老表 6 列，汇总表里「主营业务收入 5000」在明细里根本对不上号。
test("finance-report.cash-flow：收支明细表 9 列（老表 6 列 + 分类 + 项目 + 银行账户）", async () => {
  const table = buildCashFlowDetailTable(detailRows(), { currencyLabels: LABELS });
  const { name, rows } = readSheet(await renderReportWorkbook([table]));
  assert.equal(name, "收支明细");
  assert.deepEqual(rows[0], ["日期", "对方名称", "币种", "分类", "项目", "收入", "支出", "银行账户", "结算方式"]);
  assert.equal(CASH_FLOW_DETAIL_COLUMNS.length, 9);
  assert.deepEqual(CASH_FLOW_DETAIL_COLUMNS.map((column) => column.header), ["日期", "对方名称", "币种", "分类", "项目", "收入", "支出", "银行账户", "结算方式"], "分类在项目之前");
});

test("finance-report.cash-flow：收入/支出分列，没有的那一边写 0；分类、科目与银行账户逐行带出", async () => {
  const table = buildCashFlowDetailTable(detailRows(), { currencyLabels: LABELS });
  const { rows } = readSheet(await renderReportWorkbook([table]));
  assert.deepEqual(rows[1], ["2026-09-14", "兴田", "人民币", "损益类", "主营业务成本", 0, 2900, "农业银行5706", "转账--农业银行5706"], "支出行：收入写 0");
  assert.deepEqual(rows[2], ["2026-09-14", "中谷ZG", "美元", "损益类", "主营业务收入", 1000, 0, "中国银行7624", "转账--中国银行（美元）7624"], "收入行：支出写 0");
});

test("finance-report.cash-flow：分类/科目缺失的历史流水两类都留空（不写横杠，否则会混进数值列）", async () => {
  const table = buildCashFlowDetailTable([{ date: new Date("2026-09-14T00:00:00.000Z"), counterpartyName: "兴田", currency: "CNY", direction: "expense", amount: dec("100"), category: null, subjectName: null, bankLabel: null, settlementMethod: null, settlementAccountLabel: null }], { currencyLabels: LABELS });
  const { rows } = readSheet(await renderReportWorkbook([table]));
  assert.ok(!rows[1][3], "缺失的分类是空单元格（不是横杠，横杠会被当成文本混进数值列）");
  assert.ok(!rows[1][4], "缺失的项目是空单元格");
  assert.ok(!rows[1][7], "缺失的银行账户是空单元格");
});

test("finance-report.cash-flow：收入/支出是数值类型，且全表没有文本型数字", async () => {
  const table = buildCashFlowDetailTable(detailRows(), { currencyLabels: LABELS });
  const { sheet } = readSheet(await renderReportWorkbook([table]));
  assertNoTextNumbers(sheet, "收支明细");
  assert.equal(sheet.F2.t, "n", "收入列（第 6 列）是数值列");
  assert.equal(sheet.G2.t, "n", "支出列（第 7 列）是数值列");
  assert.equal(sheet.F2.v, 0, "0 要落成数值 0，而不是空单元格（这里 0 是「确实为零」的事实）");
  assert.equal(sheet.G2.v, 2900);
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
  { id: "subject-1", category: "资产类", name: "库存现金（备用金）" },
  { id: "subject-2", category: "损益类", name: "主营业务收入" },
  { id: "subject-3", category: "成本类", name: "房租费" },
];

test("finance-report.cash-flow：收支汇总表按币种分行，分类段末给小计、币种段末给合计（不跨币种相加）", async () => {
  const amounts = [
    { subjectId: "subject-2", currency: "CNY", income: dec("0"), expense: dec("2900") },
    { subjectId: "subject-2", currency: "USD", income: dec("5428"), expense: dec("0") },
  ];
  const table = buildCashFlowSummaryTable(ITEMS, amounts, ["CNY", "USD"], { currencyLabels: LABELS });
  const { name, rows } = readSheet(await renderReportWorkbook([table]));
  assert.equal(name, "收支汇总");
  assert.deepEqual(rows[0], ["分类", "项目", "币种", "收入", "支出"]);
  assert.equal(CASH_FLOW_SUMMARY_COLUMNS.length, 5, "比老表多「分类」与「币种」两列");
  assert.deepEqual(CASH_FLOW_SUMMARY_COLUMNS.map((column) => column.header), ["分类", "项目", "币种", "收入", "支出"], "分类必须排在第一列");

  // 人民币段：每个分类 2 行（科目 + 小计），三个分类共 6 行，末尾 1 行合计 → 第 1..7 行
  assert.deepEqual(rows[1], ["资产类", "库存现金（备用金）", "人民币", 0, 0]);
  assert.deepEqual(rows[2], ["资产类", "小计", "人民币", 0, 0], "分类段末必须给出该分类在本币种内的小计");
  assert.deepEqual(rows[3], ["损益类", "主营业务收入", "人民币", 0, 2900]);
  assert.deepEqual(rows[4], ["损益类", "小计", "人民币", 0, 2900]);
  assert.deepEqual(rows[5], ["成本类", "房租费", "人民币", 0, 0]);
  assert.deepEqual(rows[6], ["成本类", "小计", "人民币", 0, 0]);
  assert.deepEqual(rows[7], ["合计", "合计", "人民币", 0, 2900]);
  // 美元段：同样的结构
  assert.deepEqual(rows[8], ["资产类", "库存现金（备用金）", "美元", 0, 0]);
  assert.deepEqual(rows[9], ["资产类", "小计", "美元", 0, 0]);
  assert.deepEqual(rows[10], ["损益类", "主营业务收入", "美元", 5428, 0]);
  assert.deepEqual(rows[11], ["损益类", "小计", "美元", 5428, 0]);
  assert.deepEqual(rows[12], ["成本类", "房租费", "美元", 0, 0]);
  assert.deepEqual(rows[13], ["成本类", "小计", "美元", 0, 0]);
  assert.deepEqual(rows[14], ["合计", "合计", "美元", 5428, 0]);
});

test("finance-report.cash-flow：老表样本的「收入 5428（美元）支出 2900（人民币）」不再被加到一起", async () => {
  const amounts = [
    { subjectId: "subject-2", currency: "CNY", income: dec("0"), expense: dec("2900") },
    { subjectId: "subject-2", currency: "USD", income: dec("5428"), expense: dec("0") },
  ];
  const table = buildCashFlowSummaryTable(ITEMS, amounts, ["CNY", "USD"], { currencyLabels: LABELS });
  const { rows } = readSheet(await renderReportWorkbook([table]));
  // 老表的「主营业务收入」行是 收入 5428 / 支出 2900 —— 两个不同币种被加在同一列。
  // 现在的分解：人民币段 0/2900，美元段 5428/0；两段的数字各自只统计本币种。
  const cny = rows.find((row) => row[0] === "合计" && row[1] === "合计" && row[2] === "人民币");
  const usd = rows.find((row) => row[0] === "合计" && row[1] === "合计" && row[2] === "美元");
  assert.deepEqual(cny, ["合计", "合计", "人民币", 0, 2900]);
  assert.deepEqual(usd, ["合计", "合计", "美元", 5428, 0]);
  assert.equal(rows.some((row) => row[3] === 5428 && row[4] === 2900), false, "不允许出现把两个币种相加的格子");
});

test("finance-report.cash-flow：本期没发生的科目照样列出（写 0），老表的科目清单形态得以保留", async () => {
  const table = buildCashFlowSummaryTable(ITEMS, [], ["CNY"], { currencyLabels: LABELS });
  const { rows } = readSheet(await renderReportWorkbook([table]));
  assert.deepEqual(rows[1], ["资产类", "库存现金（备用金）", "人民币", 0, 0]);
  assert.deepEqual(rows[2], ["资产类", "小计", "人民币", 0, 0]);
  assert.deepEqual(rows[3], ["损益类", "主营业务收入", "人民币", 0, 0]);
  assert.deepEqual(rows[4], ["损益类", "小计", "人民币", 0, 0]);
  assert.deepEqual(rows[5], ["成本类", "房租费", "人民币", 0, 0]);
  assert.deepEqual(rows[6], ["成本类", "小计", "人民币", 0, 0]);
  assert.deepEqual(rows[7], ["合计", "合计", "人民币", 0, 0]);
});

test("finance-report.cash-flow：分类小计只累计本分类，且不与同名「合计」行混淆", async () => {
  const amounts = [
    { subjectId: "subject-2", currency: "USD", income: dec("5428"), expense: dec("428") },
    { subjectId: "subject-3", currency: "USD", income: dec("100"), expense: dec("0") },
  ];
  const table = buildCashFlowSummaryTable(ITEMS, amounts, ["USD"], { currencyLabels: LABELS });
  const { rows } = readSheet(await renderReportWorkbook([table]));
  const subtotals = rows.filter((row) => row[1] === "小计");
  assert.deepEqual(subtotals, [
    ["资产类", "小计", "美元", 0, 0],
    ["损益类", "小计", "美元", 5428, 428],
    ["成本类", "小计", "美元", 100, 0],
  ], "每个分类各一行小计：只累计本分类的科目，且不跨分类相加");
  // 三类小计的合计必须等于币种段末的合计（否则「分类统计」与「币种合计」对不上）
  const total = rows.find((row) => row[0] === "合计" && row[1] === "合计");
  assert.deepEqual(total, ["合计", "合计", "美元", 5528, 428]);
});

test("finance-report.cash-flow：收支汇总表的收入/支出是数值类型，且表尾说明写清「不跨币种相加」与分类小计", async () => {
  const amounts = [{ subjectId: "subject-2", currency: "USD", income: dec("5428"), expense: dec("0") }];
  const table = buildCashFlowSummaryTable(ITEMS, amounts, ["USD"], { currencyLabels: LABELS });
  const { sheet } = readSheet(await renderReportWorkbook([table]));
  assertNoTextNumbers(sheet, "收支汇总");
  assert.equal(sheet.D2.t, "n", "收入列（第 4 列）是数值列");
  assert.equal(table.footnotes.length, 3);
  assert.match(table.footnotes[0], /不跨币种相加/);
  assert.match(table.footnotes[2], /小计/, "分类小计的说明要写进表尾");
  // 7 行数据（3 个科目 + 3 行分类小计 + 1 行合计）→ 表尾说明与正文空一行后落在第 10 行
  assert.match(sheet.A10.v, /不跨币种相加/, "表尾说明要落到导出文件里");
});
