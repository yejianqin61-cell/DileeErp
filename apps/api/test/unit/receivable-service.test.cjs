const assert = require("node:assert/strict");
const test = require("node:test");
const { ReceivableService } = require("../../dist/modules/finance/receivable.service.js");

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
