const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { test } = require("node:test");
const { PrismaClient } = require("@prisma/client");
const { ProductionOrdersService } = require("../../dist/modules/production/production-orders.service.js");
const { ProductionProgressService } = require("../../dist/modules/production/production-progress.service.js");
const { requireTestDatabaseUrl, testRun } = require("../../../../tests/helpers/test-context.cjs");

test("production.order.creates_from_confirmed_order_and_requires_operations_before_start", async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: requireTestDatabaseUrl() } } });
  const run = testRun("production"); const user = { id: randomUUID(), username: "integration", display_name: "集成测试" }; const audit = { create: () => ({ createdBy: user.id, updatedBy: user.id }), update: () => ({ updatedBy: user.id }), softDelete: () => ({ deletedAt: new Date(), deletedBy: user.id, updatedBy: user.id }), record: () => Promise.resolve() }; let salesId;
  try {
    const unit = await prisma.unit.create({ data: { name: `件-${run.id}`, ...audit.create() } });
    const customer = await prisma.customer.create({ data: { customerCode: `C-${run.id}`, name: `客户-${run.id}`, ...audit.create() } });
    const sales = await prisma.salesOrder.create({ data: { orderNo: run.orderNo, customerId: customer.id, customerSnapshot: {}, orderDate: new Date(), productName: "测试雨伞", quantity: "10", unit: unit.name, currency: "USD", status: "confirmed", ...audit.create() } }); salesId = sales.id;
    const version = await prisma.salesOrderVersion.create({ data: { salesOrderId: sales.id, version: 1, snapshot: {}, ...audit.create() } });
    const bom = await prisma.bom.create({ data: { orderNo: run.orderNo, salesOrderId: sales.id, salesOrderVersionId: version.id, version: 1, status: "published", ...audit.create() } });
    const location = await prisma.productionLocation.create({ data: { name: `车间-${run.id}`, locationType: "workshop", ...audit.create() } });
    const outsourceSite = await prisma.productionLocation.create({ data: { name: `外加工点-${run.id}`, locationType: "outsource_site", ...audit.create() } });
    const operation = await prisma.operationCatalog.create({ data: { operationCode: `OP-${run.id}`, operationName: "缝制", defaultUnitId: unit.id, ...audit.create() } });
    const operation2 = await prisma.operationCatalog.create({ data: { operationCode: `OP2-${run.id}`, operationName: "裁剪", defaultUnitId: unit.id, ...audit.create() } });
    const service = new ProductionOrdersService(prisma, audit);
    const order = await service.create({ order_no: run.orderNo, bom_id: bom.id, bom_version: 1, execution_mode: "in_house", execution_location_id: location.id, planned_quantity: "10", unit_id: unit.id }, user);
    assert.equal(order.orderNo, run.orderNo); assert.equal(order.bomVersion, 1);
    await assert.rejects(() => service.transition(order.id, "in_progress", "启动", user), (error) => error.getResponse().code === "PRODUCTION_OPERATIONS_REQUIRED");
    await service.addOperation(order.id, { operation_id: operation.id, sequence_no: 1, target_quantity: "10" }, user);
    const started = await service.transition(order.id, "in_progress", "启动", user);
    assert.equal(started.status, "in_progress");
    const appended = await service.addOperation(order.id, { operation_id: operation2.id, sequence_no: 2, target_quantity: "10" }, user);
    assert.equal(appended.operationNameSnapshot, "裁剪");
    const outsourced = await service.create({ order_no: run.orderNo, bom_id: bom.id, bom_version: 1, execution_mode: "outsourced", execution_location_id: outsourceSite.id, planned_quantity: "10", unit_id: unit.id }, user);
    const outsourcedOperation = await service.addOperation(outsourced.id, { operation_id: operation.id, sequence_no: 1, target_quantity: "10" }, user);
    assert.equal(outsourcedOperation.operationNameSnapshot, "缝制");
  } finally {
    await prisma.productionOrderOperation.deleteMany({ where: { productionOrder: { orderNo: run.orderNo } } });
    await prisma.productionOrder.deleteMany({ where: { orderNo: run.orderNo } });
    await prisma.operationCatalog.deleteMany({ where: { operationCode: { in: [`OP-${run.id}`, `OP2-${run.id}`] } } });
    await prisma.productionLocation.deleteMany({ where: { name: { in: [`车间-${run.id}`, `外加工点-${run.id}`] } } });
    await prisma.bom.deleteMany({ where: { orderNo: run.orderNo } });
    if (salesId) await prisma.salesOrderVersion.deleteMany({ where: { salesOrderId: salesId } });
    await prisma.salesOrder.deleteMany({ where: { orderNo: run.orderNo } });
    await prisma.customer.deleteMany({ where: { customerCode: `C-${run.id}` } });
    await prisma.unit.deleteMany({ where: { name: `件-${run.id}` } });
    await prisma.$disconnect();
  }
});

test("production.order.operation.target-and-unit.patchable-with-lock-and-validation", async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: requireTestDatabaseUrl() } } });
  const run = testRun("patchop"); const user = { id: randomUUID(), username: "integration", display_name: "集成测试" }; const audit = { create: () => ({ createdBy: user.id, updatedBy: user.id }), update: () => ({ updatedBy: user.id }), softDelete: () => ({ deletedAt: new Date(), deletedBy: user.id, updatedBy: user.id }), record: () => Promise.resolve() }; let salesId;
  try {
    const unit = await prisma.unit.create({ data: { name: `件-${run.id}`, ...audit.create() } });
    const altUnit = await prisma.unit.create({ data: { name: `打-${run.id}`, ...audit.create() } });
    const customer = await prisma.customer.create({ data: { customerCode: `C-${run.id}`, name: `客户-${run.id}`, ...audit.create() } });
    const sales = await prisma.salesOrder.create({ data: { orderNo: run.orderNo, customerId: customer.id, customerSnapshot: {}, orderDate: new Date(), productName: "测试雨伞", quantity: "10", unit: unit.name, currency: "USD", status: "confirmed", ...audit.create() } }); salesId = sales.id;
    const version = await prisma.salesOrderVersion.create({ data: { salesOrderId: sales.id, version: 1, snapshot: {}, ...audit.create() } });
    const bom = await prisma.bom.create({ data: { orderNo: run.orderNo, salesOrderId: sales.id, salesOrderVersionId: version.id, version: 1, status: "published", ...audit.create() } });
    const location = await prisma.productionLocation.create({ data: { name: `车间-${run.id}`, locationType: "workshop", ...audit.create() } });
    const operation = await prisma.operationCatalog.create({ data: { operationCode: `OP-${run.id}`, operationName: "缝制", defaultUnitId: unit.id, ...audit.create() } });
    const progressService = new ProductionProgressService(prisma, audit);
    const service = new ProductionOrdersService(prisma, audit, progressService);
    const order = await service.create({ order_no: run.orderNo, bom_id: bom.id, bom_version: 1, execution_mode: "in_house", execution_location_id: location.id, planned_quantity: "10", unit_id: unit.id }, user);
    const operationRow = await service.addOperation(order.id, { operation_id: operation.id, sequence_no: 1, target_quantity: "10" }, user);

    // Draft order: target + unit editable without a reason.
    const patched = await service.updateOperation(order.id, operationRow.id, { target_quantity: "8", unit_id: altUnit.id }, undefined, user);
    assert.equal(String(patched.targetQuantity), "8");
    assert.equal(patched.unitId, altUnit.id);

    // Invalid target/unit are rejected before any write.
    await assert.rejects(() => service.updateOperation(order.id, operationRow.id, { target_quantity: "0" }, undefined, user), (error) => error.getResponse().code === "INVALID_OPERATION_TARGET");
    await assert.rejects(() => service.updateOperation(order.id, operationRow.id, { unit_id: randomUUID() }, undefined, user), (error) => error.getResponse().code === "UNIT_NOT_FOUND");

    await service.transition(order.id, "in_progress", "启动", user);
    // In production: a missing reason is refused, a supplied reason is accepted.
    await assert.rejects(() => service.updateOperation(order.id, operationRow.id, { target_quantity: "6" }, undefined, user), (error) => error.getResponse().code === "OPERATION_UPDATE_REASON_REQUIRED");
    const reasoned = await service.updateOperation(order.id, operationRow.id, { target_quantity: "6" }, "客户改单下调目标", user);
    assert.equal(String(reasoned.targetQuantity), "6");

    // The progress measurement snapshot was recalculated by the PATCH itself.
    const recalcEvents = await prisma.auditEvent.count({ where: { entityType: "production_progress", entityId: order.id, action: "production_progress.recalculate", details: { path: ["trigger", "source_type"], equals: "production_order_operation" } } });
    assert.ok(recalcEvents >= 2, "target/unit PATCH must recalculate the progress snapshot");

    // Completed orders are frozen for operation edits.
    const reports = [];
    // Reach completion through a fresh active target that matches reported quantity.
    await service.updateOperation(order.id, operationRow.id, { target_quantity: "2" }, "对齐完工口径", user);
    reports.push({ productionOrderId: order.id, productionOrderOperationId: operationRow.id, orderNo: run.orderNo, productionOrderNoSnapshot: order.productionOrderNo, operationNameSnapshot: "缝制", unitId: altUnit.id, reportDate: new Date(), completedQuantity: "2", ...audit.create() });
    await prisma.operationDailyReport.create({ data: reports[0] });
    await service.transition(order.id, "completed", "完工", user);
    await assert.rejects(() => service.updateOperation(order.id, operationRow.id, { target_quantity: "5" }, "冻结校验", user), (error) => error.getResponse().code === "PRODUCTION_OPERATION_NOT_EDITABLE");
  } finally {
    await prisma.auditEvent.deleteMany({ where: { orderNo: run.orderNo } });
    await prisma.operationDailyReport.deleteMany({ where: { orderNo: run.orderNo } });
    await prisma.productionDailyAlert.deleteMany({ where: { orderNo: run.orderNo } });
    await prisma.productionOrderOperation.deleteMany({ where: { productionOrder: { orderNo: run.orderNo } } });
    await prisma.productionOrder.deleteMany({ where: { orderNo: run.orderNo } });
    await prisma.operationCatalog.deleteMany({ where: { operationCode: `OP-${run.id}` } });
    await prisma.productionLocation.deleteMany({ where: { name: `车间-${run.id}` } });
    await prisma.bom.deleteMany({ where: { orderNo: run.orderNo } });
    if (salesId) await prisma.salesOrderVersion.deleteMany({ where: { salesOrderId: salesId } });
    await prisma.salesOrder.deleteMany({ where: { orderNo: run.orderNo } });
    await prisma.customer.deleteMany({ where: { customerCode: `C-${run.id}` } });
    await prisma.unit.deleteMany({ where: { name: { in: [`件-${run.id}`, `打-${run.id}`] } } });
    await prisma.$disconnect();
  }
});
