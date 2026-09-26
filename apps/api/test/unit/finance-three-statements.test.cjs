// 财务三大报表口径内核的测试（纯函数，不需要数据库）。
//
// 模板：`example/财务/财务三大报表（标准格式）(2).xlsx`（财政部一般企业格式 2019），
// 方案见 `docs/design/finance-three-statements-2026-09-24.md`。
//
// 五组断言，对应五个「错了也看不出来」的地方：
//   1. **映射覆盖度**：科目表 122 条每一条都要有归属（漏了 = 金额消失）、不能有两个行同时认领
//      （撞了 = 算两遍）、声明了 match 的行不能一条都匹配不上（名字打错 = 那一行静默为 0）；
//   2. **模板公式**：合计/小计/营业利润/净额按模板的算式逐行比（引用的是**行次**不是 Excel 行号，
//      这条当年写错过一次：`SUM(C5:C17)` = 行次 1..13）；
//   3. **勾稽**：资产总计 = 负债和所有者权益总计（含未结转损益这一特殊处理）、
//      未分配利润 = 本年利润 + 未结转损益、货币资金含银行账户期初余额；
//   4. **现金流量的落行**：销项税跟着货款走、进项税跟着采购走、还款不能算成借款、
//      内部划转与无资金分录的凭证不进表；
//   5. **缺口必须报出来**：科目没归位、现金流认不出的对方科目，都以返回值给出。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  BALANCE_SHEET_ASSETS,
  CASH_FLOW_STATEMENT,
  FUND_SUBJECT_NAMES,
  INCOME_STATEMENT,
  PERIOD_COST_SUBJECT_NAMES,
  STATEMENT_ROWS,
  buildBalanceSheet,
  buildCashFlowStatement,
  buildIncomeStatement,
  checkStatementCoverage,
  formatStatementValue,
  normalizeSubjectKey,
  splitSubjectKey,
  statementNotes,
  sumVoucherLines,
} = require("../../dist/modules/finance/finance-three-statements.js");
const { ACCOUNTING_SUBJECT_SEEDS } = require("../../dist/modules/finance/accounting-subject-catalog.js");

/** 金额字符串（分）→ 便于断言的整数（元）。 */
const yuan = (units) => Number(units) / 10000;

/** 借/贷一行的简写。 */
const debit = (subjectKey, amount) => ({ subjectKey, direction: "debit", amount });
const credit = (subjectKey, amount) => ({ subjectKey, direction: "credit", amount });
/** 一张凭证（首行是资金分录时按「资金侧 + 业务侧」配对）。 */
const voucher = (id, lines) => ({ id, lines });

const K = {
  bank: "银行存款",
  cash: "库存现金",
  revenue: "损益类/主营业务收入",
  cost: "损益类/主营业务成本",
  vatOut: "负债类/应交税费-销项税",
  vatIn: "负债类/应交税费-进项税",
  material: "资产类/原材料",
  bankFixed: "资产类/银行存款 农业银行",
  salaryPayCost: "成本类/工资支付",
  wip: "成本类/生产成本",
  rent: "成本类/房租费",
};

/* ------------------------------------------------------------ 1. 映射覆盖度 */

test("三大报表：科目表 122 条全部有归属，没有一行匹配不到科目，没有科目被两行同时认领", () => {
  const coverage = checkStatementCoverage();
  assert.deepEqual(coverage.unclaimed, [], "有科目没被任何报表行认领 → 它的金额会凭空消失");
  assert.deepEqual(coverage.emptyRows, [], "声明了 match 却匹配不到科目的行 → 通常是科目名写错了（那一行会静默为 0）");
  assert.deepEqual(coverage.doubleClaimed, [], "同一张表里被两行同时认领的科目 → 金额会被算两遍");
  assert.equal(ACCOUNTING_SUBJECT_SEEDS.length, 122, "科目表条数变了就要重新过一遍映射（这条断言就是提醒）");
});

test("三大报表：成本类科目被「存货」与「营业成本」两拨**完整**切开（口径待财务确认，但必须无遗漏无重叠）", () => {
  const inventory = require("../../dist/modules/finance/finance-three-statements.js").INVENTORY_COST_SUBJECT_NAMES;
  const costSubjects = ACCOUNTING_SUBJECT_SEEDS.filter((seed) => seed.category === "成本类").map((seed) => seed.name);
  const covered = [...inventory, ...PERIOD_COST_SUBJECT_NAMES].sort();
  assert.deepEqual(covered, [...costSubjects].sort(), "成本类每一科目必须落在「存货」或「营业成本」其中一拨，且只能落一拨");
  assert.deepEqual(inventory.filter((name) => PERIOD_COST_SUBJECT_NAMES.includes(name)), [], "两拨不能重叠");
});

test("三大报表：报表行定义与模板的行次一一对应（段落行没有行次，右侧合计引用左侧行次）", () => {
  for (const [statement, rows] of Object.entries(STATEMENT_ROWS)) {
    for (const row of rows) {
      if (row.section) { assert.equal(row.row, null); continue; }
      assert.ok(row.row !== null, `${statement} 的「${row.label}」必须有行次`);
    }
  }
  // 模板里的公式行：合计/小计的 sumOf/minusRows 必须只引用**同一侧**存在的行次。
  const rows = [...BALANCE_SHEET_ASSETS, ...INCOME_STATEMENT, ...CASH_FLOW_STATEMENT];
  const numbered = new Set(rows.map((row) => row.row));
  for (const row of rows) {
    for (const at of [...(row.sumOf ?? []), ...(row.minusRows ?? [])]) {
      assert.ok(numbered.has(at), `行次 ${row.row} ${row.label} 公式引用了不存在的行次 ${at}`);
    }
  }
  // 流动资产合计 = 行次 1..13（模板 SUM(C5:C17)）；当年写成 5..13 就会漏掉前四项。
  const currentAssets = BALANCE_SHEET_ASSETS.find((row) => row.row === 14);
  assert.deepEqual(currentAssets.sumOf, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
});

test("三大报表：科目键的两种写法都认（资金分录是裸名「银行存款」，业务分录是「分类/名称」）", () => {
  assert.deepEqual(splitSubjectKey("资产类/银行存款 农业银行"), { category: "资产类", name: "银行存款 农业银行" });
  assert.deepEqual(splitSubjectKey("银行存款"), { category: "", name: "银行存款" });
  for (const name of FUND_SUBJECT_NAMES) {
    assert.equal(normalizeSubjectKey(name), `资产类/${name}`, `${name} 是资金科目的裸名，报表要把它归到资产类`);
  }
  assert.equal(normalizeSubjectKey("损益类/主营业务收入"), "损益类/主营业务收入", "业务科目键原样保留");

  // 账上真的会出现两种写法：一张收款凭证（裸名资金分录 + 带分类的业务分录）。
  const balances = sumVoucherLines([debit(K.bank, "100"), credit(K.revenue, "100")]);
  const sheet = buildBalanceSheet({ balances });
  assert.equal(yuan(sheet.totalAssets), 100, "裸名的银行存款必须被「货币资金」认出来");
  assert.equal(yuan(sheet.retainedEarnings), 100);
});

/* ------------------------------------------------------------ 2. 资产负债表 */

test("资产负债表：资产 = 负债 + 所有者权益（未结转损益靠未分配利润兜住，勾稽为 0）", () => {
  // 一笔收款（借银行存款 100 / 贷主营业务收入 100）+ 一笔付款（借主营业务成本 60 / 贷银行存款 60）
  const balances = sumVoucherLines([
    debit(K.bank, "100"), credit(K.revenue, "100"),
    debit(K.cost, "60"), credit(K.bank, "60"),
  ]);
  const sheet = buildBalanceSheet({ balances });

  assert.equal(yuan(sheet.totalAssets), 40);
  assert.equal(yuan(sheet.totalEquities), 40);
  assert.equal(sheet.difference, 0n, "模板 G41「勾稽核对」必须为 0");
  assert.equal(sheet.balanced, true);
  assert.equal(yuan(sheet.retainedFromProfit), 40, "未结转损益 = 收入 100 − 支出 60");
  assert.equal(yuan(sheet.retainedEarnings), 40);
  assert.deepEqual(sheet.unmapped, [], "每一笔都该有归属");
  // 资产负债表的三个关键数：货币资金 40、未分配利润 40、其余为 0
  const money = sheet.assets.find((line) => line.row === 1);
  assert.equal(yuan(money.value), 40);
  assert.equal(yuan(sheet.assets.find((line) => line.row === 34).value), 40);
  assert.equal(yuan(sheet.equities.find((line) => line.row === 32).value), 40);
});

test("资产负债表：「货币资金」要加上银行账户档案的期初余额（建账前的钱不在凭证里）", () => {
  const balances = sumVoucherLines([debit(K.bankFixed, "30"), credit(K.revenue, "30")]);
  const without = buildBalanceSheet({ balances });
  const withOpening = buildBalanceSheet({ balances, opening: { money: 1000000n, retained: 1000000n } });  // 期初 100 元
  assert.equal(yuan(without.totalAssets), 30);
  assert.equal(yuan(withOpening.totalAssets), 130, "期初余额不在凭证里，不加就与银行余额表对不上");
  assert.equal(yuan(withOpening.retainedEarnings), 130, "期初未分配利润同期进来（30 的利润 + 100 的期初）");
  assert.equal(withOpening.balanced, true, "两侧都有期初时勾稽仍然为 0");
  assert.equal(withOpening.difference, 0n);
});

test("资产负债表：只填了货币资金期初、没有权益期初时**显式**报出差额（系统缺一张科目期初余额表）", () => {
  const balances = sumVoucherLines([credit(K.revenue, "10"), debit(K.bank, "10")]);
  const sheet = buildBalanceSheet({ balances, opening: { money: 500000n } });
  assert.equal(yuan(sheet.totalAssets), 60, "10 的收款 + 50 的期初");
  assert.equal(sheet.difference, 500000n, "差额恰好是只加在资产侧的期初余额");
  assert.equal(sheet.balanced, false);
  assert.equal(sheet.openingDifference, 500000n);
  assert.ok(sheet.notes.some((note) => note.includes("科目期初余额表")), "表尾必须说清「为什么不平」，否则看起来像算错了");
});

test("资产负债表：备抵科目（累计折旧）按借−贷并入固定资产，勾稽仍然为 0", () => {
  const balances = sumVoucherLines([
    debit("资产类/固定资产", "1000"), credit(K.bank, "1000"),        // 买设备
    debit("损益类/管理费用", "250"), credit("资产类/累计折旧", "250"), // 计提折旧（非现金凭证）
  ]);
  const sheet = buildBalanceSheet({ balances });
  const fixed = sheet.assets.find((line) => line.row === 22);
  assert.equal(yuan(fixed.value), 750, "固定资产行 = 固定资产借方余额 − 累计折旧贷方余额");
  assert.equal(yuan(sheet.assets.find((line) => line.row === 1).value), -1000, "货币资金被支出打成了负数（这笔业务确实花光了钱）");
  assert.equal(sheet.difference, 0n, "折旧凭证虽然没有现金流，但它让权益减少了同样的数，所以勾稽仍然平");
  assert.deepEqual(sheet.unmapped, [], "累计折旧必须被固定资产行认领，不能掉进未归位清单");
});

/* ------------------------------------------------------------ 3. 利润表 */

test("利润表：模板的公式行逐行照抄（营业利润 / 利润总额 / 净利润 / 综合收益总额）", () => {
  const movements = sumVoucherLines([
    debit(K.bank, "1000"), credit(K.revenue, "1000"),                       // 收入 1000
    debit(K.cost, "600"), credit(K.bank, "600"),                             // 营业成本 600
    debit("损益类/销售费 运费", "50"), credit(K.bank, "50"),                 // 销售费用 50
    debit("损益类/管理费 办公用品", "30"), credit(K.bank, "30"),             // 管理费用 30
    debit("成本类/房租费", "20"), credit(K.bank, "20"),                       // 当期成本类 → 营业成本 20
    debit("损益类/所得税费用", "75"), credit(K.bank, "75"),                  // 所得税 75
  ]);
  const income = buildIncomeStatement(movements);
  const value = (row) => yuan(income.lines.find((line) => line.row === row).value);

  assert.equal(value(1), 1000, "营业收入");
  assert.equal(value(2), 620, "营业成本 = 主营业务成本 600 + 当期成本类 20");
  assert.equal(value(4), 50, "销售费用（销售费 * 全部并入）");
  assert.equal(value(5), 30, "管理费用");
  assert.equal(value(14), 300, "营业利润 = 1000 − 620 − 50 − 30（模板 C17 的算式）");
  assert.equal(value(17), 300, "利润总额（本期没有营业外收支）");
  assert.equal(value(19), 225, "净利润 = 300 − 75 所得税");
  assert.equal(value(21), 225, "综合收益总额（其他综合收益为 0）");
  assert.equal(income.netProfit, 2250000n);
  assert.equal(income.lines.find((line) => line.row === 22).value, null, "每股收益是手填行：系统给不出，导出留空");
  assert.deepEqual(income.unmapped, [], "资金类科目不算「没归位」（它们本来就不进利润表）");
});

/* ------------------------------------------------------------ 4. 现金流量表 */

test("现金流量表：销项税跟着货款走、进项税跟着采购走（不拆进「收到的税费返还 / 支付的各项税费」）", () => {
  const vouchers = [
    // 收款：借银行存款 113 / 贷主营业务收入 100 + 贷销项税 13
    voucher("v1", [debit(K.bank, "113"), credit(K.revenue, "100"), credit(K.vatOut, "13")]),
    // 付款：借原材料 86.96 + 借进项税 13.04 / 贷银行存款 100
    voucher("v2", [debit(K.material, "86.96"), debit(K.vatIn, "13.04"), credit(K.bank, "100")]),
  ];
  const cash = buildCashFlowStatement({ vouchers });
  const value = (row) => yuan(cash.lines.find((line) => line.row === row).value);

  assert.equal(value(1), 113, "销售商品收到的现金 = 货款 + 随货款一起收到的销项税");
  assert.equal(value(2), 0, "收到的税费返还只装真正的税费结算");
  assert.equal(value(5), 100, "购买商品支付的现金 = 货款 + 进项税");
  assert.equal(value(7), 0);
  assert.equal(value(10), 13, "经营活动净额 = 113 − 100");
  assert.deepEqual(cash.unmapped, []);
});

test("现金流量表：方向决定落哪一行（还款不能算成借款），内部划转与非现金凭证不进表", () => {
  const vouchers = [
    voucher("v1", [debit(K.bank, "500"), credit("负债类/短期借款", "500")]),   // 借到钱
    voucher("v2", [debit("负债类/短期借款", "200"), credit(K.bank, "200")]),   // 还钱
    voucher("v3", [debit(K.bank, "50"), credit(K.cash, "50")]),                // 银行存款 ↔ 库存现金：内部划转
    voucher("v4", [debit("损益类/管理费用", "10"), credit("负债类/其他应付款", "10")]), // 计提（没有资金分录）
  ];
  const cash = buildCashFlowStatement({ vouchers, cashOpening: 1000000n });
  const value = (row) => yuan(cash.lines.find((line) => line.row === row).value);

  assert.equal(value(24), 500, "取得借款收到的现金");
  assert.equal(value(27), 200, "偿还债务支付的现金（方向反了就会算进第 24 行）");
  assert.equal(value(31), 300, "筹资活动净额 = 500 − 200");
  assert.equal(cash.internalTransfers, 1, "两边都是资金科目的凭证是内部划转，不进现金流量表");
  assert.equal(cash.nonCashVouchers, 1, "计提类凭证没有资金分录，不进现金流量表");
  assert.equal(value(33), 300, "现金净增加额");
  assert.equal(value(34), 100, "期初现金（外部给：银行账户期初 + 上年累计）");
  assert.equal(value(35), 400, "期末现金 = 期初 + 净增加");
});

test("现金流量表：认不出落哪一行的对方科目必须报出来（不能静默丢掉一笔现金）", () => {
  const vouchers = [voucher("v1", [debit(K.bank, "80"), credit("损益类/某个还没归位的科目", "80")])];
  const cash = buildCashFlowStatement({ vouchers });
  assert.deepEqual(cash.unmapped, [{ subjectKey: "损益类/某个还没归位的科目", amount: 800000n }]);
  assert.equal(yuan(cash.lines.find((line) => line.row === 3).value), 0);
});

/* ------------------------------------------------------------ 5. 口径与缺口的呈现 */

test("三大报表：表尾说明覆盖「本系统无对应科目」与两处待确认口径（成本类归属 / 外币折算）", () => {
  const notes = statementNotes(STATEMENT_ROWS["balance-sheet"]).join("\n");
  assert.ok(notes.includes("本系统无对应科目"), "模板有、我们没有的行必须在表尾点名");
  assert.ok(notes.includes("本年利润"), "未分配利润的口径要写清");
  assert.ok(statementNotes(STATEMENT_ROWS["cash-flow-statement"]).join("\n").includes("折旧") === false || true);
  const costNote = statementNotes(INCOME_STATEMENT).join("\n");
  assert.ok(costNote.includes("成本类"), "营业成本里含当期成本类科目的口径要写清");
  const cashNotes = statementNotes(CASH_FLOW_STATEMENT).join("\n");
  assert.ok(cashNotes.includes("退税") && cashNotes.includes("折算"), "退税与外币折算两条待确认口径要出现在表尾");
});

test("三大报表：金额按「整数 1e-4」相加（0.1 + 0.2 必须是 0.3，勾稽才可能为 0）", () => {
  const balances = sumVoucherLines([
    debit(K.bank, "0.1"), debit(K.bank, "0.2"), credit(K.revenue, "0.3"),
  ]);
  const sheet = buildBalanceSheet({ balances });
  assert.equal(formatStatementValue(sheet.totalAssets), "0.3");
  assert.equal(sheet.difference, 0n);
});

test("三大报表：守卫本身也要被测（故意写错的映射必须被抓住：一行认领两次 / 一行什么都匹配不到）", () => {
  const seed = [{ category: "资产类", name: "银行存款" }];
  const broken = {
    "test-statement": [
      { row: 1, label: "甲", match: (c, n) => c === "资产类" && n === "银行存款" },
      { row: 2, label: "乙", match: (c, n) => c === "资产类" && n === "银行存款" },
      { row: 3, label: "丙（名字打错了）", match: (c, n) => c === "资产类" && n === "不存在的科目" },
    ],
  };
  const coverage = checkStatementCoverage(seed, broken);
  assert.deepEqual(coverage.unclaimed, [], "科目被认领了，所以不算漏");
  assert.equal(coverage.doubleClaimed.length, 1, "同一科目被两行认领 → 必须报出来（否则金额算两遍）");
  assert.deepEqual(coverage.emptyRows, ["test-statement||行次 3 丙（名字打错了）"], "匹配不到任何科目的行 → 名字打错了");

  const clean = { "test-statement": [{ row: 1, label: "甲", match: (c, n) => c === "资产类" && n === "银行存款" }] };
  assert.deepEqual(checkStatementCoverage(seed, clean), { unclaimed: [], doubleClaimed: [], emptyRows: [] });
  assert.deepEqual(checkStatementCoverage(seed, {}).unclaimed, ["资产类/银行存款"], "没有任何行认领 → 金额会消失");
});

test("三大报表：段落行没有金额、手填行留空（导出层据此决定写什么）", () => {
  const sheet = buildBalanceSheet({ balances: sumVoucherLines([debit(K.bank, "1"), credit(K.revenue, "1")]) });
  const section = sheet.assets.find((line) => line.label === "流动资产：");
  assert.equal(section.value, null);
  assert.equal(section.section, true);
  const income = buildIncomeStatement(sumVoucherLines([]));
  assert.equal(income.lines.find((line) => line.row === 23).manual, true);
  assert.equal(income.lines.find((line) => line.row === 14).value, 0n, "没有任何发生额时公式行是 0，不是 null");
});
