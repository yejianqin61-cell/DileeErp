const test = require("node:test");
const assert = require("node:assert/strict");
const { payableOutstanding, paymentAllocationRemaining, payableAllocationRemaining, payableStatus, sourceType } = require("../../dist/modules/finance/supplier-payable.domain.js");

test("C6 calculates payable outstanding with exact decimal arithmetic", () => {
  assert.equal(payableOutstanding("100.1250", "30.1250"), "70");
  assert.equal(payableStatus("100", "0"), "confirmed");
  assert.equal(payableStatus("100", "20"), "partially_paid");
  assert.equal(payableStatus("100", "100"), "paid");
});

test("C6 blocks allocation beyond either payment or payable balance", () => {
  assert.equal(paymentAllocationRemaining("100", "20", "30"), "50");
  assert.equal(payableAllocationRemaining("100", "20", "30"), "50");
  assert.throws(() => paymentAllocationRemaining("100", "90", "11"), /payment allocation/);
  assert.throws(() => payableAllocationRemaining("100", "90", "11"), /payable allocation/);
});

test("C6 accepts all supported payable source types", () => {
  assert.equal(sourceType("raw_material_inbound"), "raw_material_inbound");
  assert.equal(sourceType("purchase_receipt"), "purchase_receipt");
  assert.equal(sourceType("outsource_receipt"), "outsource_receipt");
  assert.throws(() => sourceType("customer_return"), /invalid payable source/);
});
