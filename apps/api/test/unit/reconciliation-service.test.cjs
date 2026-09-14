const assert = require("node:assert/strict");
const test = require("node:test");
const { Prisma } = require("@prisma/client");
const { ReconciliationService } = require("../../dist/modules/finance/reconciliation.service.js");

test("receivable reconciliation resolution locks and rechecks status", async () => {
  let lockCount = 0;
  let updateCount = 0;
  const row = { id: "recon-1", status: "resolved", orderNo: "SO-1", difference: { toString: () => "1" } };
  const prisma = { receivableReconciliation: { findFirst: async () => row, update: async () => { updateCount += 1; return row; } }, $transaction: async (fn) => fn({ $queryRaw: async () => { lockCount += 1; }, receivableReconciliation: prisma.receivableReconciliation }) };
  const service = new ReconciliationService(prisma, { update: () => ({}), recordWithOrderNo: async () => {} }, {});
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
  return { service: new ReconciliationService(prisma, audit, {}), created, sourceQueries, audits };
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
  const prisma = {
    receivableReconciliation: { findFirst: async () => reconciliation },
    receivableSource: {
      findMany: async (args) => { confirmHarness.lastQuery = args; return drafts; },
      update: async ({ where, data }) => { updates.push({ id: where.id, status: data.status }); return { ...where, status: data.status }; },
    },
  };
  prisma.$transaction = async (fn) => fn({
    $queryRaw: async (strings) => { locks.push(Array.isArray(strings) ? strings.join("") : String(strings)); return []; },
    receivableReconciliation: prisma.receivableReconciliation,
    receivableSource: prisma.receivableSource,
  });
  const audit = { create: () => ({}), update: () => ({ updatedBy: "user-1" }), record: async (...args) => audits.push(args), recordWithOrderNo: async (...args) => audits.push(args) };
  return { service: new ReconciliationService(prisma, audit, {}), locks, updates, audits };
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
