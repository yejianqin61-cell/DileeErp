const test = require("node:test");
const assert = require("node:assert/strict");
const { UnprocessableEntityException } = require("@nestjs/common");
const { deriveFinishedGoodsQcConclusion, availableFinishedGoodsInboundQuantity } = require("../../dist/modules/warehouse/finished-goods-qc.domain.js");

// 关键回归（客户报的「成品质检显示服务器内部错误」）：
// 这些业务规则以前抛普通 Error，Nest 会返回 500；必须是 422 + 可读中文提示。
function assertRuleError(error, expectedCode) {
  assert.ok(error instanceof UnprocessableEntityException, `必须是 422（UnprocessableEntityException），实际是 ${error?.constructor?.name}`);
  assert.equal(error.getResponse().code, expectedCode);
  assert.equal(typeof error.getResponse().message, "string");
  return true;
}

test("finished goods QC derives qualified conclusion and balances quantities", () => {
  assert.equal(deriveFinishedGoodsQcConclusion({ inspected_quantity: "10", qualified_quantity: "10", conditional_accept_quantity: "0", rejected_quantity: "0" }).conclusion, "qualified");
});

test("finished goods QC keeps conditional and rejected quantities distinct", () => {
  assert.equal(deriveFinishedGoodsQcConclusion({ inspected_quantity: "10", qualified_quantity: "4", conditional_accept_quantity: "3", rejected_quantity: "3" }).conclusion, "mixed");
});

test("数量不配平返回 422 并说明差额（不再是 500 服务器内部错误）", () => {
  assert.throws(
    () => deriveFinishedGoodsQcConclusion({ inspected_quantity: "10", qualified_quantity: "8", conditional_accept_quantity: "0", rejected_quantity: "1" }),
    (error) => {
      assertRuleError(error, "QC_QUANTITY_NOT_BALANCED");
      assert.match(error.getResponse().message, /数量不配平/);
      assert.match(error.getResponse().message, /本次检验数量（10）/);
      assert.match(error.getResponse().message, /拆分合计 9|当前合计 9/);
      return true;
    },
  );
});

test("数量留空或非数字返回 422 且提示是哪个字段", () => {
  assert.throws(
    () => deriveFinishedGoodsQcConclusion({ inspected_quantity: "10", qualified_quantity: "", conditional_accept_quantity: "0", rejected_quantity: "0" }),
    (error) => {
      assertRuleError(error, "INVALID_QC_QUANTITY");
      assert.match(error.getResponse().message, /合格数量/);
      return true;
    },
  );
  assert.throws(
    () => deriveFinishedGoodsQcConclusion({ inspected_quantity: "0", qualified_quantity: "0", conditional_accept_quantity: "0", rejected_quantity: "0" }),
    (error) => assertRuleError(error, "QC_INSPECTED_QUANTITY_REQUIRED"),
  );
});

test("finished goods inbound source is QC accepted quantity minus prior inbound", () => {
  assert.equal(availableFinishedGoodsInboundQuantity("7", "2", "3"), "6");
  assert.throws(
    () => availableFinishedGoodsInboundQuantity("1", "0", "2"),
    (error) => assertRuleError(error, "QC_INBOUND_QUANTITY_EXCEEDED"),
  );
});
