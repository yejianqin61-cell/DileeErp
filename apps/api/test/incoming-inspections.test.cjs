const assert = require("node:assert/strict");
const { test } = require("node:test");
const { UnprocessableEntityException } = require("@nestjs/common");
const { IncomingInspectionsService } = require("../dist/modules/procurement/incoming-inspections.service.js");

const user = { id: "1f7d261d-0089-4d32-9aa1-19942c41cb1d", username: "operator", display_name: "操作员" };

test("passed QC creates one draft inbound in the same transaction", async () => {
  const calls = [];
  const tx = { $queryRaw: async () => undefined, purchaseReceipt: { findFirst: async () => ({ id: "receipt-1", orderNo: "DL260001", quantity: "10", extensionData: {}, inspections: [] }) }, incomingInspection: { create: async ({ data }) => ({ id: "inspection-1", ...data }) } };
  const prisma = { $transaction: async (fn) => fn(tx) };
  const inbounds = { createDraftForInspection: async (client, id) => { calls.push([client, id]); return { id: "inbound-1", status: "draft" }; } };
  const service = new IncomingInspectionsService(prisma, { create: () => ({}), record: async () => {} }, inbounds);
  const result = await service.create({ purchase_receipt_id: "receipt-1", inspected_quantity: "10", accepted_quantity: "8", conditional_quantity: "2", rejected_quantity: "0" }, user);
  assert.equal(result.status, "conditionally_accepted");
  assert.deepEqual(calls, [[tx, "inspection-1"]]);
});

test("incoming QC cannot cumulatively exceed its receipt quantity", async () => {
  const tx = { $queryRaw: async () => undefined, purchaseReceipt: { findFirst: async () => ({ id: "receipt-1", orderNo: "DL260001", quantity: "10", inspections: [{ inspectedQuantity: "8" }] }) }, incomingInspection: { create: async () => { throw new Error("must not write"); } } };
  const prisma = { $transaction: async (fn) => fn(tx) };
  const service = new IncomingInspectionsService(prisma, { create: () => ({ createdBy: user.id, updatedBy: user.id }), record: async () => {} });
  await assert.rejects(() => service.create({ purchase_receipt_id: "receipt-1", inspected_quantity: "3", accepted_quantity: "3", conditional_quantity: "0", rejected_quantity: "0" }, user), (error) => error instanceof UnprocessableEntityException && error.getResponse().code === "INSPECTION_QUANTITY_MISMATCH");
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

test("incoming QC correction is rejected after inbound facts", async () => {
  const tx = { $queryRaw: async () => undefined, incomingInspection: { findFirst: async () => ({ id: "inspection-1", purchaseReceipt: { quantity: "10", rawMaterialInbounds: [] }, rawMaterialInbounds: [{ id: "inbound-1" }] }) } };
  const service = new IncomingInspectionsService({ $transaction: async (fn) => fn(tx) }, { update: () => ({ updatedBy: user.id }), record: async () => {} });
  await assert.rejects(() => service.update("inspection-1", { inspected_quantity: "1", accepted_quantity: "1", conditional_quantity: "0", rejected_quantity: "0", reason: "复核" }, user), (error) => error instanceof UnprocessableEntityException && error.getResponse().code === "INSPECTION_DOWNSTREAM_EXISTS");
});
