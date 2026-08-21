const assert = require("node:assert/strict");
const { test } = require("node:test");
const { assertAudit, assertInventoryFacts, assertNoDuplicateSource, assertOrderNo, assertQcBalance } = require("../../../../tests/helpers/business-invariants.cjs");

test("business invariants accept a valid procurement fact set", () => {
  assertOrderNo("procurement order identity", "T-1", [{ id: "po", orderNo: "T-1" }, { id: "inbound", order_no: "T-1" }]);
  assertAudit("audited write", { id: "inbound", createdAt: new Date(), updatedAt: new Date(), createdBy: "user", updatedBy: "user" });
  assertQcBalance("incoming QC", { inspectedQuantity: "10", acceptedQuantity: "8", conditionalQuantity: "1", rejectedQuantity: "1" });
  assertNoDuplicateSource("payable source", [{ raw_material_inbound_id: "inbound-1" }]);
  assertInventoryFacts("inbound inventory", [{ quantityDelta: "8" }], "8");
});

test("business invariant errors identify the affected chain fact", () => {
  assert.throws(() => assertQcBalance("incoming QC", { inspectedQuantity: "10", acceptedQuantity: "9", conditionalQuantity: "0", rejectedQuantity: "0" }), /incoming QC/);
  assert.throws(() => assertNoDuplicateSource("payable source", [{ raw_material_inbound_id: "inbound-1" }, { raw_material_inbound_id: "inbound-1" }]), /payable source/);
});
