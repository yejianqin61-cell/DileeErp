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
    rawMaterialInboundNotice: { findFirst: async () => ({ status: "acknowledged" }) },
    incomingInspection: { findFirst: async () => ({ id: "inspection-1", acceptedQuantity: "5", conditionalQuantity: "0", rawMaterialInbounds: [{ id: "inbound-1", quantity: new Prisma.Decimal("1"), status: "draft" }, { id: "inbound-2", quantity: new Prisma.Decimal("5"), status: "draft" }] }) },
  };
  const prisma = { $transaction: async (fn) => fn(tx) };
  const service = new RawMaterialInboundsService(prisma, { update: () => ({}), record: async () => undefined }, {});
  await assert.rejects(() => service.update("inbound-1", { quantity: "2" }, { id: "user-1" }), (error) => error instanceof UnprocessableEntityException && error.getResponse().code === "INBOUND_QUANTITY_EXCEEDED");
  assert.deepEqual(calls, ["lock", "lock"]);
});

test("raw-material inbound posting uses the locked current draft", async () => {
  const quantities = [];
  const current = {
    id: "inbound-1", status: "draft", incomingInspectionId: "inspection-1", materialId: "material-1", unitId: "unit-1", inventoryCategory: "raw_material", quantity: new Prisma.Decimal("7"), purchaseReceiptId: "receipt-1", purchaseOrderId: "purchase-1", purchaseOrderItemId: "item-1", supplierId: "supplier-1", orderNo: "SO-1",
    inboundNotice: { status: "acknowledged" }, incomingInspection: { qcResult: "all_inbound", status: "accepted", acceptedQuantity: "7", conditionalQuantity: "0", rawMaterialInbounds: [], purchaseReceipt: { purchaseOrderItem: { unitPrice: "2", taxRate: "0" }, purchaseOrder: { currency: "CNY" } } },
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
  assert.deepEqual(quantities.map(String), ["7"]);
});

test("inbound posting snapshots all-inbound payable with purchase unit price", async () => {
  let created;
  const current = {
    id: "inbound-1", status: "draft", quantity: new Prisma.Decimal("5"), materialId: "material-1", unitId: "unit-1", inventoryCategory: "raw_material", purchaseReceiptId: "receipt-1", purchaseOrderId: "purchase-1", purchaseOrderItemId: "item-1", supplierId: "supplier-1", orderNo: "SO-1",
    inboundNotice: { status: "acknowledged" },
    incomingInspection: { qcResult: "all_inbound", status: "accepted", acceptedQuantity: "5", conditionalQuantity: "0", rawMaterialInbounds: [], purchaseReceipt: { purchaseOrderItem: { unitPrice: "2", taxRate: "0" }, purchaseOrder: { currency: "CNY" } } },
  };
  const tx = {
    $queryRaw: async () => [],
    rawMaterialInbound: { findFirst: async () => current, update: async () => current },
    inventoryFact: { create: async () => ({}) },
    payableSource: { findFirst: async () => null, create: async ({ data }) => { created = data; return { id: "payable-1", ...data }; } },
  };
  const prisma = { rawMaterialInbound: { findFirst: async () => ({ id: "inbound-1", status: "draft" }) }, $transaction: async (fn) => fn(tx) };
  const service = new RawMaterialInboundsService(prisma, { update: () => ({}), create: () => ({}), record: async () => undefined }, {});
  await service.post("inbound-1", { id: "user-1" });
  assert.equal(created.materialId, "material-1");
  assert.equal(created.unitPrice, "2");
  assert.equal(created.amount, "10.0000");
  assert.equal(created.settlementTotalAmount, null);
  assert.equal(created.settlementAmountReason, null);
  assert.equal(created.qcResult, "all_inbound");
  assert.equal(created.acceptedQuantity, "5");
  assert.equal(String(created.actualInboundQuantity), "5");
});

test("inbound posting snapshots partial-inbound settlement amount and reason", async () => {
  let created;
  const current = {
    id: "inbound-1", status: "draft", quantity: new Prisma.Decimal("3"), materialId: "material-1", unitId: "unit-1", inventoryCategory: "raw_material", purchaseReceiptId: "receipt-1", purchaseOrderId: "purchase-1", purchaseOrderItemId: "item-1", supplierId: "supplier-1", orderNo: "SO-1",
    settlementUnitPrice: "2", settlementTotalAmount: new Prisma.Decimal("5"), settlementAmountReason: "质量折价",
    inboundNotice: { status: "acknowledged" },
    incomingInspection: { qcResult: "partial_inbound", status: "partially_accepted", acceptedQuantity: "5", conditionalQuantity: "0", rawMaterialInbounds: [], purchaseReceipt: { purchaseOrderItem: { unitPrice: "2", taxRate: "0" }, purchaseOrder: { currency: "CNY" } } },
  };
  const tx = {
    $queryRaw: async () => [],
    rawMaterialInbound: { findFirst: async () => current, update: async () => current },
    inventoryFact: { create: async () => ({}) },
    payableSource: { findFirst: async () => null, create: async ({ data }) => { created = data; return { id: "payable-1", ...data }; } },
  };
  const prisma = { rawMaterialInbound: { findFirst: async () => ({ id: "inbound-1", status: "draft" }) }, $transaction: async (fn) => fn(tx) };
  const service = new RawMaterialInboundsService(prisma, { update: () => ({}), create: () => ({}), record: async () => undefined }, {});
  await service.post("inbound-1", { id: "user-1" });
  assert.equal(created.unitPrice, "2");
  assert.equal(created.amount, "5.0000");
  assert.equal(created.settlementUnitPrice, "2");
  assert.equal(String(created.settlementTotalAmount), "5");
  assert.equal(created.settlementAmountReason, "质量折价");
  assert.equal(created.qcResult, "partial_inbound");
  assert.equal(created.acceptedQuantity, "5");
  assert.equal(String(created.actualInboundQuantity), "3");
});


test("raw-material inbound reversal voids pending payable source", async () => {
  let payableWhere;
  let payableUpdates = 0;
  const inbound = { id: "inbound-1", status: "posted", orderNo: "SO-1", materialId: "material-1", unitId: "unit-1", quantity: "3", purchaseReceiptId: "receipt-1" };
  const current = { ...inbound, payableSources: [{ id: "payable-1", supplierPayableEntry: null }] };
  const tx = {
    $queryRaw: async () => [],
    rawMaterialInbound: { findFirst: async () => current, update: async ({ data }) => ({ ...current, ...data }) },
    inventoryFact: { create: async () => ({}) },
    payableSource: { updateMany: async (args) => { payableWhere = args.where; payableUpdates += 1; return { count: 1 }; } },
    supplierPayableEntry: { updateMany: async () => ({ count: 0 }) },
  };
  const prisma = { rawMaterialInbound: { findFirst: async () => inbound }, $transaction: async (fn) => fn(tx) };
  const service = new RawMaterialInboundsService(prisma, { update: () => ({}), record: async () => undefined }, { rawMaterialBalance: async () => new Prisma.Decimal("10") });
  await service.reverse("inbound-1", { reason: "入库登记错误" }, { id: "user-1" });
  assert.deepEqual(payableWhere, { OR: [{ rawMaterialInboundId: "inbound-1" }, { purchaseReceiptId: "receipt-1", rawMaterialInboundId: null }], status: { not: "voided" } });
  assert.equal(payableUpdates, 1);
});

test("raw-material inbound reversal voids a draft payable entry", async () => {
  let entryUpdate;
  const inbound = { id: "inbound-1", status: "posted", orderNo: "SO-1", materialId: "material-1", unitId: "unit-1", quantity: "3", purchaseReceiptId: "receipt-1" };
  const current = { ...inbound, payableSources: [{ id: "payable-1", supplierPayableEntry: { id: "payable-entry-1", status: "draft", allocations: [] } }] };
  const tx = {
    $queryRaw: async () => [],
    rawMaterialInbound: { findFirst: async () => current, update: async ({ data }) => ({ ...current, ...data }) },
    inventoryFact: { create: async () => ({}) },
    payableSource: { updateMany: async () => ({ count: 1 }) },
    supplierPayableEntry: { updateMany: async (args) => { entryUpdate = args; return { count: 1 }; } },
  };
  const prisma = { rawMaterialInbound: { findFirst: async () => inbound }, $transaction: async (fn) => fn(tx) };
  const service = new RawMaterialInboundsService(prisma, { update: () => ({}), record: async () => undefined }, { rawMaterialBalance: async () => new Prisma.Decimal("10") });
  await service.reverse("inbound-1", { reason: "入库登记错误" }, { id: "user-1" });
  assert.deepEqual(entryUpdate.where, { id: { in: ["payable-entry-1"] } });
  assert.equal(entryUpdate.data.status, "voided");
});

test("raw-material inbound reversal is blocked by a confirmed payable entry", async () => {
  let inventoryWrites = 0;
  const inbound = { id: "inbound-1", status: "posted", orderNo: "SO-1", materialId: "material-1", unitId: "unit-1", quantity: "3", purchaseReceiptId: "receipt-1" };
  const current = { ...inbound, payableSources: [{ id: "payable-1", supplierPayableEntry: { id: "payable-entry-1", status: "confirmed", allocations: [] } }] };
  const tx = {
    $queryRaw: async () => [],
    rawMaterialInbound: { findFirst: async () => current, update: async () => current },
    inventoryFact: { create: async () => { inventoryWrites += 1; } },
    payableSource: { updateMany: async () => ({ count: 0 }) },
    supplierPayableEntry: { updateMany: async () => ({ count: 0 }) },
  };
  const prisma = { rawMaterialInbound: { findFirst: async () => inbound }, $transaction: async (fn) => fn(tx) };
  const service = new RawMaterialInboundsService(prisma, { update: () => ({}), record: async () => undefined }, { rawMaterialBalance: async () => new Prisma.Decimal("10") });
  await assert.rejects(() => service.reverse("inbound-1", { reason: "入库登记错误" }, { id: "user-1" }), (error) => error.getResponse().code === "INBOUND_PAYABLE_ALREADY_CONFIRMED");
  assert.equal(inventoryWrites, 0);
});

test("raw-material inbound reversal is blocked by posted payable payment allocations", async () => {
  const inbound = { id: "inbound-1", status: "posted", orderNo: "SO-1", materialId: "material-1", unitId: "unit-1", quantity: "3", purchaseReceiptId: "receipt-1" };
  const current = { ...inbound, payableSources: [{ id: "payable-1", supplierPayableEntry: { id: "payable-entry-1", status: "partially_paid", allocations: [{ payment: { status: "posted" } }] } }] };
  const tx = {
    $queryRaw: async () => [],
    rawMaterialInbound: { findFirst: async () => current, update: async () => current },
    inventoryFact: { create: async () => ({}) },
    payableSource: { updateMany: async () => ({ count: 0 }) },
    supplierPayableEntry: { updateMany: async () => ({ count: 0 }) },
  };
  const prisma = { rawMaterialInbound: { findFirst: async () => inbound }, $transaction: async (fn) => fn(tx) };
  const service = new RawMaterialInboundsService(prisma, { update: () => ({}), record: async () => undefined }, { rawMaterialBalance: async () => new Prisma.Decimal("10") });
  await assert.rejects(() => service.reverse("inbound-1", { reason: "入库登记错误" }, { id: "user-1" }), (error) => error.getResponse().code === "INBOUND_PAYABLE_HAS_PAYMENT");
});

function settlementHarness(inspection) {
  return new RawMaterialInboundsService(
    {
      incomingInspection: { findFirst: async () => inspection },
      rawMaterialInboundNotice: { findFirst: async () => ({ id: "notice-1", status: "acknowledged" }) },
      $transaction: async (fn) => fn({
        incomingInspection: { findFirst: async () => inspection },
        rawMaterialInboundNotice: { findFirst: async () => ({ id: "notice-1", status: "acknowledged" }) },
        rawMaterialInbound: { create: async () => ({ id: "inbound-x" }) },
      }),
    },
    { create: () => ({}), update: () => ({}), record: async () => undefined },
    {},
  );
}

test("partial inbound requires settlement price, total, and reason before any write", async () => {
  const inspection = { id: "inspection-1", qcResult: "partial_inbound", status: "partially_accepted", acceptedQuantity: "5", conditionalQuantity: "0", rawMaterialInbounds: [], purchaseReceipt: { purchaseOrder: {}, purchaseOrderItem: { material: { materialType: "raw_material" } } } };
  const service = settlementHarness(inspection);
  await assert.rejects(() => service.create({ incoming_inspection_id: "inspection-1", quantity: "3" }, { id: "user-1" }), (error) => error.getResponse().code === "PARTIAL_INBOUND_SETTLEMENT_REQUIRED");
  // 价+总缺原因：先命中通用“总价必须说明原因”，也属于正确拦截。
  await assert.rejects(() => service.create({ incoming_inspection_id: "inspection-1", quantity: "3", settlement_unit_price: "2", settlement_total_amount: "6" }, { id: "user-1" }), (error) => ["PARTIAL_INBOUND_SETTLEMENT_REQUIRED", "SETTLEMENT_REASON_REQUIRED"].includes(error.getResponse().code));
});

test("a manual settlement total requires a discrepancy reason even on create", async () => {
  const inspection = { id: "inspection-1", qcResult: "all_inbound", status: "accepted", acceptedQuantity: "5", conditionalQuantity: "0", rawMaterialInbounds: [], purchaseReceipt: { purchaseOrder: {}, purchaseOrderItem: { material: { materialType: "raw_material" } } } };
  const service = settlementHarness(inspection);
  await assert.rejects(() => service.create({ incoming_inspection_id: "inspection-1", quantity: "3", settlement_total_amount: "9" }, { id: "user-1" }), (error) => error.getResponse().code === "SETTLEMENT_REASON_REQUIRED");
});


test("inbound posting restores a voided payable source instead of creating a duplicate", async () => {
  let updated;
  let createCount = 0;
  const current = {
    id: "inbound-1", status: "draft", quantity: new Prisma.Decimal("5"), materialId: "material-1", unitId: "unit-1", inventoryCategory: "raw_material", purchaseReceiptId: "receipt-1", purchaseOrderId: "purchase-1", purchaseOrderItemId: "item-1", supplierId: "supplier-1", orderNo: "SO-1",
    inboundNotice: { status: "acknowledged" },
    incomingInspection: { qcResult: "all_inbound", status: "accepted", acceptedQuantity: "5", conditionalQuantity: "0", rejectedQuantity: "0", rawMaterialInbounds: [], purchaseReceipt: { purchaseOrderItem: { unitPrice: "2", taxRate: "0" }, purchaseOrder: { currency: "CNY" } } },
  };
  const tx = {
    $queryRaw: async () => [],
    rawMaterialInbound: { findFirst: async () => current, update: async () => current },
    inventoryFact: { create: async () => ({}) },
    payableSource: {
      findFirst: async () => ({ id: "payable-existing", status: "voided" }),
      update: async ({ data }) => { updated = data; return { id: "payable-existing", ...data }; },
      create: async () => { createCount += 1; },
    },
  };
  const prisma = { rawMaterialInbound: { findFirst: async () => ({ id: "inbound-1", status: "draft" }) }, $transaction: async (fn) => fn(tx) };
  const service = new RawMaterialInboundsService(prisma, { update: () => ({}), create: () => ({}), record: async () => undefined }, {});
  await service.post("inbound-1", { id: "user-1" });
  assert.equal(updated.status, "pending_finance");
  assert.equal(String(updated.actualInboundQuantity), "5");
  assert.equal(updated.qcResult, "all_inbound");
  assert.equal(createCount, 0);
});

test("legacy partial inspection without qc_result still requires settlement fields", async () => {
  const inspection = { id: "inspection-legacy", qcResult: null, status: "partially_accepted", acceptedQuantity: "5", conditionalQuantity: "0", rawMaterialInbounds: [], purchaseReceipt: { purchaseOrder: {}, purchaseOrderItem: { material: { materialType: "raw_material" } } } };
  const service = settlementHarness(inspection);
  await assert.rejects(
    () => service.create({ incoming_inspection_id: "inspection-legacy", quantity: "3" }, { id: "user-1" }),
    (error) => error.getResponse().code === "PARTIAL_INBOUND_SETTLEMENT_REQUIRED",
  );
});
