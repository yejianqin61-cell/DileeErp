const { testRun } = require("../helpers/test-context.cjs");

function businessFixtures(run = testRun()) {
  return {
    run,
    customer: () => ({ customer_code: `C-${run.id}`, name: `测试客户-${run.id}`, currency: "USD" }),
    salesOrder: (customerId) => ({ order_no: run.orderNo, customer_id: customerId, order_date: "2026-08-21", product_name: "测试雨伞", quantity: "100", unit: "个", currency: "USD" }),
    material: () => ({ material_code: `M-${run.id}`, name: `测试物料-${run.id}`, category: "fabric", unit: "个" }),
    supplier: () => ({ supplier_code: `S-${run.id}`, name: `测试供应商-${run.id}` }),
  };
}

module.exports = { businessFixtures };
