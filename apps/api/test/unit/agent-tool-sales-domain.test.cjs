// 销售领域 4 个 operation 的单元测试（假只读 client，喂「带财务字段/敏感联系方式的宽行」）。
//
// 两条硬红线：财务字段（单价/金额/币种/结算/应收）一个不剩；客户联系人电话/地址是
// 待定口径，默认收紧——get_customer 只给编码与名称。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { getSalesOrder, getCustomer, getBom, getSalesReturns } = require("../../dist/modules/business-query-agent/tools/sales-query-tools.js");

const ROOT = { id: "root-1", orderNo: "SO-TEST-001", quantity: { toString: () => "100" }, unit: "把", status: "confirmed", updatedAt: new Date() };

function fakeClient(config = {}) {
  return {
    salesOrder: { findFirst: async () => config.order ?? null },
    customer: { findFirst: async () => config.customer ?? null },
    bom: { findMany: async () => config.boms ?? [{ id: "b1", version: 3, status: "approved", createdAt: new Date() }] },
    bomItem: { findMany: async () => config.bomItems ?? [{ bomId: "b1", sequence: 1, materialName: "伞骨", model: "G-1", specificationModel: "6mm", color: null, requiredQuantity: { toString: () => "300" }, unit: "支", approvedUsage: { toString: () => "310" }, extensionData: { reference_unit_price: "1.2", reference_currency: "CNY" }, materialSnapshot: { reference_unit_price: "1.2" } }] },
    customerReturn: { findMany: async () => config.returns ?? [{ returnNo: "CR-1", quantity: { toString: () => "8" }, returnDate: new Date("2026-10-10"), destination: "finished_goods", status: "posted", reason: "客户吵架了不要了", remark: "内部备注", attachment: [{ name: "x.png" }], idempotencyKey: "k1" }] },
  };
}

test("get_sales_order：白名单投影，单价/金额/币种/结算/客户快照全部不出", async () => {
  const client = fakeClient({
    order: { orderNo: ROOT.orderNo, itemNo: "ITEM-1", reorderFromOrderNo: null, customerPoNo: "PO-X", externalContractNo: "CT-1", orderDate: new Date(), productName: "折叠伞", productSpec: "21寸", quantity: { toString: () => "100" }, unit: "把", deliveryDate: new Date(), currency: "USD", unitPrice: { toString: () => "9.9" }, totalAmount: { toString: () => "990" }, taxRate: { toString: () => "0.13" }, settlementUnitPrice: { toString: () => "9.8" }, receivableAmount: { toString: () => "900" }, localCurrencyAmount: { toString: () => "7000" }, status: "confirmed", currentVersion: 3, factory: "本厂", completionRemark: "交期紧", attentionNote: "注意唛头", customerSnapshot: { name: "客户甲", phone: "138" }, extensionData: { secret: 1 }, createdAt: new Date(), updatedAt: new Date() },
  });
  const result = await getSalesOrder(client, ROOT);
  const json = JSON.stringify(result.data);
  for (const banned of ["unit_price", "total_amount", "currency", "tax_rate", "settlement", "receivable", "local_currency", "customer_snapshot", "customerSnapshot", "9.9", "990", "900", "138", "extensionData", "secret"]) {
    assert.ok(!json.includes(banned), `销售单投影不得出现 ${banned}`);
  }
  assert.equal(result.data.order_no, ROOT.orderNo);
  assert.equal(result.data.product_name, "折叠伞");
  assert.equal(result.data.quantity, "100");
  assert.equal(result.data.current_version, 3);
  assert.equal(result.data.factory, "本厂");
});

test("get_customer：只给编码与名称——电话/地址/付款条款是待定口径，默认收紧", async () => {
  const client = fakeClient({
    order: { customerId: "c-1", customerSnapshot: { name: "快照名" } },
    customer: { customerCode: "C-001", name: "客户甲", countryRegion: "中国", address: "某市某路 1 号", paymentTerms: "月结 30 天", currency: "CNY", remark: "备注", isActive: true },
  });
  const result = await getCustomer(client, ROOT);
  assert.deepEqual(Object.keys(result.data).sort(), ["customer_code", "name"].sort());
  assert.equal(result.data.customer_code, "C-001");
  assert.equal(result.data.name, "客户甲");
});

test("get_customer：客户被软删时回退订单快照名，但不编造编码", async () => {
  const client = fakeClient({ order: { customerId: "c-1", customerSnapshot: { name: "快照名" } }, customer: null });
  const result = await getCustomer(client, ROOT);
  assert.equal(result.data.name, "快照名");
  assert.equal(result.data.customer_code, null);
});

test("get_bom：明细只有物料/用量/单位，快照与扩展里的参考价不出", async () => {
  const result = await getBom(fakeClient(), ROOT);
  const json = JSON.stringify(result);
  for (const banned of ["reference_unit_price", "reference_currency", "materialSnapshot", "extensionData", "1.2"]) {
    assert.ok(!json.includes(banned), `BOM 投影不得出现 ${banned}`);
  }
  assert.equal(result.data[0].bom_version, 3);
  assert.equal(result.data[0].material_name, "伞骨");
  assert.equal(result.data[0].required_quantity, "300");
  assert.equal(result.sources[0].business_type, "sales_order");
});

test("get_sales_returns：只有单号/数量/日期/去向/状态，自由原因/备注/附件不出", async () => {
  const result = await getSalesReturns(fakeClient(), ROOT);
  const json = JSON.stringify(result);
  for (const banned of ["reason", "remark", "attachment", "idempotency", "客户吵架"]) {
    assert.ok(!json.includes(banned), `退货投影不得出现 ${banned}`);
  }
  assert.equal(result.data[0].return_no, "CR-1");
  assert.equal(result.data[0].quantity, "8");
  assert.equal(result.data[0].destination, "finished_goods");
});
