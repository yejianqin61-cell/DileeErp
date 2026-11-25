const assert = require("node:assert/strict");
const { test } = require("node:test");
const { splitNeededFields } = require("../../dist/modules/business-query-agent/tools/gap-fields.js");

test("存在的字段进 verified，销售单没有供应商名", () => {
  assert.deepEqual(splitNeededFields(["SalesOrder.orderNo", "SalesOrder.supplierName"]), { verified: ["SalesOrder.orderNo"], unverified: ["SalesOrder.supplierName"] });
});

test("格式不是 模型.字段 的全部未核实", () => {
  const fields = ["供应商名称", "orderNo", "SalesOrder.orderNo.x", "Nope.id"];
  assert.deepEqual(splitNeededFields(fields), { verified: [], unverified: fields });
});

test("大小写敏感", () => {
  const fields = ["salesorder.orderNo", "SalesOrder.OrderNo"];
  assert.deepEqual(splitNeededFields(fields), { verified: [], unverified: fields });
});

test("保持顺序并各自去重", () => {
  assert.deepEqual(splitNeededFields(["a", "SalesOrder.orderNo", "a", "SalesOrder.orderNo"]), { verified: ["SalesOrder.orderNo"], unverified: ["a"] });
});

test("默认读 DMMF，也可传入模型清单", () => {
  assert.deepEqual(splitNeededFields(["PurchaseOrder.purchaseOrderNo"]).verified, ["PurchaseOrder.purchaseOrderNo"]);
  assert.deepEqual(splitNeededFields([]), { verified: [], unverified: [] });
  assert.deepEqual(splitNeededFields(["M.f"], [{ name: "M", fields: [{ name: "f" }] }]).verified, ["M.f"]);
});
