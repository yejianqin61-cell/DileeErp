// 工单 T-0018：原料到货登记要能选择同安仓 / 晋江仓 / 大田仓，并把入库地点保存到到货批次。
//
// 这里钉住三件事：
//   1. 新登记到货把 warehouse_code/name 写进 purchase_receipts.extension_data（不新增列）；
//   2. 老客户端不传仓库时按历史口径回落同安仓，不因为新增字段而报错；
//   3. 非法仓库编码在写任何数据前拒绝，避免留下半套到货事实。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { Prisma } = require("@prisma/client");
const { UnprocessableEntityException } = require("@nestjs/common");
const { PurchaseOrdersService } = require("../../dist/modules/procurement/purchase-orders.service.js");

const audit = { create: () => ({}), update: () => ({}), record: async () => undefined };

function receiptFixture(receipts = []) {
  return {
    id: "po-1",
    orderNo: "SO-1",
    status: "ordered",
    extensionData: {},
    currency: "CNY",
    items: [{
      id: "item-1",
      quantity: new Prisma.Decimal("10"),
      unitPrice: new Prisma.Decimal("2"),
      material: { materialType: "raw_material" },
      receipts,
    }],
  };
}

function transactionFor({ receipts = [], create }) {
  const tx = {
    $queryRaw: async () => [],
    purchaseOrder: {
      findFirst: async () => receiptFixture(receipts),
      update: async () => ({ id: "po-1" }),
    },
    purchaseReceipt: { create },
    incomingInspection: { create: async () => ({ id: "inspection-1" }) },
    purchaseOrderItem: { findMany: async () => [] },
  };
  return tx;
}

test("登记到货：晋江仓写入到货批次 extension_data，并在响应里带出地点", async () => {
  let createdData;
  const created = { id: "receipt-1", quantity: new Prisma.Decimal("2"), extensionData: {} };
  const tx = transactionFor({
    create: async ({ data }) => {
      createdData = data;
      created.extensionData = data.extensionData;
      return created;
    },
  });
  const service = new PurchaseOrdersService({ $transaction: async (fn) => fn(tx) }, audit);

  const result = await service.receiptV2("po-1", "item-1", { quantity: "2", received_date: "2026-11-18", warehouse_code: "jinjiang" }, { id: "user-1" });

  assert.equal(createdData.extensionData.warehouse_code, "jinjiang");
  assert.equal(createdData.extensionData.warehouse_name, "晋江仓");
  assert.equal(result.warehouseCode, "jinjiang");
  assert.equal(result.warehouseName, "晋江仓");
});

test("登记到货：不传仓库时按历史口径回落同安仓", async () => {
  let createdData;
  const tx = transactionFor({
    create: async ({ data }) => {
      createdData = data;
      return { id: "receipt-1", quantity: data.quantity, extensionData: data.extensionData };
    },
  });
  const service = new PurchaseOrdersService({ $transaction: async (fn) => fn(tx) }, audit);

  const result = await service.receiptV2("po-1", "item-1", { quantity: "2", received_date: "2026-11-18" }, { id: "user-1" });

  assert.equal(createdData.extensionData.warehouse_code, "tongan");
  assert.equal(createdData.extensionData.warehouse_name, "同安仓");
  assert.equal(result.warehouseName, "同安仓");
});

test("登记到货：非法仓库编码在创建任何单据前拒绝", async () => {
  let receiptWrites = 0;
  const tx = transactionFor({
    create: async () => {
      receiptWrites += 1;
      return { id: "receipt-1" };
    },
  });
  const service = new PurchaseOrdersService({ $transaction: async (fn) => fn(tx) }, audit);

  await assert.rejects(
    () => service.receiptV2("po-1", "item-1", { quantity: "2", received_date: "2026-11-18", warehouse_code: "shanghai" }, { id: "user-1" }),
    (error) => error instanceof UnprocessableEntityException && error.getResponse().code === "INVALID_WAREHOUSE",
  );
  assert.equal(receiptWrites, 0);
});

test("采购单详情：从 extension_data 透出入库地点，老单回落同安仓", async () => {
  const service = new PurchaseOrdersService({
    purchaseOrder: {
      findFirst: async () => ({
        id: "po-1",
        items: [{
          id: "item-1",
          receipts: [
            { id: "receipt-1", receiptNo: "GR-1", quantity: "2", extensionData: { warehouse_code: "daitan", warehouse_name: "大田仓" }, inspections: [], rawMaterialInbounds: [], payableSources: [] },
            { id: "receipt-2", receiptNo: "GR-2", quantity: "1", extensionData: {}, inspections: [], rawMaterialInbounds: [], payableSources: [] },
          ],
        }],
      }),
    },
  }, audit);

  const result = await service.get("po-1");
  assert.equal(result.items[0].receipts[0].warehouseCode, "daitan");
  assert.equal(result.items[0].receipts[0].warehouseName, "大田仓");
  assert.equal(result.items[0].batchWorkflows[0].warehouseName, "大田仓");
  assert.equal(result.items[0].receipts[1].warehouseName, "同安仓");
});

test("编辑到货批次：传仓库就更新，不传保持原值", async () => {
  const writes = [];
  let currentExtensionData = { warehouse_code: "jinjiang", warehouse_name: "晋江仓" };
  const tx = {
    $queryRaw: async () => [],
    purchaseReceipt: {
      findFirst: async () => ({
        id: "receipt-1",
        purchaseOrderId: "po-1",
        orderNo: "SO-1",
        purchaseOrderItemId: "item-1",
        extensionData: currentExtensionData,
        purchaseOrderItem: { quantity: new Prisma.Decimal("10"), unitPrice: new Prisma.Decimal("2") },
        inspections: [],
        rawMaterialInbounds: [],
        payableSources: [],
      }),
      aggregate: async () => ({ _sum: { quantity: null } }),
      update: async ({ data }) => {
        writes.push(data);
        currentExtensionData = data.extensionData;
        return { id: "receipt-1", ...data };
      },
    },
    purchaseOrder: { findFirst: async () => ({ extensionData: {} }) },
  };
  const service = new PurchaseOrdersService({ $transaction: async (fn) => fn(tx) }, audit);

  await service.updateReceipt("receipt-1", { quantity: "5", reason: "改地点", warehouse_code: "daitan" }, { id: "user-1" });
  assert.equal(writes[0].extensionData.warehouse_code, "daitan");
  assert.equal(writes[0].extensionData.warehouse_name, "大田仓");

  await service.updateReceipt("receipt-1", { quantity: "5", reason: "只改数量" }, { id: "user-1" });
  assert.equal(writes[1].extensionData.warehouse_code, "daitan");
  assert.equal(writes[1].extensionData.warehouse_name, "大田仓");
});
