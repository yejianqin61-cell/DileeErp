const assert = require("node:assert/strict");
const { test } = require("node:test");
const { RawMaterialInboundsService } = require("../../dist/modules/procurement/raw-material-inbounds.service.js");

test("pending payable sources expose purchase order and receipt batch sequence", async () => {
  const service = new RawMaterialInboundsService({ payableSource: { findMany: async () => [{ id: "source-1", purchaseOrder: { purchaseOrderNo: "PO-1" }, purchaseReceipt: { extensionData: { batch_sequence: 3 } } }] } }, {}, {});
  const rows = await service.payableSources();
  assert.equal(rows[0].purchase_order_no, "PO-1");
  assert.equal(rows[0].batch_sequence, 3);
});
