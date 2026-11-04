const assert = require("node:assert/strict");
const { test } = require("node:test");
const { UnprocessableEntityException } = require("@nestjs/common");
const { IncomingInspectionsService } = require("../dist/modules/procurement/incoming-inspections.service.js");

const user = { id: "1f7d261d-0089-4d32-9aa1-19942c41cb1d", username: "operator", display_name: "操作员" };

// 质检阶段只产生可入库数量：入库草稿由仓库“接收入库通知”时创建（见 raw-material-inbound-notices.service.acknowledge）。
test("passed QC does not create an inbound draft by itself", async () => {
  const calls = [];
  const tx = { $queryRaw: async () => undefined, purchaseReceipt: { findFirst: async () => ({ id: "receipt-1", orderNo: "DL260001", quantity: "10", extensionData: {}, inspections: [] }) }, incomingInspection: { create: async ({ data }) => ({ id: "inspection-1", ...data }) } };
  const prisma = { $transaction: async (fn) => fn(tx) };
  const inbounds = { createDraftForInspection: async (client, id) => { calls.push([client, id]); return { id: "inbound-1", status: "draft" }; } };
  const service = new IncomingInspectionsService(prisma, { create: () => ({}), record: async () => {} }, inbounds);
  const result = await service.create({ purchase_receipt_id: "receipt-1", inspected_quantity: "10", accepted_quantity: "8", conditional_quantity: "2", rejected_quantity: "0" }, user);
  assert.equal(result.status, "conditionally_accepted");
  assert.deepEqual(calls, [], "质检不得自行创建入库草稿，必须等仓库接收通知");
});

// 用户 2026-11-04：供应商多送（订购 1500 码、实收 1600 码）时，来料质检必须能按实收登记。
// 超收不再报「累计检验数量不能超过到货数量」，而是把到货批次数量抬到累计实收量，
// 入库与应付随之按实数走；采购单上的订购数量不动。
test("incoming QC over-delivery raises the receipt quantity to the actual inspected total", async () => {
  const receiptUpdates = [];
  const audits = [];
  const { Prisma } = require("@prisma/client");
  const receipt = { id: "receipt-1", orderNo: "DL260001", quantity: new Prisma.Decimal("10"), extensionData: { batch_sequence: 1 }, inspections: [{ inspectedQuantity: new Prisma.Decimal("8"), acceptedQuantity: new Prisma.Decimal("8"), conditionalQuantity: new Prisma.Decimal("0"), rejectedQuantity: new Prisma.Decimal("0"), extensionData: {} }] };
  const tx = {
    $queryRaw: async () => undefined,
    purchaseReceipt: { findFirst: async () => receipt, update: async ({ data }) => { receiptUpdates.push(data); return { ...receipt, ...data }; } },
    incomingInspection: { update: async ({ data }) => ({ id: "inspection-1", orderNo: "DL260001", ...data }) },
  };
  const service = new IncomingInspectionsService(
    { $transaction: async (fn) => fn(tx) },
    { create: () => ({}), update: () => ({}), record: async (...args) => { audits.push(args); } },
  );
  const result = await service.create({ purchase_receipt_id: "receipt-1", inspected_quantity: "3", accepted_quantity: "3", conditional_quantity: "0", rejected_quantity: "0", remark: "供应商多送 1" }, user);
  assert.equal(result.inspectedQuantity.toString(), "11");
  assert.equal(receiptUpdates.length, 1, "超收时必须把到货批次改到实收量");
  assert.equal(receiptUpdates[0].quantity.toString(), "11");
  assert.equal(receiptUpdates[0].extensionData.over_receipt, true);
  assert.equal(receiptUpdates[0].extensionData.over_receipt_corrected_from, "10");
  assert.equal(receiptUpdates[0].extensionData.over_receipt_reason, "供应商多送 1");
  const overAudit = audits.find(([event]) => event === "purchase_receipt.over_receipt");
  assert.ok(overAudit, "超收修正必须留一条审计");
  assert.equal(overAudit[4].from, "10");
  assert.equal(overAudit[4].to, "11");
});

test("incoming QC keeps the receipt quantity untouched when the actual total is within it", async () => {
  let receiptWrites = 0;
  const receipt = { id: "receipt-1", orderNo: "DL260001", quantity: "10", extensionData: {}, inspections: [] };
  const tx = {
    $queryRaw: async () => undefined,
    purchaseReceipt: { findFirst: async () => receipt, update: async () => { receiptWrites += 1; return receipt; } },
    incomingInspection: { create: async ({ data }) => ({ id: "inspection-1", ...data }) },
  };
  const service = new IncomingInspectionsService({ $transaction: async (fn) => fn(tx) }, { create: () => ({}), record: async () => {} });
  await service.create({ purchase_receipt_id: "receipt-1", inspected_quantity: "10", accepted_quantity: "10", conditional_quantity: "0", rejected_quantity: "0" }, user);
  assert.equal(receiptWrites, 0, "没超收到货数量时不应改到货批次");
});

test("an empty QC registration remains pending instead of rejected", async () => {
  let created;
  const tx = { $queryRaw: async () => undefined, purchaseReceipt: { findFirst: async () => ({ id: "receipt-1", orderNo: "DL260001", quantity: "10", extensionData: {}, inspections: [] }) }, incomingInspection: { create: async ({ data }) => { created = data; return { id: "inspection-1", ...data }; } } };
  const service = new IncomingInspectionsService({ $transaction: async (fn) => fn(tx), incomingInspection: { findFirst: async () => ({ id: "inspection-1" }) } }, { create: () => ({}), record: async () => {} });
  await service.create({ purchase_receipt_id: "receipt-1", inspected_quantity: "0", accepted_quantity: "0", conditional_quantity: "0", rejected_quantity: "0" }, user);
  assert.equal(created.status, "pending");
});

test("accepted QC can be reverted with a reason before inbound", async () => {
  let update;
  const prisma = { incomingInspection: { findFirst: async () => ({ id: "inspection-1", status: "accepted", remark: null, rawMaterialInbounds: [], }), update: async ({ data }) => { update = data; return { id: "inspection-1", status: data.status }; } } };
  const service = new IncomingInspectionsService(prisma, { update: () => ({ updatedBy: user.id }), record: async () => {} });
  const result = await service.transition("inspection-1", "pending", "数量需复核", user);
  assert.equal(result.status, "pending");
  assert.match(update.remark, /数量需复核/);
});

test("QC with inbound facts cannot be reverted", async () => {
  const prisma = { incomingInspection: { findFirst: async () => ({ id: "inspection-1", status: "accepted", remark: null, rawMaterialInbounds: [{ id: "inbound-1" }] }) } };
  const service = new IncomingInspectionsService(prisma, { update: () => ({ updatedBy: user.id }), record: async () => {} });
  await assert.rejects(() => service.transition("inspection-1", "pending", "复核", user), (error) => error instanceof UnprocessableEntityException && error.getResponse().code === "INSPECTION_DOWNSTREAM_EXISTS");
});

test("QC cannot be completed before inspection quantities are recorded", async () => {
  const prisma = { incomingInspection: { findFirst: async () => ({ id: "inspection-1", status: "inspecting", inspectedQuantity: "0", rawMaterialInbounds: [] }) } };
  const service = new IncomingInspectionsService(prisma, { update: () => ({ updatedBy: user.id }), record: async () => {} });
  await assert.rejects(() => service.transition("inspection-1", "completed", undefined, user), (error) => error instanceof UnprocessableEntityException && error.getResponse().code === "INSPECTION_QUANTITY_REQUIRED");
});

test("incoming QC can be corrected before inbound with a reason", async () => {
  let update;
  const current = { id: "inspection-1", orderNo: "DL260001", status: "accepted", inspectedQuantity: "3", acceptedQuantity: "3", conditionalQuantity: "0", rejectedQuantity: "0", extensionData: {}, remark: null, purchaseReceipt: { quantity: "10", rawMaterialInbounds: [] }, rawMaterialInbounds: [] };
  const tx = { $queryRaw: async () => undefined, incomingInspection: { findFirst: async () => current, update: async ({ data }) => { update = data; return { ...current, ...data }; } } };
  const service = new IncomingInspectionsService({ $transaction: async (fn) => fn(tx) }, { update: () => ({ updatedBy: user.id }), record: async () => {} });
  const result = await service.update("inspection-1", { inspected_quantity: "4", accepted_quantity: "3", conditional_quantity: "1", rejected_quantity: "0", reason: "复核后补录条件接收" }, user);
  assert.equal(result.acceptedQuantity.toString(), "3");
  assert.equal(update.status, "conditionally_accepted");
  assert.match(update.remark, /复核后补录条件接收/);
});

test("incoming QC rollback rejects a downstream inbound even when it is linked through the receipt", async () => {
  const tx = {
    $queryRaw: async () => undefined,
    incomingInspection: { findFirst: async () => ({ id: "inspection-1", status: "accepted", remark: null, rawMaterialInbounds: [], purchaseReceipt: { rawMaterialInbounds: [{ id: "inbound-1" }] } }) },
  };
  const service = new IncomingInspectionsService({ $transaction: async (fn) => fn(tx) }, { update: () => ({ updatedBy: user.id }), record: async () => {} });
  await assert.rejects(() => service.update("inspection-1", { inspected_quantity: "1", accepted_quantity: "1", conditional_quantity: "0", rejected_quantity: "0", reason: "复核" }, user), (error) => error instanceof UnprocessableEntityException && error.getResponse().code === "INSPECTION_DOWNSTREAM_EXISTS");
});

test("incoming QC status rollback rejects an inbound linked to the inspection", async () => {
  const prisma = { incomingInspection: { findFirst: async () => ({ id: "inspection-1", status: "completed", remark: null, inspectedQuantity: "1", rawMaterialInbounds: [{ id: "inbound-1" }] }) } };
  const service = new IncomingInspectionsService(prisma, { update: () => ({ updatedBy: user.id }), record: async () => {} });
  await assert.rejects(() => service.transition("inspection-1", "pending", "回退复核", user), (error) => error instanceof UnprocessableEntityException && error.getResponse().code === "INSPECTION_DOWNSTREAM_EXISTS");
});

test("incoming QC correction is rejected after inbound facts", async () => {
  const tx = { $queryRaw: async () => undefined, incomingInspection: { findFirst: async () => ({ id: "inspection-1", purchaseReceipt: { quantity: "10", rawMaterialInbounds: [] }, rawMaterialInbounds: [{ id: "inbound-1" }] }) } };
  const service = new IncomingInspectionsService({ $transaction: async (fn) => fn(tx) }, { update: () => ({ updatedBy: user.id }), record: async () => {} });
  await assert.rejects(() => service.update("inspection-1", { inspected_quantity: "1", accepted_quantity: "1", conditional_quantity: "0", rejected_quantity: "0", reason: "复核" }, user), (error) => error instanceof UnprocessableEntityException && error.getResponse().code === "INSPECTION_DOWNSTREAM_EXISTS");
});

test("a full return voids pending payables and cancels the inspection", async () => {
  let update;
  let voided;
  const current = { id: "inspection-1", orderNo: "DL260001", status: "accepted", remark: null, purchaseReceiptId: "receipt-1", rawMaterialInbounds: [], purchaseReceipt: { payableSources: [{ id: "payable-1", status: "pending_finance" }] } };
  const tx = {
    $queryRaw: async () => undefined,
    incomingInspection: { findFirst: async () => current, update: async ({ data }) => { update = data; return { ...current, ...data }; } },
    payableSource: { updateMany: async ({ where, data }) => { voided = { where, data }; return { count: 1 }; } },
  };
  const service = new IncomingInspectionsService({ $transaction: async (fn) => fn(tx) }, { update: () => ({ updatedBy: user.id }), record: async () => {} });
  const result = await service.returnToSupplier("inspection-1", "来料规格不符", user);
  assert.equal(result.status, "cancelled");
  assert.equal(voided.where.purchaseReceiptId, "receipt-1");
  assert.equal(voided.data.status, "voided");
  assert.match(update.remark, /整批退货：来料规格不符/);
});

test("a return is refused with inbound facts, posted payables, or a missing reason", async () => {
  const base = { id: "inspection-1", orderNo: "DL260001", status: "accepted", remark: null, purchaseReceiptId: "receipt-1" };
  const serviceFor = (current) => {
    const tx = { $queryRaw: async () => undefined, incomingInspection: { findFirst: async () => current }, payableSource: { updateMany: async () => ({ count: 0 }) } };
    return new IncomingInspectionsService({ $transaction: async (fn) => fn(tx) }, { update: () => ({ updatedBy: user.id }), record: async () => {} });
  };
  await assert.rejects(() => serviceFor({ ...base, rawMaterialInbounds: [{ id: "inbound-1" }], purchaseReceipt: { payableSources: [] } }).returnToSupplier("inspection-1", "退货", user), (error) => error.getResponse().code === "INSPECTION_DOWNSTREAM_EXISTS");
  await assert.rejects(() => serviceFor({ ...base, rawMaterialInbounds: [], purchaseReceipt: { payableSources: [{ id: "payable-1", status: "posted" }] } }).returnToSupplier("inspection-1", "退货", user), (error) => error.getResponse().code === "PAYABLE_SOURCE_POSTED");
  await assert.rejects(() => serviceFor({ ...base, rawMaterialInbounds: [], purchaseReceipt: { payableSources: [] } }).returnToSupplier("inspection-1", "   ", user), (error) => error.getResponse().code === "INSPECTION_RETURN_REASON_REQUIRED");
});

test("a returned batch cannot be corrected back to life or returned twice", async () => {
  const returned = { id: "inspection-1", orderNo: "DL260001", status: "cancelled", purchaseReceiptId: "receipt-1", remark: "整批退货：来料规格不符", extensionData: {}, rawMaterialInbounds: [], purchaseReceipt: { quantity: "10", payableSources: [], rawMaterialInbounds: [] } };
  const txFor = () => ({ $queryRaw: async () => undefined, incomingInspection: { findFirst: async () => returned, update: async ({ data }) => { throw new Error("must not write"); } }, payableSource: { updateMany: async () => { throw new Error("must not write"); } } });
  const correctionService = new IncomingInspectionsService({ $transaction: async (fn) => fn(txFor()) }, { update: () => ({ updatedBy: user.id }), record: async () => {} });
  await assert.rejects(() => correctionService.update("inspection-1", { inspected_quantity: "1", accepted_quantity: "1", conditional_quantity: "0", rejected_quantity: "0", reason: "复核" }, user), (error) => error.getResponse().code === "INSPECTION_RETURNED_NOT_CORRECTABLE");
  const returnService = new IncomingInspectionsService({ $transaction: async (fn) => fn(txFor()) }, { update: () => ({ updatedBy: user.id }), record: async () => {} });
  await assert.rejects(() => returnService.returnToSupplier("inspection-1", "重复退货", user), (error) => error.getResponse().code === "INSPECTION_ALREADY_RETURNED");
});

test("a transition rechecks live state inside the lock before writing", async () => {
  const initial = { id: "inspection-1", status: "accepted", remark: null, inspectedQuantity: "1", rawMaterialInbounds: [] };
  const live = { id: "inspection-1", status: "cancelled", remark: "整批退货：规格不符", inspectedQuantity: "1", rawMaterialInbounds: [] };
  const tx = { $queryRaw: async () => undefined, incomingInspection: { findFirst: async () => live, update: async () => { throw new Error("must not write"); } } };
  const service = new IncomingInspectionsService({ $transaction: async (fn) => fn(tx), incomingInspection: { findFirst: async () => initial } }, { update: () => ({ updatedBy: user.id }), record: async () => {} }, { createDraftForInspection: async () => ({ id: "inbound-x", status: "draft" }) });
  await assert.rejects(() => service.transition("inspection-1", "pending", "回退", user), (error) => error.getResponse().code === "INVALID_INSPECTION_STATE");
});
