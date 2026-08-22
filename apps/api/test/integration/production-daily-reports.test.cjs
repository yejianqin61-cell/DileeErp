const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { test } = require("node:test");
const { PrismaClient } = require("@prisma/client");
const { OperationDailyReportsService } = require("../../dist/modules/production/operation-daily-reports.service.js");
const { EmployeeDailyReportsService } = require("../../dist/modules/production/employee-daily-reports.service.js");
const { ProductionDailyAlertsService } = require("../../dist/modules/production/production-daily-alerts.service.js");
const { ProductionProgressService } = require("../../dist/modules/production/production-progress.service.js");
const { AuditService } = require("../../dist/platform/audit/audit.service.js");
const { requireTestDatabaseUrl, testRun } = require("../../../../tests/helpers/test-context.cjs");

test("production.daily-reports.calculates-progress-payroll-and-alert-lifecycle", async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: requireTestDatabaseUrl() } } });
  const run = testRun("daily"); const user = { id: randomUUID(), username: "d5-integration", display_name: "D5 集成测试" }; const audit = new AuditService(prisma); const fixtureAudit = { createdBy: user.id, updatedBy: user.id }; const date = new Date("2026-08-21T00:00:00.000Z");
  let salesId;
  try {
    const unit = await prisma.unit.create({ data: { name: `件-${run.id}`, ...fixtureAudit } });
    const customer = await prisma.customer.create({ data: { customerCode: `C-${run.id}`, name: `客户-${run.id}`, ...fixtureAudit } });
    const sales = await prisma.salesOrder.create({ data: { orderNo: run.orderNo, customerId: customer.id, customerSnapshot: {}, orderDate: date, productName: "测试雨伞", quantity: "5", unit: unit.name, currency: "USD", status: "confirmed", ...fixtureAudit } }); salesId = sales.id;
    const version = await prisma.salesOrderVersion.create({ data: { salesOrderId: sales.id, version: 1, snapshot: {}, ...fixtureAudit } });
    const bom = await prisma.bom.create({ data: { orderNo: run.orderNo, salesOrderId: sales.id, salesOrderVersionId: version.id, version: 1, status: "published", ...fixtureAudit } });
    const location = await prisma.productionLocation.create({ data: { name: `车间-${run.id}`, locationType: "workshop", ...fixtureAudit } });
    const operation = await prisma.operationCatalog.create({ data: { operationCode: `OP-${run.id}`, operationName: "缝制", defaultUnitId: unit.id, ...fixtureAudit } });
    const department = await prisma.department.create({ data: { code: `D-${run.id}`, name: `车间部-${run.id}`, ...fixtureAudit } });
    const position = await prisma.position.create({ data: { departmentId: department.id, code: `P-${run.id}`, name: `工人-${run.id}`, ...fixtureAudit } });
    const employee = await prisma.employee.create({ data: { employeeNo: `E-${run.id}`, name: "测试员工", departmentId: department.id, positionId: position.id, employeeType: "workshop", employmentStatus: "active", ...fixtureAudit } });
    await prisma.operationRate.createMany({ data: [{ employeeId: employee.id, operationId: operation.id, wageMode: "piece_rate", unitPrice: "2", effectiveFrom: new Date("2026-01-01"), ...fixtureAudit }, { employeeId: employee.id, operationId: operation.id, wageMode: "time_rate", unitPrice: "3", effectiveFrom: new Date("2026-01-01"), ...fixtureAudit }] });
    const productionOrder = await prisma.productionOrder.create({ data: { productionOrderNo: `MO-${run.id}`, orderNo: run.orderNo, salesOrderId: sales.id, bomId: bom.id, bomVersion: 1, bomSnapshot: {}, executionMode: "in_house", executionLocationId: location.id, plannedQuantity: "5", unitId: unit.id, status: "in_progress", ...fixtureAudit } });
    const productionOperation = await prisma.productionOrderOperation.create({ data: { productionOrderId: productionOrder.id, operationCatalogId: operation.id, operationNameSnapshot: operation.operationName, unitId: unit.id, sequenceNo: 1, targetQuantity: "5", ...fixtureAudit } });
    const progressService = new ProductionProgressService(prisma, audit); const operationReports = new OperationDailyReportsService(prisma, audit, progressService); const employeeReports = new EmployeeDailyReportsService(prisma, audit, progressService); const alerts = new ProductionDailyAlertsService(prisma, audit);

    const first = await operationReports.create({ production_order_id: productionOrder.id, production_order_operation_id: productionOperation.id, report_date: "2026-08-21", completed_quantity: "6", idempotency_key: "d5-operation-key" }, user);
    const duplicate = await operationReports.create({ production_order_id: productionOrder.id, production_order_operation_id: productionOperation.id, report_date: "2026-08-21", completed_quantity: "6", idempotency_key: "d5-operation-key" }, user); assert.equal(duplicate.id, first.id);
    let progress = await operationReports.progress(productionOrder.id); assert.equal(progress.operations[0].status, "over_order"); assert.equal(progress.operations[0].over_order_quantity, "1");
    let d7Progress = await progressService.getProductionOrderProgress(productionOrder.id); assert.equal(d7Progress.status, "blocked"); assert.ok(d7Progress.blockers.includes("over_order_unconfirmed"));
    let dailyAlerts = await alerts.list({ alert_type: "over_order" }); assert.equal(dailyAlerts.length, 1); await alerts.confirm(dailyAlerts[0].id, "已核对超单", user);
    const piece = await employeeReports.create({ production_order_id: productionOrder.id, production_order_operation_id: productionOperation.id, employee_id: employee.id, report_date: "2026-08-21", wage_mode: "piece_rate", quantity: "4" }, user); assert.equal(piece.calculatedAmount.toString(), "8");
    const time = await employeeReports.create({ production_order_id: productionOrder.id, production_order_operation_id: productionOperation.id, employee_id: employee.id, report_date: "2026-08-21", wage_mode: "time_rate", quantity: "2", duration_minutes: "60" }, user); assert.equal(time.calculatedAmount.toString(), "180");
    dailyAlerts = await alerts.list({ alert_type: "daily_discrepancy" }); assert.equal(dailyAlerts[0].status, "recovered");
    d7Progress = await progressService.getProductionOrderProgress(productionOrder.id); assert.equal(d7Progress.status, "production_completed"); assert.equal(d7Progress.blockers.length, 0); assert.equal(d7Progress.capability_not_implemented.length, 0);
    const sources = await employeeReports.payrollSources({ from: "2026-08-01", to: "2026-08-31" }); assert.equal(sources.length, 2); assert.deepEqual(sources.map((item) => item.amount).sort(), ["180", "8"]);
    const extra = await operationReports.create({ production_order_id: productionOrder.id, production_order_operation_id: productionOperation.id, report_date: "2026-08-21", completed_quantity: "1" }, user); dailyAlerts = await alerts.list({ alert_type: "over_order" }); assert.equal(dailyAlerts[0].status, "pending");
    await operationReports.update(first.id, { completed_quantity: "6", reason: "复核日报", expected_version: 1 }, user);
    await assert.rejects(() => operationReports.update(first.id, { completed_quantity: "7", reason: "并发旧版本", expected_version: 1 }, user), (error) => error.getResponse().code === "DAILY_REPORT_VERSION_CONFLICT");
    await operationReports.remove(extra.id, "撤回误报", user); progress = await operationReports.progress(productionOrder.id); assert.equal(progress.operations[0].cumulative_quantity, "6");
    assert.equal((await alerts.auditEvents(dailyAlerts[0].id)).length > 0, true);
    assert.equal((await prisma.auditEvent.count({ where: { entityType: "production_progress", entityId: productionOrder.id } })) >= 5, true);
  } finally {
    const orderNo = run.orderNo.replaceAll("'", "''");
    await prisma.productionDailyAlert.deleteMany({ where: { orderNo: run.orderNo } });
    await prisma.employeeDailyReport.deleteMany({ where: { orderNo: run.orderNo } });
    await prisma.operationDailyReport.deleteMany({ where: { orderNo: run.orderNo } });
    await prisma.productionOrderOperation.deleteMany({ where: { productionOrder: { orderNo: run.orderNo } } });
    await prisma.productionOrder.deleteMany({ where: { orderNo: run.orderNo } });
    await prisma.operationRate.deleteMany({ where: { employee: { employeeNo: `E-${run.id}` } } });
    await prisma.employee.deleteMany({ where: { employeeNo: `E-${run.id}` } });
    await prisma.position.deleteMany({ where: { code: `P-${run.id}` } });
    await prisma.department.deleteMany({ where: { code: `D-${run.id}` } });
    await prisma.operationCatalog.deleteMany({ where: { operationCode: `OP-${run.id}` } });
    await prisma.productionLocation.deleteMany({ where: { name: `车间-${run.id}` } });
    await prisma.bom.deleteMany({ where: { orderNo: run.orderNo } });
    if (salesId) await prisma.salesOrderVersion.deleteMany({ where: { salesOrderId: salesId } });
    await prisma.salesOrder.deleteMany({ where: { orderNo: run.orderNo } });
    await prisma.customer.deleteMany({ where: { customerCode: `C-${run.id}` } });
    await prisma.unit.deleteMany({ where: { name: `件-${run.id}` } });
    await prisma.$executeRawUnsafe(`DELETE FROM audit_events WHERE details->>'order_no' = '${orderNo}'`);
    await prisma.$disconnect();
  }
});
