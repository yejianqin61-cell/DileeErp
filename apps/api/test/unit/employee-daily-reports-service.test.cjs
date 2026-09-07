const assert = require("node:assert/strict");
const { test } = require("node:test");
const { EmployeeDailyReportsService } = require("../../dist/modules/production/employee-daily-reports.service.js");
const { UnprocessableEntityException } = require("@nestjs/common");

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
    // 事务内复检会再次调用 productionOrder/productionOrderOperation/employee 等 findFirst，
    // 因此把外层替身展开进回调对象；$queryRaw 记录 "lock"，幂等复查记录 "idempotency"。
    $transaction: async (fn) => fn({
      ...prisma,
      $queryRaw: async () => { calls.push("lock"); },
      employeeDailyReport: { findFirst: async () => { calls.push("idempotency"); return existing; } },
    }),
  };
  const service = new EmployeeDailyReportsService(prisma, { record: async () => { calls.push("audit"); } }, {});
  // 历史日报补录不再强制填写备注原因。
  const result = await service.create({ production_order_id: "order-1", production_order_operation_id: "operation-1", employee_id: "employee-1", report_date: "2026-09-03", wage_mode: "piece_rate", quantity: "2", unit_price: "2", idempotency_key: "daily-key-1" }, { id: "user-1" });
  assert.equal(result.id, "report-1");
  // 幂等复查发生在事务内 FOR UPDATE 锁（生产单、工序两道行锁）之后
  assert.equal(calls[0], "lock");
  assert.ok(calls.lastIndexOf("lock") < calls.indexOf("idempotency"), `expected lock before idempotency, got: ${JSON.stringify(calls)}`);
});

test("corrections still require a reason", async () => {
  const service = new EmployeeDailyReportsService({ employeeDailyReport: { findFirst: async () => ({ id: "report-1", version: 1 }) } }, {}, {});
  await assert.rejects(
    () => service.update("report-1", { quantity: "2", reason: "   " }, { id: "user-1" }),
    (error) => error instanceof UnprocessableEntityException && error.getResponse().code === "CORRECTION_REASON_REQUIRED",
  );
});

test("new employee daily reports are rejected after production completion", async () => {
  const prisma = {
    productionOrder: { findFirst: async () => ({ id: "order-1", orderNo: "SO-1", productionOrderNo: "MO-1", executionMode: "in_house", status: "completed" }) },
    productionOrderOperation: { findFirst: async () => ({ id: "operation-1", productionOrderId: "order-1", operationNameSnapshot: "缝制", status: "active" }) },
    employee: { findFirst: async () => ({ id: "employee-1", name: "张三", employmentStatus: "active", hiredOn: null, leftOn: null }) },
  };
  const service = new EmployeeDailyReportsService(prisma, {}, {});
  await assert.rejects(
    () => service.create({ production_order_id: "order-1", production_order_operation_id: "operation-1", employee_id: "employee-1", report_date: "2026-09-03", wage_mode: "piece_rate", quantity: "1", unit_price: "2" }, { id: "user-1" }),
    (error) => error instanceof UnprocessableEntityException && error.getResponse().code === "PRODUCTION_ORDER_DAILY_REPORT_FORBIDDEN",
  );
});
