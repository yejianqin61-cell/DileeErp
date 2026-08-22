const test = require("node:test");
const assert = require("node:assert/strict");
const { deriveFinishedGoodsQcConclusion, availableFinishedGoodsInboundQuantity } = require("../../dist/modules/warehouse/finished-goods-qc.domain.js");

test("finished goods QC derives qualified conclusion and balances quantities", () => {
  assert.equal(deriveFinishedGoodsQcConclusion({ inspected_quantity: "10", qualified_quantity: "10", conditional_accept_quantity: "0", rejected_quantity: "0" }).conclusion, "qualified");
});

test("finished goods QC keeps conditional and rejected quantities distinct", () => {
  assert.equal(deriveFinishedGoodsQcConclusion({ inspected_quantity: "10", qualified_quantity: "4", conditional_accept_quantity: "3", rejected_quantity: "3" }).conclusion, "mixed");
});

test("finished goods QC rejects unbalanced quantities", () => {
  assert.throws(() => deriveFinishedGoodsQcConclusion({ inspected_quantity: "10", qualified_quantity: "8", conditional_accept_quantity: "0", rejected_quantity: "1" }));
});

test("finished goods inbound source is QC accepted quantity minus prior inbound", () => {
  assert.equal(availableFinishedGoodsInboundQuantity("7", "2", "3"), "6");
  assert.throws(() => availableFinishedGoodsInboundQuantity("1", "0", "2"));
});
