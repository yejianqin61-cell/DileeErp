const assert = require("node:assert/strict");
const { test } = require("node:test");
const { UnprocessableEntityException } = require("@nestjs/common");
const { RawMaterialInboundsService } = require("../../dist/modules/procurement/raw-material-inbounds.service.js");

test("raw-material inbound edits lock and recheck the QC source", async () => {
  const calls = [];
  const tx = {
    $queryRaw: async () => { calls.push("lock"); },
    rawMaterialInbound: { findFirst: async () => ({ id: "inbound-1", status: "draft", incomingInspectionId: "inspection-1" }), update: async () => ({ id: "inbound-1", orderNo: "SO-1" }) },
    incomingInspection: { findFirst: async () => ({ id: "inspection-1", acceptedQuantity: "5", conditionalQuantity: "0", rawMaterialInbounds: [{ id: "inbound-1", quantity: "1" }, { id: "inbound-2", quantity: "5" }] }) },
  };
  const prisma = { $transaction: async (fn) => fn(tx) };
  const service = new RawMaterialInboundsService(prisma, { update: () => ({}), record: async () => undefined }, {});
  await assert.rejects(() => service.update("inbound-1", { quantity: "2" }, { id: "user-1" }), (error) => error instanceof UnprocessableEntityException && error.getResponse().code === "INBOUND_QUANTITY_EXCEEDED");
  assert.deepEqual(calls, ["lock", "lock"]);
});
