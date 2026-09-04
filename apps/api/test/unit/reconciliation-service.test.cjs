const assert = require("node:assert/strict");
const test = require("node:test");
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
