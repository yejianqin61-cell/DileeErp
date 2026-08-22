const test = require("node:test");
const assert = require("node:assert/strict");
const { allocationAvailable, paymentAllocationRemaining, receivableStatus } = require("../../dist/modules/finance/receivable.domain.js");

test("E4 prevents allocation beyond receivable balance", () => {
  assert.equal(allocationAvailable("100", "30", "20"), "50");
  assert.throws(() => allocationAvailable("100", "90", "20"));
});

test("E4 prevents payment over-allocation", () => {
  assert.equal(paymentAllocationRemaining("100", "30", "20"), "50");
  assert.throws(() => paymentAllocationRemaining("100", "90", "20"));
});

test("E4 derives receivable payment status", () => {
  assert.equal(receivableStatus("100", "0"), "confirmed");
  assert.equal(receivableStatus("100", "30"), "partially_paid");
  assert.equal(receivableStatus("100", "100"), "paid");
});
