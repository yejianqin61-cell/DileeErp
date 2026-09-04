const assert = require("node:assert/strict");
const { test } = require("node:test");
const { IncomingInspectionsService } = require("../../dist/modules/procurement/incoming-inspections.service.js");

test("incoming inspection preserves the purchase receipt batch sequence", async () => {
  const inspection = { id: "inspection-1", orderNo: "PO-1", status: "accepted", inspectedQuantity: 2, acceptedQuantity: 2, conditionalQuantity: 0, rejectedQuantity: 0, extensionData: {} };
  const tx = {
    $queryRaw: async () => [],
    purchaseReceipt: { findFirst: async () => ({ id: "receipt-2", orderNo: "PO-1", quantity: 2, extensionData: { batch_sequence: 2 }, inspections: [] }) },
    incomingInspection: { create: async ({ data }) => { assert.equal(data.extensionData.batch_sequence, 2); return inspection; } },
  };
  const audit = { record: async () => undefined, create: () => ({}), update: () => ({}) };
  const service = new IncomingInspectionsService({ $transaction: async (fn) => fn(tx) }, audit);
  await service.create({ purchase_receipt_id: "receipt-2", inspected_quantity: "2", accepted_quantity: "2", conditional_quantity: "0", rejected_quantity: "0" }, { id: "user-1" });
});

test("inspection list uses the persisted receipt batch sequence", async () => {
  const service = new IncomingInspectionsService({ incomingInspection: { findMany: async () => [{ id: "inspection-2", extensionData: { batch_sequence: 9 }, purchaseReceipt: { purchaseOrderId: "po-1", extensionData: { batch_sequence: 2 } } }] } }, {});
  const rows = await service.list();
  assert.equal(rows[0].batchSequence, 2);
});
