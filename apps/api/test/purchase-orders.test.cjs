const assert = require("node:assert/strict");
const { test } = require("node:test");
const { PurchaseOrdersService } = require("../dist/modules/procurement/purchase-orders.service.js");
const { NotFoundException, UnprocessableEntityException } = require("@nestjs/common");

test("purchase order accepts the editable BOM belonging to its confirmed sales order", async () => {
  const prisma = {
    salesOrder: { findFirst: async () => ({ id: "order-1", orderNo: "SO-1" }) },
    bom: { findFirst: async () => ({ id: "bom-1", salesOrderId: "order-1", orderNo: "SO-1", version: 1, status: "draft" }) },
    supplier: { findMany: async () => [{ id: "supplier-1" }] },
    material: { findMany: async () => [{ id: "material-1" }] },
    unit: { findMany: async () => [{ id: "unit-1" }] },
    bomItem: { findMany: async () => [] },
  };
  const service = new PurchaseOrdersService(prisma, {});
  const refs = await service.refs({ order_no: "SO-1", bom_id: "bom-1", supplier_id: "supplier-1", purchase_date: new Date().toISOString(), currency: "USD", items: [{ material_id: "material-1", unit_id: "unit-1", supplier_id: "supplier-1", quantity: "1", unit_price: "0", extension_data: { outside_bom_reason: "临时替代料" } }] });
  assert.equal(refs.bom.id, "bom-1");
  assert.equal(refs.order.id, "order-1");
});

test("purchase order requires a reason for material outside the BOM", async () => {
  const prisma = {
    salesOrder: { findFirst: async () => ({ id: "order-1", orderNo: "SO-1" }) },
    bom: { findFirst: async () => ({ id: "bom-1", salesOrderId: "order-1", orderNo: "SO-1", version: 1 }) },
    supplier: { findMany: async () => [{ id: "supplier-1" }] },
    material: { findMany: async () => [{ id: "material-1" }] },
    unit: { findMany: async () => [{ id: "unit-1" }] },
    bomItem: { findMany: async () => [] },
  };
  const service = new PurchaseOrdersService(prisma, {});
  await assert.rejects(() => service.refs({ order_no: "SO-1", bom_id: "bom-1", supplier_id: "supplier-1", purchase_date: new Date().toISOString(), currency: "CNY", items: [{ material_id: "material-1", unit_id: "unit-1", supplier_id: "supplier-1", quantity: "1", unit_price: "1" }] }), (error) => error instanceof UnprocessableEntityException && error.getResponse().code === "PURCHASE_OUTSIDE_BOM_REASON_REQUIRED");
});

test("purchase order rejects a BOM item belonging to another BOM", async () => {
  const prisma = {
    salesOrder: { findFirst: async () => ({ id: "order-1", orderNo: "SO-1" }) },
    bom: { findFirst: async () => ({ id: "bom-1", salesOrderId: "order-1", orderNo: "SO-1", version: 1 }) },
    supplier: { findMany: async () => [{ id: "supplier-1" }] },
    material: { findMany: async () => [{ id: "material-1" }] },
    unit: { findMany: async () => [{ id: "unit-1" }] },
    bomItem: { findMany: async () => [] },
  };
  const service = new PurchaseOrdersService(prisma, {});
  await assert.rejects(() => service.refs({ order_no: "SO-1", bom_id: "bom-1", supplier_id: "supplier-1", purchase_date: new Date().toISOString(), currency: "CNY", items: [{ material_id: "material-1", bom_item_id: "other-item", unit_id: "unit-1", supplier_id: "supplier-1", quantity: "1", unit_price: "1" }] }), (error) => error instanceof UnprocessableEntityException && error.getResponse().code === "PURCHASE_BOM_ITEM_MISMATCH");
});

test("purchase order rejects finished products even with an outside-BOM reason", async () => {
  const prisma = {
    salesOrder: { findFirst: async () => ({ id: "order-1", orderNo: "SO-1" }) },
    bom: { findFirst: async () => ({ id: "bom-1", salesOrderId: "order-1", orderNo: "SO-1", version: 1 }) },
    supplier: { findMany: async () => [{ id: "supplier-1" }] },
    material: { findMany: async ({ where }) => (where.materialType === "raw_material" ? [] : [{ id: "product-1", materialType: "finished_product" }]) },
    unit: { findMany: async () => [{ id: "unit-1" }] },
    bomItem: { findMany: async () => [] },
  };
  const service = new PurchaseOrdersService(prisma, {});
  await assert.rejects(
    () => service.refs({ order_no: "SO-1", bom_id: "bom-1", supplier_id: "supplier-1", purchase_date: new Date().toISOString(), currency: "CNY", items: [{ material_id: "product-1", unit_id: "unit-1", supplier_id: "supplier-1", quantity: "1", unit_price: "1", extension_data: { outside_bom_reason: "测试" } }] }),
    (error) => error instanceof NotFoundException,
  );
});

test("only draft purchase orders can replace their rows", async () => {
  const service = new PurchaseOrdersService({ purchaseOrder: { findFirst: async () => ({ id: "purchase-1", status: "ordered", items: [] }) } }, {});
  await assert.rejects(() => service.update("purchase-1", {}, {}), (error) => error instanceof UnprocessableEntityException && error.getResponse().code === "PURCHASE_ORDER_NOT_EDITABLE");
});

test("completed receipt totals remain closable until arrival closure is recorded", async () => {
  const rows = [
    { id: "open", status: "arrived_complete", extensionData: { over_order: true } },
    { id: "closed", status: "arrived_complete", extensionData: { arrival_closed: true } },
  ];
  const service = new PurchaseOrdersService({ purchaseOrder: { findMany: async () => rows } }, {});
  const result = await service.list();
  assert.equal(result.find((row) => row.id === "open").status, "partially_arrived");
  assert.equal(result.find((row) => row.id === "closed").status, "arrived_complete");
});

test("closed arrival batches reject correction and cancellation", async () => {
  const service = new PurchaseOrdersService({ purchaseReceipt: { findFirst: async () => ({ purchaseOrder: { extensionData: { arrival_closed: true } } }) } }, {});
  await assert.rejects(() => service.updateReceiptV2("receipt-1", { quantity: "1", reason: "修正" }, {}), (error) => error instanceof UnprocessableEntityException && error.getResponse().code === "PURCHASE_ARRIVALS_CLOSED");
  await assert.rejects(() => service.cancelReceiptV2("receipt-1", "撤销", {}), (error) => error instanceof UnprocessableEntityException && error.getResponse().code === "PURCHASE_ARRIVALS_CLOSED");
});

test("receipt correction rechecks arrival closure after locking the purchase order", async () => {
  const tx = {
    $queryRaw: async () => [],
    purchaseReceipt: {
      findFirst: async () => ({
        id: "receipt-1",
        purchaseOrderId: "purchase-1",
        orderNo: "SO-1",
        extensionData: {},
        purchaseOrderItemId: "item-1",
        purchaseOrderItem: { quantity: new (require("@prisma/client").Prisma.Decimal)("10"), unitPrice: new (require("@prisma/client").Prisma.Decimal)("2") },
        inspections: [],
        rawMaterialInbounds: [],
        payableSources: [],
      }),
    },
    purchaseOrder: { findFirst: async () => ({ extensionData: { arrival_closed: true } }) },
  };
  const service = new PurchaseOrdersService({ $transaction: async (fn) => fn(tx) }, { record: async () => {} });
  await assert.rejects(
    () => service.updateReceipt("receipt-1", { quantity: "1", reason: "修正" }, {}),
    (error) => error instanceof UnprocessableEntityException && error.getResponse().code === "PURCHASE_ARRIVALS_CLOSED",
  );
});

test("receipt update rejects every downstream fact that would make correction unsafe", async () => {
  const cases = [
    { name: "positive inspection", inspections: [{ inspectedQuantity: new (require("@prisma/client").Prisma.Decimal)("1") }], rawMaterialInbounds: [], payableSources: [] },
    { name: "raw material inbound", inspections: [], rawMaterialInbounds: [{ id: "inbound-1" }], payableSources: [] },
    { name: "posted payable", inspections: [], rawMaterialInbounds: [], payableSources: [{ status: "posted" }] },
  ];
  for (const scenario of cases) {
    const tx = {
      $queryRaw: async () => [],
      purchaseReceipt: { findFirst: async () => ({ id: "receipt-1", purchaseOrderId: "purchase-1", orderNo: "SO-1", purchaseOrderItemId: "item-1", purchaseOrderItem: { quantity: new (require("@prisma/client").Prisma.Decimal)("10"), unitPrice: new (require("@prisma/client").Prisma.Decimal)("2") }, inspections: scenario.inspections, rawMaterialInbounds: scenario.rawMaterialInbounds, payableSources: scenario.payableSources }) },
      purchaseOrder: { findFirst: async () => ({ extensionData: {} }) },
    };
    // Keep the mock intentionally minimal: the guard must run before any write.
    tx.purchaseReceipt.findFirst = async () => ({ id: "receipt-1", purchaseOrderId: "purchase-1", orderNo: "SO-1", purchaseOrderItemId: "item-1", purchaseOrderItem: { quantity: new (require("@prisma/client").Prisma.Decimal)("10"), unitPrice: new (require("@prisma/client").Prisma.Decimal)("2") }, inspections: scenario.inspections, rawMaterialInbounds: scenario.rawMaterialInbounds, payableSources: scenario.payableSources });
    const service = new PurchaseOrdersService({ $transaction: async (fn) => fn(tx) }, { record: async () => {} });
    await assert.rejects(() => service.updateReceipt("receipt-1", { quantity: "2", reason: `修正-${scenario.name}` }, {}), (error) => error instanceof UnprocessableEntityException && error.getResponse().code === "RECEIPT_DOWNSTREAM_EXISTS");
  }
});

test("receipt cancellation rejects downstream facts instead of soft-deleting the batch", async () => {
  let writes = 0;
  const tx = {
    $queryRaw: async () => [],
    purchaseReceipt: { findFirst: async () => ({ id: "receipt-1", purchaseOrderId: "purchase-1", purchaseOrder: {}, inspections: [], rawMaterialInbounds: [{ id: "inbound-1" }], payableSources: [] }), update: async () => { writes += 1; } },
    purchaseOrder: { findFirst: async () => ({ extensionData: {} }) },
  };
  const service = new PurchaseOrdersService({ $transaction: async (fn) => fn(tx) }, { record: async () => {} });
  await assert.rejects(() => service.cancelReceipt("receipt-1", "撤销", {}), (error) => error instanceof UnprocessableEntityException && error.getResponse().code === "RECEIPT_DOWNSTREAM_EXISTS");
  assert.equal(writes, 0);
});

test("arrival rollback rejects inspection, inbound, and posted payable downstream facts", async () => {
  const downstreamCases = [
    { name: "inspection", inspections: [{ inspectedQuantity: new (require("@prisma/client").Prisma.Decimal)("1") }], rawMaterialInbounds: [], payableSources: [] },
    { name: "inbound", inspections: [], rawMaterialInbounds: [{ id: "inbound-1" }], payableSources: [] },
    { name: "posted payable", inspections: [], rawMaterialInbounds: [], payableSources: [{ status: "posted" }] },
  ];
  for (const scenario of downstreamCases) {
    const tx = {
      $queryRaw: async () => [],
      purchaseOrder: {
        findFirst: async () => ({ id: "purchase-1", status: "arrived_complete", extensionData: {}, items: [{ receipts: [{ inspections: scenario.inspections, rawMaterialInbounds: scenario.rawMaterialInbounds, payableSources: scenario.payableSources }] }] }),
      },
    };
    const service = new PurchaseOrdersService({ $transaction: async (fn) => fn(tx) }, { record: async () => {} });
    await assert.rejects(() => service.revertArrivals("purchase-1", `回退-${scenario.name}`, {}), (error) => error instanceof UnprocessableEntityException && error.getResponse().code === "PURCHASE_ARRIVAL_DOWNSTREAM_EXISTS");
  }
});

test("arrived-complete orders accept another receipt before close", async () => {
  const created = { id: "receipt-2", quantity: new (require("@prisma/client").Prisma.Decimal)("2"), extensionData: {} };
  const tx = {
    $queryRaw: async () => [],
    purchaseOrder: { findFirst: async () => ({ id: "purchase-1", orderNo: "SO-1", status: "arrived_complete", extensionData: {}, supplierId: "supplier-1", currency: "CNY", items: [{ id: "item-1", quantity: new (require("@prisma/client").Prisma.Decimal)("10"), unitPrice: new (require("@prisma/client").Prisma.Decimal)("2"), material: { materialType: "raw_material" }, receipts: [{ id: "receipt-1", quantity: new (require("@prisma/client").Prisma.Decimal)("10"), extensionData: {} }] }] }), update: async ({ data }) => ({ id: "purchase-1", orderNo: "SO-1", extensionData: data.extensionData }) },
    purchaseReceipt: { create: async () => created },
    incomingInspection: { create: async () => ({ id: "inspection-2" }) },
    payableSource: { create: async () => ({ id: "payable-2" }) },
    purchaseOrderItem: { findMany: async () => [] },
  };
  tx.purchaseOrderItem.findMany = async () => [{ quantity: new (require("@prisma/client").Prisma.Decimal)("10"), receipts: [{ quantity: new (require("@prisma/client").Prisma.Decimal)("10") }, { quantity: new (require("@prisma/client").Prisma.Decimal)("2") }] }];
  const audit = { create: () => ({}), update: () => ({}), record: async () => undefined };
  const service = new PurchaseOrdersService({ $transaction: async (fn) => fn(tx) }, audit);
  const result = await service.receiptV2("purchase-1", "item-1", { quantity: "2", received_date: "2026-09-03", over_receipt_reason: "追加到货" }, { id: "user-1" });
  assert.equal(result.id, "receipt-2");
});

const refsPrisma = (suppliers) => ({
  salesOrder: { findFirst: async () => ({ id: "order-1", orderNo: "SO-1" }) },
  bom: { findFirst: async () => ({ id: "bom-1", salesOrderId: "order-1", orderNo: "SO-1", version: 1 }) },
  supplier: { findMany: async () => suppliers },
  material: { findMany: async () => [{ id: "material-1" }, { id: "material-2" }] },
  unit: { findMany: async () => [{ id: "unit-1" }, { id: "unit-2" }] },
  bomItem: { findMany: async () => [{ id: "bomItem-1", materialId: "material-1" }] },
});

test("purchase order requires a supplier on every item", async () => {
  const service = new PurchaseOrdersService(refsPrisma([{ id: "supplier-1" }]), {});
  await assert.rejects(
    () => service.refs({ order_no: "SO-1", bom_id: "bom-1", purchase_date: new Date().toISOString(), currency: "CNY", items: [{ material_id: "material-1", unit_id: "unit-1", quantity: "1", unit_price: "1", extension_data: { outside_bom_reason: "临时" } }] }),
    (error) => error instanceof UnprocessableEntityException && error.getResponse().code === "PURCHASE_ITEM_SUPPLIER_REQUIRED",
  );
});

test("purchase order rejects unknown or disabled item suppliers", async () => {
  const service = new PurchaseOrdersService(refsPrisma([]), {});
  await assert.rejects(
    () => service.refs({ order_no: "SO-1", bom_id: "bom-1", purchase_date: new Date().toISOString(), currency: "CNY", items: [{ material_id: "material-1", unit_id: "unit-1", supplier_id: "supplier-missing", quantity: "1", unit_price: "1", extension_data: { outside_bom_reason: "临时" } }] }),
    (error) => error instanceof NotFoundException && error.getResponse().code === "SUPPLIER_NOT_FOUND",
  );
});

test("refs resolves per-item suppliers and keeps an order-level snapshot compatible", async () => {
  const service = new PurchaseOrdersService(refsPrisma([{ id: "supplier-2", name: "乙供应商" }, { id: "supplier-3", name: "丙供应商" }]), {});
  const refs = await service.refs({
    order_no: "SO-1", bom_id: "bom-1", purchase_date: new Date().toISOString(), currency: "USD",
    items: [
      { material_id: "material-1", unit_id: "unit-1", bom_item_id: "bomItem-1", supplier_id: "supplier-2", expected_date: "2026-09-10", quantity: "1", unit_price: "2" },
      { material_id: "material-2", unit_id: "unit-2", supplier_id: "supplier-3", expected_date: "2026-09-12", quantity: "1", unit_price: "2", extension_data: { outside_bom_reason: "临时新增" } },
    ],
  });
  assert.equal(refs.supplier.id, "supplier-2");
  assert.equal(refs.supplierMap.get("supplier-3").name, "丙供应商");
  assert.equal(refs.supplierMap.size, 2);
});

test("create writes per-item supplier snapshots and derives the order-level supplier and expected date", async () => {
  let captured = null;
  const created = { id: "purchase-1", orderNo: "SO-1", status: "draft", items: [], extensionData: {} };
  const tx = { purchaseOrder: { create: async ({ data }) => { captured = data; return created; } } };
  const prisma = { ...refsPrisma([{ id: "supplier-2", name: "乙供应商" }, { id: "supplier-3", name: "丙供应商" }]), $transaction: async (fn) => fn(tx), purchaseOrder: { findFirst: async () => created } };
  const audit = { create: () => ({}), update: () => ({}), record: async () => {} };
  const service = new PurchaseOrdersService(prisma, audit);
  await service.create({
    order_no: "SO-1", bom_id: "bom-1", purchase_date: "2026-09-08", currency: "USD",
    items: [
      { material_id: "material-1", unit_id: "unit-1", bom_item_id: "bomItem-1", supplier_id: "supplier-2", expected_date: "2026-09-10", quantity: "2", unit_price: "3" },
      { material_id: "material-2", unit_id: "unit-2", supplier_id: "supplier-3", expected_date: "2026-09-12", quantity: "1", unit_price: "2", extension_data: { outside_bom_reason: "临时新增" } },
    ],
  }, { id: "user-1" });
  assert.equal(captured.supplierId, "supplier-2");
  assert.equal(captured.supplierSnapshot.name, "乙供应商");
  assert.equal(captured.expectedDate.getTime(), new Date("2026-09-12").getTime());
  assert.equal(captured.items.create[0].supplierId, "supplier-2");
  assert.equal(captured.items.create[0].supplierSnapshot.name, "乙供应商");
  assert.equal(captured.items.create[0].expectedDate.getTime(), new Date("2026-09-10").getTime());
  assert.equal(captured.items.create[1].supplierId, "supplier-3");
  assert.equal(captured.items.create[1].expectedDate.getTime(), new Date("2026-09-12").getTime());
});

test("update replaces rows with per-item suppliers and keeps the order-level supplier in sync", async () => {
  let createManyData = null;
  let orderUpdateData = null;
  const row = { id: "purchase-1", status: "draft", orderNo: "SO-1", items: [], extensionData: {} };
  const tx = {
    purchaseOrderItem: { updateMany: async () => {}, createMany: async ({ data }) => { createManyData = data; } },
    purchaseOrder: { update: async ({ data }) => { orderUpdateData = data; return row; } },
  };
  const prisma = { ...refsPrisma([{ id: "supplier-1", name: "甲供应商" }]), $transaction: async (fn) => fn(tx), purchaseOrder: { findFirst: async () => row } };
  const audit = { create: () => ({}), update: () => ({}), record: async () => {} };
  const service = new PurchaseOrdersService(prisma, audit);
  await service.update("purchase-1", {
    order_no: "SO-1", bom_id: "bom-1", purchase_date: "2026-09-08", currency: "USD",
    items: [{ material_id: "material-1", unit_id: "unit-1", bom_item_id: "bomItem-1", supplier_id: "supplier-1", expected_date: "2026-09-15", quantity: "2", unit_price: "3" }],
  }, { id: "user-1" });
  assert.equal(createManyData[0].supplierId, "supplier-1");
  assert.equal(createManyData[0].supplierSnapshot.name, "甲供应商");
  assert.equal(createManyData[0].expectedDate.getTime(), new Date("2026-09-15").getTime());
  assert.equal(orderUpdateData.supplierId, "supplier-1");
  assert.equal(orderUpdateData.supplierSnapshot.name, "甲供应商");
  assert.equal(orderUpdateData.expectedDate.getTime(), new Date("2026-09-15").getTime());
});

test("order expected date falls back to the latest item date when the order does not send one", async () => {
  const service = new PurchaseOrdersService({}, {});
  const derived = service.orderExpectedDate({ order_no: "SO-1", bom_id: "bom-1", purchase_date: "2026-09-08", currency: "USD", items: [
    { material_id: "material-1", unit_id: "unit-1", supplier_id: "supplier-1", expected_date: "2026-09-18", quantity: "1", unit_price: "1" },
    { material_id: "material-2", unit_id: "unit-2", supplier_id: "supplier-2", expected_date: "2026-09-14", quantity: "1", unit_price: "1" },
  ] });
  assert.equal(derived.getTime(), new Date("2026-09-18").getTime());
  assert.equal(service.orderExpectedDate({ order_no: "SO-1", bom_id: "bom-1", purchase_date: "2026-09-08", currency: "USD", items: [{ material_id: "material-1", unit_id: "unit-1", supplier_id: "supplier-1", quantity: "1", unit_price: "1" }] }), undefined);
});
