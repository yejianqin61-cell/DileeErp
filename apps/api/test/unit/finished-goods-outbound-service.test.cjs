const assert = require("node:assert/strict");
const { test } = require("node:test");
const { UnprocessableEntityException } = require("@nestjs/common");
const { FinishedGoodsOutboundService } = require("../../dist/modules/warehouse/finished-goods-outbound.service.js");

test("finished-goods outbound posting locks its production order before checking facts", async () => {
  const calls = [];
  const current = { id: "outbound-1", status: "draft", productionOrderId: "production-1", unitId: "unit-1" };
  const prisma = {
    finishedGoodsOutbound: { findFirst: async () => current },
    $transaction: async (fn) => fn({
      $queryRaw: async () => { calls.push("lock"); },
      inventoryFact: { findFirst: async () => ({ id: "fact-1" }) },
    }),
  };
  const service = new FinishedGoodsOutboundService(prisma, {}, {});
  await assert.rejects(() => service.postOutbound(current.id, { id: "user-1" }), (error) => error instanceof UnprocessableEntityException && error.getResponse().code === "FINISHED_GOODS_OUTBOUND_ALREADY_POSTED");
  assert.deepEqual(calls, ["lock"]);
});


test("finished-goods outbound reversal cancels a draft receivable source", async () => {
  const calls = [];
  let cancelled = false;
  const current = { id: "outbound-1", status: "posted", productionOrderId: "production-1", unitId: "unit-1", quantity: "2", orderNo: "ORD-1", productNameSnapshot: "P", productSpecificationSnapshot: "S", remark: null };
  const prisma = {
    finishedGoodsOutbound: { findFirst: async () => current, update: async () => current },
    $transaction: async (fn) => fn({
      $queryRaw: async () => [],
      finishedGoodsOutbound: { update: async ({ data }) => ({ ...current, ...data }) },
      inventoryFact: { findFirst: async () => null, create: async () => { calls.push("inventory-reversal"); } },
      // 冲销后要把来源出库通知退回待处理（新增链路），替身必须提供该方法。
      finishedGoodsOutboundNotice: { updateMany: async () => ({ count: 0 }) },
      receivableSource: {
        findFirst: async () => ({ id: "receivable-1", status: "draft", remark: null, allocations: [] }),
        update: async ({ data }) => { cancelled = data.status === "cancelled"; },
      },
    }),
  };
  const audit = { update: () => ({ updatedBy: "user-1" }), record: async () => {} };
  const service = new FinishedGoodsOutboundService(prisma, audit, {});
  await service.reverseOutbound("outbound-1", "登记错误", { id: "user-1" });
  assert.equal(cancelled, true);
  assert.deepEqual(calls, ["inventory-reversal"]);
});

test("finished-goods outbound reversal is blocked by a confirmed receivable source", async () => {
  let inventoryReversal = false;
  const current = { id: "outbound-1", status: "posted", productionOrderId: "production-1", unitId: "unit-1", quantity: "2", orderNo: "ORD-1", productNameSnapshot: "P", productSpecificationSnapshot: "S", remark: null };
  const prisma = {
    finishedGoodsOutbound: { findFirst: async () => current, update: async () => current },
    $transaction: async (fn) => fn({
      $queryRaw: async () => [],
      inventoryFact: { findFirst: async () => null, create: async () => { inventoryReversal = true; } },
      finishedGoodsOutboundNotice: { updateMany: async () => ({ count: 0 }) },
      receivableSource: { findFirst: async () => ({ id: "receivable-1", status: "confirmed", remark: null, allocations: [] }) },
    }),
  };
  const audit = { update: () => ({}), record: async () => {} };
  const service = new FinishedGoodsOutboundService(prisma, audit, {});
  await assert.rejects(
    () => service.reverseOutbound("outbound-1", "登记错误", { id: "user-1" }),
    (error) => error.getResponse().code === "OUTBOUND_REVERSAL_HAS_RECEIVABLE",
  );
  assert.equal(inventoryReversal, false);
});

test("finished-goods outbound reversal is blocked by posted receivable payment allocations", async () => {
  const current = { id: "outbound-1", status: "posted", productionOrderId: "production-1", unitId: "unit-1", quantity: "2", orderNo: "ORD-1", productNameSnapshot: "P", productSpecificationSnapshot: "S", remark: null };
  const prisma = {
    finishedGoodsOutbound: { findFirst: async () => current, update: async () => current },
    $transaction: async (fn) => fn({
      $queryRaw: async () => [],
      inventoryFact: { findFirst: async () => null, create: async () => {} },
      receivableSource: { findFirst: async () => ({ id: "receivable-1", status: "partially_paid", remark: null, allocations: [{ payment: { status: "posted" } }] }) },
    }),
  };
  const audit = { update: () => ({}), record: async () => {} };
  const service = new FinishedGoodsOutboundService(prisma, audit, {});
  await assert.rejects(
    () => service.reverseOutbound("outbound-1", "登记错误", { id: "user-1" }),
    (error) => error.getResponse().code === "OUTBOUND_REVERSAL_HAS_RECEIVABLE_PAYMENTS",
  );
});
