const assert = require("node:assert/strict");
const test = require("node:test");
const { ReceivableAdjustmentService } = require("../../dist/modules/finance/receivable-adjustment.service.js");

test("receivable adjustment posting locks and rechecks the adjustment", async () => {
  const locks = [];
  const prisma = {
    receivableAdjustment: { findFirst: async () => ({ id: "adjustment-1", status: "posted" }) },
    $transaction: async (fn) => fn({ $queryRaw: async (_s, ...values) => { locks.push(values[0]); }, receivableAdjustment: prisma.receivableAdjustment }),
  };
  const service = new ReceivableAdjustmentService(prisma, {}, {});
  await assert.rejects(() => service.post("adjustment-1", { id: "user-1" }), (error) => error.getResponse().code === "RECEIVABLE_ADJUSTMENT_NOT_POSTABLE");
  assert.deepEqual(locks, ["adjustment-1"]);
});

test("receivable adjustment reversal locks and rechecks status", async () => {
  let lockCount = 0;
  let updateCount = 0;
  const row = { id: "adjustment-1", status: "reversed" };
  const prisma = { receivableAdjustment: { findFirst: async () => row, update: async () => { updateCount += 1; return row; } }, $transaction: async (fn) => fn({ $queryRaw: async () => { lockCount += 1; }, receivableAdjustment: prisma.receivableAdjustment }) };
  const service = new ReceivableAdjustmentService(prisma, { update: () => ({}), recordWithOrderNo: async () => {} }, {});
  await assert.rejects(() => service.reverse("adjustment-1", "撤销原因", { id: "user-1" }), (error) => error.getResponse().code === "RECEIVABLE_ADJUSTMENT_NOT_REVERSIBLE");
  assert.equal(lockCount, 1); assert.equal(updateCount, 0);
});
