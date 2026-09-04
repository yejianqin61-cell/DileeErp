const assert = require("node:assert/strict");
const { test } = require("node:test");
const { UnprocessableEntityException } = require("@nestjs/common");
const { RawMaterialInboundsService } = require("../../dist/modules/procurement/raw-material-inbounds.service.js");

test("inbound posting rechecks inspection completion after locking", async () => {
  const tx = {
    $queryRaw: async () => [],
    rawMaterialInbound: { findFirst: async () => ({ id: "inbound-1", status: "draft", incomingInspection: { status: "pending", acceptedQuantity: 2, conditionalQuantity: 0, rawMaterialInbounds: [], purchaseReceipt: { purchaseOrderItem: { unitPrice: 1 }, purchaseOrder: { currency: "CNY" } } }, materialId: "material-1", unitId: "unit-1", inventoryCategory: "raw_material", quantity: 1 }) },
  };
  const service = new RawMaterialInboundsService({ rawMaterialInbound: { findFirst: async () => ({ id: "inbound-1", status: "draft" }) }, $transaction: async (fn) => fn(tx) }, {} , {});
  await assert.rejects(() => service.post("inbound-1", { id: "user-1" }), (error) => error instanceof UnprocessableEntityException && error.getResponse().code === "INSPECTION_NOT_AVAILABLE");
});
