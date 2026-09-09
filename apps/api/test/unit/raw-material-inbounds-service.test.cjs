const assert = require("node:assert/strict");
const { test } = require("node:test");
const { UnprocessableEntityException } = require("@nestjs/common");
const { RawMaterialInboundsService } = require("../../dist/modules/procurement/raw-material-inbounds.service.js");
const { Prisma } = require("@prisma/client");

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
    incomingInspection: { status: "accepted", acceptedQuantity: "7", conditionalQuantity: "0", rawMaterialInbounds: [], purchaseReceipt: { purchaseOrderItem: { unitPrice: "2", taxRate: "0" }, purchaseOrder: { currency: "CNY" } } },
  };
  const tx = {
    $queryRaw: async () => undefined,
    rawMaterialInbound: { findFirst: async () => current, update: async () => current },
    inventoryFact: { findFirst: async () => null, create: async ({ data }) => { quantities.push(data.quantityDelta); } },
    payableSource: { findFirst: async () => ({ id: "payable-1" }), findUnique: async () => ({ id: "payable-1" }) },
  };
  const prisma = { rawMaterialInbound: { findFirst: async () => ({ id: "inbound-1", status: "draft" }) }, $transaction: async (fn) => fn(tx) };
  const service = new RawMaterialInboundsService(prisma, { update: () => ({}), create: () => ({}), record: async () => undefined }, {});
  await service.post("inbound-1", { id: "user-1" });
  assert.deepEqual(quantities, ["7"]);
});

test("raw-material inbound reversal voids the pending receipt payable source", async () => {
  let where;
  const inbound = { id: "inbound-1", status: "posted", orderNo: "SO-1", materialId: "material-1", unitId: "unit-1", quantity: "3", purchaseReceiptId: "receipt-1", payableSources: [] };
  const tx = {
    rawMaterialInbound: { update: async ({ data }) => ({ ...inbound, ...data }) },
    inventoryFact: { create: async () => ({}) },
    payableSource: { updateMany: async (args) => { where = args.where; return { count: 1 }; } },
  };
  const prisma = { rawMaterialInbound: { findFirst: async () => inbound }, $transaction: async (fn) => fn(tx) };
  const service = new RawMaterialInboundsService(prisma, { update: () => ({}), record: async () => undefined }, { rawMaterialBalance: async () => new Prisma.Decimal("10") });
  await service.reverse("inbound-1", { reason: "入库登记错误" }, { id: "user-1" });
  assert.deepEqual(where, { OR: [{ rawMaterialInboundId: "inbound-1" }, { purchaseReceiptId: "receipt-1" }], status: "pending_finance" });
});
