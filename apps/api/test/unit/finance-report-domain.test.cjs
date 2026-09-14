// 财务对账报表的派生口径测试。
//
// 这些断言不是「实现快照」：每一条都能对应 `example/财务/` 里老表的真实单元格
// （销售对账明细表第一/二行、销售利润报表），因此它们是**口径回归**，而不是代码复述。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { Prisma } = require("@prisma/client");
const {
  LOCAL_CURRENCY,
  NUMBER_FORMAT,
  currencyLabel,
  localAmountFor,
  localUnitPriceFor,
  salesExchangeRate,
  toDateText,
  toDecimal,
  toExportNumber,
} = require("../../dist/modules/finance/finance-report.domain.js");

const dec = (value) => new Prisma.Decimal(value);

/** 老表样本：销售对账明细表第一行（美元，本币金额 12475.56 ÷ 原币金额 1862.024 = 6.7）。 */
const USD_ORDER = { currency: "USD", totalAmount: dec("1862.024"), receivableAmount: null, localCurrencyAmount: dec("12475.56") };
/** 老表样本：销售对账明细表第二行（人民币，汇率 1、本币列与原币列同值）。 */
const CNY_ORDER = { currency: "CNY", totalAmount: dec("9600"), receivableAmount: null, localCurrencyAmount: null };

test("finance-report.rate：美元单据的汇率还原成老表的 6.7", () => {
  assert.equal(salesExchangeRate(USD_ORDER).toString(), "6.7", "12475.56 ÷ 1862.024 收敛到 6 位应是 6.7，不能是 6.6999995705…");
});

test("finance-report.rate：本位币单据汇率为 1（老表人民币行）", () => {
  assert.equal(salesExchangeRate(CNY_ORDER).toString(), "1");
  assert.equal(LOCAL_CURRENCY, "CNY", "本位币固定 CNY：local_currency_amount 的语义就是折算成人民币");
});

test("finance-report.rate：外币没有本币金额时留空，绝不回落成 1", () => {
  const rate = salesExchangeRate({ currency: "USD", totalAmount: dec("100"), receivableAmount: null, localCurrencyAmount: null });
  assert.equal(rate, null, "回落成 1 会把美元金额当人民币记账，宁可不显示");
});

test("finance-report.rate：缺失销售单时留空", () => {
  assert.equal(salesExchangeRate(null), null);
  assert.equal(salesExchangeRate(undefined), null);
});

test("finance-report.rate：总额缺失时退到应收金额（销售利润报表样本 164317.5 ÷ 24525 = 6.7）", () => {
  const rate = salesExchangeRate({ currency: "USD", totalAmount: null, receivableAmount: dec("24525"), localCurrencyAmount: dec("164317.5") });
  assert.equal(rate.toString(), "6.7");
});

test("finance-report.localAmount：整单出库时本币金额精确等于销售单的本币金额（不产生尾差）", () => {
  const amount = localAmountFor(dec("1862.024"), USD_ORDER);
  assert.equal(amount.toString(), "12475.56", "若按 1862.024 × 6.7 折算会得到 12475.5608，对账时与本币金额对不上");
});

test("finance-report.localAmount：分批出库按比例分摊，各行相加回到整单本币金额", () => {
  const first = localAmountFor(dec("1000"), USD_ORDER);
  const second = localAmountFor(dec("862.024"), USD_ORDER);
  assert.equal(first.plus(second).toString(), "12475.56", "分批出库的尾差必须收敛到销售单本币金额");
});

test("finance-report.localAmount：本位币单据本币金额等于原币金额", () => {
  assert.equal(localAmountFor(dec("9600"), CNY_ORDER).toString(), "9600");
  assert.equal(localAmountFor(dec("41.67"), CNY_ORDER).toString(), "41.67");
});

test("finance-report.localAmount：外币没有本币金额时留空", () => {
  const amount = localAmountFor(dec("100"), { currency: "USD", totalAmount: dec("100"), receivableAmount: null, localCurrencyAmount: null });
  assert.equal(amount, null);
});

test("finance-report.localUnitPrice：本币单价 × 数量恒等于本币金额（对账第一件要核的事）", () => {
  const localAmount = localAmountFor(dec("1862.024"), USD_ORDER);
  const localUnitPrice = localUnitPriceFor(localAmount, dec("41.67"));
  assert.equal(localUnitPrice.mul(dec("41.67")).toDecimalPlaces(6).toString(), localAmount.toDecimalPlaces(6).toString());
  assert.equal(localUnitPrice.toDecimalPlaces(3).toString(), "299.389", "老表样本写的是 299.389");
});

test("finance-report.localUnitPrice：数量为 0 或缺失时留空（不能除以 0）", () => {
  assert.equal(localUnitPriceFor(dec("100"), dec("0")), null);
  assert.equal(localUnitPriceFor(dec("100"), null), null);
  assert.equal(localUnitPriceFor(null, dec("10")), null);
});

test("finance-report.toExportNumber：0 是「确实为零」，必须导出成 0 而不是留空", () => {
  assert.equal(toExportNumber(dec("0")), 0);
  assert.equal(toExportNumber("0"), 0);
  assert.equal(toExportNumber(0), 0);
});

test("finance-report.toExportNumber：空值导出成 null（空单元格），不是 0 也不是空字符串", () => {
  assert.equal(toExportNumber(null), null);
  assert.equal(toExportNumber(undefined), null);
  assert.equal(toExportNumber(""), null);
  assert.equal(toExportNumber("不是数字"), null);
});

test("finance-report.toExportNumber：结果必须是 JS number（Excel 数值类型）", () => {
  assert.equal(typeof toExportNumber(dec("1862.0240")), "number");
  assert.equal(toExportNumber(dec("1862.0240")), 1862.024);
  assert.equal(toExportNumber(dec("12475.5600")), 12475.56);
});

test("finance-report.toDateText：日期写成 YYYY-MM-DD 文本", () => {
  assert.equal(toDateText(new Date("2026-09-07T00:00:00.000Z")), "2026-09-07");
  assert.equal(toDateText(null), null);
  assert.equal(toDateText(new Date("invalid")), null);
});

test("finance-report.currencyLabel：代码转中文标签，未登记回落原代码", () => {
  const labels = new Map([["USD", "美元"], ["CNY", "人民币"]]);
  assert.equal(currencyLabel("USD", labels), "美元");
  assert.equal(currencyLabel("CNY", labels), "人民币");
  assert.equal(currencyLabel("XYZ", labels), "XYZ", "未登记币种回落原代码，不能丢信息");
  assert.equal(currencyLabel(null, labels), null);
});

test("finance-report.toDecimal：空字符串与非法值都当空，不抛异常", () => {
  assert.equal(toDecimal(""), null);
  assert.equal(toDecimal(null), null);
  assert.equal(toDecimal("abc"), null);
  assert.equal(toDecimal("1.5").toString(), "1.5");
});

test("finance-report.NUMBER_FORMAT：数值格式逐格还原老表显示（0 位到 4 位小数）", () => {
  assert.equal(NUMBER_FORMAT, "0.####", "老表同一列里既有 99 也有 1862.024 还有 12475.56，固定小数位会对不上");
});
