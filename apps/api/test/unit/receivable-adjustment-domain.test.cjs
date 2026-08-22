const test = require("node:test");
const assert = require("node:assert/strict");
const { adjustmentNet, adjustmentOutstanding, assertAdjustmentWithinBalance, reconciliationStatus, closeBlockers } = require("../../dist/modules/finance/receivable-adjustment.domain.js");

test("E5 calculates independent adjustment net without changing source facts", () => {
  assert.equal(adjustmentNet([{ effect: "decrease", amount: "20" }, { effect: "increase", amount: "5" }]).toString(), "-15");
  assert.equal(adjustmentOutstanding("100", "30", [{ effect: "decrease", amount: "20" }]).toString(), "50");
});

test("E5 blocks a refund or red credit beyond the current source balance", () => {
  assert.equal(assertAdjustmentWithinBalance("20", "70"), "50");
  assert.throws(() => assertAdjustmentWithinBalance("71", "70"), /adjustment exceeds/);
});

test("E5 marks reconciliation differences and allows exact matches", () => {
  assert.equal(reconciliationStatus("80.0000", "80"), "matched");
  assert.equal(reconciliationStatus("80", "79.99"), "difference");
});

test("E5 exposes every order-close blocker without mutating order state", () => {
  assert.deepEqual(closeBlockers({ productionComplete: false, outboundComplete: false, outstandingAmount: "10", unresolvedReconciliations: 1, unreversedAdjustments: 2 }), ["PRODUCTION_NOT_COMPLETE", "OUTBOUND_NOT_COMPLETE", "RECEIVABLE_OUTSTANDING", "UNRESOLVED_RECONCILIATION", "UNREVERSED_ADJUSTMENT"]);
  assert.deepEqual(closeBlockers({ productionComplete: true, outboundComplete: true, outstandingAmount: "0", unresolvedReconciliations: 0, unreversedAdjustments: 0 }), []);
});
