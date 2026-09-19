// 外汇一览表（`example/财务/外汇一览表.xlsx`）测试：
//   1) 纯版式构造 —— 列名列序、定金/货款/其他三列的分桶、是否完结、汇总表按币种分段；
//   2) 取数与归属 —— 一笔收款只在表里出现一次、由确认应收写入的流水精确挂到它自己的出库、
//      订单级收款退化成「最早那次出库」、归不到的必须进表尾而不是被静默丢掉。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const XLSX = require("xlsx");
const { Prisma } = require("@prisma/client");
const {
  FOREX_DETAIL_COLUMNS,
  FOREX_SUMMARY_COLUMNS,
  buildForexCustomerSummaryTable,
  buildForexDetailTable,
  forexOutstanding,
  forexSettlement,
  forexUnattributedFootnotes,
} = require("../../dist/modules/finance/finance-report-forex.tables.js");
const { FinanceReportQueryService, MAX_REPORT_ROWS } = require("../../dist/modules/finance/finance-report-query.service.js");
const { renderReportWorkbook } = require("../../dist/modules/finance/finance-report-workbook.js");

const dec = (value) => new Prisma.Decimal(value);
const LABELS = new Map([["USD", "美元"], ["CNY", "人民币"]]);

/** 一行明细的样本（默认：一次出库，期间内收到一笔货款）。 */
function row(overrides = {}) {
  const amount = overrides.amount ?? dec("3100");
  const receivedToDate = overrides.receivedToDate ?? dec("2790");
  return {
    customerName: "中谷",
    currency: "USD",
    orderNo: "DL260002",
    orderQuantity: dec("300"),
    shipmentDate: new Date("2026-05-11T00:00:00.000Z"),
    outboundNo: "OUT-1",
    quantity: dec("100"),
    unit: "打",
    unitPrice: dec("31"),
    amount,
    depositDate: null,
    depositAmount: dec("0"),
    balanceDate: new Date("2026-05-20T00:00:00.000Z"),
    balanceAmount: dec("2790"),
    otherAmount: dec("0"),
    receivedAmount: dec("2790"),
    receivedToDate,
    outstanding: forexOutstanding(amount, receivedToDate),
    remark: null,
    ...overrides,
  };
}

function readWorkbook(buffer) {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const name = workbook.SheetNames[0];
  return { workbook, name, sheet: workbook.Sheets[name], rows: XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, raw: true, defval: null, blankrows: true }) };
}

// ------------------------------------------------------------------ 纯版式

test("外汇明细表：21 列，跟单与银行手续费照老表保留但恒空", () => {
  assert.deepEqual(FOREX_DETAIL_COLUMNS.map((column) => column.header), [
    "客户", "币种", "订单号", "订单数量", "跟单", "出货日期", "单位", "出货数量", "单价", "货款金额",
    "定金日期", "定金金额", "货款日期", "货款金额", "其他到账", "汇入总金额", "银行手续费", "实到账金额",
    "欠尾款", "是否完结", "备注",
  ]);
  // 「跟单」是老表的列，系统没有字段；这里必须是**文本列**（没给 numFmt），
  // 否则渲染层会要求和数字，一张空表都导不出来。
  assert.equal(FOREX_DETAIL_COLUMNS[4].numFmt, undefined, "跟单是文本列");
  assert.ok(FOREX_DETAIL_COLUMNS[16].numFmt, "银行手续费是数值列（将来加了字段能直接落数）");
});

test("外汇明细表：汇入总金额 = 定金 + 货款 + 其他，三列一定加得起来", () => {
  const table = buildForexDetailTable([row({
    depositDate: new Date("2026-05-16T00:00:00.000Z"), depositAmount: dec("620"),
    balanceDate: new Date("2026-05-20T00:00:00.000Z"), balanceAmount: dec("2400"),
    otherAmount: dec("80"), receivedAmount: dec("3100"), receivedToDate: dec("3100"),
  })], { currencyLabels: LABELS });
  const cells = table.rows[0];
  assert.equal(cells[11], 620, "定金金额");
  assert.equal(cells[13], 2400, "货款金额");
  assert.equal(cells[14], 80, "其他到账");
  assert.equal(cells[15], 3100, "汇入总金额");
  assert.equal(cells[15], cells[11] + cells[13] + cells[14], "汇入总金额必须等于三列之和");
});

test("外汇明细表：期间内没有的收款写空单元格而不是 0（0 是「确实为零」的事实）", () => {
  const table = buildForexDetailTable([row({ depositDate: null, depositAmount: dec("0"), otherAmount: dec("0") })], { currencyLabels: LABELS });
  assert.equal(table.rows[0][10], null, "定金日期空");
  assert.equal(table.rows[0][11], null, "定金金额空（不是 0）");
  assert.equal(table.rows[0][14], null, "其他到账空");
});

test("外汇明细表：实到账金额 = 汇入总金额（手续费无字段，所以未扣），跟单恒空", () => {
  const table = buildForexDetailTable([row({ receivedAmount: dec("2790") })], { currencyLabels: LABELS });
  assert.equal(table.rows[0][4], null, "跟单：系统无此字段");
  assert.equal(table.rows[0][16], null, "银行手续费：系统无此字段");
  assert.equal(table.rows[0][17], 2790, "实到账金额 = 汇入总金额 − 0");
  assert.match(table.footnotes.join("\n"), /跟单.*银行手续费.*没有字段/, "表尾必须写清哪两列是空的、为什么");
});

test("外汇明细表：不设合计列 —— 本表一行一个币种，跨币种相加没有意义", () => {
  const table = buildForexDetailTable([row(), row({ currency: "CNY", amount: dec("1005") })], { currencyLabels: LABELS });
  assert.equal(table.totalColumns, undefined);
  assert.match(table.footnotes.join("\n"), /按币种分行、不跨币种相加/, "页面上没有合计行，必须在表尾说清为什么");
});

test("是否完结：一分没收到 / 收清了 / 收了一部分，三种取值分得开", () => {
  assert.equal(forexSettlement(dec("3100"), dec("0")), "未收款", "一分没收到——催款动作与「收了一部分」不同");
  assert.equal(forexSettlement(dec("0"), dec("3100")), "结清");
  assert.equal(forexSettlement(dec("310"), dec("2790")), "未结清");
  // 超收（不该发生）不隐藏：欠尾款为负、仍算结清，让财务自己看出异常。
  assert.equal(forexSettlement(dec("-10"), dec("3110")), "结清");
});

test("客户汇总：按币种分段，一行一个客户 + 段末合计，段内绝不跨币种相加", () => {
  const table = buildForexCustomerSummaryTable([
    row({ customerName: "中谷", currency: "USD", receivedAmount: dec("2790"), receivedToDate: dec("2790"), outstanding: dec("310") }),
    row({ customerName: "中谷", currency: "CNY", amount: dec("1005"), receivedAmount: dec("1005"), receivedToDate: dec("1005"), outstanding: dec("0"), balanceAmount: dec("1005") }),
    row({ customerName: "家百纳", currency: "USD", receivedAmount: dec("500"), receivedToDate: dec("500"), outstanding: dec("0") }),
  ], { currencyLabels: LABELS });
  assert.equal(table.sheetName, "客户汇总");
  assert.equal(table.totalColumns, undefined, "合计已在每个币种段末给出，不再让渲染层全表求和");
  const customerNames = table.rows.map((cells) => cells[0]);
  assert.deepEqual(customerNames, ["中谷", "合计", "中谷", "家百纳", "合计"], "CNY 一段（1 客户）、USD 一段（2 客户），各段自己合计");
  const cnyTotal = table.rows[1];
  assert.equal(cnyTotal[1], "人民币");
  assert.equal(cnyTotal[7], 1005, "人民币段的合计只统计人民币");
  const usdTotal = table.rows[4];
  assert.equal(usdTotal[1], "美元");
  assert.equal(usdTotal[7], 3290, "美元段合计 = 2790 + 500，不含人民币那 1005");
});

test("客户汇总：订单数/出库数去重，已完结/未完结按订单计", () => {
  const table = buildForexCustomerSummaryTable([
    // 同一张订单分两次出库：订单数 1、出库数 2；两行都结清 → 已完结 1。
    row({ orderNo: "DL1", outboundNo: "OUT-1", outstanding: dec("0"), receivedToDate: dec("3100") }),
    row({ orderNo: "DL1", outboundNo: "OUT-2", outstanding: dec("0"), receivedToDate: dec("3100") }),
    // 另一张订单只收了一部分 → 未完结 1。
    row({ orderNo: "DL2", outboundNo: "OUT-3", outstanding: dec("310"), receivedToDate: dec("2790") }),
  ], { currencyLabels: LABELS });
  const customer = table.rows[0];
  assert.equal(customer[2], 2, "订单数按订单号去重");
  assert.equal(customer[3], 3, "出库数按出库行");
  assert.equal(customer[11], 1, "已完结订单数");
  assert.equal(customer[12], 1, "未完结订单数");
});

test("客户汇总：混合币种时表尾也要说清「不跨币种相加」", () => {
  const table = buildForexCustomerSummaryTable([row(), row({ currency: "CNY" })], { currencyLabels: LABELS });
  assert.match(table.footnotes.join("\n"), /不跨币种相加/);
});

test("归不到的收款：按原因分类、按币种给金额、列出订单号/流水号、超过 10 笔折叠", () => {
  const many = Array.from({ length: 13 }, (_, index) => ({
    entryNo: `CF-${index}`, entryDate: new Date("2026-05-01T00:00:00.000Z"),
    amount: dec("100"), currency: "USD", orderNo: `DL-${index}`,
  }));
  const lines = forexUnattributedFootnotes({
    reconciliation: [{ entryNo: "CF-R", entryDate: new Date("2026-05-02T00:00:00.000Z"), amount: dec("500"), currency: "USD", orderNo: "REC-1" }],
    no_outbound: many,
    no_order: [{ entryNo: "CF-N", entryDate: new Date("2026-05-03T00:00:00.000Z"), amount: dec("700"), currency: "CNY", orderNo: null }],
    currency_mismatch: [],
  });
  assert.equal(lines.length, 3, "空的那一类不出行");
  assert.match(lines[0], /1 笔到账（合计 500.00 USD）.*对账单/);
  assert.match(lines[1], /13 笔到账（合计 1300.00 USD）.*订单还没有成品出库/);
  assert.match(lines[1], /另有 3 笔未列出/, "13 笔只列 10 个标识符，其余折叠成条数");
  assert.match(lines[2], /流水 CF-N/, "没有订单号时用流水号定位");
});

test("客户汇总为空时不报错（期间内没有任何到账）", () => {
  const table = buildForexCustomerSummaryTable([], { currencyLabels: LABELS });
  assert.deepEqual(table.rows, []);
});

test("外汇两张表渲染成工作簿：金额列落 Excel 数值类型，两张表在同一个文件里", async () => {
  const detail = buildForexDetailTable([row()], { currencyLabels: LABELS });
  const summary = buildForexCustomerSummaryTable([row()], { currencyLabels: LABELS });
  const buffer = await renderReportWorkbook([detail, summary]);
  const workbook = XLSX.read(buffer, { type: "buffer" });
  assert.deepEqual(workbook.SheetNames, ["外汇一览", "客户汇总"]);
  const sheet = workbook.Sheets["外汇一览"];
  // 列字母 → 含义：D 订单数量 / H 出货数量 / I 单价 / J 货款金额 / L 定金金额 /
  // N 货款金额 / O 其他到账 / P 汇入总金额 / R 实到账金额 / S 欠尾款。
  // 老表这些格全是文本型数字（SUM 得 0），所以逐格钉死类型。
  for (const cell of ["D2", "H2", "I2", "J2", "N2", "P2", "R2", "S2"]) {
    assert.equal(typeof sheet[cell].v, "number", `${cell} 必须是数值类型（老表全是文本型数字，SUM 得 0）`);
  }
  assert.equal(typeof sheet.F2.v, "string", "F 是出货日期，仍是文本列");
  assert.equal(sheet.E2, undefined, "跟单列没有值时是空单元格，不写 0、也不写字符串");
  assert.equal(sheet.Q2, undefined, "银行手续费同理：空单元格");
});

test("外汇表在 0 明细时只写表头，不写合计行（表尾说明照旧）", async () => {
  const table = buildForexDetailTable([], { currencyLabels: LABELS });
  const { sheet, rows } = readWorkbook(await renderReportWorkbook([table]));
  assert.deepEqual(rows[0], FOREX_DETAIL_COLUMNS.map((column) => column.header), "第 1 行是表头");
  assert.equal(sheet.A2, undefined, "第 2 行没有数据");
  // 表尾说明从第 3 行开始（无数据行、无合计行）—— 说明里有「跟单/银行手续费恒空」这类
  // 必须让人看到的话，所以「空表」指的是没有数据行，不是整个文件只有一行。
  assert.match(sheet.A3.v, /不跨币种相加/);
  assert.equal(table.totalColumns, undefined);
});

// ------------------------------------------------------------------ 取数与归属

const OUT_1 = {
  id: "src-1", outboundId: "out-1", orderNo: "DL260002", currency: "USD", amount: dec("3100"),
  unitPrice: dec("31"), unit: "打", remark: null,
  customer: { id: "c-1", name: "中谷" },
  outbound: { outboundNo: "OUT-1", shipmentDate: new Date("2026-05-11T00:00:00.000Z"), quantity: dec("100") },
  salesOrder: { quantity: dec("300"), customerId: "c-1" },
};
const OUT_2 = {
  ...OUT_1,
  id: "src-2", outboundId: "out-2",
  outbound: { outboundNo: "OUT-2", shipmentDate: new Date("2026-05-15T00:00:00.000Z"), quantity: dec("100") },
};
const OUT_OTHER_CUSTOMER = {
  ...OUT_1,
  id: "src-3", outboundId: "out-3", orderNo: "DL260003",
  customer: { id: "c-2", name: "家百纳" },
  outbound: { outboundNo: "OUT-3", shipmentDate: new Date("2026-05-12T00:00:00.000Z"), quantity: dec("50") },
};

/**
 * 外汇取数的假 Prisma。
 *
 * `receivableSource.findMany` 会被调用两次，形状不同：一次按 `id in`（追来源），
 * 一次按 `orderNo in`（取该订单的出库候选）。靠 where 上有没有 `id` 区分，
 * 而不是靠调用次序 —— 靠次序的假实现会在真实代码调整查询顺序时静默给出错数据。
 */
function forexPrisma({ entries = [], sources = [], reconciliations = [], orders = [] } = {}) {
  const calls = { cashFlowEntry: [], receivableSource: [], receivableReconciliation: [], salesOrder: [] };
  const prisma = {
    cashFlowEntry: {
      findMany: async (args) => {
        calls.cashFlowEntry.push(args);
        const where = args.where;
        const orderNos = where.OR?.find((clause) => clause.orderNo)?.orderNo?.in;
        const sourceIds = where.OR?.find((clause) => clause.sourceId)?.sourceId?.in;
        return entries.filter((entry) => {
          const range = where.entryDate;
          if (range?.gte && entry.entryDate < range.gte) return false;
          if (range?.lte && entry.entryDate > range.lte) return false;
          if (!orderNos && !sourceIds) return true;
          if (orderNos?.includes(entry.orderNo)) return true;
          return Boolean(sourceIds?.includes(entry.sourceId));
        });
      },
    },
    receivableSource: {
      findMany: async (args) => {
        calls.receivableSource.push(args);
        if (args.where.id) return sources.filter((source) => args.where.id.in.includes(source.id));
        return sources.filter((source) => args.where.orderNo.in.includes(source.orderNo));
      },
    },
    receivableReconciliation: {
      findMany: async (args) => {
        calls.receivableReconciliation.push(args);
        return reconciliations.filter((item) => args.where.id.in.includes(item.id));
      },
    },
    salesOrder: {
      findMany: async (args) => {
        calls.salesOrder.push(args);
        return orders.filter((order) => args.where.orderNo.in.includes(order.orderNo));
      },
    },
  };
  return { prisma, calls };
}

const entry = (overrides) => ({
  id: overrides.id ?? overrides.entryNo, entryNo: overrides.entryNo, entryDate: overrides.entryDate,
  amount: overrides.amount, currency: overrides.currency ?? "USD", paymentNature: overrides.paymentNature ?? null,
  orderNo: overrides.orderNo ?? null, sourceType: overrides.sourceType ?? null, sourceId: overrides.sourceId ?? null,
});

const QUERY = { from: "2026-05-01", to: "2026-05-31" };

test("外汇取数：确认应收写入的流水精确挂到它自己那一次出库，不会堆到第一次出货上", async () => {
  // src-2 是同一订单的**第二次**出库；它的货款必须落在 OUT-2 那一行。
  const { prisma } = forexPrisma({
    entries: [entry({ entryNo: "CF-1", entryDate: new Date("2026-05-20T00:00:00.000Z"), amount: dec("2790"), paymentNature: "balance", orderNo: "DL260002", sourceType: "receivable_source", sourceId: "src-2" })],
    sources: [OUT_1, OUT_2],
    orders: [{ orderNo: "DL260002", customerId: "c-1" }],
  });
  const { rows } = await new FinanceReportQueryService(prisma).forexReceipts(QUERY);
  assert.equal(rows.length, 1, "只有收到钱的那次出库成行");
  assert.equal(rows[0].outboundNo, "OUT-2");
  assert.equal(rows[0].balanceAmount.toFixed(2), "2790.00");
  assert.equal(rows[0].outstanding.toFixed(2), "310.00", "欠尾款 = 3100 − 2790");
  assert.equal(rows[0].depositAmount.toFixed(2), "0.00");
});

test("外汇取数：订单级收款（出货前收到的定金）归到该订单出货日期最早的那次出库", async () => {
  const { prisma } = forexPrisma({
    entries: [
      entry({ entryNo: "CF-DEP", entryDate: new Date("2026-05-16T00:00:00.000Z"), amount: dec("620"), paymentNature: "deposit", orderNo: "DL260002" }),
      entry({ entryNo: "CF-BAL", entryDate: new Date("2026-05-20T00:00:00.000Z"), amount: dec("2480"), paymentNature: "balance", sourceType: "receivable_source", sourceId: "src-2" }),
    ],
    sources: [OUT_1, OUT_2],
    orders: [{ orderNo: "DL260002", customerId: "c-1" }],
  });
  const { rows } = await new FinanceReportQueryService(prisma).forexReceipts(QUERY);
  const earliest = rows.find((item) => item.outboundNo === "OUT-1");
  const later = rows.find((item) => item.outboundNo === "OUT-2");
  assert.equal(earliest.depositAmount.toFixed(2), "620.00", "定金只出现在最早那次出库上");
  assert.equal(later.depositAmount.toFixed(2), "0.00", "后面那次出库不重复计定金");
  assert.equal(earliest.receivedAmount.toFixed(2), "620.00");
  assert.equal(later.receivedAmount.toFixed(2), "2480.00");
  assert.equal(earliest.outstanding.plus(later.outstanding).toFixed(2), "3100.00", "两次出库欠尾款合计 = 6200 − 3100");
});

test("外汇取数：期间外的收款只进累计已收，不让那一行出现在本期表里", async () => {
  const { prisma } = forexPrisma({
    entries: [
      // 4 月收到的定金：本期（5 月）不该让它成行，但算欠尾款时要算上。
      entry({ entryNo: "CF-OLD", entryDate: new Date("2026-04-10T00:00:00.000Z"), amount: dec("1000"), paymentNature: "deposit", orderNo: "DL260002" }),
      entry({ entryNo: "CF-NEW", entryDate: new Date("2026-05-20T00:00:00.000Z"), amount: dec("1000"), paymentNature: "balance", sourceType: "receivable_source", sourceId: "src-2" }),
    ],
    sources: [OUT_1, OUT_2],
    orders: [{ orderNo: "DL260002", customerId: "c-1" }],
  });
  const { rows } = await new FinanceReportQueryService(prisma).forexReceipts(QUERY);
  assert.equal(rows.length, 1, "只有本期收到钱的那次出库成行");
  assert.equal(rows[0].outboundNo, "OUT-2", "4 月那笔定金挂在 OUT-1 上，OUT-1 本期没有到账 → 不成行");
  assert.equal(rows[0].receivedAmount.toFixed(2), "1000.00", "本期到账只算本期这笔");
  assert.equal(rows[0].receivedToDate.toFixed(2), "1000.00");
});

test("外汇取数：期间只按收款日期卡，出库日期在期间外不影响准入", async () => {
  const { prisma } = forexPrisma({
    entries: [entry({ entryNo: "CF-1", entryDate: new Date("2026-05-20T00:00:00.000Z"), amount: dec("500"), sourceType: "receivable_source", sourceId: "src-2" })],
    // 出库在 3 月、钱 5 月到 —— 老表标题是「外汇入款一览表」，就该出现在 5 月这一段。
    sources: [{ ...OUT_2, outbound: { ...OUT_2.outbound, shipmentDate: new Date("2026-03-01T00:00:00.000Z") } }],
    orders: [{ orderNo: "DL260002", customerId: "c-1" }],
  });
  const { rows } = await new FinanceReportQueryService(prisma).forexReceipts(QUERY);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].shipmentDate.toISOString().slice(0, 10), "2026-03-01");
});

test("外汇取数：按对账单一键确认的流水归不到具体出库 → 进表尾而不是静默丢掉", async () => {
  const { prisma } = forexPrisma({
    entries: [entry({ entryNo: "CF-REC", entryDate: new Date("2026-05-20T00:00:00.000Z"), amount: dec("900"), sourceType: "receivable_reconciliation", sourceId: "rec-1" })],
    sources: [OUT_1],
    reconciliations: [{ id: "rec-1", orderNo: null, customerId: "c-1" }],
    orders: [{ orderNo: "DL260002", customerId: "c-1" }],
  });
  const { rows, footnotes } = await new FinanceReportQueryService(prisma).forexReceipts(QUERY);
  assert.deepEqual(rows, [], "一条流水覆盖多张出库单，拆不出来就一行都不猜");
  assert.match(footnotes.join("\n"), /按对账单一键确认应收/);
  assert.match(footnotes.join("\n"), /900\.00 USD/, "金额不能丢：表尾要报出这几笔是多少钱");
});

test("外汇取数：订单还没出货 / 没填订单号 / 币种不一致，三种漏项分别说明", async () => {
  const { prisma } = forexPrisma({
    entries: [
      entry({ entryNo: "CF-A", entryDate: new Date("2026-05-01T00:00:00.000Z"), amount: dec("100"), orderNo: "DL-NOSHIP" }),
      entry({ entryNo: "CF-B", entryDate: new Date("2026-05-02T00:00:00.000Z"), amount: dec("200") }),
      entry({ entryNo: "CF-C", entryDate: new Date("2026-05-03T00:00:00.000Z"), amount: dec("300"), currency: "CNY", sourceType: "receivable_source", sourceId: "src-1" }),
    ],
    sources: [OUT_1],
    orders: [{ orderNo: "DL260002", customerId: "c-1" }, { orderNo: "DL-NOSHIP", customerId: "c-1" }],
  });
  const { rows, footnotes } = await new FinanceReportQueryService(prisma).forexReceipts(QUERY);
  assert.deepEqual(rows, [], "三种都归不到位，一行都不该出来");
  const text = footnotes.join("\n");
  assert.match(text, /订单还没有成品出库/);
  assert.match(text, /流水上没有订单号/);
  assert.match(text, /币种不一致/);
  assert.match(text, /不含在汇入总金额里/, "必须写明这些钱没算进表里的合计，否则财务会以为账平了");
});

test("外汇取数：没有订单号的流水按来源反查订单号（历史流水也要救回来）", async () => {
  const { prisma } = forexPrisma({
    // 流水自己没填 orderNo（这一列 2026-09-17 才有），但挂着确认应收的来源。
    entries: [entry({ entryNo: "CF-LEGACY", entryDate: new Date("2026-05-20T00:00:00.000Z"), amount: dec("2790"), sourceType: "receivable_source", sourceId: "src-2" })],
    sources: [OUT_1, OUT_2],
    orders: [{ orderNo: "DL260002", customerId: "c-1" }],
  });
  const { rows, footnotes } = await new FinanceReportQueryService(prisma).forexReceipts(QUERY);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].outboundNo, "OUT-2");
  assert.deepEqual(footnotes, []);
});

test("外汇取数：客户筛选按反查出来的客户生效，表尾漏项也一起筛", async () => {
  const { prisma } = forexPrisma({
    entries: [
      entry({ entryNo: "CF-1", entryDate: new Date("2026-05-20T00:00:00.000Z"), amount: dec("2790"), sourceType: "receivable_source", sourceId: "src-2" }),
      entry({ entryNo: "CF-2", entryDate: new Date("2026-05-21T00:00:00.000Z"), amount: dec("500"), sourceType: "receivable_source", sourceId: "src-3" }),
      entry({ entryNo: "CF-3", entryDate: new Date("2026-05-22T00:00:00.000Z"), amount: dec("50"), orderNo: "DL-NOSHIP" }),
    ],
    sources: [OUT_1, OUT_2, OUT_OTHER_CUSTOMER],
    orders: [{ orderNo: "DL260002", customerId: "c-1" }, { orderNo: "DL260003", customerId: "c-2" }, { orderNo: "DL-NOSHIP", customerId: "c-2" }],
  });
  const { rows, footnotes } = await new FinanceReportQueryService(prisma).forexReceipts({ ...QUERY, customerId: "c-1" });
  assert.deepEqual(rows.map((item) => item.customerName), ["中谷"]);
  assert.deepEqual(footnotes, [], "筛客户 A 时不该报客户 B 的漏项（否则财务会去追一笔不属于这个客户的钱）");
});

test("外汇取数：没有订单号且筛了客户时整条排除（无从判断属不属于这个客户）", async () => {
  const { prisma } = forexPrisma({
    entries: [entry({ entryNo: "CF-NO", entryDate: new Date("2026-05-01T00:00:00.000Z"), amount: dec("100") })],
    sources: [], orders: [],
  });
  const { rows, footnotes } = await new FinanceReportQueryService(prisma).forexReceipts({ ...QUERY, customerId: "c-1" });
  assert.deepEqual(rows, []);
  assert.deepEqual(footnotes, []);
});

test("外汇取数：一行排序按客户 → 出货日期 → 出库单号（用户要的是「按客户收束」）", async () => {
  const { prisma } = forexPrisma({
    entries: [
      entry({ entryNo: "CF-1", entryDate: new Date("2026-05-20T00:00:00.000Z"), amount: dec("100"), sourceType: "receivable_source", sourceId: "src-1" }),
      entry({ entryNo: "CF-2", entryDate: new Date("2026-05-20T00:00:00.000Z"), amount: dec("100"), sourceType: "receivable_source", sourceId: "src-2" }),
      entry({ entryNo: "CF-3", entryDate: new Date("2026-05-20T00:00:00.000Z"), amount: dec("100"), sourceType: "receivable_source", sourceId: "src-3" }),
    ],
    sources: [OUT_2, OUT_OTHER_CUSTOMER, OUT_1],
    orders: [{ orderNo: "DL260002", customerId: "c-1" }, { orderNo: "DL260003", customerId: "c-2" }],
  });
  const { rows } = await new FinanceReportQueryService(prisma).forexReceipts(QUERY);
  // 中文按拼音排序（家 jia < 中 zhong）——钱是按客户收束看的，所以客户名是第一关键字；
  // 同一客户内按出货日期、再按出库单号，保证同一份数据两次导出顺序一致。
  assert.deepEqual(rows.map((item) => item.customerName), ["家百纳", "中谷", "中谷"]);
  assert.deepEqual(rows.map((item) => item.outboundNo), ["OUT-3", "OUT-1", "OUT-2"]);
});

test("外汇取数：期间内一条收入流水都没有时直接返回空，不打后面的查询", async () => {
  const { prisma, calls } = forexPrisma({ entries: [], sources: [OUT_1] });
  const result = await new FinanceReportQueryService(prisma).forexReceipts(QUERY);
  assert.deepEqual(result, { rows: [], footnotes: [] });
  assert.equal(calls.receivableSource.length, 0, "没有流水就不该去读来源表");
});

test("外汇取数：只取生效中的收入流水，支出与已冲销不参与", async () => {
  const { prisma, calls } = forexPrisma({ entries: [] });
  await new FinanceReportQueryService(prisma).forexReceipts(QUERY);
  assert.equal(calls.cashFlowEntry[0].where.status, "posted");
  assert.equal(calls.cashFlowEntry[0].where.direction, "income");
  assert.equal(calls.cashFlowEntry[0].where.deletedAt, null);
});

test("外汇取数：候选收款的上界是「期间末」而不是整段期间（算累计已收必须能看见期间内的钱）", async () => {
  const { prisma, calls } = forexPrisma({
    entries: [entry({ entryNo: "CF-1", entryDate: new Date("2026-05-20T00:00:00.000Z"), amount: dec("100"), sourceType: "receivable_source", sourceId: "src-1" })],
    sources: [OUT_1], orders: [{ orderNo: "DL260002", customerId: "c-1" }],
  });
  await new FinanceReportQueryService(prisma).forexReceipts(QUERY);
  assert.equal(calls.cashFlowEntry.length, 2, "先按完整期间找线索，再按「截至期间末」取候选");
  const seedRange = calls.cashFlowEntry[0].where.entryDate;
  assert.equal(seedRange.gte.toISOString(), "2026-05-01T00:00:00.000Z");
  const candidateRange = calls.cashFlowEntry[1].where.entryDate;
  assert.equal(candidateRange.gte, undefined, "候选不带下界：期间前收到的钱也要算进累计已收");
  assert.equal(candidateRange.lte.toISOString(), "2026-05-31T23:59:59.999Z");
});

test("外汇取数：行数上限仍然生效（超出必须报错，不能静默截断）", async () => {
  const entries = [];
  const sources = [];
  for (let index = 0; index < MAX_REPORT_ROWS + 1; index += 1) {
    sources.push({
      ...OUT_1,
      id: `src-${index}`,
      outboundId: `out-${index}`,
      outbound: { outboundNo: `OUT-${index}`, shipmentDate: new Date("2026-05-11T00:00:00.000Z"), quantity: dec("1") },
    });
    entries.push(entry({ entryNo: `CF-${index}`, entryDate: new Date("2026-05-20T00:00:00.000Z"), amount: dec("1"), sourceType: "receivable_source", sourceId: `src-${index}` }));
  }
  const { prisma } = forexPrisma({ entries, sources, orders: [{ orderNo: "DL260002", customerId: "c-1" }] });
  await assert.rejects(
    () => new FinanceReportQueryService(prisma).forexReceipts(QUERY),
    (error) => error.response?.code === "REPORT_TOO_LARGE",
  );
});

test("外汇汇总表：列定义与明细表一样，银行手续费恒空、实到账等于汇入总金额", () => {
  assert.deepEqual(FOREX_SUMMARY_COLUMNS.map((column) => column.header), [
    "客户", "币种", "订单数", "出库数", "定金合计", "货款合计", "其他到账", "汇入总金额",
    "银行手续费", "实到账金额", "欠尾款", "已完结订单数", "未完结订单数",
  ]);
  const table = buildForexCustomerSummaryTable([row({ receivedAmount: dec("2790") })], { currencyLabels: LABELS });
  assert.equal(table.rows[0][8], null, "银行手续费恒空");
  assert.equal(table.rows[0][9], 2790, "实到账金额 = 汇入总金额");
});
