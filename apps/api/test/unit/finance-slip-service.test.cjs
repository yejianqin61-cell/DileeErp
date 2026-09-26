// 收/付款单服务（预填 + 导出）的测试。
//
// 预填口径的五件事必须钉死（两种单据各一遍）：
//   ① 「我方开户银行 / 我方银行账号 / 总账科目」取自**确认时实际记账的那条流水**（不在条目上）；
//      多个条目指向不同银行时**留空**，绝不填一个看起来像真的账户；分组之后更要按**本组**的流水判断；
//   ② 「对方开户银行 / 对方银行账号」是**另一对格子**（用户 2026-09-24）：供应商主数据的
//      `settlementInfo` 认得出就预填，认不出留空；客户没有结算信息列，所以收款单一律留空；
//   ③ 单号是 `<前缀>-<年月>-<序号>`，序号 = 该对方单位本月第几笔结算；付款 FK、收款 SK；
//   ④ 一次勾选 → **按「对方单位 + 币种」拆成多张**（用户 2026-09-24：「还是不能实现一起付款，
//      只能算是一起确认了，然后还是一个个的改付款单」），拆张后每张各自只有一家的条目；
//   ⑤ 收款单必须是付款单的**镜像**（贷业务收入、借银行存款），而不是「换个标题的付款单」。
//
// 导出这条路上最要紧的是：**以界面提交的内容为准**（财务改了金额就按她改的出单）、
// 校验不过时一次把全部问题说出来、以及「全部导出」把多张渲染成一个工作簿（一张单子一个工作表）。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { Prisma } = require("@prisma/client");
const XLSX = require("xlsx");
const { FinanceSlipService } = require("../../dist/modules/finance/finance-slip.service.js");

const USER = { id: "user-1", username: "ye", display_name: "小叶" };

/** 付款单预填的取数替身：应付条目 + 每个条目的支出流水（银行 / 科目）+ 本月已确认条数。 */
function paymentHarness({ entries, flows = [], settledThisMonth = 0 } = {}) {
  const queries = [];
  const prisma = {
    supplierPayableEntry: {
      findMany: async (args) => { queries.push(args); return entries; },
      count: async () => settledThisMonth,
    },
    cashFlowEntry: { findMany: async () => flows },
  };
  return { service: new FinanceSlipService(prisma, { record: async () => {} }), queries };
}

/** 收款单预填的取数替身：应收条目 + 每个条目的收入流水 + 本月已确认条数。 */
function receiptHarness({ entries, flows = [], settledThisMonth = 0 } = {}) {
  const prisma = {
    receivableSource: { findMany: async () => entries, count: async () => settledThisMonth },
    cashFlowEntry: { findMany: async () => flows },
  };
  return { service: new FinanceSlipService(prisma, { record: async () => {} }) };
}

const payableEntry = (extra = {}) => ({
  id: "entry-1", payableNo: "AP-1", sourceType: "raw_material_inbound", status: "confirmed", supplierId: "supplier-1",
  currency: "CNY", amount: new Prisma.Decimal("500"), sourceNoSnapshot: "IN-1",
  supplier: { id: "supplier-1", name: "晋江大田", settlementInfo: { bank_name: "兴业银行", account_number: "1573 0001 0000 1234" } },
  payableSource: { purchaseOrderItem: { material: { name: "涤纶布" }, materialSnapshot: null } },
  outsourcePayableSource: null,
  ...extra,
});

const receivableEntry = (extra = {}) => ({
  id: "rec-1", sourceNo: "AR-1", status: "confirmed", customerId: "customer-1", currency: "USD",
  amount: new Prisma.Decimal("120"), orderNo: "SO-1",
  customer: { id: "customer-1", name: "香港迪礼" },
  outbound: { outboundNo: "OUT-1", productNameSnapshot: "折叠伞" },
  ...extra,
});

const flow = (sourceId, extra = {}) => ({
  sourceId, subject: { name: "原材料" }, bank: { id: "bank-1", bankName: "中国农业银行", accountNumber: "40390001040045706" }, ...extra,
});

test("付款单预填：一行一条应付（贷方是银行存款合计），收款单位 / 双方账户 / 制单人 / 附单据都带出来", async () => {
  const entries = [payableEntry(), payableEntry({ id: "entry-2", payableNo: "AP-2", amount: new Prisma.Decimal("280"), payableSource: { purchaseOrderItem: { material: { name: "拉链" }, materialSnapshot: null } } })];
  const { service } = paymentHarness({ entries, flows: [flow("entry-1"), flow("entry-2")], settledThisMonth: 2 });
  const [slip] = await service.draft("payment", ["entry-1", "entry-2"], USER);

  assert.equal(slip.kind, "payment");
  assert.equal(slip.counterparty_name, "晋江大田");
  assert.equal(slip.currency, "CNY", "币种跟着单子走：队列靠它分辨同一家公司的不同币种");
  // 我方两格来自**确认时实际走的那张卡**（流水里的 bank），对方两格来自供应商的结算信息 —— 两对不许串位。
  assert.equal(slip.our_bank_name, "中国农业银行");
  assert.equal(slip.our_bank_account, "40390001040045706");
  assert.equal(slip.counterparty_bank_name, "兴业银行");
  assert.equal(slip.counterparty_bank_account, "1573 0001 0000 1234");
  assert.equal(slip.attachment_count, 2, "附单据张数 = 这一笔付款要对上的单据条数");
  assert.equal(slip.maker, "小叶");
  assert.equal(slip.slip_method, "银行转账");
  assert.match(slip.slip_date, /^\d{4}-\d{2}-\d{2}$/, "单据日期默认今天");
  assert.match(slip.slip_no, /^FK-\d{6}-001$/, "该供应商本月第 1 笔结算（本月已确认 2 条 = 本次这 2 条）");

  assert.deepEqual(slip.lines, [
    { summary: "支付晋江大田涤纶布款", general_subject: "原材料", detail_subject: "", debit: "500", credit: "", remark: "" },
    { summary: "支付晋江大田拉链款", general_subject: "原材料", detail_subject: "", debit: "280", credit: "", remark: "" },
    { summary: "支付晋江大田款项合计", general_subject: "银行存款", detail_subject: "中国农业银行", debit: "", credit: "780", remark: "" },
  ], "借方一行一条应付（金额全额，不自动拆进项税），贷方一行银行存款等于合计");
});

test("付款单预填：单号序号按「该供应商本月第几笔结算」顺延（本月已有 5 条、本次付 2 条 → 004）", async () => {
  const entries = [payableEntry(), payableEntry({ id: "entry-2" })];
  const { service } = paymentHarness({ entries, flows: [flow("entry-1"), flow("entry-2")], settledThisMonth: 5 });
  const [slip] = await service.draft("payment", ["entry-1", "entry-2"], USER);
  assert.match(slip.slip_no, /^FK-\d{6}-004$/);
});

test("付款单预填：科目优先用确认时实际记账的科目，查不到时退回按来源的候选链", async () => {
  const entries = [payableEntry(), payableEntry({ id: "entry-2", sourceType: "other", sourceNoSnapshot: "其他应付-8 月运费", payableSource: null })];
  const { service } = paymentHarness({ entries, flows: [flow("entry-1", { subject: { name: "材料采购" } })], settledThisMonth: 2 });
  const [slip] = await service.draft("payment", ["entry-1", "entry-2"], USER);
  assert.equal(slip.lines[0].general_subject, "材料采购", "确认时记在哪个科目，付款单上就是哪个科目");
  // 其他应付没有自己的流水时退回候选链首位，且摘要用录入时写的支出说明（去掉来源快照前缀）。
  assert.equal(slip.lines[1].summary, "支付晋江大田8 月运费款");
  assert.ok(slip.lines[1].general_subject.length > 0, "候选链首位必须给一个能用的科目名，不能让财务面对空格子");
});

test("付款单预填：多条应付指向不同银行时**我方**开户行/账号留空（填一个看起来像真的账户比留空更危险）", async () => {
  const entries = [payableEntry(), payableEntry({ id: "entry-2" })];
  const { service } = paymentHarness({
    entries,
    flows: [flow("entry-1"), flow("entry-2", { bank: { id: "bank-2", bankName: "中国银行", accountNumber: "9999" } })],
    settledThisMonth: 2,
  });
  const [slip] = await service.draft("payment", ["entry-1", "entry-2"], USER);
  assert.equal(slip.our_bank_name, "");
  assert.equal(slip.our_bank_account, "");
  assert.equal(slip.lines[2].detail_subject, "", "贷方行的明细科目也跟着留空");
  // 我方账户留空不影响对方账户：那两格来自供应商主数据，与本次走哪张卡无关。
  assert.equal(slip.counterparty_bank_name, "兴业银行");
});

test("付款单预填：供应商没填结算信息时对方账户留空（不拿我方账户去凑那一格）", async () => {
  const entries = [payableEntry({ supplier: { id: "supplier-1", name: "晋江大田" } })];
  const { service } = paymentHarness({ entries, flows: [flow("entry-1")], settledThisMonth: 1 });
  const [slip] = await service.draft("payment", ["entry-1"], USER);
  assert.equal(slip.counterparty_bank_name, "");
  assert.equal(slip.counterparty_bank_account, "");
  assert.equal(slip.our_bank_name, "中国农业银行", "我方那两格照样填得上");
});

test("付款单预填：跨供应商 / 跨币种**拆成多张**（一次勾选就是一次集中付款，不再逼她一家家重选）", async () => {
  // 两家供应商 + 其中一家两个币种 → 3 张单子，每张只有自己那家的条目。
  const entries = [
    payableEntry(),
    payableEntry({ id: "entry-2", supplierId: "supplier-2", supplier: { id: "supplier-2", name: "富雨鑫" } }),
    payableEntry({ id: "entry-3", currency: "USD", amount: new Prisma.Decimal("70") }),
  ];
  const { service } = paymentHarness({ entries, flows: [flow("entry-1"), flow("entry-2"), flow("entry-3")], settledThisMonth: 3 });
  const slips = await service.draft("payment", ["entry-1", "entry-2", "entry-3"], USER);

  assert.equal(slips.length, 3, "按「收款单位 + 币种」分组：一家一张、一个币种一张");
  // 顺序 = 分组首次出现的顺序（滑块顺序必须稳定，否则财务每次打开看到的次序都不一样）。
  assert.deepEqual(slips.map((slip) => [slip.counterparty_name, slip.currency]), [["晋江大田", "CNY"], ["富雨鑫", "CNY"], ["晋江大田", "USD"]]);
  const usd = slips.find((slip) => slip.currency === "USD");
  assert.deepEqual(usd.lines.map((line) => line.debit || line.credit), ["70", "70"], "每张单子只有自己那一组的分录（不是把三家混在一张上）");
  assert.equal(usd.attachment_count, 1, "附单据张数按本组算");
  // 编号是「该对方单位本月第几笔」：两家供应商各自都会有 003（编号语义如此，不是重号事故）；
  // 只有**同一家**拆成两张时才必须错开，否则打印出来是两张同名单据。
  assert.deepEqual(slips.map((slip) => slip.slip_no.replace(/^FK-\d{6}/, "FK")), ["FK-003", "FK-003", "FK-004"]);
  assert.notEqual(slips[0].slip_no, slips[2].slip_no, "同一家供应商的两张单子必须不同号（CNY 与 USD 各一张）");

  const missing = paymentHarness({ entries: [payableEntry()] });
  await assert.rejects(() => missing.service.draft("payment", ["entry-1", "entry-2"], USER), (error) => error.getResponse().code === "PAYMENT_SLIP_ENTRY_NOT_FOUND");

  const none = paymentHarness({ entries: [] });
  await assert.rejects(() => none.service.draft("payment", [], USER), (error) => error.getResponse().code === "PAYMENT_SLIP_ENTRY_REQUIRED");
});

test("付款单预填：银行按**本组**的流水判断（分组后仍拿全批的账户去填，就会指到别家那笔钱的账户）", async () => {
  const entries = [
    payableEntry({ id: "entry-1", supplierId: "supplier-1", supplier: { id: "supplier-1", name: "晋江大田" } }),
    payableEntry({ id: "entry-2", supplierId: "supplier-2", supplier: { id: "supplier-2", name: "富雨鑫" } }),
  ];
  const { service } = paymentHarness({
    entries,
    flows: [flow("entry-1"), flow("entry-2", { bank: { id: "bank-2", bankName: "中国银行", accountNumber: "9999" } })],
    settledThisMonth: 2,
  });
  const slips = await service.draft("payment", ["entry-1", "entry-2"], USER);
  assert.equal(slips.length, 2);
  assert.equal(slips[0].our_bank_name, "中国农业银行", "第一张填的是这笔钱实际走的账户");
  assert.equal(slips[1].our_bank_name, "中国银行", "第二张也是自己那笔的账户（不是第一张的）");
});

// --------------------------------------------------------------------------- 收款单（镜像）

test("收款单预填：一行一条应收（贷业务收入）、借方一行银行存款等于合计，单号是 SK 前缀", async () => {
  const entries = [
    receivableEntry(),
    receivableEntry({ id: "rec-2", sourceNo: "AR-2", amount: new Prisma.Decimal("80"), outbound: { outboundNo: "OUT-2", productNameSnapshot: "直骨伞" } }),
  ];
  const { service } = receiptHarness({
    entries,
    flows: [flow("rec-1", { subject: { name: "主营业务收入" } }), flow("rec-2", { subject: { name: "主营业务收入" } })],
    settledThisMonth: 2,
  });
  const [slip] = await service.draft("receipt", ["rec-1", "rec-2"], USER);

  assert.equal(slip.kind, "receipt");
  assert.equal(slip.counterparty_name, "香港迪礼", "收款单上的对方是客户（付款单位）");
  assert.equal(slip.currency, "USD");
  assert.equal(slip.our_bank_name, "中国农业银行");
  assert.equal(slip.counterparty_bank_name, "", "客户主数据没有结算信息列 → 对方账户一律留空，财务照回单填");
  assert.equal(slip.counterparty_bank_account, "");
  assert.equal(slip.attachment_count, 2);
  assert.match(slip.slip_no, /^SK-\d{6}-001$/, "收款单用 SK 前缀，序号口径与付款单一致");
  assert.deepEqual(slip.lines, [
    { summary: "收香港迪礼折叠伞款", general_subject: "主营业务收入", detail_subject: "", debit: "", credit: "120", remark: "" },
    { summary: "收香港迪礼直骨伞款", general_subject: "主营业务收入", detail_subject: "", debit: "", credit: "80", remark: "" },
    { summary: "收香港迪礼款项合计", general_subject: "银行存款", detail_subject: "中国农业银行", debit: "200", credit: "", remark: "" },
  ], "收款单是付款单的镜像：贷方一条一条应收，借方一行银行存款");
});

test("收款单预填：没有确认流水时退回「主营业务收入」候选链；跨客户**拆张**（收束收款同样要一次拿全）", async () => {
  const { service } = receiptHarness({ entries: [receivableEntry({ status: "draft" })], flows: [] });
  const [slip] = await service.draft("receipt", ["rec-1"], USER);
  assert.equal(slip.lines[0].general_subject, "主营业务收入");
  assert.equal(slip.our_bank_name, "", "还没确认（没有流水）就没有银行可带，留空由财务填");

  const twoCustomers = receiptHarness({
    entries: [receivableEntry(), receivableEntry({ id: "rec-2", customerId: "customer-2", customer: { id: "customer-2", name: "联晟" } })],
    flows: [],
    settledThisMonth: 2,
  });
  const slips = await twoCustomers.service.draft("receipt", ["rec-1", "rec-2"], USER);
  assert.deepEqual(slips.map((item) => item.counterparty_name), ["香港迪礼", "联晟"], "两个客户 → 两张收款单（一张单子只有一个付款单位）");
  assert.deepEqual(slips.map((item) => item.currency), ["USD", "USD"]);
  // 编号口径是「**该客户**本月第几笔结算」，所以两个客户各自都会有 002 —— 这不是重号事故，
  // 是编号本身的语义（口径写在 suggestNumber 上）。同一家拆两张时才靠 offset 错开。
  assert.deepEqual(slips.map((item) => item.slip_no.replace(/^SK-\d{6}/, "SK")), ["SK-002", "SK-002"]);
});

// --------------------------------------------------------------------------- 导出

test("付款单导出：以界面提交的内容为准（财务把金额改成 100 就按 100 出单），并记一条审计", async () => {
  const events = [];
  const service = new FinanceSlipService({}, { record: async (...args) => events.push(args) });
  const slip = {
    kind: "payment", currency: "CNY",
    slip_no: "FK-202609-001", slip_date: "2026-09-20", slip_method: "银行转账", counterparty_name: "富雨鑫",
    our_bank_name: "中国农业银行", our_bank_account: "4039", counterparty_bank_name: "兴业银行", counterparty_bank_account: "1573", attachment_count: 1, remark: "本次只付 100", maker: "小叶",
    lines: [
      { summary: "支付富雨鑫材料款", general_subject: "原材料", detail_subject: "", debit: "86.96", credit: "", remark: "" },
      { summary: "进项税额", general_subject: "应交税费-进项税", detail_subject: "", debit: "13.04", credit: "", remark: "" },
      { summary: "支付富雨鑫款项合计", general_subject: "银行存款", detail_subject: "中国农业银行", debit: "", credit: "100", remark: "" },
    ],
  };
  const result = await service.export(slip, USER);
  assert.equal(result.fileName, "迪礼付款单-FK-202609-001.xlsx");
  const workbook = XLSX.read(result.body, { type: "buffer" });
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1, raw: true, defval: null, blankrows: true });
  assert.equal(rows[9][3], 100, "借方合计 = 财务自己拆的两行之和");
  assert.equal(rows[9][4], 100);
  assert.equal(rows[10][1], "壹佰元整");
  assert.equal(events.length, 1);
  assert.equal(events[0][0], "payment_slip.export");
  assert.equal(events[0][1], "payment_slip");
  assert.equal(events[0][4].amount, "100", "审计记的是**这张单子实际开出去的金额**");
  assert.equal(events[0][4].slip_no, "FK-202609-001");
  assert.equal(events[0][4].currency, "CNY");
  assert.equal("batch_size" in events[0][4], false, "单张导出不写 batch_size");
});

test("付款单「全部导出」：多张渲染成**一个工作簿多个工作表**（一张单子一张、各有自己的分录与合计）", async () => {
  const events = [];
  const service = new FinanceSlipService({}, { record: async (...args) => events.push(args) });
  const slip = (extra) => ({
    kind: "payment", currency: "CNY",
    slip_no: "FK-202609-001", slip_date: "2026-09-20", slip_method: "银行转账", counterparty_name: "富雨鑫",
    our_bank_name: "中国农业银行", our_bank_account: "4039", counterparty_bank_name: "兴业银行", counterparty_bank_account: "1573", attachment_count: 1, remark: "", maker: "小叶",
    lines: [
      { summary: "借", general_subject: "原材料", detail_subject: "", debit: "100", credit: "", remark: "" },
      { summary: "贷", general_subject: "银行存款", detail_subject: "", debit: "", credit: "100", remark: "" },
    ],
    ...extra,
  });
  const result = await service.exportMany([
    slip({}),
    slip({ slip_no: "FK-202609-002", counterparty_name: "晋江大田", lines: [
      { summary: "借", general_subject: "加工费", detail_subject: "", debit: "70", credit: "", remark: "" },
      { summary: "贷", general_subject: "银行存款", detail_subject: "", debit: "", credit: "70", remark: "" },
    ] }),
  ], USER);

  assert.equal(result.fileName, "迪礼付款单-2张.xlsx", "文件名给的是「几张」，不是几个单号拼起来");
  const workbook = XLSX.read(result.body, { type: "buffer" });
  assert.equal(workbook.SheetNames.length, 2, "一张单子一个工作表");
  assert.equal(workbook.SheetNames[0], "付款单", "第一张沿用单据名");
  assert.equal(workbook.SheetNames[1], "付款单2-晋江大田", "第二张带序号与对方单位（同名工作表会让 ExcelJS 直接抛错）");
  const second = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[1]], { header: 1, raw: true, defval: null, blankrows: true });
  assert.equal(second[8][3], 70, "第二张是自己的金额，不是第一张的 100");
  // 审计：一张一条（单据是逐张签发的凭证），并标出这是一次集中付款。
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((event) => event[4].slip_no), ["FK-202609-001", "FK-202609-002"]);
  assert.equal(events[0][4].batch_size, 2);
});

test("付款单「全部导出」：某一张不过关时**按张点名**（队列里五张时，一句「第 3 行请填写…」没法定位）", async () => {
  const service = new FinanceSlipService({}, { record: async () => {} });
  const good = {
    kind: "payment", currency: "CNY", slip_no: "FK-1", slip_date: "2026-09-20", slip_method: "", counterparty_name: "富雨鑫",
    our_bank_name: "", our_bank_account: "", counterparty_bank_name: "", counterparty_bank_account: "", attachment_count: 0, remark: "", maker: "",
    lines: [
      { summary: "借", general_subject: "原材料", detail_subject: "", debit: "100", credit: "", remark: "" },
      { summary: "贷", general_subject: "银行存款", detail_subject: "", debit: "", credit: "100", remark: "" },
    ],
  };
  const broken = { ...good, slip_no: "FK-2", counterparty_name: "晋江大田", lines: [
    { summary: "借", general_subject: "原材料", detail_subject: "", debit: "100", credit: "", remark: "" },
    { summary: "贷", general_subject: "银行存款", detail_subject: "", debit: "", credit: "99", remark: "" },
  ] };
  await assert.rejects(
    () => service.exportMany([good, broken], USER),
    (error) => {
      const response = error.getResponse();
      assert.equal(response.code, "SLIP_NOT_BALANCED");
      assert.ok(response.message.startsWith("第 2 张（晋江大田）："), `必须点名是哪一张，实际：${response.message}`);
      return true;
    },
  );
  await assert.rejects(() => service.exportMany([], USER), (error) => error.getResponse().code === "SLIP_REQUIRED");
});

test("收款单导出：同一套渲染与审计，动作与实体名换成 receipt_slip", async () => {
  const events = [];
  const service = new FinanceSlipService({}, { record: async (...args) => events.push(args) });
  const result = await service.export({
    kind: "receipt", currency: "USD",
    slip_no: "SK-202609-007", slip_date: "2026-09-20", slip_method: "银行转账", counterparty_name: "香港迪礼",
    our_bank_name: "中国银行", our_bank_account: "7624", counterparty_bank_name: "招商银行", counterparty_bank_account: "6225", attachment_count: 1, remark: "", maker: "小叶",
    lines: [
      { summary: "收香港迪礼折叠伞款", general_subject: "主营业务收入", detail_subject: "", debit: "", credit: "100", remark: "" },
      { summary: "收香港迪礼款项合计", general_subject: "银行存款", detail_subject: "中国银行", debit: "100", credit: "", remark: "" },
    ],
  }, USER);
  assert.equal(result.fileName, "迪礼收款单-SK-202609-007.xlsx");
  assert.equal(events[0][0], "receipt_slip.export");
  assert.equal(events[0][1], "receipt_slip");
  assert.equal(events[0][4].counterparty_name, "香港迪礼");
});

test("导出：校验不过一次把全部问题说出来（含行号），一个字节都不下发", async () => {
  const events = [];
  const service = new FinanceSlipService({}, { record: async (...args) => events.push(args) });
  await assert.rejects(
    () => service.export({
      kind: "payment", currency: "CNY",
      slip_no: "", slip_date: "2026-09-20", slip_method: "", counterparty_name: "", our_bank_name: "", our_bank_account: "", counterparty_bank_name: "", counterparty_bank_account: "",
      attachment_count: 0, remark: "", maker: "",
      lines: [
        { summary: "借方", general_subject: "原材料", detail_subject: "", debit: "100", credit: "", remark: "" },
        { summary: "贷方少了一块", general_subject: "银行存款", detail_subject: "", debit: "", credit: "99", remark: "" },
      ],
    }, USER),
    (error) => {
      const response = error.getResponse();
      assert.equal(response.code, "SLIP_NO_REQUIRED");
      assert.ok(response.message.includes("单据编号") && response.message.includes("收款单位") && response.message.includes("借贷不平衡"), "一次说清全部问题");
      return true;
    },
  );
  assert.equal(events.length, 0, "校验不过不记审计、不生成文件");
});
