const test = require("node:test");
const assert = require("node:assert/strict");
const { UnprocessableEntityException } = require("@nestjs/common");
const { RawMaterialInboundNoticesService } = require("../dist/modules/procurement/raw-material-inbound-notices.service.js");

const user = { id: "00000000-0000-0000-0000-000000000001" };
const audit = { record: async () => undefined };

function serviceFor(inspection, created) {
  let updates = [];
  let noticeCreates = 0;
  const tx = {
    $queryRaw: async () => undefined,
    incomingInspection: { findFirst: async () => inspection },
    rawMaterialInboundNotice: {
      create: async ({ data }) => { noticeCreates += 1; return created ?? { id: "notice-1", ...data }; },
      findFirst: async () => inspection.inboundNotices?.[0] ?? null,
    },
    rawMaterialInbound: { updateMany: async (input) => { updates.push(input); return { count: 1 }; } }
  };
  const prisma = {
    $transaction: async (callback) => callback(tx),
    rawMaterialInboundNotice: { findFirst: async () => inspection.inboundNotices?.[0] ?? { id: "notice-1" } }
  };
  return { service: new RawMaterialInboundNoticesService(prisma, audit, { createDraftForInspection: async () => ({ id: "inbound-1" }) }), updates, getNoticeCreates: () => noticeCreates };
}

test("inbound notice rejects incomplete or rejected QC", async () => {
  const inspection = {
    id: "inspection-1", status: "inspecting", qcResult: null, orderNo: "SO-1", purchaseReceiptId: "receipt-1",
    purchaseReceipt: { purchaseOrderId: "po-1", purchaseOrderItemId: "item-1", purchaseOrderItem: { materialId: "material-1", unitId: "unit-1", material: { materialType: "raw_material" } } }, rawMaterialInbounds: [], inboundNotices: []
  };
  const { service } = serviceFor(inspection);
  await assert.rejects(() => service.createFromInspection("inspection-1", undefined, user), (error) => error instanceof UnprocessableEntityException && error.getResponse().code === "INBOUND_NOTICE_QC_NOT_READY");
});

test("inbound notice is idempotent for the same inspection", async () => {
  const existing = { id: "notice-existing", status: "pending", deletedAt: null };
  const inspection = {
    id: "inspection-1", status: "accepted", qcResult: "all_inbound", orderNo: "SO-1", purchaseReceiptId: "receipt-1",
    purchaseReceipt: { purchaseOrderId: "po-1", purchaseOrderItemId: "item-1" }, rawMaterialInbounds: [], inboundNotices: [existing]
  };
  const { service, getNoticeCreates } = serviceFor(inspection);
  const result = await service.createFromInspection("inspection-1", undefined, user);
  assert.equal(result.id, "notice-existing");
  assert.equal(getNoticeCreates(), 0);
});

test("notice creation links existing draft inbounds without changing stock", async () => {
  const inspection = {
    id: "inspection-1", status: "accepted", qcResult: "all_inbound", acceptedQuantity: "4", conditionalQuantity: "0", orderNo: "SO-1", purchaseReceiptId: "receipt-1",
    purchaseReceipt: { purchaseOrderId: "po-1", purchaseOrderItemId: "item-1", purchaseOrderItem: { materialId: "material-1", unitId: "unit-1", material: { materialType: "raw_material" } } },
    rawMaterialInbounds: [{ quantity: "3", status: "draft" }], inboundNotices: []
  };
  const { service, updates } = serviceFor(inspection);
  await service.createFromInspection("inspection-1", "到货单已核对", user);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].data.inboundNoticeId, "notice-1");
});
