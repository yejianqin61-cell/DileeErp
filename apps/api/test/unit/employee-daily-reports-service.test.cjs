const assert = require("node:assert/strict");
const { test } = require("node:test");
const { EmployeeDailyReportsService } = require("../../dist/modules/production/employee-daily-reports.service.js");

test("employee daily report checks idempotency after the operation lock", async () => {
  const existing = {
    id: "report-1",
    productionOrderId: "order-1",
    productionOrderOperationId: "operation-1",
    employeeId: "employee-1",
    reportDate: new Date("2026-09-03T00:00:00.000Z"),
    wageMode: "piece_rate",
    quantity: "2",
    calculatedAmount: "4",
  };
  const calls = [];
  let lookup = 0;
  const prisma = {
    productionOrder: { findFirst: async () => ({ id: "order-1", orderNo: "SO-1", productionOrderNo: "MO-1", executionMode: "in_house", status: "in_progress" }) },
    productionOrderOperation: { findFirst: async () => ({ id: "operation-1", productionOrderId: "order-1", operationNameSnapshot: "缝制", status: "active" }) },
    employee: { findFirst: async () => ({ id: "employee-1", name: "张三", employmentStatus: "active", hiredOn: null, leftOn: null }) },
    employeeDailyReport: { findFirst: async () => lookup++ === 0 ? null : existing },
    $transaction: async (fn) => fn({
      $queryRaw: async () => { calls.push("lock"); },
      employeeDailyReport: { findFirst: async () => { calls.push("idempotency"); return existing; } },
    }),
  };
  const service = new EmployeeDailyReportsService(prisma, { record: async () => { calls.push("audit"); } }, {});
  const result = await service.create({ production_order_id: "order-1", production_order_operation_id: "operation-1", employee_id: "employee-1", report_date: "2026-09-03", wage_mode: "piece_rate", quantity: "2", unit_price: "2", idempotency_key: "daily-key-1" }, { id: "user-1" });
  assert.equal(result.id, "report-1");
  assert.deepEqual(calls.slice(0, 2), ["lock", "idempotency"]);
});
