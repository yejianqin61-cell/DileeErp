// 凭证的纯逻辑（收支流水 → 借贷分录）。
//
// 这一层刻意不依赖 Nest/Prisma，所以这些用例跑的是「凭证长什么样」的业务口径本身：
// 收入=借资金贷业务科目、支出=借业务科目贷资金、金额恒为正、科目名做快照。
const assert = require("node:assert/strict");
const test = require("node:test");
const {
  FUND_SUBJECT_BANK, FUND_SUBJECT_CASH, fundLineFor, fundSubjectFor, reverseLines, voucherBalance, voucherLinesFor, voucherPeriodFor, voucherSummaryFor,
} = require("../../dist/modules/finance/voucher.domain.js");

const entry = (extra = {}) => ({
  entryNo: "CF-20260915-0001",
  entryDate: new Date("2026-09-15T00:00:00.000Z"),
  counterpartyName: "香港迪礼",
  direction: "income",
  amount: "14310.0000",
  currency: "USD",
  itemKey: "货款",
  itemLabel: "货款",
  settlementMethod: "转账--农业银行5706",
  settlementAccountLabel: "农业银行5706",
  remark: null,
  ...extra,
});

test("收入：借资金科目、贷业务科目（科目名取自收支项目，资金科目默认银行存款）", () => {
  const lines = voucherLinesFor(entry());
  assert.equal(lines.length, 2);
  assert.deepEqual(lines.map((line) => [line.line_no, line.direction, line.subject_label]), [
    [1, "debit", FUND_SUBJECT_BANK],
    [2, "credit", "货款"],
  ]);
  assert.deepEqual(lines.map((line) => line.amount), ["14310.0000", "14310.0000"], "金额恒为正数，方向由 direction 决定");
  assert.equal(lines[0].currency, "USD");
});

test("支出：借业务科目、贷资金科目（方向与收入相反）", () => {
  const lines = voucherLinesFor(entry({ direction: "expense", itemKey: "原材料 成本", itemLabel: "原材料 成本", amount: "5200.0000" }));
  assert.deepEqual(lines.map((line) => [line.direction, line.subject_label]), [
    ["debit", "原材料 成本"],
    ["credit", FUND_SUBJECT_BANK],
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

test("摘要 = 对方 · 收支项目（有备注就补在括号里），并截断到 500 字", () => {
  assert.equal(voucherSummaryFor({ counterpartyName: "香港迪礼", itemLabel: "货款" }), "香港迪礼 · 货款");
  assert.equal(voucherSummaryFor({ counterpartyName: "甲", itemLabel: "乙", remark: "9 月货款" }), "甲 · 乙（9 月货款）");
  assert.equal(voucherSummaryFor({ counterpartyName: "", itemLabel: "货款" }), "货款", "对方为空时不出现空的分隔符");
  assert.equal(voucherSummaryFor({ counterpartyName: "甲".repeat(400), itemLabel: "乙".repeat(400) }).length, 500);
});

test("会计期间取自凭证日期（YYYY-MM）", () => {
  assert.equal(voucherPeriodFor(new Date("2026-09-15T00:00:00.000Z")), "2026-09");
  assert.equal(voucherPeriodFor("2026-01-31T00:00:00.000Z"), "2026-01");
});

test("红字凭证：借/贷对调、金额不变、摘要加「红冲：」前缀", () => {
  const lines = reverseLines([
    { direction: "debit", subject_key: "银行存款", subject_label: "银行存款", summary: "香港迪礼 · 货款", amount: "100.0000", currency: "USD" },
    { direction: "credit", subject_key: "货款", subject_label: "货款", summary: "香港迪礼 · 货款", amount: "100.0000", currency: "USD" },
  ]);
  assert.deepEqual(lines.map((line) => [line.line_no, line.direction, line.subject_label]), [
    [1, "credit", "银行存款"],
    [2, "debit", "货款"],
  ]);
  assert.equal(lines[0].amount, "100.0000");
  assert.equal(lines[0].summary, "红冲：香港迪礼 · 货款");
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
  assert.equal(lines[1].bank_id, undefined, "业务科目（收支项目）不挂银行账户");
});

test("历史数据（没有银行账户、只有结算方式文本）按「现金」判断，且不写 bank_id", () => {
  const [bank] = voucherLinesFor(entry({ settlementAccountLabel: "农业银行5706" }));
  assert.equal(bank.subject_label, FUND_SUBJECT_BANK);
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
  const lines = reverseLines([{ direction: "debit", subject_key: FUND_SUBJECT_BANK, subject_label: "银行存款—农业银行5706", summary: "香港迪礼 · 货款", amount: "100.0000", currency: "CNY", bank_id: "bank-1" }]);
  assert.equal(lines[0].direction, "credit");
  assert.equal(lines[0].bank_id, "bank-1");
  assert.equal(lines[0].subject_label, "银行存款—农业银行5706");
});
