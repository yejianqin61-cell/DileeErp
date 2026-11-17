// 凭证的纯逻辑（收支流水 → 借贷分录）。
//
// 这一层刻意不依赖 Nest/Prisma，所以这些用例跑的是「凭证长什么样」的业务口径本身：
// 收入=借资金贷业务科目、支出=借业务科目贷资金、金额恒为正、科目名做快照。
const assert = require("node:assert/strict");
const test = require("node:test");
const {
  FUND_SUBJECT_BANK, FUND_SUBJECT_CASH, PETTY_CASH_RECEIVABLE_SUBJECT, PETTY_CASH_REIMBURSEMENT_LABEL,
  fundLineFor, fundSubjectFor, isBankFamilySubject, isCashFamilySubject, isPettyCashReimbursement, isReceivableFamilySubject,
  reverseLines, voucherBalance, voucherLinesFor, voucherPeriodFor, voucherSummaryFor, voucherSummaryForEntry,
} = require("../../dist/modules/finance/voucher.domain.js");

const entry = (extra = {}) => ({
  entryNo: "CF-20260915-0001",
  entryDate: new Date("2026-09-15T00:00:00.000Z"),
  counterpartyName: "香港迪礼",
  direction: "income",
  amount: "14310.0000",
  currency: "USD",
  subjectKey: "损益类/主营业务收入",
  subjectLabel: "主营业务收入",
  settlementMethod: "转账--农业银行5706",
  settlementAccountLabel: "农业银行5706",
  remark: null,
  ...extra,
});

test("收入：借资金科目、贷业务科目（科目名取自会计科目，资金科目默认银行存款）", () => {
  const lines = voucherLinesFor(entry());
  assert.equal(lines.length, 2);
  // 2026-11-05：资金侧的科目名带上账户（结算账户优先），见下面「贷方科目名」那组用例。
  assert.deepEqual(lines.map((line) => [line.line_no, line.direction, line.subject_label]), [
    [1, "debit", "银行存款—农业银行5706"],
    [2, "credit", "主营业务收入"],
  ]);
  assert.equal(lines[1].subject_key, "损益类/主营业务收入", "科目编码 = 分类/项目（科目表没有唯一编码）");
  assert.deepEqual(lines.map((line) => line.amount), ["14310.0000", "14310.0000"], "金额恒为正数，方向由 direction 决定");
  assert.equal(lines[0].currency, "USD");
});

test("支出：借业务科目、贷资金科目（方向与收入相反）", () => {
  const lines = voucherLinesFor(entry({ direction: "expense", subjectKey: "损益类/主营业务成本", subjectLabel: "主营业务成本", amount: "5200.0000" }));
  assert.deepEqual(lines.map((line) => [line.direction, line.subject_label]), [
    ["debit", "主营业务成本"],
    ["credit", "银行存款—农业银行5706"],
  ]);
  assert.equal(lines[1].amount, "5200.0000");
});

test("资金科目按「现金」识别：结算方式或账户名里含现金 → 库存现金", () => {
  assert.equal(fundSubjectFor("现金支付"), FUND_SUBJECT_CASH);
  assert.equal(fundSubjectFor("提现--备用金现金"), FUND_SUBJECT_CASH);
  assert.equal(fundSubjectFor("转账--农业银行5706"), FUND_SUBJECT_BANK);
  assert.equal(fundSubjectFor(null), FUND_SUBJECT_BANK, "没有结算信息时默认银行存款");
  // 结算账户名优先于结算方式（前者更具体）
  const lines = voucherLinesFor(entry({ settlementMethod: "转账", settlementAccountLabel: "库存现金" }));
  assert.equal(lines[0].subject_label, FUND_SUBJECT_CASH);
});

test("摘要 = 对方 · 会计科目（有备注就补在括号里），并截断到 500 字", () => {
  assert.equal(voucherSummaryFor({ counterpartyName: "香港迪礼", subjectLabel: "主营业务收入" }), "香港迪礼 · 主营业务收入");
  assert.equal(voucherSummaryFor({ counterpartyName: "甲", subjectLabel: "乙", remark: "9 月货款" }), "甲 · 乙（9 月货款）");
  assert.equal(voucherSummaryFor({ counterpartyName: "", subjectLabel: "主营业务收入" }), "主营业务收入", "对方为空时不出现空的分隔符");
  assert.equal(voucherSummaryFor({ counterpartyName: "甲".repeat(400), subjectLabel: "乙".repeat(400) }).length, 500);
});

test("会计期间取自凭证日期（YYYY-MM）", () => {
  assert.equal(voucherPeriodFor(new Date("2026-09-15T00:00:00.000Z")), "2026-09");
  assert.equal(voucherPeriodFor("2026-01-31T00:00:00.000Z"), "2026-01");
});

test("红字凭证：借/贷对调、金额不变、摘要加「红冲：」前缀", () => {
  const lines = reverseLines([
    { direction: "debit", subject_key: "银行存款", subject_label: "银行存款", summary: "香港迪礼 · 主营业务收入", amount: "100.0000", currency: "USD" },
    { direction: "credit", subject_key: "损益类/主营业务收入", subject_label: "主营业务收入", summary: "香港迪礼 · 主营业务收入", amount: "100.0000", currency: "USD" },
  ]);
  assert.deepEqual(lines.map((line) => [line.line_no, line.direction, line.subject_label]), [
    [1, "credit", "银行存款"],
    [2, "debit", "主营业务收入"],
  ]);
  assert.equal(lines[0].amount, "100.0000");
  assert.equal(lines[0].summary, "红冲：香港迪礼 · 主营业务收入");
});

test("借贷平衡判定按「分位对齐」做精确比较（不吃浮点误差）", () => {
  const balanced = voucherBalance([{ direction: "debit", amount: "0.1000" }, { direction: "credit", amount: "0.1000" }]);
  assert.equal(balanced.balanced, true);
  assert.equal(balanced.debit, balanced.credit);
  const unbalanced = voucherBalance([{ direction: "debit", amount: "0.3000" }, { direction: "credit", amount: "0.1000" }, { direction: "credit", amount: "0.2001" }]);
  assert.equal(unbalanced.balanced, false, "0.1000 + 0.2001 ≠ 0.3000");
  // 生成出来的分录天然平衡
  assert.equal(voucherBalance(voucherLinesFor(entry())).balanced, true);
  assert.throws(() => voucherBalance([{ direction: "debit", amount: "abc" }]), /INVALID_AMOUNT/);
});

// ---------------------------------------------------------------------------
// 2026-09-16（用户要求）：「凭证中的那个会计科目的银行存款，要引用的是具体的银行账户」。
// 科目名仍是「银行存款」（会计科目要能汇总），账户是明细引用（bank_id）+ 科目名快照（打印出来
// 的纸质凭证要能自己说明是哪本账）。判定顺序：显式引用（bankId）优先于文本猜测（含「现金」）。
// ---------------------------------------------------------------------------

test("资金类分录引用具体银行账户：科目名照旧，科目名快照带上账户，分录带 bank_id", () => {
  const lines = voucherLinesFor(entry({ bankId: "bank-1", bankLabel: "农业银行5706" }));
  assert.equal(lines[0].subject_key, FUND_SUBJECT_BANK, "会计科目仍是「银行存款」，这样银行存款才能汇总");
  assert.equal(lines[0].subject_label, "银行存款—农业银行5706", "科目名快照要能自己说明是哪本账");
  assert.equal(lines[0].bank_id, "bank-1");
  assert.equal(lines[1].bank_id, undefined, "业务科目（会计科目）不挂银行账户");
});

test("历史数据（没有银行账户、只有结算方式文本）按「现金」判断，且不写 bank_id", () => {
  const [bank] = voucherLinesFor(entry({ settlementAccountLabel: "农业银行5706" }));
  // 2026-11-05：有结算账户就把它写成科目名的一部分（它是财务账套里的账户叫法），
  // 但**没有** bank_id 引用 —— 没有账户事实就不编一个。
  assert.equal(bank.subject_label, "银行存款—农业银行5706");
  assert.equal(bank.bank_id, null, "没有账户引用就是 null，不能编一个");
  const [cash] = voucherLinesFor(entry({ settlementAccountLabel: "现金日记账" }));
  assert.equal(cash.subject_label, FUND_SUBJECT_CASH);
  assert.equal(cash.bank_id, null, "库存现金不是银行账户");
});

test("挂了银行账户就优先判成银行存款（显式引用优先于文本猜测），即使结算方式里写着「现金」", () => {
  const line = fundLineFor({ bankId: "bank-1", bankLabel: "农业银行5706", settlementMethod: "现金", settlementAccountLabel: "现金" });
  assert.equal(line.subject_key, FUND_SUBJECT_BANK);
  assert.equal(line.bank_id, "bank-1");
});

test("有账户但拿不到账户名时不写半截科目名（退回「银行存款」而不是「银行存款—」）", () => {
  const line = fundLineFor({ bankId: "bank-1", bankLabel: "  " });
  assert.equal(line.subject_label, FUND_SUBJECT_BANK);
  assert.equal(line.bank_id, "bank-1", "账户引用仍然要保留");
});

test("红字凭证的分录照旧带银行账户引用（否则银行存款明细账会对不上银行对账单）", () => {
  const lines = reverseLines([{ direction: "debit", subject_key: FUND_SUBJECT_BANK, subject_label: "银行存款—农业银行5706", summary: "香港迪礼 · 主营业务收入", amount: "100.0000", currency: "CNY", bank_id: "bank-1" }]);
  assert.equal(lines[0].direction, "credit");
  assert.equal(lines[0].bank_id, "bank-1");
  assert.equal(lines[0].subject_label, "银行存款—农业银行5706");
});

// ---------------------------------------------------------------------------
// 2026-11-05（用户）：「凭证里面，贷方的会计科目填写结算账户+银行账户」——
//   追问后选定**只用结算账户名**：资金行的账户名快照优先级 = 结算账户 > 银行账户。
//   结算账户是财务账套里的账户叫法（老表「结算方式」的原文，如「农业银行5706」）；
//   银行账户是银行池里的那张卡（如「招商银行6214851811022925」）。两者都有时写结算账户，
//   银行账户仍作为 `bank_id` 引用（余额、明细账用它）。
// ---------------------------------------------------------------------------

test("贷方资金科目名优先用「结算账户」（两样都有时不再写银行池的账号）", () => {
  const line = fundLineFor({ bankId: "bank-1", bankLabel: "招商银行6214851811022925", settlementAccountLabel: "农业银行5706", settlementMethod: "银行转账" });
  assert.equal(line.subject_key, FUND_SUBJECT_BANK, "会计科目仍是「银行存款」，账户只是名称快照");
  assert.equal(line.subject_label, "银行存款—农业银行5706");
  assert.equal(line.bank_id, "bank-1", "账户引用照旧保留：余额与明细账要用它");
});

test("没有结算账户时才退回银行账户名（2026-09-16 的口径不能被这次改坏）", () => {
  const line = fundLineFor({ bankId: "bank-1", bankLabel: "招商银行6214851811022925", settlementAccountLabel: null });
  assert.equal(line.subject_label, "银行存款—招商银行6214851811022925");
});

test("结算账户名里写着「现金」时不当银行账户名用（不写出「银行存款—现金日记账」这种假账户）", () => {
  const line = fundLineFor({ bankId: "bank-1", bankLabel: "招商银行6214851811022925", settlementAccountLabel: "现金日记账", settlementMethod: "现金" });
  assert.equal(line.subject_label, "银行存款—招商银行6214851811022925");
});

// ---------------------------------------------------------------------------
// 2026-10-16：**「备用金付款」= 从银行取现到备用金**（用户报障：备用金那笔应付的凭证纸上
//   会计科目写着「应付账款」，她要的是「库存现金（备用金）」；选定口径为
//   「借 库存现金（备用金）/贷 银行存款」）。
//
//   原因：备用金这类其他应付的会计科目是「资产类 / 库存现金（备用金）」——它**本身就是现金科目**，
//   所以「钱从哪来」只可能是银行。而原来的资金侧只看结算方式里有没有「现金」二字，
//   「提现--备用金现金」这类文本会把两边都判成现金：借 库存现金（备用金）/贷 库存现金
//   （同一个钱柜自己转给自己，等于科目没显示对）。
// ---------------------------------------------------------------------------

test("资金科目族判定：库存现金（备用金）算现金科目，银行存款明细算银行科目", () => {
  assert.equal(isCashFamilySubject("库存现金（备用金）"), true);
  assert.equal(isCashFamilySubject("库存现金"), true);
  assert.equal(isCashFamilySubject("银行存款 中国银行（美元）"), false, "银行存款不是现金族");
  assert.equal(isCashFamilySubject("管理费用"), false);
  assert.equal(isCashFamilySubject(null), false, "取不到科目名时不能瞎认，按老规则走");
  assert.equal(isBankFamilySubject("银行存款 中国银行（美元）"), true);
  assert.equal(isBankFamilySubject("库存现金（备用金）"), false);
});

test("业务科目是库存现金（备用金）时资金侧取银行存款（即使结算方式里写着「现金」）", () => {
  const lines = voucherLinesFor(entry({
    direction: "expense",
    subjectKey: "资产类/库存现金（备用金）",
    subjectLabel: "库存现金（备用金）",
    // 文本里有「现金」，但那是**取现的去向**（备用金现金），不是钱的来源：
    // 来源是银行，所以贷方必须是银行存款 —— 这就是用户要的那张凭证。
    settlementMethod: "提现--备用金现金",
    settlementAccountLabel: null,
    amount: "3000.0000",
  }));
  assert.deepEqual(lines.map((line) => [line.direction, line.subject_label]), [
    ["debit", "库存现金（备用金）"],
    ["credit", FUND_SUBJECT_BANK],
  ]);
  assert.equal(lines[1].bank_id, null, "没有账户引用时不能编一个 bank_id");
});

test("业务科目是库存现金（备用金）且单据上选了银行账户时，贷方写「银行存款—账户」并引用它", () => {
  const line = fundLineFor({
    bankId: "bank-1", bankLabel: "农业银行5706",
    settlementMethod: "备用金", settlementAccountLabel: null,
    subjectLabel: "库存现金（备用金）",
  });
  assert.equal(line.subject_key, FUND_SUBJECT_BANK);
  assert.equal(line.subject_label, "银行存款—农业银行5706");
  assert.equal(line.bank_id, "bank-1");
  // 反向守卫：**普通**业务科目仍然按「现金」二字猜资金侧（原来那条口径不变）。
  const expense = fundLineFor({ bankId: null, bankLabel: null, settlementMethod: "现金报销", settlementAccountLabel: null, subjectLabel: "管理费用" });
  assert.equal(expense.subject_label, FUND_SUBJECT_CASH);
});

// ---------------------------------------------------------------------------
// 2026-11-17（用户）：「招行」≠「对公直接支付」；备用金报销的贷方不能自动带出银行存款，
//   要走「其他应收款—备用金」。
//
//   生产账套用银行账户池里的 `bankCode = 备用金` 区分那张招行个人备用金卡；
//   公司对公招行户的 bankCode 不是「备用金」。识别只认这个标记/结算文本，不认银行名。
// ---------------------------------------------------------------------------

test("备用金报销：招行备用金卡 + 费用科目 → 贷 其他应收款-备用金，不再贷银行存款", () => {
  const lines = voucherLinesFor(entry({
    direction: "expense",
    counterpartyName: "拼多多",
    subjectKey: "负债类/应付账款",
    subjectLabel: "应付账款",
    categorySubjectLabel: "管理费用",
    bankId: "bank-petty",
    bankCode: "备用金",
    bankName: "招商银行",
    accountName: "周金红",
    bankLabel: "招商银行6214851811022925",
    settlementMethod: "库存现金-备用金--招商银行6214851811022925",
    settlementAccountLabel: null,
    amount: "78.7400",
  }));
  assert.deepEqual(lines.map((line) => [line.direction, line.subject_label, line.bank_id]), [
    ["debit", "应付账款", undefined],
    ["credit", PETTY_CASH_RECEIVABLE_SUBJECT, null],
  ], "贷方是其他应收款-备用金；备用金报销不是银行存款动账，不能挂 bank_id");
  assert.equal(lines[1].subject_key, "资产类/其他应收款-备用金");
  assert.equal(lines[0].summary, `拼多多 · ${PETTY_CASH_REIMBURSEMENT_LABEL} · 管理费用`, "自动摘要带业务类型，业务科目取收支类目");
  assert.equal(lines[1].summary, lines[0].summary, "凭证头与两条分录共用同一份摘要");
  assert.equal(voucherSummaryForEntry({ ...entry({ direction: "expense", subjectLabel: "应付账款", categorySubjectLabel: "管理费用" }), bankCode: "备用金" }), `香港迪礼 · ${PETTY_CASH_REIMBURSEMENT_LABEL} · 管理费用`);
});

test("招行对公户的普通支出仍贷银行存款：不能因为银行名是「招商银行」就判成备用金报销", () => {
  const lines = voucherLinesFor(entry({
    direction: "expense",
    subjectKey: "损益类/管理费用",
    subjectLabel: "管理费用",
    bankId: "bank-cmb-corporate",
    bankCode: "招行",
    bankName: "招商银行",
    accountName: "厦门迪礼进出口有限公司",
    bankLabel: "招商银行5920",
    settlementMethod: "转账--招商银行5920",
    settlementAccountLabel: null,
    amount: "100.0000",
  }));
  assert.deepEqual(lines.map((line) => [line.direction, line.subject_label]), [
    ["debit", "管理费用"],
    ["credit", "银行存款—招商银行5920"],
  ]);
  assert.equal(lines[1].bank_id, "bank-cmb-corporate", "对公户仍是银行存款并引用账户");
  assert.equal(isPettyCashReimbursement({ direction: "expense", subjectLabel: "管理费用", bankCode: "招行", bankName: "招商银行", accountName: "厦门迪礼进出口有限公司" }), false);
});

test("拨付备用金（业务科目就是其他应收款）仍借其他应收款 / 贷银行存款", () => {
  const lines = voucherLinesFor(entry({
    direction: "expense",
    subjectKey: "资产类/其他应收款-备用金",
    subjectLabel: "其他应收款-备用金",
    bankId: "bank-cmb-corporate",
    bankCode: "招行",
    bankName: "招商银行",
    accountName: "厦门迪礼进出口有限公司",
    bankLabel: "招商银行5920",
    settlementMethod: "拨付备用金--招商银行5920",
    settlementAccountLabel: null,
    amount: "3000.0000",
  }));
  assert.deepEqual(lines.map((line) => [line.direction, line.subject_label]), [
    ["debit", "其他应收款-备用金"],
    ["credit", "银行存款—招商银行5920"],
  ]);
  assert.equal(lines[1].bank_id, "bank-cmb-corporate");
  assert.equal(isReceivableFamilySubject("其他应收款-备用金"), true);
  assert.equal(isReceivableFamilySubject("应收账款"), false, "应收账款是货款往来，不是备用金");
});

test("只写结算方式「备用金报销」、没选银行账户时也能识别（历史/手工流水）", () => {
  const line = fundLineFor({ direction: "expense", bankId: null, bankLabel: null, settlementMethod: "备用金报销", settlementAccountLabel: null, subjectLabel: "管理费用" });
  assert.equal(line.subject_key, "资产类/其他应收款-备用金");
  assert.equal(line.subject_label, PETTY_CASH_RECEIVABLE_SUBJECT);
  assert.equal(line.bank_id, null);
  // 反向守卫：收入方向不按报销处理；业务科目是「库存现金（备用金）」的取现也保持老口径。
  assert.equal(isPettyCashReimbursement({ direction: "income", subjectLabel: "管理费用", bankCode: "备用金" }), false);
  assert.equal(isPettyCashReimbursement({ direction: "expense", subjectLabel: "库存现金（备用金）", bankCode: "备用金" }), false);
});
