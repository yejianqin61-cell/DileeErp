const assert = require("node:assert/strict");
const { test } = require("node:test");
const { Prisma } = require("@prisma/client");
const { getOrderCostProfit, getOrderPayroll } = require("../../dist/modules/business-query-agent/tools/finance-query-tools.js");

const ROOT = { id: "order-id", orderNo: "SO-FIN-003", quantity: { toString: () => "10" }, unit: "把", status: "confirmed", updatedAt: new Date() };
const decimal = (value) => new Prisma.Decimal(value);

function fakeClient({ shipped = true } = {}) {
  const queries = {};
  return {
    __queries: queries,
    salesOrder: { findMany: async (query) => {
      queries.salesOrder = query;
      return [{ id: ROOT.id, orderNo: ROOT.orderNo, orderDate: new Date("2026-10-01"), currency: "CNY", quantity: decimal("10"), unit: "把", totalAmount: decimal("125"), receivableAmount: decimal("125"), localCurrencyAmount: null }];
    } },
    finishedGoodsOutbound: { findMany: async (query) => {
      queries.finishedGoodsOutbound = query;
      return shipped ? [{ salesOrderId: ROOT.id, quantity: decimal("10") }] : [];
    } },
    outsourceDirectShipment: { findMany: async (query) => {
      queries.outsourceDirectShipment = query;
      return [];
    } },
    bom: { findMany: async () => [{ salesOrderId: ROOT.id, items: [{ materialId: "mat-1", materialName: "材料甲", approvedUsage: decimal("1"), baseUsage: null, requiredQuantity: null, productionBatchBase: null, material: { materialCode: "MAT-1", name: "材料甲" } }] }] },
    purchaseOrderItem: { findMany: async () => [{ materialId: "mat-1", unitPrice: decimal("2"), purchaseOrder: { purchaseDate: new Date("2026-10-01"), createdAt: new Date("2026-10-01") } }] },
    employeeDailyReport: { findMany: async (query) => {
      queries.employeeDailyReport = query;
      return [{ id: "daily-1", reportDate: new Date("2026-10-02"), employeeNameSnapshot: "员工甲", operationNameSnapshot: "编织", wageMode: "piece", quantity: decimal("10"), unitPrice: decimal("1"), calculatedAmount: decimal("10"), remark: "不得泄露", productionOrderOperation: { unit: { name: "把" } } }];
    }, aggregate: async () => ({ _sum: { calculatedAmount: decimal("10") } }) },
  };
}

test("get_order_cost_profit：已出货订单复用 BOM 采购价和日报人工口径", async () => {
  const result = await getOrderCostProfit(fakeClient(), ROOT, 1);
  assert.deepEqual(result.data, [{
    order_no: "SO-FIN-003", shipped: true, currency: "CNY", sales_amount: "125", local_revenue_amount: "125",
    material_cost_amount: "20", labor_amount: "10", total_cost_amount: "30", profit_amount: "95",
    cost_basis: "BOM 原料成本 + 订单关联日报人工；未指定期间，未纳入月度管理费",
    footnotes: [],
  }]);
});

test("get_order_cost_profit：未出货订单明确没有可核算数据", async () => {
  const result = await getOrderCostProfit(fakeClient({ shipped: false }), ROOT, 1);
  assert.deepEqual(result.data, [{
    order_no: "SO-FIN-003", shipped: false, cost_basis: "销售利润和核算表仅纳入已出货订单", footnotes: ["尚未出货的销售单（未计入本表）：SO-FIN-003"],
  }]);
});

test("get_order_payroll：只读取精确订单的日报白名单字段", async () => {
  const client = fakeClient();
  const result = await getOrderPayroll(client, ROOT, 1);
  assert.deepEqual(result.data, [{
    report_date: new Date("2026-10-02"), employee_name: "员工甲", operation_name: "编织", wage_mode: "piece", quantity: "10", unit: "把", unit_price: "1", amount: "10",
  }]);
  assert.deepEqual(client.__queries.employeeDailyReport.where, { orderNo: ROOT.orderNo, deletedAt: null });
  assert.doesNotMatch(JSON.stringify(result), /不得泄露/);
});
