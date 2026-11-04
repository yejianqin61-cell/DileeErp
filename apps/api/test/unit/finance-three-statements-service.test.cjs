// 三大报表**取数**的测试（只读口径：取哪些凭证、怎么按期间切片、缺口怎么报）。
//
// 内核（映射与公式）在 `finance-three-statements.test.cjs`，版式在 `finance-three-statements-tables.test.cjs`。
// 这里钉四件事：
//   ① 只取 `status = posted`（草稿不是账；已红冲的原凭证由红冲件抵消，两者都取会算两遍）；
//   ② 一次取「到期末为止」的凭证，再切四个切片（期末 / 年初 / 本期 / 上期）—— 四次查库迟早口径分叉；
//   ③ 折算：外币按期末/期初各自的汇率折成人民币，折不了的币种进表尾缺口；
//   ④ 银行账户期初余额进货币资金；本期已生效但**没生成凭证**的流水条数必须报出来。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { FinanceThreeStatementsService, previousPeriodOf, utcDate } = require("../../dist/modules/finance/finance-three-statements.service.js");

const dec = (text) => ({ toString: () => text });
const line = (subjectKey, direction, amount) => ({ subjectKey, direction, amount: dec(amount) });
const voucher = (id, date, lines, currency = "CNY") => ({ id, voucherDate: utcDate(date), currency, lines });

/** 内存桩：凭证清单 / 银行期初 / 已生效流水 / 已生成凭证 / 草稿张数 / 科目期初余额表 / 期末汇率。 */
function harness({ vouchers = [], banks = [], entries = [], generated = [], draftCount = 0, opening = null, openingGroups = null, rates = [] } = {}) {
  const queries = [];
  const prisma = {
    voucher: {
      findMany: async (args) => {
        queries.push({ model: "voucher.findMany", args });
        return args.where.sourceType === "cash_flow_entry" ? generated : vouchers;
      },
      count: async (args) => { queries.push({ model: "voucher.count", args }); return draftCount; },
    },
    bank: { findMany: async (args) => { queries.push({ model: "bank.findMany", args }); return banks; } },
    cashFlowEntry: { findMany: async (args) => { queries.push({ model: "cashFlowEntry.findMany", args }); return entries; } },
  };
  const groups = openingGroups ?? (opening ? [{ ...opening, currency: "CNY" }] : []);
  const openings = { effectiveFor: async () => opening, effectiveForAll: async () => groups };
  // 汇率桩：`rates` 是 [{ currency, period, rate }]，与 `ExchangeRateService.rateBook()` 的返回同型。
  const book = new Map();
  for (const entry of rates) {
    const bucket = book.get(entry.currency) ?? [];
    bucket.push({ period: entry.period, rate: require("../../dist/modules/finance/money.js").toRateUnits(entry.rate) });
    book.set(entry.currency, bucket);
  }
  const exchangeRates = { rateBook: async () => book };
  return { service: new FinanceThreeStatementsService(prisma, openings, exchangeRates), queries };
}

const yuan = (units) => Number(units) / 10000;

test("三大报表取数：只取已过账凭证，且一次取到期末（四个切片共用同一批）", async () => {
  const { service, queries } = harness({ vouchers: [voucher("v1", "2026-09-10", [line("银行存款", "debit", "100"), line("损益类/主营业务收入", "credit", "100")])] });
  await service.balanceSheet({ from: "2026-09-01", to: "2026-09-30" });

  const listQuery = queries.find((query) => query.model === "voucher.findMany" && query.args.where.sourceType === undefined);
  assert.equal(listQuery.args.where.status, "posted");
  assert.equal(listQuery.args.where.deletedAt, null);
  assert.equal(listQuery.args.where.voucherDate.lte.toISOString(), "2026-09-30T00:00:00.000Z", "取到期末为止的全部凭证，再在内存里切片");
  // 「其它币种」也靠这一批数据算出来，所以不按币种过滤（过滤了就报不出未折算的外币凭证）。
  assert.equal(listQuery.args.where.currency, undefined);
  assert.equal(listQuery.args.select.lines.select.amount, true);
});

test("三大报表取数：期末 / 年初 / 本期 / 上期四个切片各取各的（上期是紧邻的等长期间）", async () => {
  const { service } = harness({
    vouchers: [
      voucher("v-old", "2025-11-20", [line("银行存款", "debit", "500"), line("损益类/主营业务收入", "credit", "500")]),   // 年初之前
      voucher("v-prev", "2026-08-15", [line("银行存款", "debit", "300"), line("损益类/主营业务收入", "credit", "300")]),  // 上期
      voucher("v-now", "2026-09-10", [line("银行存款", "debit", "200"), line("损益类/主营业务收入", "credit", "200")]),   // 本期
    ],
    banks: [{ openingBalance: dec("1000") }],
  });

  const sheet = await service.balanceSheet({ from: "2026-09-01", to: "2026-09-30" });
  // 期末 = 期初 1000 + 500 + 300 + 200
  assert.equal(yuan(sheet.current.totalAssets), 2000);
  // ⚠️ 勾稽不平**恰好等于银行期初余额**：这是「只录了银行账户期初、没有科目期初余额表」的已知缺口
  // （用户已确认要做期初表）。这条断言把这个数钉住，免得以后有人以为报表算错了。
  assert.equal(yuan(sheet.current.difference), 1000);
  assert.equal(yuan(sheet.current.openingDifference), 1000);
  assert.ok(sheet.current.notes.some((note) => note.includes("科目期初余额表")));
  // 年初 = 期初 1000 + 500（2025-11-20 那笔）
  assert.equal(yuan(sheet.yearStartResult.totalAssets), 1500);
  assert.equal(sheet.period.yearStart, "2025-12-31");

  // 没有期初余额时（或期初两侧都录了）勾稽为 0 —— 报表本身是平的。
  const noOpening = harness({
    vouchers: [voucher("v1", "2026-09-10", [line("银行存款", "debit", "100"), line("损益类/主营业务收入", "credit", "100")])],
  });
  const flat = await noOpening.service.balanceSheet({ from: "2026-09-01", to: "2026-09-30" });
  assert.equal(flat.current.balanced, true);
  assert.equal(flat.current.difference, 0n);

  const income = await service.incomeStatement({ from: "2026-09-01", to: "2026-09-30" });
  assert.equal(yuan(income.current.lines.find((row) => row.row === 1).value), 200, "本期只有 9 月那笔");
  assert.equal(yuan(income.previous.lines.find((row) => row.row === 1).value), 300, "上期是 8 月那笔");
  assert.deepEqual(income.previousPeriod, { from: "2026-08-01", to: "2026-08-31" });

  const cash = await service.cashFlowStatement({ from: "2026-09-01", to: "2026-09-30" });
  assert.equal(yuan(cash.cashOpening), 1800, "期初现金 = 银行期初 1000 + 期初之前的资金类净额 800");
  assert.equal(yuan(cash.current.netIncrease), 200);
  assert.equal(yuan(cash.current.closing), 2000, "期末现金 = 期初 + 本期净增加（与资产负债表货币资金一致）");
});

test("三大报表取数：外币凭证按期汇率折算并入本表；一条汇率都没有的币种进「未折算」缺口", async () => {
  const vouchers = [
    voucher("v-cny", "2026-09-10", [line("银行存款", "debit", "100"), line("损益类/主营业务收入", "credit", "100")]),
    voucher("v-usd", "2026-09-11", [line("银行存款", "debit", "50"), line("损益类/主营业务收入", "credit", "50")], "USD"),
    voucher("v-hkd", "2026-09-12", [line("银行存款", "debit", "80"), line("损益类/主营业务收入", "credit", "80")], "HKD"),
  ];
  const converted = harness({ vouchers, rates: [{ currency: "USD", period: "2026-08", rate: "7" }], entries: [{ id: "entry-1" }, { id: "entry-2" }], generated: [{ sourceId: "entry-1" }], draftCount: 2 });
  const report = await converted.service.balanceSheet({ from: "2026-09-01", to: "2026-09-30", currency: "CNY" });

  assert.equal(report.currency, "CNY");
  assert.equal(yuan(report.current.totalAssets), 450, "100 本币 + USD 50 × 7（回退到 8 月汇率）= 450");
  assert.deepEqual(report.gap.otherCurrencies, [{ currency: "USD", count: 1, period: "2026-08" }], "表尾要写明用的是 8 月的汇率");
  assert.deepEqual(report.gap.unconverted, [{ currency: "HKD", vouchers: 1, opening: false }], "没有汇率的币种不许静默丢：HKD 必须报出来");
  assert.equal(report.gap.draftVouchers, 2);
  assert.equal(report.gap.entriesWithoutVoucher, 1, "两条已生效流水里有一条还没有凭证");

  // 折算后的分录进了同一套内核：现金流量表的期末现金与资产负债表货币资金一致（模板勾稽①）。
  const cash = await converted.service.cashFlowStatement({ from: "2026-09-01", to: "2026-09-30", currency: "CNY" });
  assert.equal(yuan(cash.current.closing), 450);
  assert.equal(yuan(cash.current.lines.find((row) => row.row === 32).value), 0, "本币与同月汇率下没有汇率变动影响");
});

test("三大报表取数：期初/期末用不同汇率时，差额进「汇率变动对现金的影响」（行次 32）", async () => {
  // 美元户期初 100，期初汇率 7（上期期末月 8 月），期末汇率 7.2（9 月）→ 10 元的汇率变动。
  const { service } = harness({
    banks: [],
    openingGroups: [{ currency: "USD", asOfDate: "2026-09-01", rows: [{ subjectKey: "资产类/银行存款", direction: "debit", amount: "100" }] }],
    rates: [{ currency: "USD", period: "2026-08", rate: "7" }, { currency: "USD", period: "2026-09", rate: "7.2" }],
  });
  const cash = await service.cashFlowStatement({ from: "2026-09-01", to: "2026-09-30", currency: "CNY" });

  assert.equal(yuan(cash.cashOpening), 700, "期初现金按 8 月汇率 7 折算");
  assert.equal(yuan(cash.current.lines.find((row) => row.row === 32).value), 20, "期末 720 − 期初 700 = 20 的汇率变动");
  assert.equal(yuan(cash.current.closing), 720, "期末现金按 9 月汇率 7.2 折算");

  const sheet = await service.balanceSheet({ from: "2026-09-01", to: "2026-09-30", currency: "CNY" });
  assert.equal(yuan(sheet.current.totalAssets), 720, "资产负债表货币资金同样按期末汇率折算");
});

test("三大报表取数：上期按**自然月**对齐（整月时），自定义期间按等长天数回退", () => {
  assert.deepEqual(previousPeriodOf({ from: "2026-09-01", to: "2026-09-30" }), { from: "2026-08-01", to: "2026-08-31" });
  assert.deepEqual(previousPeriodOf({ from: "2026-03-01", to: "2026-03-31" }), { from: "2026-02-01", to: "2026-02-28" }, "3 月对 2 月按天数对齐");
  assert.deepEqual(previousPeriodOf({ from: "2026-01-01", to: "2026-01-31" }), { from: "2025-12-01", to: "2025-12-31" }, "跨年");
  assert.deepEqual(previousPeriodOf({ from: "2026-09-01", to: "2026-09-15" }), { from: "2026-08-17", to: "2026-08-31" }, "半月期间同样等长");
});

test("三大报表取数：有科目期初余额表时，报表 = 建账期初 + 建账日之后的凭证（勾稽真正为 0）", async () => {
  const { service } = harness({
    vouchers: [
      // 建账日之前那笔不进余额 —— 它已经含在建账期初里了，再取一遍就是算两遍。
      voucher("v-before", "2026-08-20", [line("银行存款", "debit", "500"), line("损益类/主营业务收入", "credit", "500")]),
      voucher("v-after", "2026-09-10", [line("银行存款", "debit", "200"), line("损益类/主营业务收入", "credit", "200")]),
    ],
    opening: {
      asOfDate: "2026-09-01",
      rows: [
        { subjectKey: "资产类/银行存款", direction: "debit", amount: "1000" },
        { subjectKey: "所有者权益类/实收资本", direction: "credit", amount: "1000" },
      ],
    },
  });
  const sheet = await service.balanceSheet({ from: "2026-09-01", to: "2026-09-30" });

  assert.equal(yuan(sheet.current.totalAssets), 1200, "期初 1000 + 建账之后 200");
  assert.equal(sheet.current.balanced, true, "有完整的科目期初时，勾稽真正为 0（不再是「差一个期初余额」）");
  assert.equal(sheet.current.difference, 0n);
  assert.equal(sheet.openingAsOfDate, "2026-09-01");
  assert.equal(yuan(sheet.current.equities.find((row) => row.row === 25).value), 1000, "实收资本来自期初余额表");
  assert.equal(yuan(sheet.current.equities.find((row) => row.row === 32).value), 200, "未分配利润只有建账之后赚的 200");
  assert.equal(sheet.current.notes.some((note) => note.includes("科目期初余额表")), false, "平衡了就不该再有那条差额说明");

  // 现金流量表的期初现金必须包含**期初里的资金类部分**（漏了它期初现金会变成 0，期末余额一路错）。
  const cash = await service.cashFlowStatement({ from: "2026-09-01", to: "2026-09-30" });
  assert.equal(yuan(cash.cashOpening), 1000);
  assert.equal(yuan(cash.current.closing), 1200, "期末现金 = 期初 1000 + 本期 200（与资产负债表货币资金一致）");
});

test("三大报表取数：银行账户期初余额按币种只取该币种的账户（别把美元户的期初算进人民币报表）", async () => {
  const { service, queries } = harness({ banks: [{ openingBalance: dec("1000") }] });
  await service.balanceSheet({ currency: "USD", to: "2026-09-30" });
  const bankQuery = queries.find((query) => query.model === "bank.findMany");
  assert.equal(bankQuery.args.where.currency, "USD");
  assert.equal(bankQuery.args.where.deletedAt, null, "停用账户的钱还在，不能漏");
});

/**
 * 2026-11-04 用户报障：已挂账的付款，付款凭证的业务分录是「应付账款」，
 * 现金流量表照它落行会把销售费/管理费类支出算成「购买商品、接受劳务支付的现金」。
 * 取数层必须把来源流水的「收支类目」带到 StatementVoucher 上，内核优先按类目落行。
 */
test("三大报表取数：现金流量表的凭证带上来来源流水的「收支类目」（2026-11-04）", async () => {
  const { service } = harness({
    vouchers: [
      {
        ...voucher("v-pay", "2026-09-10", [line("负债类/应付账款", "debit", "2700"), line("银行存款", "credit", "2700")]),
        sourceType: "cash_flow_entry",
        sourceId: "entry-1",
      },
    ],
    entries: [{ id: "entry-1", categorySubject: { category: "损益类", name: "销售费 推广费" } }],
  });
  const cash = await service.cashFlowStatement({ from: "2026-09-01", to: "2026-09-30" });
  assert.equal(yuan(cash.current.lines.find((row) => row.row === 8).value), 2700, "按收支类目落「支付其他与经营活动有关的现金」");
  assert.equal(yuan(cash.current.lines.find((row) => row.row === 5).value), 0, "不能按应付账款算成采购付款");
});
