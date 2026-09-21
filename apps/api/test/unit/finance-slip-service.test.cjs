// 收/付款单服务（预填 + 导出）的测试。
//
// 预填口径的三件事必须钉死（两种单据各一遍）：
//   ① 「开户银行 / 银行账号 / 总账科目」取自**确认时实际记账的那条流水**（不在条目上）；
//      多个条目指向不同银行时**留空**，绝不填一个看起来像真的账户；
//   ② 单号是 `<前缀>-<年月>-<序号>`，序号 = 该对方单位本月第几笔结算；付款 FK、收款 SK；
//   ③ 一张单子只能有一个对方单位与一个币种（混着两家开不出去）。
// 另外：收款单必须是付款单的**镜像**（贷业务收入、借银行存款），而不是「换个标题的付款单」。
//
// 导出这条路上最要紧的是：**以界面提交的内容为准**（财务改了金额就按她改的出单），
// 以及校验不过时一次把全部问题说出来。
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
  supplier: { id: "supplier-1", name: "晋江大田" },
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

test("付款单预填：一行一条应付（贷方是银行存款合计），收款单位 / 开户行 / 账号 / 制单人 / 附单据都带出来", async () => {
  const entries = [payableEntry(), payableEntry({ id: "entry-2", payableNo: "AP-2", amount: new Prisma.Decimal("280"), payableSource: { purchaseOrderItem: { material: { name: "拉链" }, materialSnapshot: null } } })];
  const { service } = paymentHarness({ entries, flows: [flow("entry-1"), flow("entry-2")], settledThisMonth: 2 });
  const slip = await service.draft("payment", ["entry-1", "entry-2"], USER);

  assert.equal(slip.kind, "payment");
  assert.equal(slip.counterparty_name, "晋江大田");
  assert.equal(slip.bank_name, "中国农业银行");
  assert.equal(slip.bank_account, "40390001040045706");
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
  const slip = await service.draft("payment", ["entry-1", "entry-2"], USER);
  assert.match(slip.slip_no, /^FK-\d{6}-004$/);
});

test("付款单预填：科目优先用确认时实际记账的科目，查不到时退回按来源的候选链", async () => {
  const entries = [payableEntry(), payableEntry({ id: "entry-2", sourceType: "other", sourceNoSnapshot: "其他应付-8 月运费", payableSource: null })];
  const { service } = paymentHarness({ entries, flows: [flow("entry-1", { subject: { name: "材料采购" } })], settledThisMonth: 2 });
  const slip = await service.draft("payment", ["entry-1", "entry-2"], USER);
  assert.equal(slip.lines[0].general_subject, "材料采购", "确认时记在哪个科目，付款单上就是哪个科目");
  // 其他应付没有自己的流水时退回候选链首位，且摘要用录入时写的支出说明（去掉来源快照前缀）。
  assert.equal(slip.lines[1].summary, "支付晋江大田8 月运费款");
  assert.ok(slip.lines[1].general_subject.length > 0, "候选链首位必须给一个能用的科目名，不能让财务面对空格子");
});

test("付款单预填：多条应付指向不同银行时开户行/账号留空（填一个看起来像真的账户比留空更危险）", async () => {
  const entries = [payableEntry(), payableEntry({ id: "entry-2" })];
  const { service } = paymentHarness({
    entries,
    flows: [flow("entry-1"), flow("entry-2", { bank: { id: "bank-2", bankName: "中国银行", accountNumber: "9999" } })],
    settledThisMonth: 2,
  });
  const slip = await service.draft("payment", ["entry-1", "entry-2"], USER);
  assert.equal(slip.bank_name, "");
  assert.equal(slip.bank_account, "");
  assert.equal(slip.lines[2].detail_subject, "", "贷方行的明细科目也跟着留空");
});

test("付款单预填：跨供应商 / 跨币种必须显式报错，不静默取第一条", async () => {
  const twoSuppliers = paymentHarness({ entries: [payableEntry(), payableEntry({ id: "entry-2", supplierId: "supplier-2", supplier: { id: "supplier-2", name: "富雨鑫" } })] });
  await assert.rejects(() => twoSuppliers.service.draft("payment", ["entry-1", "entry-2"], USER), (error) => error.getResponse().code === "PAYMENT_SLIP_MULTI_COUNTERPARTY");

  const twoCurrencies = paymentHarness({ entries: [payableEntry(), payableEntry({ id: "entry-2", currency: "USD" })] });
  await assert.rejects(() => twoCurrencies.service.draft("payment", ["entry-1", "entry-2"], USER), (error) => error.getResponse().code === "PAYMENT_SLIP_MULTI_CURRENCY");

  const missing = paymentHarness({ entries: [payableEntry()] });
  await assert.rejects(() => missing.service.draft("payment", ["entry-1", "entry-2"], USER), (error) => error.getResponse().code === "PAYMENT_SLIP_ENTRY_NOT_FOUND");

  const none = paymentHarness({ entries: [] });
  await assert.rejects(() => none.service.draft("payment", [], USER), (error) => error.getResponse().code === "PAYMENT_SLIP_ENTRY_REQUIRED");
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
  const slip = await service.draft("receipt", ["rec-1", "rec-2"], USER);

  assert.equal(slip.kind, "receipt");
  assert.equal(slip.counterparty_name, "香港迪礼", "收款单上的对方是客户（付款单位）");
  assert.equal(slip.bank_name, "中国农业银行");
  assert.equal(slip.attachment_count, 2);
  assert.match(slip.slip_no, /^SK-\d{6}-001$/, "收款单用 SK 前缀，序号口径与付款单一致");
  assert.deepEqual(slip.lines, [
    { summary: "收香港迪礼折叠伞款", general_subject: "主营业务收入", detail_subject: "", debit: "", credit: "120", remark: "" },
    { summary: "收香港迪礼直骨伞款", general_subject: "主营业务收入", detail_subject: "", debit: "", credit: "80", remark: "" },
    { summary: "收香港迪礼款项合计", general_subject: "银行存款", detail_subject: "中国农业银行", debit: "200", credit: "", remark: "" },
  ], "收款单是付款单的镜像：贷方一条一条应收，借方一行银行存款");
});

test("收款单预填：没有确认流水时退回「主营业务收入」候选链；跨客户 / 跨币种显式报错", async () => {
  const { service } = receiptHarness({ entries: [receivableEntry({ status: "draft" })], flows: [] });
  const slip = await service.draft("receipt", ["rec-1"], USER);
  assert.equal(slip.lines[0].general_subject, "主营业务收入");
  assert.equal(slip.bank_name, "", "还没确认（没有流水）就没有银行可带，留空由财务填");

  const twoCustomers = receiptHarness({ entries: [receivableEntry(), receivableEntry({ id: "rec-2", customerId: "customer-2", customer: { id: "customer-2", name: "联晟" } })] });
  await assert.rejects(() => twoCustomers.service.draft("receipt", ["rec-1", "rec-2"], USER), (error) => error.getResponse().code === "RECEIPT_SLIP_MULTI_COUNTERPARTY");

  const twoCurrencies = receiptHarness({ entries: [receivableEntry(), receivableEntry({ id: "rec-2", currency: "CNY" })] });
  await assert.rejects(() => twoCurrencies.service.draft("receipt", ["rec-1", "rec-2"], USER), (error) => error.getResponse().code === "RECEIPT_SLIP_MULTI_CURRENCY");
});

// --------------------------------------------------------------------------- 导出

test("付款单导出：以界面提交的内容为准（财务把金额改成 100 就按 100 出单），并记一条审计", async () => {
  const events = [];
  const service = new FinanceSlipService({}, { record: async (...args) => events.push(args) });
  const slip = {
    kind: "payment",
    slip_no: "FK-202609-001", slip_date: "2026-09-20", slip_method: "银行转账", counterparty_name: "富雨鑫",
    bank_name: "中国农业银行", bank_account: "4039", attachment_count: 1, remark: "本次只付 100", maker: "小叶",
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
  assert.equal(rows[8][3], 100, "借方合计 = 财务自己拆的两行之和");
  assert.equal(rows[8][4], 100);
  assert.equal(rows[9][1], "壹佰元整");
  assert.equal(events.length, 1);
  assert.equal(events[0][0], "payment_slip.export");
  assert.equal(events[0][1], "payment_slip");
  assert.equal(events[0][4].amount, "100", "审计记的是**这张单子实际开出去的金额**");
  assert.equal(events[0][4].slip_no, "FK-202609-001");
});

test("收款单导出：同一套渲染与审计，动作与实体名换成 receipt_slip", async () => {
  const events = [];
  const service = new FinanceSlipService({}, { record: async (...args) => events.push(args) });
  const result = await service.export({
    kind: "receipt",
    slip_no: "SK-202609-007", slip_date: "2026-09-20", slip_method: "银行转账", counterparty_name: "香港迪礼",
    bank_name: "中国银行", bank_account: "7624", attachment_count: 1, remark: "", maker: "小叶",
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
      kind: "payment",
      slip_no: "", slip_date: "2026-09-20", slip_method: "", counterparty_name: "", bank_name: "", bank_account: "",
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
