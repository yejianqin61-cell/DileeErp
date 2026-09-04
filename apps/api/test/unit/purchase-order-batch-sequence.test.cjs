const assert = require("node:assert/strict");
const { test } = require("node:test");
const { PurchaseOrdersService } = require("../../dist/modules/procurement/purchase-orders.service.js");

test("purchase order details preserve persisted receipt batch numbers", async () => {
  const service = new PurchaseOrdersService({ purchaseOrder: { findFirst: async () => ({
    id: "po-1",
    items: [{
      id: "item-1",
      receipts: [
        { id: "receipt-2", receiptNo: "GR-2", extensionData: { batch_sequence: 2 }, quantity: "3", inspections: [], rawMaterialInbounds: [], payableSources: [] },
        { id: "receipt-3", receiptNo: "GR-3", extensionData: { batch_sequence: 3 }, quantity: "4", inspections: [], rawMaterialInbounds: [], payableSources: [] },
      ],
    }],
  }) } }, {});

  const result = await service.get("po-1");
  assert.deepEqual(result.items[0].receipts.map((row) => row.batchSequence), [2, 3]);
  assert.deepEqual(result.items[0].batchWorkflows.map((row) => row.batchSequence), [2, 3]);
});

test("purchase order details fall back to position for legacy receipts", async () => {
  const service = new PurchaseOrdersService({ purchaseOrder: { findFirst: async () => ({
    id: "po-1",
    items: [{ id: "item-1", receipts: [{ id: "receipt-1", receiptNo: "GR-1", extensionData: null, quantity: "1", inspections: [], rawMaterialInbounds: [], payableSources: [] }] }],
  }) } }, {});
  const result = await service.get("po-1");
  assert.equal(result.items[0].receipts[0].batchSequence, 1);
});
