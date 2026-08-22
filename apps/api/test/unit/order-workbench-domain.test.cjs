const test = require("node:test");
const assert = require("node:assert/strict");
const { overallStatus, decimalString, WORKBENCH_STATUS_LABELS } = require("../../dist/modules/order-workbench/order-workbench.domain.js");

test("G1 gives blockers precedence over otherwise completed modules", () => {
  assert.equal(overallStatus(["completed", "paid"], [{ code: "QC_REJECTED", label: "不合格", suggestion: "处理" }]), "blocked");
});

test("G1 derives the most useful order-level status", () => {
  assert.equal(overallStatus(["in_progress"], []), "in_progress");
  assert.equal(overallStatus(["ready_to_ship"], []), "ready_to_ship");
  assert.equal(overallStatus(["completed", "paid", "closed"], []), "completed");
  assert.equal(overallStatus([], []), "not_started");
  assert.equal(WORKBENCH_STATUS_LABELS.not_started, "未建立");
});

test("G1 preserves Decimal values as strings and explicit zero", () => {
  assert.equal(decimalString({ toString: () => "12.5000" }), "12.5000");
  assert.equal(decimalString(undefined), "0");
});
