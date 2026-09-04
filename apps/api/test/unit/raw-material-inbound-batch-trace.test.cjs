const assert = require("node:assert/strict");
const { test } = require("node:test");
const { RawMaterialInboundsService } = require("../../dist/modules/procurement/raw-material-inbounds.service.js");

test("raw material inbound list exposes purchase and batch traceability", async () => {
  const service = new RawMaterialInboundsService({ rawMaterialInbound: { findMany: async () => [{ id: "inbound-1", purchaseOrder: { purchaseOrderNo: "PO-1" }, purchaseReceipt: { receiptNo: "GR-2", extensionData: { batch_sequence: 2 } }, incomingInspection: { extensionData: {}, status: "accepted" } }] } }, {}, {});
  const rows = await service.list();
  assert.deepEqual({ purchase_order_no: rows[0].purchase_order_no, receipt_no: rows[0].receipt_no, batch_sequence: rows[0].batch_sequence, inspection_status: rows[0].inspection_status }, { purchase_order_no: "PO-1", receipt_no: "GR-2", batch_sequence: 2, inspection_status: "accepted" });
});
