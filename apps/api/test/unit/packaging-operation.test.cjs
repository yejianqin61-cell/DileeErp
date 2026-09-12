const assert = require("node:assert/strict");
const { test } = require("node:test");
const { isPackagingOperationName, findPackagingOperation, PACKAGING_OPERATION_KEYWORD } = require("../../dist/modules/production/packaging-operation.js");

// 包装工序认定口径（用户确认）：工序名称包含「包装」即视为每个生产单的收尾工序。
test("按名称识别包装工序", () => {
  assert.equal(PACKAGING_OPERATION_KEYWORD, "包装");
  assert.equal(isPackagingOperationName("包装"), true);
  assert.equal(isPackagingOperationName("包装（模拟）"), true);
  assert.equal(isPackagingOperationName("大包装"), true);
  assert.equal(isPackagingOperationName("折伞"), false);
  assert.equal(isPackagingOperationName(""), false);
  assert.equal(isPackagingOperationName(null), false);
  assert.equal(isPackagingOperationName(undefined), false);
});

test("findPackagingOperation 只取未取消的包装工序，多道命中时取序号最大的收尾工序", () => {
  const operations = [
    { id: "op-1", operationNameSnapshot: "缝伞", status: "active", sequenceNo: 1 },
    { id: "op-2", operationNameSnapshot: "包装", status: "active", sequenceNo: 2 },
    { id: "op-3", operationNameSnapshot: "包装（返工）", status: "active", sequenceNo: 5 },
  ];
  assert.equal(findPackagingOperation(operations).id, "op-3");
  assert.equal(findPackagingOperation([{ id: "op-1", operationNameSnapshot: "缝伞", status: "active", sequenceNo: 1 }]), null);
  assert.equal(findPackagingOperation([]), null);
});

test("已取消的包装工序不算数（否则会给已取消工序发入库通知）", () => {
  const operations = [
    { id: "op-1", operationNameSnapshot: "包装", status: "cancelled", sequenceNo: 1 },
    { id: "op-2", operationNameSnapshot: "品检", status: "active", sequenceNo: 2 },
  ];
  assert.equal(findPackagingOperation(operations), null);
  assert.equal(findPackagingOperation([...operations, { id: "op-3", operationNameSnapshot: "包装", status: "active", sequenceNo: 3 }]).id, "op-3");
});
