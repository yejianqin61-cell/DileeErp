const assert = require("node:assert/strict");
const test = require("node:test");
const { Prisma } = require("@prisma/client");
const { ReceivableService } = require("../../dist/modules/finance/receivable.service.js");
const { settlementRemark } = require("../../dist/modules/warehouse/finished-goods-settlement.js");

/**
 * CashFlowService 替身：确认应收（逐条 / 按订单批量）都要记账 ——
 * `requireItem` 校验收支项目，`recordConfirmation` 写收入流水（= 钱进银行账户）。
 */
const cashFlowStub = (extra = {}) => ({ requireItem: async () => null, recordConfirmation: async () => null, ...extra });

test("分批出库的应收备注写明折算口径（逐单尾差 ≤ 0.0001），整单出库不加这句", () => {
  const sales = { quantity: new Prisma.Decimal(3), unitPrice: new Prisma.Decimal(10), settlementUnitPrice: new Prisma.Decimal("33.3333"), receivableAmount: new Prisma.Decimal(100), settlementMethod: "tt", localCurrencyAmount: new Prisma.Decimal(720) };

  const partial = settlementRemark(sales, new Prisma.Decimal("33.3333"), new Prisma.Decimal(1));
  assert.match(partial, /销售单应收 100/, "财务要能看到销售单权威金额");
  assert.match(partial, /分批出库：应收按 销售单应收 ÷ 订单数量 折算/, "分批出库必须写明尾差口径");

  const full = settlementRemark(sales, new Prisma.Decimal("33.3333"), new Prisma.Decimal(3));
  assert.doesNotMatch(full, /分批出库/, "整单出库金额直接取应收金额，不存在尾差");
});

test("receivable confirmation locks and rechecks the current source", async () => {
  let lockCount = 0;
  let updateCount = 0;
  const row = { id: "source-1", status: "confirmed", orderNo: "SO-1" };
  const prisma = {
    receivableSource: { findFirst: async () => row, update: async () => { updateCount += 1; return row; } },
    $transaction: async (fn) => fn({
      $queryRaw: async () => { lockCount += 1; return []; },
      receivableSource: prisma.receivableSource,
    }),
  };
  const audit = { update: () => ({}), record: async () => {} };
  const service = new ReceivableService(prisma, audit, cashFlowStub());
  await assert.rejects(() => service.confirm("source-1", { id: "user-1" }), (error) => error.getResponse().code === "RECEIVABLE_SOURCE_NOT_CONFIRMABLE");
  assert.equal(lockCount, 1);
  assert.equal(updateCount, 0);
});

// ---------------------------------------------------------------------------
// 2026-09-16（用户要求「一旦确认应收，金额就要进入对应的账户」）：
//   逐条确认应收也要记账。用户点的是列表行上的「确认应收」，这条路不记账的话，
//   用户实际看到的仍然是「确认了但银行余额没动」。
// ---------------------------------------------------------------------------

function confirmHarness({ row, drafts = [] } = {}) {
  const cashFlowCalls = [];
  const prisma = {
    bank: { findFirst: async ({ where }) => (where.id === "bank-dead" ? null : { id: where.id, bankName: "农业银行", accountNumber: "5706" }) },
    receivableSource: {
      findFirst: async () => row,
      findMany: async () => drafts,
      update: async ({ where, data }) => ({ ...row, id: where.id, ...data }),
      updateMany: async () => ({ count: drafts.length }),
    },
  };
  prisma.$transaction = async (fn) => fn({ $queryRaw: async () => [], receivableSource: prisma.receivableSource });
  const audit = { update: () => ({ updatedBy: "user-1" }), record: async () => {} };
  const cashFlow = cashFlowStub({ recordConfirmation: async (input) => { cashFlowCalls.push(input); return { id: "cf-1", created: true, amount: input.amount }; } });
  return { service: new ReceivableService(prisma, audit, cashFlow), cashFlowCalls };
}

const draftRow = (extra = {}) => ({
  id: "source-1", sourceNo: "AR-1", status: "draft", orderNo: "SO-1", customerId: "customer-1",
  amount: new Prisma.Decimal("120.5"), currency: "USD", customer: { name: "香港迪礼" }, ...extra,
});

test("逐条确认应收：写一条收入流水并落到指定的入账银行", async () => {
  const { service, cashFlowCalls } = confirmHarness({ row: draftRow() });
  const result = await service.confirm("source-1", { id: "user-1" }, { bank_id: "bank-1" });
  assert.equal(cashFlowCalls.length, 1);
  const input = cashFlowCalls[0];
  assert.equal(input.direction, "income", "确认应收 = 钱进来");
  assert.equal(input.sourceType, "receivable_source");
  assert.equal(input.sourceId, "source-1");
  assert.equal(input.amount.toString(), "120.5");
  assert.equal(input.currency, "USD");
  assert.equal(input.bankId, "bank-1");
  assert.equal(input.counterpartyName, "香港迪礼", "对方名称取客户名，不能退化成 UUID");
  assert.deepEqual(input.itemKeys, ["货款", "国家退税"]);
  assert.equal(result.cash_flow_entry_id, "cf-1");
  assert.equal(result.bank_missing, false);
});

test("逐条确认应收：没选银行时流水照写，但明确回报 bank_missing", async () => {
  const { service, cashFlowCalls } = confirmHarness({ row: draftRow() });
  const result = await service.confirm("source-1", { id: "user-1" });
  assert.equal(cashFlowCalls[0].bankId, null);
  assert.equal(result.bank_missing, true, "界面必须提示「这笔已记入流水，但不进任何银行余额」");
});

test("逐条确认应收：银行非法时先拒绝，不确认任何应收（不能「确认了但没记账」）", async () => {
  const { service, cashFlowCalls } = confirmHarness({ row: draftRow() });
  await assert.rejects(
    () => service.confirm("source-1", { id: "user-1" }, { bank_id: "bank-dead" }),
    (error) => error.getResponse().code === "BANK_NOT_FOUND",
  );
  assert.deepEqual(cashFlowCalls, []);
});

test("按订单批量确认应收：每条应收各记一条流水（批量没有单张单据可挂）", async () => {
  const { service, cashFlowCalls } = confirmHarness({ row: draftRow(), drafts: [
    { id: "s1", sourceNo: "AR-1", amount: new Prisma.Decimal("10"), currency: "USD", customerId: "customer-1", customer: { name: "香港迪礼" } },
    { id: "s2", sourceNo: "AR-2", amount: new Prisma.Decimal("32.5"), currency: "USD", customerId: "customer-1", customer: { name: "香港迪礼" } },
  ] });
  const result = await service.batchConfirmByOrder("SO-1", { id: "user-1" }, { bank_id: "bank-1" });
  assert.equal(result.count, 2);
  assert.equal(cashFlowCalls.length, 2, "每条应收一条流水，否则追不回是哪批货收的钱");
  assert.deepEqual(cashFlowCalls.map((item) => item.sourceId), ["s1", "s2"]);
  assert.deepEqual(cashFlowCalls.map((item) => item.amount.toString()), ["10", "32.5"]);
  assert.equal(result.bank_missing, false);
  assert.deepEqual(result.cash_flow_entry_ids, ["cf-1", "cf-1"]);
});

// ---------------------------------------------------------------------------
// 2026-09-16（用户要求「应收侧也改成勾选 + 批量确认」）：
//   界面勾选多条草稿应收 → 一次确认。整批共用「入账银行 + 收支项目」，但**每条应收各写一条流水**
//   （每条都有自己的来源编号，合并成一条就追不回是哪张出库单的钱）；已确认/已取消的条目跳过而非整批失败。
//   与应付侧 SupplierPayableService.batchConfirm 同一口径。
// ---------------------------------------------------------------------------

const batchDraft = (id, extra = {}) => ({
  id, sourceNo: `AR-${id}`, status: "draft", orderNo: "SO-1", customerId: "customer-1",
  amount: new Prisma.Decimal("100"), currency: "CNY", customer: { name: "香港迪礼" }, ...extra,
});

function batchHarness(rows, options = {}) {
  const cashFlowCalls = [];
  const writes = [];
  let locks = 0;
  const sourceTable = {
    // 替身照做服务端的过滤条件（id 列表 + status = draft），才能断言「已确认/已取消的会被跳过」。
    findMany: async (args) => rows.filter((row) => args.where.id.in.includes(row.id) && row.status === "draft"),
    updateMany: async ({ where, data }) => {
      const targets = rows.filter((row) => where.id.in.includes(row.id) && row.status === "draft");
      writes.push({ ids: where.id.in, data });
      for (const row of targets) row.status = "confirmed";
      return { count: options.updateCount ?? targets.length };
    },
  };
  const prisma = {
    bank: { findFirst: async ({ where }) => (where.id === "bank-dead" ? null : { id: where.id, bankName: "农业银行", accountNumber: "5706" }) },
    receivableSource: sourceTable,
  };
  prisma.$transaction = async (fn) => fn({ $queryRaw: async () => { locks += 1; return []; }, receivableSource: sourceTable });
  const audit = { update: () => ({ updatedBy: "user-1" }), record: async () => {} };
  const cashFlow = cashFlowStub({ recordConfirmation: async (input) => { cashFlowCalls.push(input); return { id: `cf-${cashFlowCalls.length}` }; } });
  return { service: new ReceivableService(prisma, audit, cashFlow), cashFlowCalls, writes, locks: () => locks };
}

test("勾选批量确认应收：每条各写一条收入流水，并按币种给合计", async () => {
  const harness = batchHarness([batchDraft("r1"), batchDraft("r2", { amount: new Prisma.Decimal("250") }), batchDraft("r3", { status: "confirmed" }), batchDraft("r4", { status: "cancelled" })]);
  const result = await harness.service.batchConfirm(["r1", "r2", "r3", "r4"], { id: "user-1" }, { bank_id: "bank-1", cash_flow_item_id: "item-1" });
  assert.equal(result.confirmed_count, 2);
  assert.equal(result.skipped_count, 2, "已确认/已取消的条目要跳过，不能重复记账（同一笔款进两次账户）");
  assert.equal(harness.cashFlowCalls.length, 2, "逐条写流水，才追得回是哪张出库单的钱");
  assert.deepEqual(harness.cashFlowCalls.map((call) => call.sourceId), ["r1", "r2"]);
  assert.equal(harness.cashFlowCalls.every((call) => call.direction === "income" && call.bankId === "bank-1" && call.itemId === "item-1"), true);
  assert.deepEqual(harness.cashFlowCalls[0].itemKeys, ["货款", "国家退税"]);
  assert.equal(harness.cashFlowCalls[0].counterpartyName, "香港迪礼", "对方名称取客户名，不能退化成 UUID");
  assert.deepEqual(result.amounts, [{ currency: "CNY", amount: "350.0000" }]);
  assert.equal(result.bank_missing, false);
  assert.deepEqual(harness.writes[0].ids, ["r1", "r2"], "已确认/已取消的那两条不能被写成已确认");
});

test("勾选批量确认应收：勾的全是不可确认的条目时拒绝，一条流水都不写", async () => {
  const harness = batchHarness([batchDraft("r1", { status: "confirmed" })]);
  await assert.rejects(
    () => harness.service.batchConfirm(["r1"], { id: "user-1" }),
    (error) => error.getResponse().code === "NO_DRAFT_RECEIVABLES",
  );
  assert.deepEqual(harness.cashFlowCalls, []);
  assert.deepEqual(harness.writes, []);
});

test("勾选批量确认应收：没有勾选任何条目时直接拒绝", async () => {
  const harness = batchHarness([]);
  await assert.rejects(
    () => harness.service.batchConfirm([], { id: "user-1" }),
    (error) => error.getResponse().code === "RECEIVABLE_IDS_REQUIRED",
  );
  assert.equal(harness.locks(), 0, "连事务都不该进");
});

test("勾选批量确认应收：银行非法时先拒绝，一条都不确认", async () => {
  const harness = batchHarness([batchDraft("r1")]);
  await assert.rejects(
    () => harness.service.batchConfirm(["r1"], { id: "user-1" }, { bank_id: "bank-dead" }),
    (error) => error.getResponse().code === "BANK_NOT_FOUND",
  );
  assert.deepEqual(harness.cashFlowCalls, []);
  assert.deepEqual(harness.writes, []);
});

test("勾选批量确认应收：合计按币种分组，不跨币种相加", async () => {
  const harness = batchHarness([batchDraft("r1"), batchDraft("r2", { currency: "USD", amount: new Prisma.Decimal("20") })]);
  const result = await harness.service.batchConfirm(["r1", "r2"], { id: "user-1" }, {});
  assert.deepEqual(result.amounts, [{ currency: "CNY", amount: "100.0000" }, { currency: "USD", amount: "20.0000" }]);
  assert.equal(result.bank_missing, true, "没指定银行时界面必须给出警告，而不是一句成功");
});

test("勾选批量确认应收：状态被别的入口改动时整批拒绝，不出现「界面说确认了、库里没确认」", async () => {
  const harness = batchHarness([batchDraft("r1")], { updateCount: 0 });
  await assert.rejects(
    () => harness.service.batchConfirm(["r1"], { id: "user-1" }),
    (error) => error.getResponse().code === "RECEIVABLE_CONFIRM_CONFLICT",
  );
  assert.deepEqual(harness.cashFlowCalls, [], "没写成状态就绝不能记账");
});

// ---------------------------------------------------------------------------
// 2026-09-16（用户要求）：「确认应收里如果是已收款的条目就不要出现了」+
//   「支持按已收未收、按时间范围筛选」。时间用**创建日期**（= 出库过账生成来源的日期）：
//   应收来源没有确认日期列，列表页的「待对账月份 / 出库日期」用的也是它。
// ---------------------------------------------------------------------------

test("应收台账按收款情况筛选：未收只留草稿，已收含已确认及以后", async () => {
  const base = { amount: new Prisma.Decimal("100"), currency: "USD", orderNo: "SO-1", customerId: "c-1", customer: null, outbound: null, allocations: [], dueDate: null };
  const rows = [
    { ...base, id: "r-draft", sourceNo: "AR-001", status: "draft", createdAt: new Date("2026-09-07T00:00:00.000Z") },
    { ...base, id: "r-confirmed", sourceNo: "AR-002", status: "confirmed", createdAt: new Date("2026-09-08T00:00:00.000Z") },
    { ...base, id: "r-cancelled", sourceNo: "AR-003", status: "cancelled", createdAt: new Date("2026-09-09T00:00:00.000Z") },
  ];
  const prisma = { receivableSource: { findMany: async () => rows }, receivableReconciliation: { findMany: async () => [] } };
  const service = new ReceivableService(prisma, {}, cashFlowStub());
  const ids = (filter) => service.list(undefined, undefined, undefined, filter).then((result) => result.map((row) => row.id));

  assert.deepEqual(await ids({ payment: "unpaid" }), ["r-draft"]);
  assert.deepEqual(await ids({ payment: "paid" }), ["r-confirmed"]);
  assert.deepEqual(await ids({ payment: "all" }), ["r-draft", "r-confirmed", "r-cancelled"], "全部包含已取消的");
  assert.deepEqual(await ids({}), ["r-draft", "r-confirmed", "r-cancelled"], "不传筛选时保持原行为");
});

test("应收台账按创建日期区间与关键字筛选（区间含两端，无日期的行不算命中）", async () => {
  const base = { amount: new Prisma.Decimal("100"), currency: "USD", status: "draft", orderNo: "SO-1", customerId: "c-1", customer: null, outbound: null, allocations: [], dueDate: null };
  const rows = [
    { ...base, id: "r-1", sourceNo: "AR-001", createdAt: new Date("2026-09-01T00:00:00.000Z") },
    { ...base, id: "r-2", sourceNo: "AR-002", orderNo: "SO-2", createdAt: new Date("2026-09-30T00:00:00.000Z") },
    { ...base, id: "r-3", sourceNo: "AR-003", orderNo: "SO-3", createdAt: new Date("2026-10-01T00:00:00.000Z") },
  ];
  const prisma = { receivableSource: { findMany: async () => rows }, receivableReconciliation: { findMany: async () => [] } };
  const service = new ReceivableService(prisma, {}, cashFlowStub());
  const ids = (filter) => service.list(undefined, undefined, undefined, filter).then((result) => result.map((row) => row.id));

  assert.deepEqual(await ids({ from: "2026-09-01", to: "2026-09-30" }), ["r-1", "r-2"]);
  assert.deepEqual(await ids({ to: "2026-09-30" }), ["r-1", "r-2"]);
  assert.deepEqual(await ids({ q: "AR-003" }), ["r-3"]);
});

test("receivable draft update locks and rechecks current status", async () => {
  let lockCount = 0;
  let updateCount = 0;
  const row = { id: "source-1", status: "confirmed", amount: "10", dueDate: null, amountReason: null, remark: null };
  const prisma = {
    receivableSource: { findFirst: async () => row, update: async () => { updateCount += 1; return row; } },
    $transaction: async (fn) => fn({
      $queryRaw: async () => { lockCount += 1; return []; },
      receivableSource: prisma.receivableSource,
    }),
  };
  const audit = { update: () => ({}), record: async () => {} };
  const service = new ReceivableService(prisma, audit, cashFlowStub());
  await assert.rejects(() => service.updateDraft("source-1", { amount: "12" }, { id: "user-1" }), (error) => error.getResponse().code === "RECEIVABLE_SOURCE_NOT_EDITABLE");
  assert.equal(lockCount, 1);
  assert.equal(updateCount, 0);
});

// 2026-09-15：「应收管理都要支持选择币种、编辑币种」。
// 草稿期间币种可以改（此时还没有任何收款核销，不会与已核销记录冲突）；改币种必须过币种字典。
test("应收草稿可编辑币种：只接受字典里的币种，并写回来源", async () => {
  let updated;
  const checked = [];
  const row = { id: "source-1", status: "draft", amount: "10", currency: "CNY", dueDate: null, amountReason: null, remark: null };
  const prisma = {
    receivableSource: { findFirst: async () => row, update: async ({ data }) => { updated = data; return { ...row, ...data }; } },
    $transaction: async (fn) => fn({ $queryRaw: async () => [], receivableSource: prisma.receivableSource }),
  };
  const audit = { update: () => ({}), record: async () => {} };
  const service = new ReceivableService(prisma, audit, cashFlowStub(), { assertSupported: async (code) => { checked.push(code); } });
  await service.updateDraft("source-1", { currency: "USD" }, { id: "user-1" });
  assert.deepEqual(checked, ["USD"]);
  assert.equal(updated.currency, "USD");
});

test("confirmed receivable can be reopened to draft with a reason", async () => {
  let updated;
  const row = { id: "source-1", status: "confirmed", orderNo: "SO-1", remark: null, allocations: [] };
  const prisma = {
    receivableSource: {
      findFirst: async () => row,
      update: async ({ data }) => { updated = data; return { ...row, ...data }; },
    },
    $transaction: async (fn) => fn({
      $queryRaw: async () => [],
      receivableSource: prisma.receivableSource,
    }),
  };
  const service = new ReceivableService(prisma, { update: () => ({}), record: async () => {} }, cashFlowStub());
  const result = await service.reopen("source-1", "修正应收金额", { id: "user-1" });
  assert.equal(result.status, "draft");
  assert.equal(updated.status, "draft");
});

test("receivable cancellation locks and blocks active posted allocations", async () => {
  let lockCount = 0;
  let updateCount = 0;
  const row = { id: "source-1", status: "confirmed", remark: null, allocations: [{ payment: { status: "posted" } }] };
  const prisma = {
    receivableSource: { findFirst: async () => row, update: async () => { updateCount += 1; return row; } },
    $transaction: async (fn) => fn({
      $queryRaw: async () => { lockCount += 1; return []; },
      receivableSource: prisma.receivableSource,
    }),
  };
  const audit = { update: () => ({}), record: async () => {} };
  const service = new ReceivableService(prisma, audit, cashFlowStub());
  await assert.rejects(() => service.cancel("source-1", "取消原因", { id: "user-1" }), (error) => error.getResponse().code === "RECEIVABLE_SOURCE_HAS_ALLOCATIONS");
  assert.equal(lockCount, 1);
  assert.equal(updateCount, 0);
});

test("receivable creation locks the outbound before idempotency check", async () => {
  let lockCount = 0;
  let createCount = 0;
  const prisma = {
    finishedGoodsOutbound: { findFirst: async () => ({ id: "outbound-1", status: "posted", quantity: "1", orderNo: "SO-1", salesOrderId: "sales-1", signedAt: null, salesOrder: { unitPrice: "10", customerId: "customer-1", unit: "件", taxRate: "0", currency: "CNY" } }) },
    receivableSource: { findUnique: async () => ({ id: "source-1", orderNo: "SO-1", amount: { toString: () => "10" } }), create: async () => { createCount += 1; } },
    $transaction: async (fn) => fn({
      $queryRaw: async () => { lockCount += 1; return []; },
      finishedGoodsOutbound: prisma.finishedGoodsOutbound,
      receivableSource: prisma.receivableSource,
    }),
  };
  const service = new ReceivableService(prisma, { record: async () => {} }, cashFlowStub());
  const result = await service.createFromOutbound("outbound-1", {}, { id: "user-1" });
  assert.equal(result.id, "source-1");
  assert.equal(lockCount, 1);
  assert.equal(createCount, 0);
});

test("receivable creation restores a soft-deleted outbound source", async () => {
  let restoreCount = 0;
  const deleted = { id: "source-1", deletedAt: new Date() };
  const prisma = {
    finishedGoodsOutbound: { findFirst: async () => ({ id: "outbound-1", status: "posted", quantity: "1", orderNo: "SO-1", salesOrderId: "sales-1", signedAt: null, salesOrder: { unitPrice: "10", customerId: "customer-1", unit: "件", taxRate: "0", currency: "CNY" } }) },
    receivableSource: { findUnique: async () => deleted, update: async () => { restoreCount += 1; return { ...deleted, deletedAt: null, orderNo: "SO-1", amount: { toString: () => "10" } }; } },
    $transaction: async (fn) => fn({ $queryRaw: async () => [], finishedGoodsOutbound: prisma.finishedGoodsOutbound, receivableSource: prisma.receivableSource }),
  };
  const service = new ReceivableService(prisma, { update: () => ({}), record: async () => {} }, cashFlowStub());
  const result = await service.createFromOutbound("outbound-1", {}, { id: "user-1" });
  assert.equal(result.deletedAt, null);
  assert.equal(restoreCount, 1);
});

test("receivable impact preview traces outbound qc and finished-goods inbound", async () => {
  const row = {
    id: "source-1",
    orderNo: "SO-1",
    status: "confirmed",
    amount: new Prisma.Decimal("100"),
    allocations: [],
    outbound: {
      id: "outbound-1",
      outboundNo: "FGO-1",
      status: "posted",
      productionOrder: {
        finishedGoodsInspections: [
          {
            qcRecords: [{ id: "qc-1", qcNo: "QC-1", conclusion: "qualified", status: "active" }],
            finishedGoodsInbounds: [{ id: "inbound-1", inboundNo: "FGI-1", status: "posted", quantity: new Prisma.Decimal("100") }],
          },
        ],
      },
    },
  };
  const prisma = { receivableSource: { findFirst: async () => row } };
  const service = new ReceivableService(prisma, {}, cashFlowStub());
  const preview = await service.impactPreview("source-1");
  assert.equal(preview.source_trace.outbound.outbound_no, "FGO-1");
  assert.equal(preview.source_trace.qc_records[0].qc_no, "QC-1");
  assert.equal(preview.source_trace.finished_goods_inbounds[0].inbound_no, "FGI-1");
});

// 与出库过账同一口径：手工补建应收也必须按「应收金额 ÷ 订单数量 → 结算币价 → 销售单价」计价，
// 并且金额必须大于 0（0 元应收 / 负应收都不允许写库）。
test("手工补建应收按结算口径计价（整单出库时等于销售填写的应收金额）", async () => {
  let created;
  const outbound = { id: "outbound-1", status: "posted", quantity: "100", orderNo: "SO-1", salesOrderId: "sales-1", signedAt: null, salesOrder: { quantity: "100", unitPrice: "10", settlementUnitPrice: "12.5", receivableAmount: "1300", settlementMethod: "tt", localCurrencyAmount: "9360", customerId: "customer-1", unit: "件", taxRate: null, currency: "USD" } };
  const prisma = {
    finishedGoodsOutbound: { findFirst: async () => outbound },
    receivableSource: { findUnique: async () => null, create: async ({ data }) => { created = data; return { id: "source-1", ...data }; } },
    $transaction: async (fn) => fn({ $queryRaw: async () => [], finishedGoodsOutbound: prisma.finishedGoodsOutbound, receivableSource: prisma.receivableSource }),
  };
  await new ReceivableService(prisma, { create: () => ({}), record: async () => {} }, cashFlowStub()).createFromOutbound("outbound-1", {}, { id: "user-1" });
  assert.equal(created.amount.toString(), "1300");
  assert.match(created.remark, /结算方式 T\/T 电汇/);
  assert.match(created.remark, /本币金额 9360/);
});

test("手工补建应收拒绝 0 元与负金额（与出库过账同一门槛）", async () => {
  const make = (salesOrder) => {
    const outbound = { id: "outbound-1", status: "posted", quantity: "10", orderNo: "SO-1", salesOrderId: "sales-1", signedAt: null, salesOrder };
    const prisma = {
      finishedGoodsOutbound: { findFirst: async () => outbound },
      receivableSource: { findUnique: async () => null, create: async () => { throw new Error("不应写入应收"); } },
      $transaction: async (fn) => fn({ $queryRaw: async () => [], finishedGoodsOutbound: prisma.finishedGoodsOutbound, receivableSource: prisma.receivableSource }),
    };
    return new ReceivableService(prisma, { create: () => ({}), record: async () => {} }, cashFlowStub());
  };
  const zeroPriced = { quantity: "10", unitPrice: "0", settlementUnitPrice: null, receivableAmount: null, customerId: "customer-1", unit: "件", taxRate: null, currency: "USD" };
  await assert.rejects(() => make(zeroPriced).createFromOutbound("outbound-1", {}, { id: "user-1" }), (error) => error.getResponse().code === "RECEIVABLE_AMOUNT_REQUIRED");
  const negativePriced = { ...zeroPriced, unitPrice: "-5" };
  await assert.rejects(() => make(negativePriced).createFromOutbound("outbound-1", {}, { id: "user-1" }), (error) => error.getResponse().code === "RECEIVABLE_AMOUNT_REQUIRED");
  await assert.rejects(() => make(zeroPriced).createFromOutbound("outbound-1", { amount: "0" }, { id: "user-1" }), (error) => error.getResponse().code === "RECEIVABLE_AMOUNT_REQUIRED");
});

// ---------------------------------------------------------------------------
// 2026-09-16（用户要求「应收侧对应的问题也都改」）：
//   待创建对账不该继续展示已经被某张对账单覆盖的出库条目；
//   被覆盖的条目要能查到去向（进了哪张对账单）。
// ---------------------------------------------------------------------------

test("应收列表标出每条应收被哪张对账单覆盖（订单号（填了才收窄）或客户 + 币种 + 期间）", async () => {
  const base = {
    amount: new Prisma.Decimal("100"), status: "draft", allocations: [], createdAt: new Date("2026-09-10T00:00:00.000Z"),
    customer: { id: "customer-1", name: "香港迪礼", customerCode: "C001" }, outbound: null,
  };
  const rows = [
    { ...base, id: "by-order", customerId: "customer-1", orderNo: "SO-7", currency: "USD" },
    { ...base, id: "order-mismatch", customerId: "customer-1", orderNo: "SO-8", currency: "USD" },
    { ...base, id: "other-customer", customerId: "customer-2", orderNo: "SO-99", currency: "USD" },
    { ...base, id: "other-month", customerId: "customer-1", orderNo: "SO-7", currency: "USD", createdAt: new Date("2026-08-10T00:00:00.000Z") },
    { ...base, id: "other-currency", customerId: "customer-1", orderNo: "SO-7", currency: "CNY" },
  ];
  const prisma = {
    receivableSource: { findMany: async () => rows },
    receivableReconciliation: {
      findMany: async (args) => {
        // 按订单建的对账不会被 customerId 过滤漏掉：OR 里同时查 orderNo
        assert.deepEqual(args.where.OR, [{ customerId: { in: ["customer-1", "customer-2"] } }, { orderNo: { in: ["SO-7", "SO-8", "SO-99"] } }], "客户与订单两种对账都要取回来");
        return [
          { id: "recon-1", reconciliationNo: "REC-001", status: "matched", customerId: "customer-1", orderNo: "SO-7", currency: "USD", periodStart: new Date("2026-09-01T00:00:00.000Z"), periodEnd: new Date("2026-09-30T00:00:00.000Z") },
          { id: "recon-2", reconciliationNo: "REC-002", status: "difference", customerId: "customer-2", orderNo: null, currency: "USD", periodStart: new Date("2026-09-01T00:00:00.000Z"), periodEnd: new Date("2026-09-30T00:00:00.000Z") },
        ];
      },
    },
  };
  const result = await new ReceivableService(prisma, {}, cashFlowStub()).list();
  const byId = Object.fromEntries(result.map((row) => [row.id, row]));
  assert.deepEqual(byId["by-order"].reconciliation, { id: "recon-1", reconciliation_no: "REC-001", status: "matched", period_start: new Date("2026-09-01T00:00:00.000Z"), period_end: new Date("2026-09-30T00:00:00.000Z") });
  assert.equal(byId["order-mismatch"].reconciliation, null, "按订单建的对账只覆盖该订单，也不被别家客户的客户级对账覆盖");
  assert.equal(byId["other-customer"].reconciliation.id, "recon-2", "按客户的（orderNo 为空）对账覆盖该客户所有订单");
  assert.equal(byId["other-month"].reconciliation, null, "8 月的出库条目不在 9 月对账范围内");
  assert.equal(byId["other-currency"].reconciliation, null, "币种不一致不算覆盖");
  // 列表本身的既有字段不能被覆盖标记挤掉
  assert.equal(byId["by-order"].customer_name, "香港迪礼");
  assert.equal(byId["by-order"].outstanding_amount, "100.0000");
});

