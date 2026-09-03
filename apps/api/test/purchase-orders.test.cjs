const assert = require("node:assert/strict");
const { test } = require("node:test");
const { PurchaseOrdersService } = require("../dist/modules/procurement/purchase-orders.service.js");
const { UnprocessableEntityException } = require("@nestjs/common");

test("purchase order accepts the editable BOM belonging to its confirmed sales order", async () => {
  const prisma = {
    salesOrder: { findFirst: async () => ({ id: "order-1", orderNo: "SO-1" }) },
    bom: { findFirst: async () => ({ id: "bom-1", salesOrderId: "order-1", orderNo: "SO-1", version: 1, status: "draft" }) },
    supplier: { findFirst: async () => ({ id: "supplier-1" }) },
    material: { findMany: async () => [{ id: "material-1" }] },
    unit: { findMany: async () => [{ id: "unit-1" }] },
  };
  const service = new PurchaseOrdersService(prisma, {});
  const refs = await service.refs({ order_no: "SO-1", bom_id: "bom-1", supplier_id: "supplier-1", purchase_date: new Date().toISOString(), currency: "USD", items: [{ material_id: "material-1", unit_id: "unit-1", quantity: "1", unit_price: "0" }] });
  assert.equal(refs.bom.id, "bom-1");
  assert.equal(refs.order.id, "order-1");
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
