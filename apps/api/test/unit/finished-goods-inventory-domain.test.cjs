const test = require("node:test");
const assert = require("node:assert/strict");
const { UnprocessableEntityException } = require("@nestjs/common");
const { availableFinishedGoodsQuantity, availableDefectiveGoodsQuantity } = require("../../dist/modules/warehouse/finished-goods-inventory.domain.js");

// 与成品 QC 同一口径：规则不满足要返回 422 + 可读提示，不能是 500「服务器内部错误」。
function assertRuleError(error, expectedCode) {
  assert.ok(error instanceof UnprocessableEntityException, `必须是 422，实际是 ${error?.constructor?.name}`);
  assert.equal(error.getResponse().code, expectedCode);
  return true;
}

test("E2 keeps finished goods inbound quantity bounded by QC accepted quantity", () => {
  assert.equal(availableFinishedGoodsQuantity("10", "3"), "7");
  assert.throws(() => availableFinishedGoodsQuantity("2", "3"), (error) => assertRuleError(error, "FINISHED_GOODS_INBOUND_EXCEEDS_QC"));
});

test("E2 keeps defective goods quantity bounded by QC rejected quantity", () => {
  assert.equal(availableDefectiveGoodsQuantity("4.5", "1.25"), "3.25");
  assert.throws(() => availableDefectiveGoodsQuantity("1", "2"), (error) => assertRuleError(error, "DEFECTIVE_GOODS_EXCEEDS_QC"));
});

test("数量非法/为空时给出 422 而不是 500", () => {
  assert.throws(() => availableFinishedGoodsQuantity("", "1"), (error) => assertRuleError(error, "INVALID_QUANTITY"));
  assert.throws(() => availableDefectiveGoodsQuantity("1", "abc"), (error) => assertRuleError(error, "INVALID_QUANTITY"));
});
