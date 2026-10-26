// 采购领域 4 个 operation 的单元测试（假只读 client，宽行含金额/结算/应付来源/联系人）。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { getPurchasePlans, getPurchaseOrders, getReceipts, getIncomingInspections } = require("../../dist/modules/business-query-agent/tools/procurement-query-tools.js");

const ROOT = { id: "root-1", orderNo: "SO-TEST-001", quantity: { toString: () => "100" }, unit: "把", status: "confirmed", updatedAt: new Date() };

function fakeClient(config = {}) {
  return {
    purchasePlan: { findMany: async () => config.plans ?? [{ planNo: "PP-1", bomVersion: 3, createdAt: new Date(), items: [{ model: "G-1", quantity: { toString: () => "300" }, materialSnapshot: { name: "伞骨", reference_unit_price: "1.2" }, unitSnapshot: { name: "支" }, supplierSnapshot: { name: "供应商甲", phone: "138" }, unitPrice: { toString: () => "1.2" }, amount: { toString: () => "360" } }] }] },
    purchasePlanItem: { findMany: async () => config.planItems ?? [] },
    purchaseOrder: { findMany: async () => config.orders ?? [{ purchaseOrderNo: "PO-1", status: "ordered", items: [{ quantity: { toString: () => "300" }, unitPrice: { toString: () => "1.2" }, amount: { toString: () => "360" } }], supplierSnapshot: { name: "供应商甲", phone: "138", address: "某市" }, purchaseDate: new Date(), expectedDate: new Date(), currency: "CNY", totalAmount: { toString: () => "360" }, paymentTerms: "月结30天", deliveryTerms: "送货上门 某市某路", createdAt: new Date(), updatedAt: new Date() }] },
    purchaseOrderItem: { findMany: async () => config.orderItems ?? [{ purchaseOrderId: "po-1", quantity: { toString: () => "300" }, unitPrice: { toString: () => "1.2" }, amount: { toString: () => "360" }, materialSnapshot: { name: "伞骨" } }] },
    purchaseReceipt: { findMany: async () => config.receipts ?? [{ receiptNo: "RC-1", referenceNo: "REF-1", receivedDate: new Date(), quantity: { toString: () => "240" }, status: "posted", extensionData: { payable_source: "x" }, remark: "内部", purchaseOrder: { purchaseOrderNo: "PO-1" } }] },
    incomingInspection: { findMany: async () => config.inspections ?? [{ id: "i1", inspectedQuantity: { toString: () => "240" }, acceptedQuantity: { toString: () => "230" }, conditionalQuantity: { toString: () => "5" }, rejectedQuantity: { toString: () => "5" }, qcResult: "让步接收", status: "posted", extensionData: { secret: 1 }, remark: "内部", purchaseReceipt: { receiptNo: "RC-1" } }] },
  };
}

test("get_purchase_plans：行只有物料/数量/单位/供应商名，单价/金额/联系人不出", async () => {
  const result = await getPurchasePlans(fakeClient(), ROOT, 1);
  const json = JSON.stringify(result);
  for (const banned of ["unit_price", "amount", "reference_unit_price", "360", "1.2", "phone", "138", "address", "supplierSnapshot", "materialSnapshot", "unitSnapshot"]) {
    assert.ok(!json.includes(banned), `采购计划投影不得出现 ${banned}`);
  }
  assert.equal(result.data[0].plan_no, "PP-1");
  assert.equal(result.data[0].material_name, "伞骨");
  assert.equal(result.data[0].quantity, "300");
  assert.equal(result.data[0].supplier_name, "供应商甲");
});

test("get_purchase_orders：单只有状态/供应商名/数量/时间，总额/币种/付款条款/交货条款不出", async () => {
  const result = await getPurchaseOrders(fakeClient(), ROOT, 1);
  const json = JSON.stringify(result);
  for (const banned of ["total_amount", "currency", "payment_terms", "delivery_terms", "360", "CNY", "月结", "送货上门", "某市", "unit_price"]) {
    assert.ok(!json.includes(banned), `采购单投影不得出现 ${banned}`);
  }
  assert.equal(result.data[0].purchase_order_no, "PO-1");
  assert.equal(result.data[0].supplier_name, "供应商甲");
  assert.equal(result.data[0].ordered_quantity, "300");
});

test("get_receipts：批次用单号标识，extensionData/应付来源/备注不出", async () => {
  const result = await getReceipts(fakeClient(), ROOT, 1);
  const json = JSON.stringify(result);
  for (const banned of ["extensionData", "payable", "remark", "内部"]) {
    assert.ok(!json.includes(banned), `到货投影不得出现 ${banned}`);
  }
  assert.equal(result.data[0].receipt_no, "RC-1");
  assert.equal(result.data[0].purchase_order_no, "PO-1");
  assert.equal(result.data[0].quantity, "240");
});

test("get_incoming_inspections：四类数量+结论+状态，extensionData 整体不出", async () => {
  const result = await getIncomingInspections(fakeClient(), ROOT, 1);
  const json = JSON.stringify(result);
  for (const banned of ["extensionData", "secret", "remark", "内部"]) {
    assert.ok(!json.includes(banned), `质检投影不得出现 ${banned}`);
  }
  assert.equal(result.data[0].receipt_no, "RC-1");
  assert.equal(result.data[0].inspected_quantity, "240");
  assert.equal(result.data[0].qc_result, "让步接收");
});
