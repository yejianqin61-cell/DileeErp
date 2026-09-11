const assert = require("node:assert/strict");
const { test } = require("node:test");
const { UnprocessableEntityException } = require("@nestjs/common");
const { Prisma } = require("@prisma/client");
const { RawMaterialInboundsService } = require("../dist/modules/procurement/raw-material-inbounds.service.js");

const user = { id: "1f7d261d-0089-4d32-9aa1-19942c41cb1d", username: "operator", display_name: "操作员" };
const audit = { create: () => ({ createdBy: user.id, updatedBy: user.id }), update: () => ({ updatedBy: user.id }), record: async () => {} };

test("raw material inbound cannot exceed QC allowed quantity", async () => {
  // 入库前必须先有仓库已接收的通知（该门禁早于数量校验），否则会以通知错误提前返回。
  const prisma = { rawMaterialInboundNotice: { findFirst: async () => ({ id: "notice-1", status: "acknowledged" }) }, rawMaterialInbound: { create: async () => { throw new Error("must not write"); } } };
  const service = new RawMaterialInboundsService(prisma, audit, {});
  service.requireInspection = async () => ({ id: "inspection-1", orderNo: "DL260001", acceptedQuantity: "10", conditionalQuantity: "0", rawMaterialInbounds: [{ quantity: "2" }], purchaseReceiptId: "receipt-1", purchaseReceipt: { purchaseOrderId: "po-1", purchaseOrderItemId: "item-1", purchaseOrder: { supplierId: "supplier-1" }, purchaseOrderItem: { materialId: "material-1" } } });
  await assert.rejects(() => service.create({ incoming_inspection_id: "inspection-1", quantity: "9" }, user), (error) => error instanceof UnprocessableEntityException && error.getResponse().code === "INBOUND_QUANTITY_EXCEEDED");
});

// 仓库只登记实际入库数量：部分入库批次不再被强制要求填写结算三字段。
test("仓库存草稿不再强制结算三字段（部分入库也可直接登记）", async () => {
  const created = [];
  const tx = {
    $queryRaw: async () => [],
    rawMaterialInboundNotice: { findFirst: async () => ({ id: "notice-1", status: "acknowledged" }) },
    rawMaterialInbound: { create: async ({ data }) => { created.push(data); return { id: "inbound-1", ...data }; } }
  };
  const prisma = {
    rawMaterialInboundNotice: { findFirst: async () => ({ id: "notice-1", status: "acknowledged" }) },
    rawMaterialInbound: { findFirst: async () => null },
    $transaction: async (fn) => fn(tx)
  };
  const service = new RawMaterialInboundsService(prisma, audit, {});
  service.requireInspection = async () => ({ id: "inspection-1", status: "partially_accepted", qcResult: "partial_inbound", orderNo: "DL260001", acceptedQuantity: "10", conditionalQuantity: "0", rawMaterialInbounds: [], purchaseReceiptId: "receipt-1", purchaseReceipt: { purchaseOrderId: "po-1", purchaseOrderItemId: "item-1", purchaseOrder: { supplierId: "supplier-1" }, purchaseOrderItem: { materialId: "material-1", unitId: "unit-1", supplierId: "supplier-1", material: { materialType: "raw_material" } } } });

  await service.create({ incoming_inspection_id: "inspection-1", quantity: "3", inventory_category: "raw_material" }, user);
  assert.equal(created.length, 1);
  assert.equal(created[0].quantity, "3");
  assert.equal(created[0].settlementUnitPrice, undefined);
});

test("采购若填写人工结算值，则必须是大于零的金额", async () => {
  const prisma = { rawMaterialInboundNotice: { findFirst: async () => ({ id: "notice-1", status: "acknowledged" }) }, rawMaterialInbound: { create: async () => { throw new Error("must not write"); } } };
  const service = new RawMaterialInboundsService(prisma, audit, {});
  service.requireInspection = async () => ({ id: "inspection-1", status: "partially_accepted", qcResult: "partial_inbound", orderNo: "DL260001", acceptedQuantity: "10", conditionalQuantity: "0", rawMaterialInbounds: [], purchaseReceiptId: "receipt-1", purchaseReceipt: { purchaseOrderId: "po-1", purchaseOrderItemId: "item-1", purchaseOrder: { supplierId: "supplier-1" }, purchaseOrderItem: { materialId: "material-1" } } });
  for (const value of ["0", "-1"]) {
    await assert.rejects(() => service.create({ incoming_inspection_id: "inspection-1", quantity: "3", settlement_unit_price: value }, user), (error) => error instanceof UnprocessableEntityException && error.getResponse().code === "INVALID_SETTLEMENT_AMOUNT");
  }
  await assert.rejects(() => service.create({ incoming_inspection_id: "inspection-1", quantity: "3", settlement_total_amount: "30" }, user), (error) => error instanceof UnprocessableEntityException && error.getResponse().code === "SETTLEMENT_REASON_REQUIRED");
});

// 过账：没有人工结算值时按采购明细单价结算，不因缺字段而拒绝过账。
test("部分入库过账按采购单价结算，不再要求结算三字段", async () => {
  const payableSources = [];
  const inspection = {
    id: "inspection-1",
    orderNo: "DL260001",
    status: "partially_accepted",
    qcResult: "partial_inbound",
    acceptedQuantity: "10",
    conditionalQuantity: "0",
    rejectedQuantity: "0",
    rawMaterialInbounds: [{ id: "inbound-1", quantity: "3", status: "draft" }],
    purchaseReceipt: { purchaseOrder: { currency: "CNY", items: [{ id: "item-1" }] }, purchaseOrderItem: { unitPrice: "2.5", taxRate: "0", materialId: "material-1" } }
  };
  const inbound = { id: "inbound-1", status: "draft", quantity: new Prisma.Decimal("3"), materialId: "material-1", unitId: "unit-1", orderNo: "DL260001", purchaseOrderId: "po-1", purchaseOrderItemId: "item-1", supplierId: "supplier-1", inventoryCategory: "raw_material", incomingInspectionId: "inspection-1", inboundNoticeId: "notice-1", settlementUnitPrice: null, settlementTotalAmount: null, settlementAmountReason: null, inboundNotice: { status: "acknowledged" }, incomingInspection: inspection };
  const tx = {
    $queryRaw: async () => [],
    rawMaterialInbound: { findFirst: async () => inbound, update: async () => ({ ...inbound, status: "posted" }) },
    inventoryFact: { create: async () => ({}) },
    payableSource: { findFirst: async () => null, create: async ({ data }) => { payableSources.push(data); return data; } }
  };
  const prisma = { rawMaterialInbound: { findFirst: async () => ({ id: "inbound-1", status: "draft" }) }, $transaction: async (fn) => fn(tx) };
  const service = new RawMaterialInboundsService(prisma, audit, {});

  await service.post("inbound-1", user);
  assert.equal(payableSources.length, 1);
  assert.equal(payableSources[0].unitPrice, "2.5", "缺省结算单价应取采购明细单价");
  assert.equal(payableSources[0].amount, "7.5000", "结算金额 = 实际入库数量 × 采购单价");
  // status 不在写入数据里，由 PayableSource.status 的数据库默认值 pending_finance 提供。
  assert.equal(payableSources[0].status, undefined, "应付来源状态应由数据库默认值提供（pending_finance）");
});
