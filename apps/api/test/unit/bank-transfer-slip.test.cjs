// 跨行转账单（财务 2026-09-24 交付的 `example/财务/跨行转账单.html`）的纯逻辑、版式与服务测试。
//
// 财务的原话：「银行账户互转的时候，跨行转账单，支持编辑这个样式的表单，并且支持导出打印」。
//
// 四组断言：
//   1. **预填**：双方全称/账号/开户行从两个银行账户来、日期币种金额汇率从互转单来、
//      折合人民币取「是人民币的那条腿」（外币转外币留空）、联行号与四个签字格留空；
//   2. **校验**：缺格一次说完；金额大写与折合人民币不一致时必须报错并给出正确写法
//      （一张大写与小写对不上的银行单据会被退回或被读错）；
//   3. **版式**：标题 / 单据编号 / 三段（付款方 / 收款方 / 转账金额）/ 大写 / 用途 / 签字栏 / 注，
//      金额是 Excel 数值类型，签字栏只印制单人（印名字等于替人签了）；
//   4. **服务**：预填查不到互转单是 404；导出记一条带来源互转单的审计。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { Prisma } = require("@prisma/client");
const XLSX = require("xlsx");
const {
  TRANSFER_SLIP_LABELS,
  bankTransferSlipFileName,
  bankTransferSlipFromTransfer,
  renderBankTransferSlipWorkbook,
  transferSlipWords,
  trimDecimal,
  validateBankTransferSlip,
} = require("../../dist/modules/finance/bank-transfer-slip.js");
const { BankTransferSlipService } = require("../../dist/modules/finance/bank-transfer-slip.service.js");

const USER = { id: "user-1", username: "ye", display_name: "小叶" };

/** 一笔「人民币 → 人民币」的互转（最常见的那种）。 */
const transfer = (extra = {}) => ({
  transferNo: "BTR-20260924-ABCD1234",
  transferDate: new Date("2026-09-24T00:00:00.000Z"),
  fromCurrency: "CNY",
  toCurrency: "CNY",
  fromAmount: new Prisma.Decimal("10000"),
  toAmount: new Prisma.Decimal("10000"),
  exchangeRate: new Prisma.Decimal("1.000000"),
  remark: "月末资金归集",
  fromBank: { bankName: "中国农业银行", accountName: "迪礼工贸有限公司", accountNumber: "40390001040045706" },
  toBank: { bankName: "中国银行（人民币）", accountName: "迪礼工贸有限公司", accountNumber: "762400001234" },
  ...extra,
});

const readSheet = (buffer) => {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const name = workbook.SheetNames[0];
  const sheet = workbook.Sheets[name];
  return { name, sheet, rows: XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null, blankrows: true }) };
};

test("跨行转账单预填：逐格对应（双方全称/账号/开户行、日期、币种、汇率、金额、用途、制单人）", () => {
  const slip = bankTransferSlipFromTransfer(transfer(), "小叶");
  assert.equal(slip.document_no, "BTR-20260924-ABCD1234", "单据编号默认取互转单号（她可以改成银行要的号）");
  assert.equal(slip.payer_name, "迪礼工贸有限公司", "付款人全称 = 转出账户的**账户名**");
  assert.equal(slip.payer_account, "40390001040045706");
  assert.equal(slip.payer_bank, "中国农业银行");
  assert.equal(slip.payee_name, "迪礼工贸有限公司");
  assert.equal(slip.payee_account, "762400001234");
  assert.equal(slip.payee_bank, "中国银行（人民币）");
  assert.equal(slip.payee_bank_no, "", "联行号系统里没有存档：留空比填一个猜来的号安全（错号会把钱转到别人账上）");
  assert.equal(slip.transfer_date, "2026-09-24");
  assert.equal(slip.currency, "CNY");
  assert.equal(slip.exchange_rate, "1", "汇率去掉没意义的尾零（1.000000 → 1）");
  assert.equal(slip.amount_original, "10000");
  assert.equal(slip.amount_cny, "10000");
  assert.equal(slip.remark, "月末资金归集");
  assert.equal(slip.maker, "小叶");
  assert.deepEqual([slip.reviewer, slip.cashier, slip.approver], ["", "", ""], "签字格留空：那三格是手签的");
  assert.deepEqual(validateBankTransferSlip(slip), [], "预填出来的单子直接就能导出");
});

test("跨行转账单预填：折合人民币取「是人民币的那条腿」，外币转外币则留空", () => {
  // 美元 → 人民币：折合人民币取转入（到账）数。
  const toCny = bankTransferSlipFromTransfer(transfer({ fromCurrency: "USD", fromAmount: new Prisma.Decimal("1000"), toCurrency: "CNY", toAmount: new Prisma.Decimal("7200"), exchangeRate: new Prisma.Decimal("7.200000") }), "小叶");
  assert.equal(toCny.currency, "USD");
  assert.equal(toCny.amount_original, "1000");
  assert.equal(toCny.amount_cny, "7200");
  assert.equal(toCny.exchange_rate, "7.2");
  assert.equal(transferSlipWords(toCny), "柒仟贰佰元整", "大写按折合人民币算");

  // 人民币 → 美元：原币就是人民币，折合人民币 = 原币（转出那条腿）。
  const fromCny = bankTransferSlipFromTransfer(transfer({ toCurrency: "USD", toAmount: new Prisma.Decimal("1000"), toBank: { bankName: "中国银行（美元）", accountName: "迪礼工贸有限公司", accountNumber: "7624" }, exchangeRate: new Prisma.Decimal("7.200000") }), "小叶");
  assert.equal(fromCny.currency, "CNY");
  assert.equal(fromCny.amount_cny, "10000");

  // 美元 → 美元：两条腿都不是人民币，那一格必须留空（外币转外币没有「折合人民币」这件事）。
  const usdToUsd = bankTransferSlipFromTransfer(transfer({ fromCurrency: "USD", fromAmount: new Prisma.Decimal("1000"), toCurrency: "USD", toAmount: new Prisma.Decimal("1000"), exchangeRate: null }), "小叶");
  assert.equal(usdToUsd.amount_cny, "");
  assert.equal(usdToUsd.exchange_rate, "", "汇率缺失时留空（人民币转账可划去汇率栏）");
  assert.equal(transferSlipWords(usdToUsd), null, "算不出人民币大写（这时由财务自己写或不写）");
  assert.deepEqual(validateBankTransferSlip(usdToUsd), [], "没有折合人民币也能导出");
});

test("跨行转账单校验：缺格一次说完；金额/汇率必须为正数", () => {
  const base = bankTransferSlipFromTransfer(transfer(), "小叶");
  assert.deepEqual(
    validateBankTransferSlip({ ...base, document_no: " ", payer_name: "", payer_account: "", payee_name: "", payee_account: "" }).map((problem) => problem.code),
    ["TRANSFER_SLIP_NO_REQUIRED", "TRANSFER_SLIP_PAYER_REQUIRED", "TRANSFER_SLIP_PAYER_ACCOUNT_REQUIRED", "TRANSFER_SLIP_PAYEE_REQUIRED", "TRANSFER_SLIP_PAYEE_ACCOUNT_REQUIRED"],
  );
  assert.equal(validateBankTransferSlip({ ...base, transfer_date: "2026/09/24" })[0].code, "TRANSFER_SLIP_DATE_INVALID");
  assert.equal(validateBankTransferSlip({ ...base, amount_original: "0" })[0].code, "TRANSFER_SLIP_AMOUNT_INVALID");
  assert.equal(validateBankTransferSlip({ ...base, amount_cny: "-1" })[0].code, "TRANSFER_SLIP_CNY_AMOUNT_INVALID");
  assert.equal(validateBankTransferSlip({ ...base, exchange_rate: "abc" })[0].code, "TRANSFER_SLIP_RATE_INVALID");
  // 开户行、联行号、用途、签字格都不是必填（银行单据上没有它们仍然成立）。
  assert.deepEqual(validateBankTransferSlip({ ...base, payer_bank: "", payee_bank: "", payee_bank_no: "", remark: "", maker: "", reviewer: "", cashier: "", approver: "" }), []);
});

test("跨行转账单校验：自己写的大写与折合人民币不一致就报错，并把正确写法给出来", () => {
  const base = bankTransferSlipFromTransfer(transfer(), "小叶");
  const written = { ...base, amount_in_words: "壹万元整" };
  assert.deepEqual(validateBankTransferSlip(written), [], "写对了就放行（她可以自己写）");
  const wrong = { ...base, amount_in_words: "壹仟元整" };
  const problems = validateBankTransferSlip(wrong);
  assert.equal(problems[0].code, "TRANSFER_SLIP_WORDS_MISMATCH");
  assert.ok(problems[0].message.includes("壹万元整"), `错误消息要给出正确写法，实际：${problems[0].message}`);
  assert.equal(problems[0].details[0].expected, "壹万元整");
});

test("跨行转账单：汇率尾零的处理（7.200000 → 7.2，1.000000 → 1，整数原样）", () => {
  assert.equal(trimDecimal("7.200000"), "7.2");
  assert.equal(trimDecimal("1.000000"), "1");
  assert.equal(trimDecimal("10000"), "10000");
  assert.equal(trimDecimal("0.5000"), "0.5");
  assert.equal(trimDecimal(" abc "), "abc", "不是十进制就原样返回（校验会另外拦）");
});

test("跨行转账单版式：三段布局逐格对齐模板，金额是数值，签字栏只印制单人", async () => {
  const slip = bankTransferSlipFromTransfer(transfer(), "小叶");
  const { name, sheet, rows } = readSheet(await renderBankTransferSlipWorkbook({ ...slip, footnote: "制表人：小叶；制表时间：2026-09-24 13:00:00（北京时间）" }));

  assert.equal(name, "跨行转账单");
  assert.equal(rows[0][0], TRANSFER_SLIP_LABELS.title);
  assert.equal(rows[1][0], `${TRANSFER_SLIP_LABELS.documentNo}BTR-20260924-ABCD1234`);
  assert.equal(rows[2][0], TRANSFER_SLIP_LABELS.payerSection);
  assert.equal(rows[3][0], TRANSFER_SLIP_LABELS.payerName);
  assert.equal(rows[3][1], "迪礼工贸有限公司");
  assert.equal(rows[4][0], TRANSFER_SLIP_LABELS.payerAccount);
  assert.equal(rows[4][2], TRANSFER_SLIP_LABELS.payerBank);
  assert.equal(rows[5][0], TRANSFER_SLIP_LABELS.payeeSection);
  assert.equal(rows[6][0], TRANSFER_SLIP_LABELS.payeeName);
  assert.equal(rows[7][2], TRANSFER_SLIP_LABELS.payeeBank);
  assert.equal(rows[8][0], TRANSFER_SLIP_LABELS.payeeBankNo);
  assert.equal(rows[8][2], TRANSFER_SLIP_LABELS.transferDate);
  assert.equal(rows[8][3], "2026-09-24");
  assert.equal(rows[9][0], TRANSFER_SLIP_LABELS.amountSection);
  assert.equal(rows[10][0], TRANSFER_SLIP_LABELS.currency);
  assert.equal(rows[10][2], TRANSFER_SLIP_LABELS.exchangeRate);
  assert.equal(rows[11][0], TRANSFER_SLIP_LABELS.amountOriginal);
  assert.equal(rows[11][1], 10000, "原币金额落数值类型（财务拿到要能求和、能排序）");
  assert.equal(rows[11][2], TRANSFER_SLIP_LABELS.amountCny);
  assert.equal(rows[11][3], 10000);
  assert.equal(rows[12][0], TRANSFER_SLIP_LABELS.amountInWords);
  assert.equal(rows[12][1], "壹万元整", "大写由后端按折合人民币算（前端不算中文大写）");
  assert.equal(rows[13][0], TRANSFER_SLIP_LABELS.remark);
  assert.equal(rows[13][1], "月末资金归集");
  assert.equal(rows[15][0], `${TRANSFER_SLIP_LABELS.maker}小叶`);
  assert.deepEqual(rows[15].slice(1, 4), [`${TRANSFER_SLIP_LABELS.reviewer}`, `${TRANSFER_SLIP_LABELS.cashier}`, `${TRANSFER_SLIP_LABELS.approver}`], "其余三格只有标签，印名字等于替人签了");
  assert.equal(rows[17][0], TRANSFER_SLIP_LABELS.note);
  assert.equal(rows[18][0], "制表人：小叶；制表时间：2026-09-24 13:00:00（北京时间）");
  // 金额两格（B12/D12）不允许是文本型数字。
  for (const address of ["B12", "D12"]) assert.equal(sheet[address].t, "n", `${address} 必须是数值单元格`);
});

test("跨行转账单服务：预填按互转单取数（含账户全称），查不到即 404", async () => {
  const calls = [];
  const prisma = {
    bankTransfer: {
      findFirst: async (args) => { calls.push(args); return transfer(); },
    },
  };
  const service = new BankTransferSlipService(prisma, { record: async () => {} });
  const slip = await service.draft("t-1", USER);
  assert.equal(slip.transfer_id, "t-1", "预填结果带上来源互转单 id：导出时进审计");
  assert.equal(slip.payer_name, "迪礼工贸有限公司");
  assert.equal(calls[0].where.id, "t-1");
  assert.equal(calls[0].select.fromBank.select.accountName, true, "账户全称必须在 select 里（列表接口不带它，所以预填只能由服务端给）");

  const missing = new BankTransferSlipService({ bankTransfer: { findFirst: async () => null } }, { record: async () => {} });
  await assert.rejects(() => missing.draft("t-9", USER), (error) => error.getResponse().code === "BANK_TRANSFER_NOT_FOUND");
});

test("跨行转账单导出：记一条带来源与金额的审计，文件名带单据编号；校验不过不下发", async () => {
  const events = [];
  const service = new BankTransferSlipService({}, { record: async (...args) => events.push(args) });
  const slip = bankTransferSlipFromTransfer(transfer(), "小叶");
  const result = await service.export({ ...slip, transfer_id: "t-1" }, USER);
  assert.equal(result.fileName, "迪礼跨行转账单-BTR-20260924-ABCD1234.xlsx");
  assert.equal(events.length, 1);
  assert.equal(events[0][0], "bank_transfer_slip.export");
  assert.equal(events[0][1], "bank_transfer_slip");
  assert.equal(events[0][3], "t-1", "审计的实体 id 是来源互转单：从这张纸追得回那笔资金动作");
  assert.equal(events[0][4].amount_cny, "10000");
  assert.equal(events[0][4].amount_in_words, "壹万元整");
  const buffer = Buffer.from(result.body);
  assert.equal(buffer.length > 0, true);

  const broken = new BankTransferSlipService({}, { record: async () => { throw new Error("校验不过不该记审计"); } });
  await assert.rejects(
    () => broken.export({ ...slip, transfer_id: "", payee_account: "", amount_in_words: "壹仟元整" }, USER),
    (error) => {
      const response = error.getResponse();
      assert.equal(response.code, "TRANSFER_SLIP_PAYEE_ACCOUNT_REQUIRED", "报第一个问题，全部问题都在 message 里");
      assert.ok(response.message.includes("收款账号") && response.message.includes("壹万元整"));
      return true;
    },
  );
});

test("跨行转账单：文件名在没有编号时不编一个", () => {
  assert.equal(bankTransferSlipFileName({ document_no: "  " }), "迪礼跨行转账单-未编号.xlsx");
});
