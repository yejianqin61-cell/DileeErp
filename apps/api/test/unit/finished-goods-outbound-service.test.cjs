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
