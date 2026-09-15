const assert = require("node:assert/strict");
const test = require("node:test");
const { Prisma } = require("@prisma/client");
const { ReceivableService } = require("../../dist/modules/finance/receivable.service.js");
const { settlementRemark } = require("../../dist/modules/warehouse/finished-goods-settlement.js");

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
  const service = new ReceivableService(prisma, audit);
  await assert.rejects(() => service.confirm("source-1", { id: "user-1" }), (error) => error.getResponse().code === "RECEIVABLE_SOURCE_NOT_CONFIRMABLE");
  assert.equal(lockCount, 1);
  assert.equal(updateCount, 0);
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
  const service = new ReceivableService(prisma, audit);
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
  const service = new ReceivableService(prisma, audit, { assertSupported: async (code) => { checked.push(code); } });
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
  const service = new ReceivableService(prisma, { update: () => ({}), record: async () => {} });
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
  const service = new ReceivableService(prisma, audit);
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
  const service = new ReceivableService(prisma, { record: async () => {} });
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
  const service = new ReceivableService(prisma, { update: () => ({}), record: async () => {} });
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
  const service = new ReceivableService(prisma, {});
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
  await new ReceivableService(prisma, { create: () => ({}), record: async () => {} }).createFromOutbound("outbound-1", {}, { id: "user-1" });
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
    return new ReceivableService(prisma, { create: () => ({}), record: async () => {} });
  };
  const zeroPriced = { quantity: "10", unitPrice: "0", settlementUnitPrice: null, receivableAmount: null, customerId: "customer-1", unit: "件", taxRate: null, currency: "USD" };
  await assert.rejects(() => make(zeroPriced).createFromOutbound("outbound-1", {}, { id: "user-1" }), (error) => error.getResponse().code === "RECEIVABLE_AMOUNT_REQUIRED");
  const negativePriced = { ...zeroPriced, unitPrice: "-5" };
  await assert.rejects(() => make(negativePriced).createFromOutbound("outbound-1", {}, { id: "user-1" }), (error) => error.getResponse().code === "RECEIVABLE_AMOUNT_REQUIRED");
  await assert.rejects(() => make(zeroPriced).createFromOutbound("outbound-1", { amount: "0" }, { id: "user-1" }), (error) => error.getResponse().code === "RECEIVABLE_AMOUNT_REQUIRED");
});

