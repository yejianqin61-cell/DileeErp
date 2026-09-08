const assert = require("node:assert/strict");
const { test } = require("node:test");
const { Prisma } = require("@prisma/client");
const { ProductionProgressService } = require("../../dist/modules/production/production-progress.service.js");

function harness({ operationReports = [], employeeReports = [] } = {}) {
  const order = { id: "order-1", productionOrderNo: "MO-1", orderNo: "SO-1", executionMode: "in_house", plannedQuantity: new Prisma.Decimal("100"), unit: { name: "个" }, status: "in_progress", updatedAt: new Date(), operations: [{ id: "op-1", operationNameSnapshot: "缝伞", sequenceNo: 1, targetQuantity: new Prisma.Decimal("50"), status: "active", unit: { name: "个" } }] };
  const prisma = {
    productionOrder: { findFirst: async () => order },
    operationDailyReport: { findMany: async () => operationReports },
    employeeDailyReport: { findMany: async () => employeeReports },
    productionDailyAlert: { findMany: async () => [] },
    outsourceReturnTransfer: { findMany: async () => [] },
    outsourceDirectShipment: { findMany: async () => [] },
    outsourceReceipt: { findMany: async () => [] },
    finishedGoodsInspectionSubmission: { findMany: async () => [] },
  };
  return new ProductionProgressService(prisma, { recordWithOrderNo: async () => {}, record: async () => {} });
}

function operationRow(summary) { return summary.measurements.find((row) => row.operation_id === "op-1"); }

test("operation actual counts employee daily report quantities when no operation report exists", async () => {
  const service = harness({ employeeReports: [{ id: "er-1", productionOrderOperationId: "op-1", reportDate: new Date(), quantity: new Prisma.Decimal("50") }] });
  const summary = await service.getProductionOrderProgress("order-1");
  assert.equal(operationRow(summary).actual_quantity.toString(), "50");
  assert.ok(operationRow(summary).source_ids.includes("er-1"));
});

test("operation actual takes the larger of the two sources instead of double counting", async () => {
  const service = harness({
    operationReports: [{ id: "or-1", productionOrderOperationId: "op-1", reportDate: new Date(), completedQuantity: new Prisma.Decimal("50") }],
    employeeReports: [{ id: "er-1", productionOrderOperationId: "op-1", reportDate: new Date(), quantity: new Prisma.Decimal("50") }],
  });
  const summary = await service.getProductionOrderProgress("order-1");
  assert.equal(operationRow(summary).actual_quantity.toString(), "50");
  assert.ok(operationRow(summary).source_ids.includes("or-1") && operationRow(summary).source_ids.includes("er-1"));
});

test("operation actual keeps the larger side when the two sources disagree", async () => {
  const service = harness({
    operationReports: [{ id: "or-1", productionOrderOperationId: "op-1", reportDate: new Date(), completedQuantity: new Prisma.Decimal("30") }],
    employeeReports: [{ id: "er-1", productionOrderOperationId: "op-1", reportDate: new Date(), quantity: new Prisma.Decimal("50") }],
  });
  const summary = await service.getProductionOrderProgress("order-1");
  assert.equal(operationRow(summary).actual_quantity.toString(), "50");
});

test("an operation with only employee reports no longer blocks as missing_operation_report", async () => {
  const service = harness({ employeeReports: [{ id: "er-1", productionOrderOperationId: "op-1", reportDate: new Date(), quantity: new Prisma.Decimal("50") }] });
  const summary = await service.getProductionOrderProgress("order-1");
  assert.ok(!summary.blockers.includes("missing_operation_report"));
});
