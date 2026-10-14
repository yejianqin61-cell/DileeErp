// 记账凭证导出（`voucher-workbook.ts`，2026-10-13）。
//
// 用户原话：「财务模块，记账凭证中，摘要也要一并导出。」
//
// 这一条最容易做歪的地方是**粒度**：摘要与会计科目是**分录行**上的字段，凭证头上只有一个总摘要 ——
// 一行一张凭证的导出表里，"这笔钱记到什么科目、凭什么"就看不见了。所以本文件的中心断言是
// 「一行一条分录」，其次是摘要的取值（分录行没写就回退凭证总摘要，与页面/PNG 同一口径）。
//
// 生产文件：apps/api/src/modules/finance/voucher-workbook.ts
// 入口：GET /api/v1/finance/vouchers/export.xlsx（voucher.controller.ts）
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { Prisma } = require("@prisma/client");
const { buildVoucherExportTable, VOUCHER_EXPORT_COLUMNS } = require("../../dist/modules/finance/voucher-workbook.js");

/** 一张两行分录（借成本 / 贷应付账款）的凭证。 */
const voucher = (overrides = {}) => ({
  voucherNo: "记-2026-10-0001",
  voucherDate: new Date("2026-10-13T00:00:00.000Z"),
  period: "2026-10",
  statusLabel: "已过账",
  sourceLabel: "收支流水 CF-20261013-0001",
  summary: "支付晋江大田涤纶布款",
  currency: "CNY",
  remark: null,
  lines: [
    { lineNo: 1, summary: "支付晋江大田涤纶布款", subjectLabel: "主营业务成本", direction: "debit", amount: new Prisma.Decimal("2900.0000") },
    { lineNo: 2, summary: "支付晋江大田涤纶布款", subjectLabel: "应付账款", direction: "credit", amount: new Prisma.Decimal("2900.0000") },
  ],
  ...overrides,
});

test("列定义：摘要与会计科目都在（用户点名的那一列不能少）", () => {
  const headers = VOUCHER_EXPORT_COLUMNS.map((column) => column.header);
  assert.deepEqual(headers, ["凭证号", "日期", "期间", "状态", "来源", "行号", "摘要", "会计科目", "借方金额", "贷方金额", "币种", "备注"]);
  assert.ok(headers.includes("摘要"));
  // 摘要紧跟行号、在会计科目之前；金额分借贷两列（照凭证纸）
  assert.equal(headers[headers.indexOf("行号") + 1], "摘要");
  // 金额列必须是数值列：导出到 Excel 后要能被求和/筛选，文本型数字会混进筛选
  for (const header of ["借方金额", "贷方金额"]) {
    assert.ok(VOUCHER_EXPORT_COLUMNS.find((column) => column.header === header).numFmt, `${header} 要落数值类型`);
  }
});

test("一行一条分录：两张凭证三行分录 → 导出三行，且每行都带得到自己的摘要与科目", () => {
  const table = buildVoucherExportTable([
    voucher(),
    voucher({
      voucherNo: "记-2026-10-0002",
      summary: "计提 10 月工资",
      sourceLabel: "手工",
      lines: [{ lineNo: 1, summary: "计提 10 月工资", subjectLabel: "生产成本", direction: "debit", amount: new Prisma.Decimal("800.0000") }],
    }),
  ]);

  assert.equal(table.sheetName, "记账凭证");
  assert.equal(table.rows.length, 3, "两张凭证 2 + 1 行分录 = 3 行");
  assert.deepEqual(table.rows[0], ["记-2026-10-0001", "2026-10-13", "2026-10", "已过账", "收支流水 CF-20261013-0001", 1, "支付晋江大田涤纶布款", "主营业务成本", 2900, null, "CNY", ""]);
  // 贷方那一行：借方为空单元格（与凭证纸一致；写 0 会被读成「确实借了 0」）
  assert.deepEqual(table.rows[1], ["记-2026-10-0001", "2026-10-13", "2026-10", "已过账", "收支流水 CF-20261013-0001", 2, "支付晋江大田涤纶布款", "应付账款", null, 2900, "CNY", ""]);
  assert.equal(table.rows[2][0], "记-2026-10-0002", "第二张凭证的行在后面");
  assert.equal(table.rows[2][5], 1, "行号是分录自己的行号");
});

test("摘要取**分录行**上的那一个；分录没写才回退凭证总摘要（与凭证纸/导出 PNG 同一口径）", () => {
  const table = buildVoucherExportTable([voucher({
    summary: "凭证总摘要",
    lines: [
      { lineNo: 1, summary: "支付涤纶布款", subjectLabel: "主营业务成本", direction: "debit", amount: "100.0000" },
      { lineNo: 2, summary: "", subjectLabel: "应付账款", direction: "credit", amount: "100.0000" },
      { lineNo: 3, summary: null, subjectLabel: "银行存款", direction: "credit", amount: "100.0000" },
    ],
  })]);

  assert.equal(table.rows[0][6], "支付涤纶布款", "这一行自己写了摘要就用自己的");
  assert.equal(table.rows[1][6], "凭证总摘要", "没写（空串）→ 回退凭证总摘要，不能留空");
  assert.equal(table.rows[2][6], "凭证总摘要", "null 同样回退");
});

test("金额：字符串/Decimal 都落成数值；不设合计列（一列里可能混着多个币种）", () => {
  const table = buildVoucherExportTable([voucher({
    lines: [
      { lineNo: 1, summary: "s", subjectLabel: "原材料", direction: "debit", amount: "1,234.5600" },
      { lineNo: 2, summary: "s", subjectLabel: "应付账款", direction: "credit", amount: new Prisma.Decimal("1234.5600") },
    ],
  })]);

  assert.equal(table.rows[0][8], 1234.56, "千分位字符串也要落成数值");
  assert.equal(typeof table.rows[0][8], "number");
  assert.equal(table.rows[1][9], 1234.56);
  assert.equal(table.totalColumns, undefined, "本表不给合计列：币种可能混在一起，跨币种相加没有意义");
});

test("没有任何分录的凭证也要占一行（清单里有、导出里没有 = 看起来像漏了）", () => {
  const table = buildVoucherExportTable([voucher({ voucherNo: "记-2026-10-0003", lines: [] })]);

  assert.equal(table.rows.length, 1, "给一行空分录，而不是整张凭证消失");
  assert.equal(table.rows[0][0], "记-2026-10-0003");
  assert.equal(table.rows[0][6], "支付晋江大田涤纶布款", "摘要列写凭证总摘要，至少认得出是哪张");
  assert.equal(table.rows[0][5], null, "行号留空（它没有分录行号）");
});

test("表尾说明写清三件事：粒度、空白的一边、为什么不给合计", () => {
  const notes = buildVoucherExportTable([]).footnotes.join("\n");
  assert.match(notes, /一行一条分录/);
  assert.match(notes, /空单元格/);
  assert.match(notes, /跨币种相加/);
});
