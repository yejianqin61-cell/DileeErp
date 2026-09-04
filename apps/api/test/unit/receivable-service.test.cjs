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
