const test = require("node:test");
const assert = require("node:assert/strict");
const { UnprocessableEntityException } = require("@nestjs/common");
const { RawMaterialInboundNoticesService } = require("../dist/modules/procurement/raw-material-inbound-notices.service.js");
const { RawMaterialInboundsService } = require("../dist/modules/procurement/raw-material-inbounds.service.js");

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

test("notice creation defers inbound draft creation until warehouse acknowledgement", async () => {
  const inspection = {
    id: "inspection-1", status: "accepted", qcResult: "all_inbound", acceptedQuantity: "4", conditionalQuantity: "0", orderNo: "SO-1", purchaseReceiptId: "receipt-1",
    purchaseReceipt: { purchaseOrderId: "po-1", purchaseOrderItemId: "item-1", purchaseOrderItem: { materialId: "material-1", unitId: "unit-1", material: { materialType: "raw_material" } } },
    rawMaterialInbounds: [{ quantity: "3", status: "draft" }], inboundNotices: []
  };
  const { service, updates } = serviceFor(inspection);
  await service.createFromInspection("inspection-1", "到货单已核对", user);
  assert.equal(updates.length, 0);
});

// ── 接收入库通知：必须真正产出可入库的草稿（仓储情况才会出现待入库记录） ──
function acknowledgeHarness({ noticeStatus = "pending", existingDraft = null, inspectionStatus = "accepted", acceptedQuantity = "4" } = {}) {
  const created = [];
  const linked = [];
  const inspection = {
    id: "inspection-1", status: inspectionStatus, qcResult: "all_inbound", acceptedQuantity, conditionalQuantity: "0", orderNo: "DL260001", purchaseReceiptId: "receipt-1",
    rawMaterialInbounds: existingDraft ? [existingDraft] : [],
    purchaseReceipt: {
      purchaseOrderId: "po-1", purchaseOrderItemId: "item-1", purchaseOrder: { id: "po-1" },
      purchaseOrderItem: { materialId: "material-1", unitId: "unit-1", supplierId: "supplier-1", material: { materialType: "raw_material" } }
    }
  };
  const tx = {
    $queryRaw: async () => [],
    rawMaterialInboundNotice: {
      findFirst: async () => ({ id: "notice-1", status: noticeStatus, incomingInspectionId: "inspection-1" }),
      update: async ({ data }) => ({ id: "notice-1", ...data })
    },
    incomingInspection: { findFirst: async () => inspection },
    rawMaterialInbound: {
      findFirst: async () => existingDraft,
      create: async ({ data }) => { created.push(data); return { id: "inbound-new", ...data }; },
      update: async (input) => { linked.push(input); return { id: input.where.id }; }
    }
  };
  const prisma = {
    $transaction: async (fn) => fn(tx),
    rawMaterialInboundNotice: { findFirst: async () => ({ id: "notice-1", status: noticeStatus === "pending" ? "acknowledged" : noticeStatus }) }
  };
  const audit = { create: () => ({ createdBy: user.id, updatedBy: user.id }), update: () => ({ updatedBy: user.id }), record: async () => undefined };
  const inbounds = new RawMaterialInboundsService({}, audit, {});
  return { service: new RawMaterialInboundNoticesService(prisma, audit, inbounds), created, linked };
}

test("接收入库通知会创建入库草稿并关联该通知", async () => {
  const { service, created, linked } = acknowledgeHarness();
  const result = await service.acknowledge("notice-1", user);
  assert.equal(result.status, "acknowledged");
  assert.equal(created.length, 1, "接收后必须产生入库草稿，否则仓储情况看不到待入库记录");
  assert.equal(String(created[0].quantity), "4");
  assert.equal(created[0].materialId, "material-1");
  assert.deepEqual(linked.map((call) => call.data), [{ inboundNoticeId: "notice-1" }]);
});

test("自愈：已接收但缺草稿的通知，再次接收会补建草稿", async () => {
  const { service, created, linked } = acknowledgeHarness({ noticeStatus: "acknowledged" });
  const result = await service.acknowledge("notice-1", user);
  assert.equal(result.status, "acknowledged");
  assert.equal(created.length, 1, "这是「接收后仓储情况没有更新」的根因：旧实现直接返回、不补建草稿");
  assert.equal(linked.length, 1, "补建的草稿必须回填通知关联");
});

test("自愈不重复建草稿：已接收且已有草稿时只做关联，不再新增", async () => {
  const existingDraft = { id: "inbound-existing", status: "draft", quantity: "4" };
  const { service, created, linked } = acknowledgeHarness({ noticeStatus: "acknowledged", existingDraft });
  await service.acknowledge("notice-1", user);
  assert.equal(created.length, 0, "已有草稿时不得重复创建");
  assert.deepEqual(linked.map((call) => call.where.id), ["inbound-existing"]);
});

test("质检未就绪时接收必须报错，且不把通知置为已接收", async () => {
  let noticeUpdates = 0;
  const { service, created } = acknowledgeHarness({ inspectionStatus: "inspecting" });
  service.prisma = {
    $transaction: async (fn) => fn({
      $queryRaw: async () => [],
      rawMaterialInboundNotice: { findFirst: async () => ({ id: "notice-1", status: "pending", incomingInspectionId: "inspection-1" }), update: async () => { noticeUpdates += 1; return { id: "notice-1", status: "acknowledged" }; } },
      incomingInspection: { findFirst: async () => null },
      rawMaterialInbound: { findFirst: async () => null, create: async () => ({ id: "x" }), update: async () => ({ id: "x" }) }
    })
  };
  await assert.rejects(() => service.acknowledge("notice-1", user), (error) => error.getResponse().code === "INBOUND_NOTICE_NOT_RECEIVABLE");
  assert.equal(created.length, 0);
  assert.equal(noticeUpdates, 0, "建不出草稿时不得把通知改成已接收，否则又会产生一张卡死的通知");
});
