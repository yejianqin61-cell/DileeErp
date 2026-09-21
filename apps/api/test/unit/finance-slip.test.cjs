// 收/付款单（财务 2026-09-20 交付的 Excel 模板）的纯逻辑与版式测试。
//
// 四组断言对应四件必须钉死的事：
//   1. **金额转中文大写**：单子上「金额（大写）」是银行看的格子，错一个字整张单子作废 ——
//      用例表逐条对齐财务模板样张（`149.50 → 壹佰肆拾玖元伍角整`）；
//   2. **借贷合计与校验**：界面上「导出」按钮能不能点、后端收不收，用的是同一套纯函数；
//   3. **版式**：标题 / 四行表头 / 分录表 / 合计行 / 大写行 / 备注行 / 两行签字栏的位置，
//      以及**金额必须是 Excel 数值类型**（文本型数字在 Excel 里 SUM 得 0）；
//   4. **付款单与收款单是同一套实现、只差用词**：两种单据各跑一遍版式与校验，
//      任何一边把文案写歪（「收款单必须填写收款单位」）都会红 —— 这正是用户
//      「同理，收款单的编辑和导出」那句话的落点。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const XLSX = require("xlsx");
const {
  amountInWords,
  financeSlipFileName,
  renderFinanceSlipWorkbook,
  slipLabels,
  slipTotals,
  validateFinanceSlip,
} = require("../../dist/modules/finance/finance-slip.js");

const PAY = slipLabels("payment");
const RECEIPT = slipLabels("receipt");

function readSheet(buffer) {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const name = workbook.SheetNames[0];
  const sheet = workbook.Sheets[name];
  return { name, sheet, rows: XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null, blankrows: true }) };
}

/**
 * 金额区扫描：不允许存在「看起来是数字却写成文本」的单元格（Excel 里无法求和/筛选/排序）。
 *
 * 只扫**分录表与合计/大写行**的金额列（D/E，行号 ≥ 6）：单子的表头区里有**本来就该是文本**的
 * 数字串 —— 银行账号 `7624` 写成数值会丢前导零、也会被 Excel 当金额右对齐。报表那套「全表扫描」
 * 在这里不适用（那里每一列都是数据，这里表头是表单）。
 */
function assertNoTextNumbers(sheet) {
  const offenders = [];
  for (const [address, cell] of Object.entries(sheet)) {
    if (address.startsWith("!")) continue;
    const match = /^([A-F]+)(\d+)$/.exec(address);
    if (!match || Number(match[2]) < 6 || !["D", "E"].includes(match[1])) continue;
    if (cell.t === "s" && typeof cell.v === "string" && /^-?\d+(\.\d+)?$/.test(cell.v.trim())) offenders.push(`${address}=${cell.v}`);
  }
  assert.deepEqual(offenders, [], "金额列不允许把数字写成文本单元格（Excel 里无法求和/筛选/排序）");
}

const line = (extra = {}) => ({ summary: "", general_subject: "", detail_subject: "", debit: "", credit: "", remark: "", ...extra });

/** 财务模板样张的那张付款单：借 原材料 130、借 应交税费-进项税 19.50、贷 银行存款 149.50。 */
const SAMPLE = {
  kind: "payment",
  slip_no: "FK-202609-001",
  slip_date: "2026-09-20",
  slip_method: "银行转账",
  counterparty_name: "富雨鑫",
  bank_name: "中国农业银行",
  bank_account: "4039 0001 0400 45706",
  attachment_count: 1,
  remark: "月结 30 天，款到发货",
  maker: "小叶",
  lines: [
    line({ summary: "支付富雨鑫材料款", general_subject: "原材料", debit: "130.00" }),
    line({ summary: "应交税费-进项税", debit: "19.50" }),
    line({ summary: "支付富雨鑫材料款（含税）", general_subject: "银行存款", detail_subject: "中国农业银行", credit: "149.50" }),
  ],
};

/** 收款单是付款单的镜像：借 银行存款 149.50、贷 主营业务收入 130 + 应交税费 19.50。 */
const RECEIPT_SAMPLE = {
  kind: "receipt",
  slip_no: "SK-202609-001",
  slip_date: "2026-09-20",
  slip_method: "银行转账",
  counterparty_name: "香港迪礼",
  bank_name: "中国银行",
  bank_account: "7624",
  attachment_count: 2,
  remark: "月结 30 天",
  maker: "小叶",
  lines: [
    line({ summary: "收香港迪礼折叠伞款", general_subject: "主营业务收入", credit: "130.00" }),
    line({ summary: "销项税额", general_subject: "应交税费-销项税", credit: "19.50" }),
    line({ summary: "收香港迪礼款项合计", general_subject: "银行存款", detail_subject: "中国银行", debit: "149.50" }),
  ],
};

// --------------------------------------------------------------------------- 人民币大写

/**
 * 用例表与财务模板样张逐条对齐。
 *
 * ⚠️ 大写金额**只有后端这一份实现**（前端编辑器刻意不预览它）：改动这张表时先想清楚
 * 「导出的那份还是权威吗」—— 前端若哪天要预览，应当调接口，而不是再抄一份算法。
 */
test("finance-slip：人民币大写与模板样张逐字一致", () => {
  const cases = [
    ["149.50", "壹佰肆拾玖元伍角整"], // 模板样张
    ["100", "壹佰元整"],
    ["130", "壹佰叁拾元整"],
    ["19.50", "壹拾玖元伍角整"],
    ["0.50", "伍角整"],
    ["0.05", "伍分"],
    ["0.55", "伍角伍分"],
    ["1.05", "壹元零伍分"],
    ["10", "壹拾元整"],
    ["1005.20", "壹仟零伍元贰角整"],
    ["10000", "壹万元整"],
    ["140000", "壹拾肆万元整"],
    ["100000005", "壹亿零伍元整"],
    ["100050000", "壹亿零伍万元整"],
    ["1000000000000", "壹万亿元整"],
    // 4 位小数按「分」四舍五入（不能截断，否则合计与单据金额差一分）
    ["1.005", "壹元零壹分"],
    ["2.9949", "贰元玖角玖分"],
  ];
  for (const [amount, expected] of cases) assert.equal(amountInWords(amount), expected, `${amount} 的大写`);
});

test("finance-slip：非法金额不许静默算成零元整", () => {
  for (const bad of ["", "0", "-5", "abc", "1.23456"]) {
    assert.throws(() => amountInWords(bad), /invalid-amount/, `${bad} 必须显式报错`);
  }
});

// --------------------------------------------------------------------------- 合计与校验

test("finance-slip：借贷合计按「分」精确相加（浮点求和会让明明平了的单子导不出去）", () => {
  const totals = slipTotals([line({ debit: "0.1" }), line({ debit: "0.2" }), line({ credit: "0.3" })]);
  assert.equal(totals.debit, "0.3");
  assert.equal(totals.credit, "0.3");
  assert.equal(totals.balanced, true);
  assert.equal(totals.invalid, false);
});

test("finance-slip：一行同时填借贷两侧算「填错了」，空行是「还没填完」，两者分开报", () => {
  const both = slipTotals([line({ debit: "10", credit: "10" })]);
  assert.equal(both.invalid, true);
  assert.equal(both.balanced, false);
  const blank = slipTotals([line({ summary: "占位" })]);
  assert.equal(blank.invalid, false, "两侧都没填不是「填错了」，由校验单独说「第 N 行请填金额」");
  assert.equal(blank.empty, true);
  assert.equal(blank.balanced, false);
});

test("finance-slip：模板样张那张付款单能导出；缺表头 / 行里没金额 / 借贷不平都会被挡下并指到具体哪一行", () => {
  assert.deepEqual(validateFinanceSlip(SAMPLE), [], "样张必须能导出");

  const problems = validateFinanceSlip({
    ...SAMPLE,
    slip_no: "  ",
    counterparty_name: "",
    slip_date: "2026/09/20",
    lines: [line({ summary: "第一行没问题", debit: "10" }), line({ summary: "第二行没金额" }), line({ summary: "第三行两边都填了", debit: "5", credit: "5" })],
  });
  const codes = problems.map((problem) => problem.code);
  assert.deepEqual(codes, [
    "SLIP_NO_REQUIRED",
    "SLIP_COUNTERPARTY_REQUIRED",
    "SLIP_DATE_INVALID",
    "SLIP_LINE_AMOUNT_REQUIRED",
    "SLIP_LINE_BOTH_SIDES",
  ], "一次把全部问题说出来（含行号），不让财务改一个试一次");
  assert.equal(problems[3].details[0].row, 2, "金额缺失要指到第 2 行");
  assert.equal(problems[4].details[0].row, 3, "两边都填要指到第 3 行");
  assert.equal(problems[1].message, "付款单必须填写收款单位", "文案按种类取对方的称谓");
});

test("finance-slip：借贷不平 / 摘要与总账科目都空 / 没有分录 各自有自己的错误码", () => {
  assert.equal(validateFinanceSlip({ ...SAMPLE, lines: [line({ summary: "只有借方", debit: "10" })] })[0].code, "SLIP_NOT_BALANCED");
  // 模板样张第 2 行就是把科目名写在「摘要」里、总账科目空着 —— 所以两列有一列就算写过了。
  assert.deepEqual(validateFinanceSlip({ ...SAMPLE, lines: [line({ debit: "10" }), line({ credit: "10" })] })
    .map((problem) => problem.code), ["SLIP_LINE_TEXT_REQUIRED", "SLIP_LINE_TEXT_REQUIRED"]);
  assert.equal(validateFinanceSlip({ ...SAMPLE, lines: [] })[0].code, "SLIP_LINE_REQUIRED");
});

test("finance-slip：收款单用同一套校验，文案说的是「付款单位」而不是「收款单位」", () => {
  assert.deepEqual(validateFinanceSlip(RECEIPT_SAMPLE), [], "镜像的那张收款单同样必须能导出");
  const problems = validateFinanceSlip({ ...RECEIPT_SAMPLE, counterparty_name: "", slip_no: "" });
  assert.deepEqual(problems.map((problem) => problem.code), ["SLIP_NO_REQUIRED", "SLIP_COUNTERPARTY_REQUIRED"]);
  assert.equal(problems[1].message, "收款单必须填写付款单位");
  assert.equal(validateFinanceSlip({ ...RECEIPT_SAMPLE, lines: [line({ summary: "只有贷方", credit: "10" })] })[0].message.includes("借贷不平衡"), true);
});

// --------------------------------------------------------------------------- 版式

test("finance-slip：付款单版式与财务模板逐格对齐（标题 / 表头 / 分录 / 合计 / 大写 / 备注 / 签字栏）", async () => {
  const { name, rows, sheet } = readSheet(await renderFinanceSlipWorkbook(SAMPLE));
  assert.equal(name, "付款单");
  assert.equal(rows[0][0], PAY.title, "第一行是标题");
  // R2：单据编号 / 付款日期 / 付款方式 三组「标签 + 值」
  assert.deepEqual(rows[1].slice(0, 6), [PAY.slipNo, "FK-202609-001", PAY.dateLabel, "2026-09-20", PAY.methodLabel, "银行转账"]);
  // R3：收款单位 + 开户银行（值跨列，读回来仍在 D 位置）
  assert.equal(rows[2][0], PAY.counterpartyLabel);
  assert.equal(rows[2][1], "富雨鑫");
  assert.equal(rows[2][2], PAY.bankName);
  assert.equal(rows[2][3], "中国农业银行");
  // R4：银行账号 + 附单据 N 张
  assert.deepEqual([rows[3][0], rows[3][1], rows[3][3], rows[3][4], rows[3][5]], [PAY.bankAccount, "4039 0001 0400 45706", PAY.attachment, 1, PAY.attachmentUnit]);
  // R5 表头
  assert.deepEqual(rows[4], [PAY.summary, PAY.generalSubject, PAY.detailSubject, PAY.debit, PAY.credit, PAY.remarkColumn]);
  // R6–R8 分录：借方只在 D、贷方只在 E，另一侧是真正的空单元格
  assert.deepEqual(rows[5].slice(0, 6), ["支付富雨鑫材料款", "原材料", null, 130, null, null]);
  assert.deepEqual(rows[6].slice(0, 6), ["应交税费-进项税", null, null, 19.5, null, null]);
  assert.deepEqual(rows[7].slice(0, 6), ["支付富雨鑫材料款（含税）", "银行存款", "中国农业银行", null, 149.5, null]);
  for (const address of ["C6", "E6", "F6", "B7", "C7", "E7", "F7", "D8", "F8"]) {
    assert.equal(sheet[address]?.v ?? null, null, `${address} 必须是空单元格（写 0 会被当成「确实为零」的事实）`);
  }
  // R9 合计 + 借贷平衡标记
  assert.deepEqual(rows[8].slice(0, 6), [PAY.total, null, null, 149.5, 149.5, PAY.balanced]);
  // R10 付款金额（大写）+ 小写
  assert.equal(rows[9][0], PAY.amountInWordsLabel);
  assert.equal(rows[9][1], "壹佰肆拾玖元伍角整");
  assert.equal(rows[9][5], 149.5);
  // R11 付款备注（用户要求「我可以写付款备注」）
  assert.equal(rows[10][0], PAY.remarkLabel);
  assert.equal(rows[10][1], "月结 30 天，款到发货");
  // R12–R13 两行签字栏，制单人已经填好（其余留空给手签），最后一格是「领款人」
  assert.deepEqual(rows[11].slice(0, 6), [PAY.maker, "小叶", PAY.reviewer, null, PAY.cashier, null]);
  assert.deepEqual(rows[12].slice(0, 6), [PAY.department, null, PAY.financeHead, null, PAY.signerLabel, null]);
  assertNoTextNumbers(sheet);
});

test("finance-slip：收款单版式与付款单同构，用词与借贷方向都是镜像", async () => {
  const { name, rows, sheet } = readSheet(await renderFinanceSlipWorkbook(RECEIPT_SAMPLE));
  assert.equal(name, "收款单");
  assert.equal(rows[0][0], RECEIPT.title);
  assert.deepEqual(rows[1].slice(0, 4), [RECEIPT.slipNo, "SK-202609-001", RECEIPT.dateLabel, "2026-09-20"]);
  assert.equal(rows[2][0], RECEIPT.counterpartyLabel, "收款单上对方是「付款单位」");
  assert.equal(rows[2][1], "香港迪礼");
  // 贷方两条、借方一条（与付款单相反）
  assert.deepEqual(rows[5].slice(0, 6), ["收香港迪礼折叠伞款", "主营业务收入", null, null, 130, null]);
  assert.deepEqual(rows[7].slice(0, 6), ["收香港迪礼款项合计", "银行存款", "中国银行", 149.5, null, null]);
  assert.deepEqual(rows[8].slice(0, 6), [RECEIPT.total, null, null, 149.5, 149.5, RECEIPT.balanced]);
  assert.equal(rows[9][0], RECEIPT.amountInWordsLabel);
  assert.equal(rows[12][4], RECEIPT.signerLabel, "签字栏最后一格是「交款人」");
  assertNoTextNumbers(sheet);
});

test("finance-slip：落款（制表人 / 制表时间）写在签字栏下面，不出现在可求和区域", async () => {
  const { rows } = readSheet(await renderFinanceSlipWorkbook({ ...SAMPLE, footnote: "制表人：小叶；制表时间：2026-09-20 14:30:05（北京时间）" }));
  assert.equal(rows[14][0], "制表人：小叶；制表时间：2026-09-20 14:30:05（北京时间）");
});

test("finance-slip：加行与删行只改变明细行数，合计与大写金额跟着走", async () => {
  const slip = {
    ...SAMPLE,
    lines: [
      line({ summary: "支付富雨鑫材料款", general_subject: "原材料", debit: "88.5" }),
      line({ summary: "进项税额", general_subject: "应交税费-进项税", debit: "11.5" }),
      line({ summary: "支付富雨鑫款项合计", general_subject: "银行存款", credit: "100" }),
    ],
  };
  assert.deepEqual(validateFinanceSlip(slip), []);
  const { rows } = readSheet(await renderFinanceSlipWorkbook(slip));
  assert.deepEqual(rows[5].slice(0, 4), ["支付富雨鑫材料款", "原材料", null, 88.5]);
  assert.deepEqual(rows[8].slice(3, 6), [100, 100, PAY.balanced]);
  assert.equal(rows[9][1], "壹佰元整", "「我要付款 100」时大写正好是壹佰元整");
});

test("finance-slip：导出文件名带种类前缀（付款单 / 收款单），没编号时不编一个", () => {
  assert.equal(financeSlipFileName(SAMPLE), "迪礼付款单-FK-202609-001.xlsx");
  assert.equal(financeSlipFileName(RECEIPT_SAMPLE), "迪礼收款单-SK-202609-001.xlsx");
  assert.equal(financeSlipFileName({ kind: "receipt", slip_no: "  " }), "迪礼收款单-未编号.xlsx");
});
