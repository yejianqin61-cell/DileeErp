const test = require("node:test");
const assert = require("node:assert/strict");
const { availableFinishedGoodsQuantity, availableDefectiveGoodsQuantity } = require("../../dist/modules/warehouse/finished-goods-inventory.domain.js");

test("E2 keeps finished goods inbound quantity bounded by QC accepted quantity", () => {
  assert.equal(availableFinishedGoodsQuantity("10", "3"), "7");
  assert.throws(() => availableFinishedGoodsQuantity("2", "3"));
});

test("E2 keeps defective goods quantity bounded by QC rejected quantity", () => {
  assert.equal(availableDefectiveGoodsQuantity("4.5", "1.25"), "3.25");
  assert.throws(() => availableDefectiveGoodsQuantity("1", "2"));
});
