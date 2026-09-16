// 银行余额与互转的**纯计算**测试（不连数据库、不启动 HTTP）。
//
// 为什么这一层要单独测：余额是财务对着银行对账单核的数字。如果算法散在服务层里，
// 「列表页一个余额、互转页另一个余额」这种偏差只能靠人眼发现；把它抽成一个纯函数之后，
// 口径就是可断言的。跨币种转账的「两边金额必须相等 / 必须显式给到账数」同理 ——
// 那是账能不能对上的边界，不是格式校验。
const assert = require("node:assert/strict");
const test = require("node:test");
const { Prisma } = require("@prisma/client");
const { bankBalance, emptyBankBalanceParts, transferAmounts, transferEffect } = require("../../dist/modules/finance/bank-balance.domain.js");

const dec = (value) => new Prisma.Decimal(value);

test("余额公式：期初 + 收入 − 支出 + 转入 − 转出", () => {
  const balance = bankBalance("1000", { cashIn: dec("500"), cashOut: dec("200.5"), transferIn: dec("300"), transferOut: dec("100.25") });
  assert.equal(balance.balance.toFixed(4), "1499.2500");
  assert.equal(balance.opening.toFixed(4), "1000.0000");
  // 四个分量必须原样给出：余额对不上时财务要能定位是哪一段错了，只给净额等于把问题藏起来。
  assert.equal(balance.cashIn.toFixed(4), "500.0000");
  assert.equal(balance.cashOut.toFixed(4), "200.5000");
  assert.equal(balance.transferIn.toFixed(4), "300.0000");
  assert.equal(balance.transferOut.toFixed(4), "100.2500");
});

test("没有期初（undefined/null）按 0 处理，不会算出 NaN", () => {
  assert.equal(bankBalance(undefined, emptyBankBalanceParts()).balance.toFixed(4), "0.0000");
  assert.equal(bankBalance(null, emptyBankBalanceParts()).balance.toFixed(4), "0.0000");
});

test("余额可以是负数（透支/漏录是要看得见的事实，不是要藏起来的错误）", () => {
  assert.equal(bankBalance("100", { ...emptyBankBalanceParts(), cashOut: dec("350") }).balance.toFixed(4), "-250.0000");
});

test("同币种互转：不给对方金额时默认等于本方金额，汇率为 1", () => {
  const result = transferAmounts({ fromAmount: "1000", fromCurrency: "CNY", toCurrency: "CNY" });
  assert.equal(result.ok, true);
  assert.equal(result.value.toAmount.toFixed(4), "1000.0000");
  assert.equal(result.value.exchangeRate.toFixed(6), "1.000000");
});

test("同币种互转：两边金额不等直接拒绝（凭空多钱/少钱没有科目承载）", () => {
  const result = transferAmounts({ fromAmount: "1000", toAmount: "999", fromCurrency: "CNY", toCurrency: "CNY" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "SAME_CURRENCY_AMOUNT_MISMATCH");
});

test("跨币种互转：必须显式给到账金额，汇率按 to/from 记 6 位小数", () => {
  const missing = transferAmounts({ fromAmount: "1000", fromCurrency: "USD", toCurrency: "CNY" });
  assert.equal(missing.ok, false, "跨币种没有默认汇率，必须由财务填实际到账数");
  const result = transferAmounts({ fromAmount: "1000", toAmount: "7150", fromCurrency: "USD", toCurrency: "CNY" });
  assert.equal(result.ok, true);
  assert.equal(result.value.exchangeRate.toFixed(6), "7.150000");
});

test("金额必须是大于零的十进制数（零与负数都不是互转）", () => {
  for (const value of ["0", "-1", "abc", ""]) {
    const result = transferAmounts({ fromAmount: value, fromCurrency: "CNY", toCurrency: "CNY" });
    assert.equal(result.ok, false, `${JSON.stringify(value)} 必须被拒绝`);
    assert.equal(result.code, "INVALID_TRANSFER_AMOUNT");
  }
  assert.equal(transferAmounts({ fromAmount: "100", toAmount: "0", fromCurrency: "USD", toCurrency: "CNY" }).ok, false);
});

test("空串的对方金额视为「没给」（表单清空后提交的是空串，不能当成 0）", () => {
  const result = transferAmounts({ fromAmount: "100", toAmount: "", fromCurrency: "CNY", toCurrency: "CNY" });
  assert.equal(result.ok, true);
  assert.equal(result.value.toAmount.toFixed(4), "100.0000");
});

test("transferEffect：转出方为负、转入方为正、无关方为 0", () => {
  const row = { fromBankId: "bank-a", fromAmount: dec("100"), toBankId: "bank-b", toAmount: dec("715") };
  assert.equal(transferEffect("bank-a", row).toFixed(4), "-100.0000");
  assert.equal(transferEffect("bank-b", row).toFixed(4), "715.0000");
  assert.equal(transferEffect("bank-c", row).toFixed(4), "0.0000");
});
