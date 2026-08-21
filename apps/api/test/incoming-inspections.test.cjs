const assert = require("node:assert/strict");
const { test } = require("node:test");
const { UnprocessableEntityException } = require("@nestjs/common");
const { IncomingInspectionsService } = require("../dist/modules/procurement/incoming-inspections.service.js");

const user = { id: "1f7d261d-0089-4d32-9aa1-19942c41cb1d", username: "operator", display_name: "操作员" };

test("incoming QC cannot cumulatively exceed its receipt quantity", async () => {
  const prisma = { purchaseReceipt: { findFirst: async () => ({ id: "receipt-1", orderNo: "DL260001", quantity: "10", inspections: [{ inspectedQuantity: "8" }] }) }, incomingInspection: { create: async () => { throw new Error("must not write"); } } };
  const service = new IncomingInspectionsService(prisma, { create: () => ({ createdBy: user.id, updatedBy: user.id }), record: async () => {} });
  await assert.rejects(() => service.create({ purchase_receipt_id: "receipt-1", inspected_quantity: "3", accepted_quantity: "3", conditional_quantity: "0", rejected_quantity: "0" }, user), (error) => error instanceof UnprocessableEntityException && error.getResponse().code === "INSPECTION_QUANTITY_MISMATCH");
});
