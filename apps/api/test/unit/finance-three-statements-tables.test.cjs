// 三大报表**版式**的测试：列名与列序照标准格式、金额落成 Excel 数值、缺口跟着表尾走。
//
// 与模板的差异只有一处（有意）：资产负债表的段落标题不单独占一行（两栏按行次一一对齐）。
// 「金额必须是数值单元格」是全站导出的硬约束（`finance-report-workbook.ts` 会拒绝字符串型数字），
// 所以这里既断言 ReportTable 的形状，也真渲染一次工作簿、用读取器回读单元格类型。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const ExcelJS = require("exceljs");
const XLSX = require("xlsx");
const {
  buildBalanceSheetTable,
  buildCashFlowStatementTable,
  buildIncomeStatementTable,
  statementFootnotes,
} = require("../../dist/modules/finance/finance-three-statements.tables.js");
const { addReportSheet } = require("../../dist/modules/finance/finance-report-workbook.js");

const gap = (extra = {}) => ({ entriesWithoutVoucher: 0, draftVouchers: 0, otherCurrencies: [], unconverted: [], ...extra });
const line = (row, label, value, extra = {}) => ({ row, label, value, ...extra });

/** 一张最小的资产负债表取数结果（两侧各两行 + 勾稽为 0）。 */
const balanceSheetReport = (extra = {}) => ({
  currency: "CNY",
  period: { to: "2026-09-30", yearStart: "2025-12-31" },
  current: {
    assets: [line(1, "货币资金", 2000000n), line(34, "资产总计", 2000000n)],
    equities: [line(32, "未分配利润", 2000000n), line(34, "负债和所有者权益总计", 2000000n)],
    totalAssets: 2000000n, totalEquities: 2000000n, difference: 0n, balanced: true,
    retainedEarnings: 2000000n, retainedFromProfit: 2000000n, openingDifference: 0n, unmapped: [], notes: ["行次 32 未分配利润：= 利润分配 + 本年利润 + 未结转的损益"],
  },
  yearStartResult: {
    assets: [line(1, "货币资金", 1000000n), line(34, "资产总计", 1000000n)],
    equities: [line(32, "未分配利润", 1000000n), line(34, "负债和所有者权益总计", 1000000n)],
    totalAssets: 1000000n, totalEquities: 1000000n, difference: 0n, balanced: true,
    retainedEarnings: 1000000n, retainedFromProfit: 1000000n, openingDifference: 0n, unmapped: [], notes: [],
  },
  gap: gap(),
  ...extra,
});

test("资产负债表版式：8 列两栏对照、按行次对齐、勾稽核对行在最后，年初列来自年初取数", () => {
  const table = buildBalanceSheetTable(balanceSheetReport());
  assert.deepEqual(table.columns.map((column) => column.header), ["资产", "行次", "期末余额", "年初余额", "负债和所有者权益（或股东权益）", "行次", "期末余额", "年初余额"]);
  assert.equal(table.sheetName, "资产负债表");
  // 两栏按**行次**对齐：每一行都有行次，不会因为某一侧没这一行就错位（夹具是稀疏的，真实数据两侧都是 1..34）。
  for (const row of table.rows.slice(0, -1)) {
    // 两侧都有这一行时行次必须相同（这就是两栏对照的对齐方式）；夹具稀疏时允许只有一侧有行次。
    if (row[1] !== null && row[5] !== null) assert.equal(row[1], row[5]);
    else assert.notEqual(row[1] === null, row[5] === null, "不允许两侧都没有行次");
  }
  const money = table.rows.find((row) => row[0] === "货币资金");
  assert.deepEqual(money.slice(0, 4), ["货币资金", 1, 200, 100], "期末 200（本期）、年初 100（年初取数）");
  const retained = table.rows.find((row) => row[4] === "未分配利润");
  assert.deepEqual(retained.slice(4), ["未分配利润", 32, 200, 100]);
  const check = table.rows.at(-1);
  assert.equal(check[0], "勾稽核对：资产总计 − 负债和所有者权益总计");
  assert.equal(check[2], 0, "勾稽差额 = 资产总计 − 负债和所有者权益总计");
  assert.equal(check[4], "✓ 平衡");
  // 段落标题（「流动资产：」这类）不占行 —— 两栏才不会错位（模板里它们本来就不在同一 Excel 行）。
  assert.equal(table.rows.some((row) => String(row[0]).endsWith("：")), false);
  assert.ok(table.footnotes.some((note) => note.includes("未分配利润")));
});

test("资产负债表版式：不平的时候把原因写在表尾（先看期初余额说明，不是算错了）", () => {
  const report = balanceSheetReport();
  report.current.balanced = false;
  report.current.difference = 500000n;
  report.current.openingDifference = 500000n;
  report.current.notes = ["行次 1 货币资金：含银行账户期初余额"];
  const table = buildBalanceSheetTable(report);
  assert.equal(table.rows.at(-1)[4], "✗ 不平衡");
  assert.ok(table.footnotes.some((note) => note.includes("相差 50") && note.includes("科目期初余额表")));
});

test("利润表 / 现金流量表版式：4 列、段落行不写金额、上期列对齐同一行次", () => {
  const income = buildIncomeStatementTable({
    currency: "CNY",
    period: { from: "2026-09-01", to: "2026-09-30" },
    previousPeriod: { from: "2026-08-01", to: "2026-08-31" },
    current: { lines: [line(null, "一、营业收入", null, { section: true }), line(1, "一、营业收入", 1000000n), line(14, "二、营业利润（亏损以“-”号填列）", 300000n)], operatingProfit: 300000n, totalProfit: 300000n, netProfit: 300000n, unmapped: [], notes: [] },
    previous: { lines: [line(null, "一、营业收入", null, { section: true }), line(1, "一、营业收入", 800000n), line(14, "二、营业利润（亏损以“-”号填列）", 200000n)], operatingProfit: 200000n, totalProfit: 200000n, netProfit: 200000n, unmapped: [], notes: [] },
    gap: gap(),
  });
  assert.deepEqual(income.columns.map((column) => column.header), ["项目", "行次", "本期金额", "上期金额"]);
  assert.equal(income.sheetName, "利润表");
  assert.deepEqual(income.rows[0], ["一、营业收入", null, null, null], "段落行没有金额");
  assert.deepEqual(income.rows[1], ["一、营业收入", 1, 100, 80]);
  assert.deepEqual(income.rows[2], ["二、营业利润（亏损以“-”号填列）", 14, 30, 20]);
  assert.ok(income.footnotes.some((note) => note.includes("期间：2026-09-01 至 2026-09-30")));

  const cash = buildCashFlowStatementTable({
    currency: "CNY",
    period: { from: "2026-09-01", to: "2026-09-30" },
    previousPeriod: { from: "2026-08-01", to: "2026-08-31" },
    current: { lines: [line(10, "经营活动产生的现金流量净额", 100000n)], netIncrease: 100000n, closing: 0n, unmapped: [{ subjectKey: "损益类/某科目", amount: 50000n }], nonCashVouchers: 1, internalTransfers: 2, notes: [] },
    previous: { lines: [line(10, "经营活动产生的现金流量净额", 0n)], netIncrease: 0n, closing: 0n, unmapped: [], nonCashVouchers: 0, internalTransfers: 0, notes: [] },
    cashOpening: 1800000n,
    gap: gap({ otherCurrencies: [{ currency: "USD", count: 2, period: "2026-09" }] }),
  });
  const notes = cash.footnotes.join("\n");
  assert.ok(notes.includes("期初现金及现金等价物余额 180"));
  assert.ok(notes.includes("没有资金分录") && notes.includes("内部划转"));
  assert.ok(notes.includes("认不出落哪一行的对方科目：损益类/某科目（5）"));
  assert.ok(notes.includes("2 张 USD 凭证"));
});

test("三大报表版式：金额落 Excel 数值单元格（文本型数字在 Excel 里 SUM 得 0）", async () => {
  const tables = [
    buildBalanceSheetTable(balanceSheetReport()),
    buildIncomeStatementTable({
      currency: "CNY", period: { from: "2026-09-01", to: "2026-09-30" }, previousPeriod: { from: "2026-08-01", to: "2026-08-31" },
      current: { lines: [line(1, "一、营业收入", 1234567n)], operatingProfit: 0n, totalProfit: 0n, netProfit: 0n, unmapped: [], notes: [] },
      previous: { lines: [line(1, "一、营业收入", 0n)], operatingProfit: 0n, totalProfit: 0n, netProfit: 0n, unmapped: [], notes: [] },
      gap: gap(),
    }),
  ];
  const workbook = new ExcelJS.Workbook();
  for (const table of tables) addReportSheet(workbook, table);
  const buffer = await workbook.xlsx.writeBuffer();
  const read = XLSX.read(buffer, { type: "buffer" });

  const sheet = read.Sheets["资产负债表"];
  assert.equal(sheet.C2.t, "n", "期末余额必须是数值单元格");
  assert.equal(sheet.D2.t, "n", "年初余额同理");
  assert.equal(sheet.C2.v, 200);
  // 段落/空值不写 0，也不写空串（「系统没有这个数据」与「确实是 0」不是一回事）。
  assert.equal(sheet.E7, undefined, "勾稽行的右栏是空的");
});

test("三大报表版式：缺口的表尾文案（未生成凭证 / 草稿 / 已折算 / 未折算外币）一处生成，三张表共用", () => {
  const notes = statementFootnotes(gap({ entriesWithoutVoucher: 3, draftVouchers: 1, otherCurrencies: [{ currency: "USD", count: 2, period: "2026-09" }] }));
  assert.equal(notes.length, 3);
  assert.ok(notes[0].includes("3 条已生效的收支流水"));
  assert.ok(notes[1].includes("1 张草稿凭证"));
  assert.ok(notes[2].includes("2 张 USD 凭证") && notes[2].includes("2026-09 的期末汇率折算"));
  assert.deepEqual(statementFootnotes(gap()), [], "没有缺口就不写废话");

  // 没有汇率的币种**必须**单独报出来：少了它的钱，两侧都少所以勾稽照样平 —— 这是最难发现的一类错。
  const lost = statementFootnotes(gap({ unconverted: [{ currency: "HKD", vouchers: 2, opening: true }] }));
  assert.equal(lost.length, 1);
  assert.ok(lost[0].includes("2 张 HKD 凭证") && lost[0].includes("建账期初") && lost[0].includes("没有维护 HKD 的期末汇率"));
});
