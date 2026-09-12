const test = require("node:test");
const assert = require("node:assert/strict");
const { UnprocessableEntityException } = require("@nestjs/common");
const { outboundAvailableQuantity, validateSignatureTime, customerReturnDestination } = require("../../dist/modules/warehouse/finished-goods-outbound.domain.js");

// 与成品 QC 同一口径：规则不满足要返回 422 + 可读提示，不能是 500「服务器内部错误」，
// 提示里要带上当前可用量，用户才知道能出多少。
function assertRuleError(error, expectedCode) {
  assert.ok(error instanceof UnprocessableEntityException, `必须是 422，实际是 ${error?.constructor?.name}`);
  assert.equal(error.getResponse().code, expectedCode);
  return true;
}

test("E3 prevents outbound quantities from making finished goods negative", () => {
  assert.equal(outboundAvailableQuantity("10", "4"), "6");
  assert.throws(
    () => outboundAvailableQuantity("3", "4"),
    (error) => {
      assertRuleError(error, "OUTBOUND_QUANTITY_EXCEEDED");
      assert.match(error.getResponse().message, /库存不足/);
      assert.deepEqual(error.getResponse().details, [{ available_quantity: "3" }]);
      return true;
    },
  );
});

test("E3 requires signature time to be on or after shipment", () => {
  assert.equal(validateSignatureTime("2026-08-22T08:00:00Z", "2026-08-22T09:00:00Z"), true);
  assert.throws(() => validateSignatureTime("2026-08-22T09:00:00Z", "2026-08-22T08:00:00Z"), (error) => assertRuleError(error, "INVALID_SIGNATURE_TIME"));
});

test("E3 supports only finished goods or defective goods return destinations", () => {
  assert.equal(customerReturnDestination("finished_goods"), "finished_goods");
  assert.equal(customerReturnDestination("defective_goods"), "defective_goods");
  assert.throws(() => customerReturnDestination("scrap"), (error) => assertRuleError(error, "INVALID_RETURN_DESTINATION"));
});

test("出库数量为空/非数字时是 422 而不是 500", () => {
  assert.throws(() => outboundAvailableQuantity("10", ""), (error) => assertRuleError(error, "INVALID_OUTBOUND_QUANTITY"));
  assert.throws(() => outboundAvailableQuantity("10", "abc"), (error) => assertRuleError(error, "INVALID_OUTBOUND_QUANTITY"));
  assert.throws(() => outboundAvailableQuantity("10", "0"), (error) => assertRuleError(error, "INVALID_OUTBOUND_QUANTITY"));
});
