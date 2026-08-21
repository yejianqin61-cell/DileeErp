const assert = require("node:assert/strict");
const { test } = require("node:test");
const { UnprocessableEntityException } = require("@nestjs/common");
const { RawMaterialInboundsService } = require("../dist/modules/procurement/raw-material-inbounds.service.js");

const user = { id: "1f7d261d-0089-4d32-9aa1-19942c41cb1d", username: "operator", display_name: "操作员" };
const audit = { create: () => ({ createdBy: user.id, updatedBy: user.id }), update: () => ({ updatedBy: user.id }), record: async () => {} };

test("raw material inbound cannot exceed QC allowed quantity", async () => {
  const prisma = { rawMaterialInbound: { create: async () => { throw new Error("must not write"); } } };
  const service = new RawMaterialInboundsService(prisma, audit, {});
  service.requireInspection = async () => ({ id: "inspection-1", orderNo: "DL260001", acceptedQuantity: "10", conditionalQuantity: "0", rawMaterialInbounds: [{ quantity: "2" }], purchaseReceiptId: "receipt-1", purchaseReceipt: { purchaseOrderId: "po-1", purchaseOrderItemId: "item-1", purchaseOrder: { supplierId: "supplier-1" }, purchaseOrderItem: { materialId: "material-1" } } });
  await assert.rejects(() => service.create({ incoming_inspection_id: "inspection-1", quantity: "9" }, user), (error) => error instanceof UnprocessableEntityException && error.getResponse().code === "INBOUND_QUANTITY_EXCEEDED");
});
