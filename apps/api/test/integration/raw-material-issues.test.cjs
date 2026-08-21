const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { test } = require("node:test");
const { PrismaClient } = require("@prisma/client");
const { RawMaterialMovementsService } = require("../../dist/modules/production/raw-material-movements.service.js");
const { InventoryService } = require("../../dist/platform/inventory/inventory.service.js");
const { requireTestDatabaseUrl, testRun } = require("../../../../tests/helpers/test-context.cjs");

test("production.issue_posts_inventory_facts_and_preserves_risk_and_idempotency", async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: requireTestDatabaseUrl() } } });
  const run = testRun("material-issue");
  const user = { id: randomUUID(), username: "integration", display_name: "集成测试" };
  const audit = { create: () => ({ createdBy: user.id, updatedBy: user.id }), update: () => ({ updatedBy: user.id }), softDelete: () => ({ deletedAt: new Date(), deletedBy: user.id, updatedBy: user.id }), record: () => Promise.resolve() };
  const inventory = new InventoryService();
  const service = new RawMaterialMovementsService(prisma, audit, inventory);
  try {
    const unit = await prisma.unit.create({ data: { name: `件-${run.id}`, ...audit.create() } });
    const material = await prisma.material.create({ data: { materialCode: `M-${run.id}`, name: `物料-${run.id}`, defaultUnitId: unit.id, ...audit.create() } });
    const extraMaterial = await prisma.material.create({ data: { materialCode: `X-${run.id}`, name: `额外物料-${run.id}`, defaultUnitId: unit.id, ...audit.create() } });
    const customer = await prisma.customer.create({ data: { customerCode: `C-${run.id}`, name: `客户-${run.id}`, ...audit.create() } });
    const salesOrder = await prisma.salesOrder.create({ data: { orderNo: run.orderNo, customerId: customer.id, customerSnapshot: {}, orderDate: new Date(), productName: "测试雨伞", quantity: "10", unit: unit.name, currency: "USD", status: "confirmed", ...audit.create() } });
    const version = await prisma.salesOrderVersion.create({ data: { salesOrderId: salesOrder.id, version: 1, snapshot: {}, ...audit.create() } });
    const bom = await prisma.bom.create({ data: { orderNo: run.orderNo, salesOrderId: salesOrder.id, salesOrderVersionId: version.id, status: "published", ...audit.create() } });
    await prisma.bomItem.create({ data: { bomId: bom.id, materialId: material.id, unitId: unit.id, materialSnapshot: {}, requiredQuantity: "5", unit: unit.name, ...audit.create() } });
    const location = await prisma.productionLocation.create({ data: { name: `车间-${run.id}`, locationType: "workshop", ...audit.create() } });
    const productionOrder = await prisma.productionOrder.create({ data: { productionOrderNo: `MO-${run.id}`, orderNo: run.orderNo, salesOrderId: salesOrder.id, bomId: bom.id, bomVersion: 1, bomSnapshot: {}, executionMode: "in_house", executionLocationId: location.id, plannedQuantity: "10", unitId: unit.id, status: "in_progress", ...audit.create() } });
    await prisma.inventoryFact.create({ data: { materialId: material.id, unitId: unit.id, inventoryCategory: "raw_material", quantityDelta: "10", sourceType: "fixture", sourceId: randomUUID(), orderNo: run.orderNo, createdBy: user.id } });
    await prisma.inventoryFact.create({ data: { materialId: extraMaterial.id, unitId: unit.id, inventoryCategory: "raw_material", quantityDelta: "3", sourceType: "fixture", sourceId: randomUUID(), orderNo: run.orderNo, createdBy: user.id } });

    const issue = await service.createIssue({ production_order_id: productionOrder.id, lines: [{ material_id: material.id, quantity: "4" }] }, user);
    const preview = await service.impactPreview(issue.id);
    assert.equal(preview.lines[0].available_before.toString(), "10");
    assert.equal(preview.lines[0].cumulative_issued_after.toString(), "4");
    await service.postIssue(issue.id, "issue-key-1", user);
    await service.postIssue(issue.id, "issue-key-1", user);
    assert.equal((await inventory.rawMaterialBalance(prisma, material.id, unit.id)).toString(), "6");
    assert.equal(await prisma.inventoryFact.count({ where: { productionOrderId: productionOrder.id, sourceType: "material_issue" } }), 1);

    const insufficient = await service.createIssue({ production_order_id: productionOrder.id, reason: "紧急补料", lines: [{ material_id: material.id, quantity: "7" }] }, user);
    await assert.rejects(() => service.postIssue(insufficient.id, "issue-key-2", user), (error) => error.getResponse().code === "INSUFFICIENT_INVENTORY");
    assert.equal(await prisma.inventoryFact.count({ where: { productionOrderId: productionOrder.id, sourceType: "material_issue" } }), 1);

    const nonBom = await service.createIssue({ production_order_id: productionOrder.id, reason: "临时替代物料", lines: [{ material_id: extraMaterial.id, quantity: "1" }] }, user);
    await service.postIssue(nonBom.id, "issue-key-3", user);
    assert.equal(await prisma.rawMaterialMovementRisk.count({ where: { movementId: nonBom.id, riskType: "MATERIAL_NOT_IN_BOM_WARNING" } }), 1);
  } finally {
    const orderNo = run.orderNo.replaceAll("'", "''");
    await prisma.$executeRawUnsafe(`DELETE FROM inventory_facts WHERE order_no = '${orderNo}'`);
    await prisma.$executeRawUnsafe(`DELETE FROM raw_material_movement_risks WHERE movement_id IN (SELECT id FROM raw_material_movements WHERE order_no = '${orderNo}')`);
    await prisma.$executeRawUnsafe(`DELETE FROM raw_material_movement_lines WHERE movement_id IN (SELECT id FROM raw_material_movements WHERE order_no = '${orderNo}')`);
    await prisma.$executeRawUnsafe(`DELETE FROM raw_material_movements WHERE order_no = '${orderNo}'`);
    await prisma.$executeRawUnsafe(`DELETE FROM production_orders WHERE order_no = '${orderNo}'`);
    await prisma.$executeRawUnsafe(`DELETE FROM production_locations WHERE name = '车间-${run.id}'`);
    await prisma.$executeRawUnsafe(`DELETE FROM bom_items WHERE bom_id IN (SELECT id FROM boms WHERE order_no = '${orderNo}')`);
    await prisma.$executeRawUnsafe(`DELETE FROM boms WHERE order_no = '${orderNo}'`);
    await prisma.$executeRawUnsafe(`DELETE FROM sales_order_versions WHERE sales_order_id IN (SELECT id FROM sales_orders WHERE order_no = '${orderNo}')`);
    await prisma.$executeRawUnsafe(`DELETE FROM sales_orders WHERE order_no = '${orderNo}'`);
    await prisma.customer.deleteMany({ where: { customerCode: `C-${run.id}` } });
    await prisma.material.deleteMany({ where: { materialCode: { in: [`M-${run.id}`, `X-${run.id}`] } } });
    await prisma.unit.deleteMany({ where: { name: `件-${run.id}` } });
    await prisma.$disconnect();
  }
});
