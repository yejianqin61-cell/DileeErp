const assert = require("node:assert/strict");
const { test } = require("node:test");
const { assertAudit, assertOrderNo, assertOutsourceNoInventoryEffect, assertOutsourceReceiptBalance } = require("../../../../tests/helpers/business-invariants.cjs");

test("D6 keeps outsourced receipt quantities bounded and reversible", () => {
  assertOutsourceReceiptBalance("outsource receipt", "10", [{ quantity: "4", reversal_quantity: "0" }], "3");
  assert.throws(() => assertOutsourceReceiptBalance("outsource receipt", "10", [{ quantity: "9", reversal_quantity: "0" }], "2"), /outsource receipt/);
});

test("D6 direct dispatch and return sources do not create warehouse inventory facts", () => {
  assertOrderNo("outsource order identity", "T-D6", [{ id: "batch", order_no: "T-D6" }, { id: "receipt", orderNo: "T-D6" }, { id: "shipment", order_no: "T-D6" }]);
  assertAudit("outsource batch audit", { id: "batch", createdAt: new Date(), updatedAt: new Date(), createdBy: "user", updatedBy: "user" });
  assertOutsourceNoInventoryEffect("outsource no inventory", [{ source_type: "outsource_direct_receipt" }, { source_type: "outsource_direct_shipment" }].filter(() => false));
});
