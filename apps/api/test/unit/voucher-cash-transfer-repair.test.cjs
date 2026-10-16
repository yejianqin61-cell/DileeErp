// 「资金搬运凭证纠正」（2026-10-16）。
//
// 用户报障：「财务部分，凭证管理，如果该笔应付选择的是备用金付款，该笔凭证的会计科目没法正常显示」——
//   凭证纸上写着「借 应付账款 / 贷 库存现金」，她要的是「借 库存现金（备用金） / 贷 银行存款」。
//   根因：其他应付的会计科目填了**资金科目**（库存现金（备用金））时，它表达的是「从银行取现到备
//   用金」而不是负债，旧口径却走了「确认挂账（贷应付账款）→ 付款（借应付账款）」两步。
//
// 新口径（voucher.service.ts 的 createAccrual + supplier-payment.service.ts 的 post）只管新发生的；
// 这一组用例盯的是**已经生成出来的旧凭证**怎么纠正：草稿直接改/删，已过账的先红冲（旧内容留痕）
// 再按新口径重开成草稿。红冲本身有它自己的用例（`voucher-service.test.cjs`），这里用替身记录调用。
const assert = require("node:assert/strict");
const test = require("node:test");
const { Prisma } = require("@prisma/client");
const { VoucherService } = require("../../dist/modules/finance/voucher.service.js");

const USER = { id: "user-1", name: "财务" };

/** 一条收支流水（合并付款过账时写的那条）：主科目是**应付账款**（旧口径留下来的事实）。 */
const flowEntry = (extra = {}) => ({
  id: "cf-1",
  entryNo: "CF-20261016-0001",
  /** 来源单据：合并付款写流水时是 `supplier_payment` + 付款单 id（纠正要靠它找回核销记录）。 */
  sourceType: "supplier_payment",
  sourceId: "pay-1",
  entryDate: new Date("2026-10-16T00:00:00.000Z"),
  counterpartyName: "周金红",
  direction: "expense",
  amount: new Prisma.Decimal("3000"),
  currency: "CNY",
  subjectId: "sub-ap",
  subject: { id: "sub-ap", category: "负债类", name: "应付账款" },
  settlementMethod: "备用金",
  settlementAccount: null,
  bank: null,
  remark: null,
  ...extra,
});

function repairHarness({ payables, accruals = [], flows = [], flowVouchers = [], redVouchers = [], allocationsByPayable, paymentIds = ["pay-1"] } = {}) {
  const events = [];
  const deleted = [];
  const updated = [];
  const rebuiltLines = [];
  const flowUpdates = [];
  const reversed = [];
  const prisma = {
    accountingSubject: {
      findMany: async () => [
        { id: "sub-cash", name: "库存现金（备用金）" },
        { id: "sub-bank", name: "银行存款 农业银行" },
      ],
    },
    supplierPayableEntry: { findMany: async () => payables },
    supplierPaymentAllocation: {
      findMany: async ({ where }) =>
        where.payableEntryId
          ? allocationsByPayable.filter((row) => where.payableEntryId.in.includes(row.payableEntryId))
          : allocationsByPayable,
    },
    supplierPayment: { findMany: async () => paymentIds.map((id) => ({ id })) },
    cashFlowEntry: {
      findMany: async () => flows,
      update: async ({ data }) => { flowUpdates.push(data); return {}; },
    },
    voucher: {
      findMany: async ({ where }) => {
        if (where.sourceType === "supplier_payable") return accruals;
        if (where.sourceType === "cash_flow_entry") return flowVouchers;
        if (where.sourceType === "voucher") return redVouchers.filter((row) => !where.sourceId || row.sourceId === where.sourceId); // 红字凭证（来源是被红冲的那张）
        return [];
      },
      update: async ({ where, data }) => {
        if (data.deletedAt) deleted.push(where.id); else updated.push({ id: where.id, data });
        return {};
      },
    },
    voucherLine: {
      deleteMany: async () => {},
      createMany: async ({ data }) => { rebuiltLines.push(...(Array.isArray(data) ? data : [data])); return {}; },
    },
    $transaction: async (fn) => fn({ $queryRaw: async () => [], voucher: prisma.voucher, voucherLine: prisma.voucherLine }),
  };
  const audit = {
    create: () => ({}), update: () => ({}), softDelete: () => ({ deletedAt: new Date(), deletedBy: USER.id, updatedBy: USER.id }),
    record: async (...args) => { events.push(args); },
  };
  const service = new VoucherService(prisma, audit);
  // 红冲是标准件（自己有一组用例）：这里只记录「对谁红冲、为什么」，并把新生成的红字凭证放回
  // 上面那本假账里 —— 纠正动作紧接着要先把它查出来、再软删（旧内容马上会被重写）。
  service.reverse = async (id, reason) => {
    reversed.push({ id, reason });
    const red = { id: `red-${id}`, voucherNo: `红-${id}`, sourceId: id };
    redVouchers.push(red);
    return red;
  };
  return { service, events, deleted, updated, rebuiltLines, flowUpdates, reversed, redVouchers };
}

const CASH_PAYABLE = { id: "ap-1", payableNo: "APO-0001", subjectId: "sub-cash" };
const ALLOC = [{ paymentId: "pay-1", payableEntryId: "ap-1", amount: "3000" }];

test("预览：只报数、不写库（财务点按钮前先看清要改几张、删几张、红冲几张）", async () => {
  const harness = repairHarness({
    payables: [CASH_PAYABLE],
    accruals: [
      { id: "v-accrual-draft", voucherNo: "记-2026-10-0001", status: "draft", sourceId: "ap-1" },
      { id: "v-accrual-posted", voucherNo: "记-2026-10-0002", status: "posted", sourceId: "ap-1" },
    ],
    flows: [flowEntry()],
    flowVouchers: [{ id: "v-pay", voucherNo: "记-2026-10-0003", status: "draft", sourceId: "cf-1" }],
    allocationsByPayable: ALLOC,
  });

  const preview = await harness.service.cashTransferRepairPreview();

  assert.equal(preview.accruals, 2);
  assert.equal(preview.accruals_draft, 1, "草稿挂账凭证 → 直接删");
  assert.equal(preview.accruals_posted, 1, "已过账挂账凭证 → 红冲（留痕）");
  assert.equal(preview.flows, 1);
  assert.equal(preview.vouchers_draft, 1);
  assert.equal(preview.targets.length, 1);
  assert.deepEqual(preview.targets[0], {
    entry_no: "CF-20261016-0001",
    cash_flow_entry_id: "cf-1",
    payable_nos: ["APO-0001"],
    subject_label: "库存现金（备用金）",
    voucher_no: "记-2026-10-0003",
    voucher_status: "draft",
  });
  assert.equal(harness.deleted.length + harness.updated.length + harness.reversed.length + harness.flowUpdates.length, 0, "预览一个字节都不写");
});

test("纠正：草稿挂账凭证删掉、已过账的红冲；付款凭证按新口径重算成「借 库存现金（备用金）/贷 银行存款」", async () => {
  const harness = repairHarness({
    payables: [CASH_PAYABLE],
    accruals: [
      { id: "v-accrual-draft", voucherNo: "记-2026-10-0001", status: "draft", sourceId: "ap-1" },
      { id: "v-accrual-posted", voucherNo: "记-2026-10-0002", status: "posted", sourceId: "ap-1" },
    ],
    flows: [flowEntry()],
    flowVouchers: [{ id: "v-pay", voucherNo: "记-2026-10-0003", status: "draft", sourceId: "cf-1" }],
    allocationsByPayable: ALLOC,
  });

  const result = await harness.service.repairCashTransferVouchers(USER);

  assert.deepEqual(harness.deleted, ["v-accrual-draft", "red-v-accrual-posted"], "草稿挂账凭证软删；已过账的红冲后把红字凭证也撤掉（这一对在账上必须是 0）");
  assert.deepEqual(harness.reversed.map((item) => item.id), ["v-accrual-posted"], "已过账的挂账凭证只能红冲");
  assert.match(harness.reversed[0].reason, /资金搬运口径纠正/);
  // ① 流水的主科目改成条目自己的科目 —— 凭证业务分录取的就是它。
  assert.equal(harness.flowUpdates[0].subjectId, "sub-cash");
  // ② 付款凭证的分录按新口径重算：借方 = 条目自己的科目，资金侧 = 银行存款（不再是「应付账款 / 库存现金」）。
  assert.deepEqual(harness.rebuiltLines.map((line) => [line.direction, line.subjectKey, line.subjectLabel]), [
    ["debit", "资产类/库存现金（备用金）", "库存现金（备用金）"],
    ["credit", "银行存款", "银行存款"],
  ]);
  // ③ 重算后回到草稿（财务再核对一次；已过账的那张内容已经红冲留痕了）。
  const revived = harness.updated.find((item) => item.id === "v-pay");
  assert.equal(revived.data.status, "draft");
  assert.equal(revived.data.debitTotal.toString(), "3000");
  assert.match(revived.data.summary, /周金红 · 库存现金（备用金）/);
  assert.equal(result.rebuilt, 1);
  assert.equal(result.reopened, 0);
  assert.equal(result.vouchers_draft, 1);
});

test("纠正：已过账的付款凭证先红冲再重开成草稿（红字凭证一并撤掉，不留悬空的反向金额）", async () => {
  const harness = repairHarness({
    payables: [CASH_PAYABLE],
    flows: [flowEntry()],
    flowVouchers: [{ id: "v-pay", voucherNo: "记-2026-10-0003", status: "posted", sourceId: "cf-1" }],
    allocationsByPayable: ALLOC,
  });

  const result = await harness.service.repairCashTransferVouchers(USER);

  assert.deepEqual(harness.reversed.map((item) => item.id), ["v-pay"], "先红冲：旧口径那张凭证的内容留在红字凭证上");
  // 红字凭证必须**一并软删**：它是「旧内容」的对冲件，而旧内容马上被重写成新口径 ——
  // 报表只认 posted，原凭证已 reversed 不进表、红字还在表里的话，会凭空多出一笔反向金额。
  assert.deepEqual(harness.deleted, ["red-v-pay"], "红字凭证软删（行留在审计里）");
  assert.equal(harness.updated.find((item) => item.id === "v-pay").data.status, "draft", "再按新口径重开成草稿");
  assert.equal(result.reopened, 1);
  assert.equal(result.rebuilt, 0);
  // 每一步都要留审计：账上少了一张挂账凭证、多了一张红字凭证，事后必须能查清是谁在什么时候做的。
  const actions = harness.events.map((event) => event[4]?.action).filter(Boolean);
  assert.ok(actions.includes("reverse_and_reopen"));
  assert.ok(actions.includes("drop_reversal"));
});

test("纠正：用户自己先红冲过的付款凭证，重记时把它那张红字凭证一并撤掉", async () => {
  const harness = repairHarness({
    payables: [CASH_PAYABLE],
    flows: [flowEntry()],
    flowVouchers: [{ id: "v-pay", voucherNo: "记-2026-10-0003", status: "reversed", sourceId: "cf-1" }],
    redVouchers: [{ id: "red-already", voucherNo: "记-2026-10-0009", sourceId: "v-pay" }],
    allocationsByPayable: ALLOC,
  });

  const result = await harness.service.repairCashTransferVouchers(USER);

  assert.equal(harness.reversed.length, 0, "已经是 reversed，不再红冲第二次");
  assert.deepEqual(harness.deleted, ["red-already"], "撤掉那一张悬空的红字凭证");
  assert.equal(harness.updated.find((item) => item.id === "v-pay").data.status, "draft");
  assert.equal(result.rebuilt, 1, "这种情况走「草稿重算」计数（没有再红冲）");
});

test("纠正：一条流水里混着非资金搬运的应付时不动它，只点名（一个主科目拆不开两种语义）", async () => {
  const harness = repairHarness({
    payables: [CASH_PAYABLE],
    flows: [flowEntry()],
    flowVouchers: [{ id: "v-pay", voucherNo: "记-2026-10-0003", status: "draft", sourceId: "cf-1" }],
    // 同一张付款单还核销了一条房租费（不是资金搬运）→ 这条流水的主科目只能人工决定。
    allocationsByPayable: [...ALLOC, { paymentId: "pay-1", payableEntryId: "ap-rent", amount: "200" }],
  });

  const result = await harness.service.repairCashTransferVouchers(USER);

  assert.equal(result.flows, 0);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, /人工处理/);
  assert.equal(harness.flowUpdates.length, 0, "不动主科目");
  assert.equal(harness.updated.length + harness.deleted.length + harness.reversed.length, 0, "不动任何凭证");
});

test("纠正：流水还没有凭证时只改科目（点「生成凭证」时就会按新口径生成）", async () => {
  const harness = repairHarness({ payables: [CASH_PAYABLE], flows: [flowEntry()], allocationsByPayable: ALLOC });

  const result = await harness.service.repairCashTransferVouchers(USER);

  assert.equal(harness.flowUpdates[0].subjectId, "sub-cash");
  assert.equal(result.without_voucher, 1);
  assert.equal(harness.updated.length + harness.deleted.length, 0);
});
