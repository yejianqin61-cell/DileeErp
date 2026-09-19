const assert = require("node:assert/strict");
const test = require("node:test");
const { Prisma } = require("@prisma/client");
const { ReconciliationService } = require("../../dist/modules/finance/reconciliation.service.js");

/**
 * CashFlowService 替身：对账只用它做两件事 ——
 *   1. `requireSubject`：建单/确认时校验会计科目（返回 null = 不指定）；
 *   2. `recordConfirmation`：确认时把金额写成收支流水（= 钱真正进入/离开银行账户）。
 */
const cashFlowStub = (extra = {}) => ({ requireSubject: async () => null, recordConfirmation: async () => null, ...extra });

test("receivable reconciliation resolution locks and rechecks status", async () => {
  let lockCount = 0;
  let updateCount = 0;
  const row = { id: "recon-1", status: "resolved", orderNo: "SO-1", difference: { toString: () => "1" } };
  const prisma = { receivableReconciliation: { findFirst: async () => row, update: async () => { updateCount += 1; return row; } }, $transaction: async (fn) => fn({ $queryRaw: async () => { lockCount += 1; }, receivableReconciliation: prisma.receivableReconciliation }) };
  const service = new ReconciliationService(prisma, { update: () => ({}), recordWithOrderNo: async () => {} }, {}, cashFlowStub());
  await assert.rejects(() => service.resolve("recon-1", "已核实", { id: "user-1" }), (error) => error.getResponse().code === "RECONCILIATION_NOT_RESOLVABLE");
  assert.equal(lockCount, 1); assert.equal(updateCount, 0);
});

// ------------------------------------------------------------------ 对账主键：客户 + 期间

function createHarness(options = {}) {
  const created = [];
  const sourceQueries = [];
  const prisma = {
    salesOrder: { findFirst: async () => options.order ?? null },
    customer: { findFirst: async () => (options.customer === undefined ? { id: "customer-1" } : options.customer) },
    receivableSource: { findMany: async (args) => { sourceQueries.push(args); return options.sources ?? []; } },
    customerPayment: { findMany: async () => [] },
    receivableAdjustment: { findMany: async () => [] },
    receivableReconciliation: { create: async ({ data }) => { created.push(data); return { id: "recon-new", ...data }; } },
  };
  const audits = [];
  const audit = { create: () => ({ createdBy: "user-1", updatedBy: "user-1" }), update: () => ({}), record: async (...args) => audits.push(args), recordWithOrderNo: async (...args) => audits.push(args) };
  return { service: new ReconciliationService(prisma, audit, {}, cashFlowStub()), created, sourceQueries, audits };
}

test("对账可以只给客户 + 期间：orderNo 落库为空，快照按客户汇总", async () => {
  const { service, created, sourceQueries } = createHarness({ sources: [{ amount: new Prisma.Decimal("100"), status: "draft" }] });
  const row = await service.create({ customer_id: "customer-1", period_start: "2026-09-01", period_end: "2026-09-30", external_balance: "100", currency: "CNY" }, { id: "user-1" });
  assert.equal(row.orderNo, null, "客户 + 期间的对账不挂在单个订单上");
  assert.equal(created[0].customerId, "customer-1");
  assert.equal(created[0].status, "matched", "系统余额 100 = 外部余额 100");
  assert.equal(created[0].systemBalance.toString(), "100");
  // 快照必须按客户过滤，而不是按订单（否则客户级对账永远汇总不到任何应收）
  assert.deepEqual(sourceQueries[0].where.customerId, "customer-1");
  assert.equal(sourceQueries[0].where.orderNo, undefined);
});

test("对账必须给出客户或可反查客户的订单号", async () => {
  const { service } = createHarness();
  await assert.rejects(
    () => service.create({ period_start: "2026-09-01", period_end: "2026-09-30", external_balance: "0", currency: "CNY" }, { id: "user-1" }),
    (error) => error.getResponse().code === "RECONCILIATION_CUSTOMER_REQUIRED",
  );
});

test("订单号与客户不一致时拒绝创建对账", async () => {
  const { service } = createHarness({ order: { id: "so-1", customerId: "customer-other" } });
  await assert.rejects(
    () => service.create({ order_no: "SO-1", customer_id: "customer-1", period_start: "2026-09-01", period_end: "2026-09-30", external_balance: "0", currency: "CNY" }, { id: "user-1" }),
    (error) => error.getResponse().code === "RECONCILIATION_CUSTOMER_MISMATCH",
  );
});

test("只给订单号时客户由销售单反查，兼容按订单建对账的旧调用方", async () => {
  const { service, created, sourceQueries } = createHarness({ order: { id: "so-1", customerId: "customer-9" } });
  const row = await service.create({ order_no: "SO-1", period_start: "2026-09-01", period_end: "2026-09-30", external_balance: "0", currency: "CNY" }, { id: "user-1" });
  assert.equal(row.orderNo, "SO-1");
  assert.equal(created[0].customerId, "customer-9");
  assert.equal(sourceQueries[0].where.orderNo, "SO-1", "给了订单号就对账范围收窄到该订单");
});

// ------------------------------------------------------------------ 对账完成 → 批量确认应收

function confirmHarness(reconciliation, drafts) {
  const locks = [];
  const updates = [];
  const audits = [];
  const cashFlowCalls = [];
  const reconciliationUpdates = [];
  const prisma = {
    receivableReconciliation: {
      findFirst: async () => reconciliation,
      update: async ({ where, data }) => { reconciliationUpdates.push({ id: where.id, ...data }); return { ...reconciliation, ...data }; },
    },
    receivableSource: {
      findMany: async (args) => { confirmHarness.lastQuery = args; return drafts; },
      update: async ({ where, data }) => { updates.push({ id: where.id, status: data.status }); return { ...where, status: data.status }; },
    },
    bank: { findFirst: async ({ where }) => (where.id === "bank-dead" ? null : { id: where.id, bankName: "农业银行", accountNumber: "5706" }) },
  };
  prisma.$transaction = async (fn) => fn({
    $queryRaw: async (strings) => { locks.push(Array.isArray(strings) ? strings.join("") : String(strings)); return []; },
    receivableReconciliation: prisma.receivableReconciliation,
    receivableSource: prisma.receivableSource,
  });
  const audit = { create: () => ({}), update: () => ({ updatedBy: "user-1" }), record: async (...args) => audits.push(args), recordWithOrderNo: async (...args) => audits.push(args) };
  const cashFlow = cashFlowStub({ recordConfirmation: async (input) => { cashFlowCalls.push(input); return { id: "cf-1", created: true, amount: input.amount }; } });
  return { service: new ReconciliationService(prisma, audit, {}, cashFlow), locks, updates, audits, cashFlowCalls, reconciliationUpdates };
}

const draftSource = (id, amount) => ({ id, sourceNo: `AR-${id}`, orderNo: "SO-1", amount: new Prisma.Decimal(amount), currency: "CNY" });

test("对账还有未处理差异时不允许批量确认应收（先对账、再确认应收）", async () => {
  const { service, updates } = confirmHarness({ id: "recon-1", status: "difference", reconciliationNo: "REC-1", customerId: "customer-1", orderNo: null, currency: "CNY", periodStart: new Date("2026-09-01"), periodEnd: new Date("2026-09-30") }, [draftSource("s1", "10")]);
  await assert.rejects(
    () => service.confirmReceivables("recon-1", { id: "user-1" }),
    (error) => error.getResponse().code === "RECONCILIATION_NOT_COMPLETED",
  );
  assert.deepEqual(updates, [], "被拒绝时不得写入任何应收");
});

test("对账对平后批量确认范围内的草稿应收，逐条行锁并回报金额", async () => {
  const { service, locks, updates, audits } = confirmHarness({ id: "recon-1", status: "matched", reconciliationNo: "REC-1", customerId: "customer-1", orderNo: null, currency: "CNY", periodStart: new Date("2026-09-01"), periodEnd: new Date("2026-09-30") }, [draftSource("s1", "10"), draftSource("s2", "32.5")]);
  const result = await service.confirmReceivables("recon-1", { id: "user-1" });
  assert.equal(result.confirmed_count, 2);
  assert.equal(result.confirmed_amount, "42.5000");
  assert.deepEqual(updates.map((item) => item.status), ["confirmed", "confirmed"]);
  // 1 次对账行锁 + 每条应收一次行锁
  assert.equal(locks.filter((sql) => sql.includes("receivable_reconciliations")).length, 1);
  assert.equal(locks.filter((sql) => sql.includes("receivable_sources")).length, 2);
  assert.equal(audits[0][0], "receivable_reconciliation.confirm_receivables");
  assert.equal(audits[0][4].confirmed_count, 2);
});

test("已处理差异（resolved）的对账同样可以批量确认应收", async () => {
  const { service, updates } = confirmHarness({ id: "recon-1", status: "resolved", reconciliationNo: "REC-1", customerId: "customer-1", orderNo: null, currency: "CNY", periodStart: new Date("2026-09-01"), periodEnd: new Date("2026-09-30") }, [draftSource("s1", "10")]);
  const result = await service.confirmReceivables("recon-1", { id: "user-1" });
  assert.equal(result.confirmed_count, 1);
  assert.equal(updates.length, 1);
});

test("批量确认只取范围内 status=draft 的应收，且期间按整天闭区间", async () => {
  const { service } = confirmHarness({ id: "recon-1", status: "matched", reconciliationNo: "REC-1", customerId: "customer-1", orderNo: null, currency: "CNY", periodStart: new Date("2026-09-01"), periodEnd: new Date("2026-09-30") }, []);
  await service.confirmReceivables("recon-1", { id: "user-1" });
  const where = confirmHarness.lastQuery.where;
  assert.equal(where.status, "draft");
  assert.equal(where.customerId, "customer-1");
  assert.equal(where.createdAt.gte.toISOString(), "2026-09-01T00:00:00.000Z");
  assert.equal(where.createdAt.lt.toISOString(), "2026-10-01T00:00:00.000Z", "结束日当天必须包含在内");
});

// 2026-09-15：「所有应收管理都要选择银行」。应收对账的回款银行同样只能取自银行账户池，且必须启用。
test("应收对账可选回款银行：校验通过后把 bankId 落库", async () => {
  const lookups = [];
  const prisma = {
    customer: { findFirst: async () => ({ id: "customer-1" }) },
    bank: { findFirst: async ({ where }) => { lookups.push(where); return { id: "bank-1", bankName: "农业银行", accountNumber: "5706" }; } },
    receivableSource: { findMany: async () => [] },
    customerPayment: { findMany: async () => [] },
    receivableAdjustment: { findMany: async () => [] },
    receivableReconciliation: { create: async ({ data }) => ({ id: "recon-new", ...data }) },
  };
  const audit = { create: () => ({ createdBy: "user-1", updatedBy: "user-1" }), update: () => ({}), record: async () => {}, recordWithOrderNo: async () => {} };
  const service = new ReconciliationService(prisma, audit, {}, cashFlowStub());
  const row = await service.create({ customer_id: "customer-1", period_start: "2026-09-01", period_end: "2026-09-30", external_balance: "0", currency: "CNY", bank_id: "bank-1" }, { id: "user-1" });
  assert.deepEqual(lookups, [{ id: "bank-1", deletedAt: null, isActive: true }]);
  assert.equal(row.bankId, "bank-1");
});

test("应收对账：回款银行不在池子里（或已停用）→ BANK_NOT_FOUND，不建对账单", async () => {
  let createCount = 0;
  const prisma = {
    customer: { findFirst: async () => ({ id: "customer-1" }) },
    bank: { findFirst: async () => null },
    receivableReconciliation: { create: async () => { createCount += 1; return {}; } },
  };
  const audit = { create: () => ({}), update: () => ({}), record: async () => {}, recordWithOrderNo: async () => {} };
  const service = new ReconciliationService(prisma, audit, {}, cashFlowStub());
  await assert.rejects(
    () => service.create({ customer_id: "customer-1", period_start: "2026-09-01", period_end: "2026-09-30", external_balance: "0", currency: "CNY", bank_id: "bank-dead" }, { id: "user-1" }),
    (error) => error.getResponse().code === "BANK_NOT_FOUND",
  );
  assert.equal(createCount, 0);
});

test("应收对账不选银行时不做任何银行查询（银行是可选字段）", async () => {
  const prisma = {
    customer: { findFirst: async () => ({ id: "customer-1" }) },
    bank: { findFirst: async () => { throw new Error("未选择银行时不应查询银行账户"); } },
    receivableSource: { findMany: async () => [] },
    customerPayment: { findMany: async () => [] },
    receivableAdjustment: { findMany: async () => [] },
    receivableReconciliation: { create: async ({ data }) => ({ id: "recon-new", ...data }) },
  };
  const audit = { create: () => ({ createdBy: "user-1", updatedBy: "user-1" }), update: () => ({}), record: async () => {}, recordWithOrderNo: async () => {} };
  const service = new ReconciliationService(prisma, audit, {}, cashFlowStub());
  const row = await service.create({ customer_id: "customer-1", period_start: "2026-09-01", period_end: "2026-09-30", external_balance: "0", currency: "CNY" }, { id: "user-1" });
  assert.equal(row.bankId ?? null, null);
});

// ---------------------------------------------------------------------------
// 2026-09-16（用户要求「一旦确认应收，金额就要进入对应的账户」）：
//   确认应收 = 记账。金额必须写成一条**收入流水**并落到对账单的银行账户上，
//   否则银行余额永远不变、收支明细表也看不到这笔钱。
// ---------------------------------------------------------------------------

const reconcilableRow = (extra = {}) => ({ id: "recon-1", status: "matched", reconciliationNo: "REC-1", customerId: "customer-1", customer: { id: "customer-1", name: "香港迪礼" }, orderNo: null, currency: "CNY", periodStart: new Date("2026-09-01"), periodEnd: new Date("2026-09-30"), bankId: "bank-1", subjectId: null, ...extra });

test("确认应收把金额写成收入流水，并落到对账单的回款银行上", async () => {
  const { service, cashFlowCalls } = confirmHarness(reconcilableRow(), [draftSource("s1", "10"), draftSource("s2", "32.5")]);
  const result = await service.confirmReceivables("recon-1", { id: "user-1" });
  assert.equal(cashFlowCalls.length, 1, "确认要记账：写一条收支流水");
  const input = cashFlowCalls[0];
  assert.equal(input.direction, "income", "确认应收 = 钱进来");
  assert.equal(input.amount.toString(), "42.5");
  assert.equal(input.currency, "CNY");
  assert.equal(input.bankId, "bank-1", "金额必须落到对账单指定的银行账户，否则银行余额不会变");
  assert.equal(input.counterpartyName, "香港迪礼", "对方名称取客户名，不能退化成 UUID");
  assert.equal(input.sourceType, "receivable_reconciliation");
  assert.equal(input.sourceId, "recon-1");
  assert.deepEqual(input.subjectNames, ["主营业务收入", "营业外收入"], "默认归到「主营业务收入」（科目名称候选链，第一个存在的生效）");
  assert.equal(result.bank_id, "bank-1");
  assert.equal(result.bank_missing, false);
  assert.equal(result.cash_flow_entry_id, "cf-1");
});

test("确认应收时补的银行与会计科目会回写到对账单上（单子上写的与实际记账一致）", async () => {
  const { service, cashFlowCalls, reconciliationUpdates } = confirmHarness(reconcilableRow({ bankId: null, subjectId: null }), [draftSource("s1", "10")]);
  const result = await service.confirmReceivables("recon-1", { id: "user-1" }, { bank_id: "bank-1", subject_id: "subject-9" });
  assert.equal(cashFlowCalls[0].bankId, "bank-1");
  assert.equal(cashFlowCalls[0].subjectId, "subject-9");
  assert.equal(reconciliationUpdates.length, 1, "补的银行/科目要回写，否则单子上还写着「没选」");
  assert.equal(reconciliationUpdates[0].bankId, "bank-1");
  assert.equal(reconciliationUpdates[0].subjectId, "subject-9");
  assert.equal(result.subject_id, "subject-9");
  assert.equal(result.bank_missing, false);
});

test("对账单没有银行账户时：流水照写（收支事实不丢），但明确回报 bank_missing", async () => {
  const { service, cashFlowCalls } = confirmHarness(reconcilableRow({ bankId: null }), [draftSource("s1", "10")]);
  const result = await service.confirmReceivables("recon-1", { id: "user-1" });
  assert.equal(cashFlowCalls[0].bankId, null);
  assert.equal(result.bank_missing, true, "没指定账户必须让界面提示，而不是静默把钱记成「不在任何账户上」");
});

test("确认应收时不能用一个不在池子里的银行账户", async () => {
  const { service, cashFlowCalls } = confirmHarness(reconcilableRow({ bankId: null }), [draftSource("s1", "10")]);
  await assert.rejects(
    () => service.confirmReceivables("recon-1", { id: "user-1" }, { bank_id: "bank-dead" }),
    (error) => error.getResponse().code === "BANK_NOT_FOUND",
  );
  assert.deepEqual(cashFlowCalls, [], "银行非法时不得记账");
});

// ---------------------------------------------------------------------------
// 2026-09-16（用户要求「应收侧对应的问题也都改」）：
//   对账列表/详情要给出流转摘要（覆盖多少条应收、多少条待确认、哪些订单与产品+规格），
//   并且只有范围内确实还有草稿时才给「一键确认应收」。
// ---------------------------------------------------------------------------

test("应收对账列表返回流转摘要：覆盖条数、待确认、订单号、产品名称与规格型号", async () => {
  const row = { id: "recon-1", status: "matched", reconciliationNo: "REC-001", customerId: "customer-1", orderNo: null, currency: "USD", periodStart: new Date("2026-09-01T00:00:00.000Z"), periodEnd: new Date("2026-09-30T00:00:00.000Z") };
  const sources = [
    { id: "s1", customerId: "customer-1", orderNo: "SO-1", currency: "USD", createdAt: new Date("2026-09-10T00:00:00.000Z"), amount: new Prisma.Decimal("120"), status: "draft", outbound: { productNameSnapshot: "折叠伞", productSpecificationSnapshot: "黑胶" } },
    { id: "s2", customerId: "customer-1", orderNo: "SO-2", currency: "USD", createdAt: new Date("2026-09-11T00:00:00.000Z"), amount: new Prisma.Decimal("30"), status: "confirmed", outbound: { productNameSnapshot: "折叠伞", productSpecificationSnapshot: null } },
    // 期间外 / 已取消：都不能混进这条对账的摘要
    { id: "s3", customerId: "customer-1", orderNo: "SO-9", currency: "USD", createdAt: new Date("2026-08-01T00:00:00.000Z"), amount: new Prisma.Decimal("999"), status: "draft", outbound: null },
  ];
  const prisma = { receivableReconciliation: { findMany: async () => [row] }, receivableSource: { findMany: async () => sources } };
  const result = (await new ReconciliationService(prisma, { record: async () => {} }, {}, cashFlowStub()).list())[0];
  assert.equal(result.flow.entry_count, 2);
  assert.equal(result.flow.draft_count, 1);
  assert.equal(result.flow.draft_amount, "120.0000");
  assert.equal(result.flow.can_confirm_receivables, true, "已对平且有草稿 → 列表行上要能直接一键确认");
  assert.deepEqual(result.flow.order_nos, ["SO-1", "SO-2"], "该行覆盖哪些订单");
  assert.deepEqual(result.flow.product_names, ["折叠伞"], "产品名称去重");
  assert.deepEqual(result.flow.product_specifications, ["黑胶"], "规格型号去重（缺失的不占位）");
});

test("范围内没有草稿时 can_confirm_receivables 为 false（不再给出会空转的一键确认）", async () => {
  const row = { id: "recon-1", status: "difference", reconciliationNo: "REC-001", customerId: "customer-1", orderNo: null, currency: "USD", periodStart: new Date("2026-09-01T00:00:00.000Z"), periodEnd: new Date("2026-09-30T00:00:00.000Z") };
  const prisma = { receivableReconciliation: { findMany: async () => [row] }, receivableSource: { findMany: async () => [] } };
  const flow = (await new ReconciliationService(prisma, { record: async () => {} }, {}, cashFlowStub()).list())[0].flow;
  assert.deepEqual(flow, { entry_count: 0, draft_count: 0, draft_amount: "0.0000", can_confirm_receivables: false, order_nos: [], product_names: [], product_specifications: [] });
});

test("应收对账详情返回 flow，且逐条明细带产品名称与规格型号", async () => {
  const row = { id: "recon-1", status: "matched", reconciliationNo: "REC-001", customerId: "customer-1", orderNo: null, currency: "USD", periodStart: new Date("2026-09-01T00:00:00.000Z"), periodEnd: new Date("2026-09-30T00:00:00.000Z") };
  const source = { id: "s1", sourceNo: "AR-1", customerId: "customer-1", orderNo: "SO-1", currency: "USD", createdAt: new Date("2026-09-10T00:00:00.000Z"), amount: new Prisma.Decimal("120"), status: "draft", allocations: [], customer: { id: "customer-1", name: "香港迪礼" }, outbound: { outboundNo: "OUT-1", status: "signed", productNameSnapshot: "折叠伞", productSpecificationSnapshot: "黑胶", signedAt: null, shipmentDate: null } };
  const prisma = { receivableReconciliation: { findFirst: async () => row }, receivableSource: { findMany: async () => [source] } };
  const detail = await new ReconciliationService(prisma, { record: async () => {} }, {}, cashFlowStub()).get("recon-1");
  assert.deepEqual(detail.flow.product_names, ["折叠伞"]);
  assert.deepEqual(detail.flow.product_specifications, ["黑胶"]);
  assert.equal(detail.details.entries[0].product_name, "折叠伞");
  assert.equal(detail.details.entries[0].product_specification, "黑胶");
  assert.equal(detail.details.can_confirm_receivables, true);
});
