const assert = require("node:assert/strict");
const { test } = require("node:test");
const { UnprocessableEntityException } = require("@nestjs/common");
const { RawMaterialInboundsService } = require("../../dist/modules/procurement/raw-material-inbounds.service.js");

test("raw-material inbound edits lock and recheck the QC source", async () => {
  const calls = [];
  const tx = {
    $queryRaw: async () => { calls.push("lock"); },
    rawMaterialInbound: { findFirst: async () => ({ id: "inbound-1", status: "draft", incomingInspectionId: "inspection-1" }), update: async () => ({ id: "inbound-1", orderNo: "SO-1" }) },
    incomingInspection: { findFirst: async () => ({ id: "inspection-1", acceptedQuantity: "5", conditionalQuantity: "0", rawMaterialInbounds: [{ id: "inbound-1", quantity: "1" }, { id: "inbound-2", quantity: "5" }] }) },
  };
  const prisma = { $transaction: async (fn) => fn(tx) };
  const service = new RawMaterialInboundsService(prisma, { update: () => ({}), record: async () => undefined }, {});
  await assert.rejects(() => service.update("inbound-1", { quantity: "2" }, { id: "user-1" }), (error) => error instanceof UnprocessableEntityException && error.getResponse().code === "INBOUND_QUANTITY_EXCEEDED");
  assert.deepEqual(calls, ["lock", "lock"]);
});

test("raw-material inbound posting uses the locked current draft", async () => {
  const quantities = [];
  const current = {
    id: "inbound-1", status: "draft", incomingInspectionId: "inspection-1", materialId: "material-1", unitId: "unit-1", inventoryCategory: "raw_material", quantity: "7", purchaseReceiptId: "receipt-1", purchaseOrderId: "purchase-1", purchaseOrderItemId: "item-1", supplierId: "supplier-1", orderNo: "SO-1",
    incomingInspection: { purchaseReceipt: { purchaseOrderItem: { unitPrice: "2", taxRate: "0" }, purchaseOrder: { currency: "CNY" } } },
  };
  const tx = {
    $queryRaw: async () => undefined,
    rawMaterialInbound: { findFirst: async () => current, update: async () => current },
    inventoryFact: { findFirst: async () => null, create: async ({ data }) => { quantities.push(data.quantityDelta); } },
    payableSource: { findUnique: async () => ({ id: "payable-1" }) },
  };
  const prisma = { rawMaterialInbound: { findFirst: async () => ({ id: "inbound-1", status: "draft" }) }, $transaction: async (fn) => fn(tx) };
  const service = new RawMaterialInboundsService(prisma, { update: () => ({}), create: () => ({}), record: async () => undefined }, {});
  await service.post("inbound-1", { id: "user-1" });
  assert.deepEqual(quantities, ["7"]);
});
