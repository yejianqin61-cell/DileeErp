// 生产领域 4 个 operation 的单元测试（假只读 client，宽行含工资/工价/采购价/应付来源/自由备注）。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { getProductionOrders, getOperationProgress, getOperationReports, getOutsourceFlow } = require("../../dist/modules/business-query-agent/tools/production-query-tools.js");

const ROOT = { id: "root-1", orderNo: "SO-TEST-001", quantity: { toString: () => "100" }, unit: "把", status: "confirmed", updatedAt: new Date() };

function fakeClient(config = {}) {
  return {
    productionOrder: {
      findMany: async () => config.production ?? [{ id: "po-1", productionOrderNo: "PR-1", executionMode: "in_house", status: "in_progress", plannedQuantity: { toString: () => "100" }, productSpecification: "21寸黑胶", startedOn: new Date("2026-10-01"), completedOn: null, deliveryDueOn: new Date("2026-11-01"), bomSnapshot: { items: [{ price: "1" }] }, remark: "内部备注", operations: [{ id: "op-1", productionOrderId: "po-1", operationNameSnapshot: "缝纫", sequenceNo: 1, targetQuantity: { toString: () => "100" }, status: "active", cancellationReason: "自由文本" }] }],
    },
    operationDailyReport: {
      findMany: async () => config.reports ?? [{ productionOrderOperationId: "op-1", productionOrderNoSnapshot: "PR-1", operationNameSnapshot: "缝纫", reportDate: new Date("2026-10-20"), completedQuantity: { toString: () => "60" }, unit: { name: "把" }, remark: "员工张三 时薪30", createdBy: "u-9" }],
    },
    outsourceLogisticsBatch: {
      findMany: async () => config.batches ?? [{ batchNo: "OSB-1", status: "dispatched", plannedQuantity: { toString: () => "200" }, dispatchedQuantity: { toString: () => "180" }, dispatchDate: new Date("2026-10-05"), dispatchProofRemark: "证明备注", remark: "内部", purchaseOrderId: "p-1" }],
    },
    outsourceReturnTransfer: {
      findMany: async () => config.returns ?? [{ transferNo: "RT-1", transferType: "finished_return", quantity: { toString: () => "150" }, transferDate: new Date("2026-10-12"), status: "posted", finishedGoodsQcStatus: "qualified", remark: "内部", material: { name: "伞骨", referenceUnitPrice: "1.2" } }],
    },
    outsourceDirectShipment: {
      findMany: async () => config.shipments ?? [{ shipmentNo: "DS-1", quantity: { toString: () => "40" }, shipmentDate: new Date("2026-10-15"), logisticsReference: "顺丰 SF123", status: "shipped", reversalQuantity: { toString: () => "0" }, reversalReason: "自由原因", remark: "内部" }],
    },
  };
}

test("get_production_orders：单与工序清单投影；整块 BOM 快照/备注/取消原因不出", async () => {
  const result = await getProductionOrders(fakeClient(), ROOT);
  const json = JSON.stringify(result);
  for (const banned of ["bomSnapshot", "remark", "内部备注", "cancellationReason", "自由文本", "price"]) {
    assert.ok(!json.includes(banned), `生产单投影不得出现 ${banned}`);
  }
  assert.equal(result.data[0].production_order_no, "PR-1");
  assert.equal(result.data[0].planned_quantity, "100");
  assert.equal(result.data[0].operations[0].operation_name, "缝纫");
  assert.equal(result.data[0].operations[0].target_quantity, "100");
});

test("get_operation_progress：按工序聚合报工，进度复用领域纯函数口径（60/100=60%）", async () => {
  const result = await getOperationProgress(fakeClient(), ROOT);
  const row = result.data[0];
  assert.equal(row.operation_name, "缝纫");
  assert.equal(row.planned_quantity, "100");
  assert.equal(row.actual_quantity, "60");
  assert.equal(row.completion_rate, "0.6");
  assert.ok(["not_started", "in_progress", "completed", "over_order", "not_applicable"].includes(row.status));
  const json = JSON.stringify(result);
  for (const banned of ["张三", "时薪", "remark"]) assert.ok(!json.includes(banned), `进度投影不得出现 ${banned}`);
});

test("get_operation_reports：报工行只有工序/数量/单位/日期；员工与计薪信息不出", async () => {
  const result = await getOperationReports(fakeClient(), ROOT, 1);
  const json = JSON.stringify(result);
  for (const banned of ["张三", "时薪", "30", "remark", "createdBy"]) {
    assert.ok(!json.includes(banned), `报工投影不得出现 ${banned}`);
  }
  assert.equal(result.data[0].production_order_no, "PR-1");
  assert.equal(result.data[0].completed_quantity, "60");
  assert.equal(result.data[0].unit, "把");
});

test("get_outsource_flow：三链（发料/回厂/直发）分列；采购价/应付/备注/回签原因不出", async () => {
  const result = await getOutsourceFlow(fakeClient(), ROOT);
  const json = JSON.stringify(result);
  for (const banned of ["dispatchProofRemark", "reversalReason", "remark", "内部", "证明备注", "自由原因", "referenceUnitPrice", "purchaseOrderId"]) {
    assert.ok(!json.includes(banned), `外加工投影不得出现 ${banned}`);
  }
  const chains = result.data.map((row) => row.chain).sort();
  assert.deepEqual(chains, ["direct_shipment", "dispatch", "return"]);
  const dispatch = result.data.find((row) => row.chain === "dispatch");
  assert.equal(dispatch.batch_no, "OSB-1");
  assert.equal(dispatch.dispatched_quantity, "180");
  const direct = result.data.find((row) => row.chain === "direct_shipment");
  assert.equal(direct.logistics_reference, "顺丰 SF123");
});
