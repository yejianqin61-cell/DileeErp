const test = require("node:test");
const assert = require("node:assert/strict");
const { outboundAvailableQuantity, validateSignatureTime, customerReturnDestination } = require("../../dist/modules/warehouse/finished-goods-outbound.domain.js");

test("E3 prevents outbound quantities from making finished goods negative", () => {
  assert.equal(outboundAvailableQuantity("10", "4"), "6");
  assert.throws(() => outboundAvailableQuantity("3", "4"));
});

test("E3 requires signature time to be on or after shipment", () => {
  assert.equal(validateSignatureTime("2026-08-22T08:00:00Z", "2026-08-22T09:00:00Z"), true);
  assert.throws(() => validateSignatureTime("2026-08-22T09:00:00Z", "2026-08-22T08:00:00Z"));
});

test("E3 supports only finished goods or defective goods return destinations", () => {
  assert.equal(customerReturnDestination("finished_goods"), "finished_goods");
  assert.equal(customerReturnDestination("defective_goods"), "defective_goods");
  assert.throws(() => customerReturnDestination("scrap"));
});
