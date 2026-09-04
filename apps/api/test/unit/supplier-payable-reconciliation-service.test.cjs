const assert = require("node:assert/strict");
const test = require("node:test");
const { SupplierPayableReconciliationService } = require("../../dist/modules/finance/supplier-payable-reconciliation.service.js");

test("supplier payable reconciliation resolution locks and rechecks status", async () => {
  let lockCount = 0;
  let updateCount = 0;
  const row = { id: "recon-1", status: "resolved" };
  const prisma = {
    supplierPayableReconciliation: { findFirst: async () => row, update: async () => { updateCount += 1; return row; } },
    $transaction: async (fn) => fn({
      $queryRaw: async () => { lockCount += 1; return []; },
      supplierPayableReconciliation: prisma.supplierPayableReconciliation,
    }),
  };
  const service = new SupplierPayableReconciliationService(prisma, { update: () => ({}), record: async () => {} });
  await assert.rejects(() => service.resolve("recon-1", "已核实", { id: "user-1" }), (error) => error.getResponse().code === "RECONCILIATION_NOT_RESOLVABLE");
  assert.equal(lockCount, 1);
  assert.equal(updateCount, 0);
});
