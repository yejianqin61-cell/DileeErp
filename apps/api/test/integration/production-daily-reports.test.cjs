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
  // 本用例固定使用 2026-08-21（下方薪资来源按 8 月区间断言，不能改成"今天"）。
  // 该日期早于实际运行日，因此工序日报必须声明补录原因，否则服务端按业务规则返回 422 BACKFILL_REASON_REQUIRED。
  const backfillRemark = "集成测试补录历史工序日报";
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

    const first = await operationReports.create({ production_order_id: productionOrder.id, production_order_operation_id: productionOperation.id, report_date: "2026-08-21", completed_quantity: "6", idempotency_key: "d5-operation-key", remark: backfillRemark }, user);
    const duplicate = await operationReports.create({ production_order_id: productionOrder.id, production_order_operation_id: productionOperation.id, report_date: "2026-08-21", completed_quantity: "6", idempotency_key: "d5-operation-key", remark: backfillRemark }, user); assert.equal(duplicate.id, first.id);
    let progress = await operationReports.progress(productionOrder.id); assert.equal(progress.operations[0].status, "over_order"); assert.equal(progress.operations[0].over_order_quantity, "1");
    let d7Progress = await progressService.getProductionOrderProgress(productionOrder.id); assert.equal(d7Progress.status, "blocked"); assert.ok(d7Progress.blockers.includes("over_order_unconfirmed"));
    let dailyAlerts = await alerts.list({ alert_type: "over_order" }); assert.equal(dailyAlerts.length, 1); await alerts.confirm(dailyAlerts[0].id, "已核对超单", user);
    const piece = await employeeReports.create({ production_order_id: productionOrder.id, production_order_operation_id: productionOperation.id, employee_id: employee.id, report_date: "2026-08-21", wage_mode: "piece_rate", quantity: "4", unit_price: "2" }, user); assert.equal(piece.calculatedAmount.toString(), "8");
    // 计时单位统一为小时：1 小时 × 3 元/小时 = 3 元；落库仍为 60 分钟。
    const time = await employeeReports.create({ production_order_id: productionOrder.id, production_order_operation_id: productionOperation.id, employee_id: employee.id, report_date: "2026-08-21", wage_mode: "time_rate", quantity: "0", duration_hours: "1", unit_price: "3" }, user); assert.equal(time.calculatedAmount.toString(), "3"); assert.equal(time.durationMinutes.toString(), "60");
    const concurrentReports = await Promise.all([
      employeeReports.create({ production_order_id: productionOrder.id, production_order_operation_id: productionOperation.id, employee_id: employee.id, report_date: "2026-08-21", wage_mode: "piece_rate", quantity: "1", unit_price: "2" }, user),
      employeeReports.create({ production_order_id: productionOrder.id, production_order_operation_id: productionOperation.id, employee_id: employee.id, report_date: "2026-08-21", wage_mode: "piece_rate", quantity: "1", unit_price: "2" }, user),
    ]);
    assert.equal(concurrentReports.length, 2);
    // 同一员工同一天同一工序允许重复登记：并发两次登记生成两条独立日报（不再合并累加），
    // 但件数汇总仍为 4 + 1 + 1 = 6，与工序日报 6 相等，差异告警应恢复。
    assert.notEqual(concurrentReports[0].id, concurrentReports[1].id);
    dailyAlerts = await alerts.list({ alert_type: "daily_discrepancy" }); assert.equal(dailyAlerts[0].status, "recovered");
    d7Progress = await progressService.getProductionOrderProgress(productionOrder.id); assert.equal(d7Progress.status, "production_completed"); assert.equal(d7Progress.blockers.length, 0); assert.equal(d7Progress.capability_not_implemented.length, 0);
    const sources = await employeeReports.payrollSources({ from: "2026-08-01", to: "2026-08-31" }); assert.equal(sources.length, 2); assert.deepEqual(sources.map((item) => item.amount).sort(), ["12", "3"]);
    // 薪资来源对外同时给出小时口径：60 分钟 => 1 小时。
    assert.equal(sources.find((item) => item.wage_mode === "time_rate").duration_hours, "1");
    const sourceBeforeReentry = await prisma.productionPayrollSource.findFirst({ where: { employeeId: employee.id, productionOrderId: productionOrder.id, wageMode: "piece_rate", deletedAt: null } }); assert.ok(sourceBeforeReentry);
    assert.equal(sourceBeforeReentry.amount.toString(), "12", "4 + 1 + 1 = 6 件 × 2 元");

    // 薪资来源是按 (员工, 生产单, 日期, 计薪方式) 聚合的**活记录**：
    // 删除一条日报后原地重算，而不是删除来源（employee-daily-reports.service.ts:271-295）。
    // 此前这里断言"来源被删成 null"，是按旧的删除-重建模型写的，与现值语义不符。
    await employeeReports.remove(piece.id, "重新登记测试", user);
    const afterRemoval = await prisma.productionPayrollSource.findFirst({ where: { id: sourceBeforeReentry.id, deletedAt: null } });
    assert.ok(afterRemoval, "删除日报后薪资来源应原地重算，而不是被删除");
    assert.equal(afterRemoval.quantity.toString(), "2", "剩余两条各 1 件");
    assert.equal(afterRemoval.amount.toString(), "4", "2 件 × 2 元");
    assert.equal(afterRemoval.sourceSnapshot.length, 2, "快照必须只包含仍然有效的日报");
    assert.ok(!afterRemoval.sourceSnapshot.some((row) => row.id === piece.id), "已删除的日报不得留在快照里");

    const reentered = await employeeReports.create({ production_order_id: productionOrder.id, production_order_operation_id: productionOperation.id, employee_id: employee.id, report_date: "2026-08-21", wage_mode: "piece_rate", quantity: "6", unit_price: "2" }, user);
    assert.equal(reentered.calculatedAmount.toString(), "12");
    const sourceAfterReentry = await prisma.productionPayrollSource.findFirst({ where: { id: sourceBeforeReentry.id, deletedAt: null } });
    assert.ok(sourceAfterReentry, "重新登记必须复用同一聚合来源（唯一键 upsert）");
    assert.equal(sourceAfterReentry.quantity.toString(), "8", "1 + 1 + 6 = 8 件");
    assert.equal(sourceAfterReentry.amount.toString(), "16", "8 件 × 2 元");
    assert.equal(sourceAfterReentry.sourceSnapshot.length, 3, "快照必须包含重新登记后的全部有效日报");
    // 工序日报的同工序同日登记是**合并累加**语义（operation-daily-reports.service.ts:58-61），
    // 不是新建一行：不带幂等键的再次登记会并入当天那条日报，并递增 version。
    // （上面带同一 idempotency_key 的重复提交走的是幂等短路 :54-57，原样返回、不改数量。）
    const extra = await operationReports.create({ production_order_id: productionOrder.id, production_order_operation_id: productionOperation.id, report_date: "2026-08-21", completed_quantity: "1", remark: backfillRemark }, user);
    assert.equal(extra.id, first.id, "同工序同日且无幂等键的登记应合并到当天日报，而不是新建一行");
    assert.equal(extra.completedQuantity.toString(), "7", "6 + 1 = 7");
    assert.equal(extra.version, 2, "合并必须递增 version");
    dailyAlerts = await alerts.list({ alert_type: "over_order" }); assert.equal(dailyAlerts[0].status, "pending");

    // 乐观锁：用当前版本可以更新，用已过期版本必须被拒
    await operationReports.update(first.id, { completed_quantity: "6", reason: "复核日报", expected_version: 2 }, user);
    await assert.rejects(() => operationReports.update(first.id, { completed_quantity: "7", reason: "并发旧版本", expected_version: 2 }, user), (error) => error.getResponse().code === "DAILY_REPORT_VERSION_CONFLICT");

    // 撤回该日报后进度与超单告警同步回落（remove 内部会重算 over_order 与进度快照，:120-122）
    await operationReports.remove(first.id, "撤回误报", user);
    progress = await operationReports.progress(productionOrder.id); assert.equal(progress.operations[0].cumulative_quantity, "0");
    dailyAlerts = await alerts.list({ alert_type: "over_order" }); assert.equal(dailyAlerts[0].status, "recovered");
    assert.equal((await alerts.auditEvents(dailyAlerts[0].id)).length > 0, true);
    assert.equal((await prisma.auditEvent.count({ where: { entityType: "production_progress", entityId: productionOrder.id } })) >= 5, true);
  } finally {
    const orderNo = run.orderNo.replaceAll("'", "''");
    await prisma.productionDailyAlert.deleteMany({ where: { orderNo: run.orderNo } });
    await prisma.productionPayrollSource.deleteMany({ where: { orderNo: run.orderNo } });
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
