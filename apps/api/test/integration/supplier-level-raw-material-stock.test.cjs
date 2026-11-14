// 原料库存按供应商分桶的集成测试。
//
// 用例覆盖设计文档 docs/design/2026-11-13-supplier-level-raw-material-stock.md §10：
//   1. 同物料两供应商分别入库→领料分行→各自扣减→总余额不变（供应商级核算）。
//   2. 伞头贴纸场景（defaultUnit=个、库存记在张、BOM 行=张）不再报库存不足：
//      领料时按 BOM 行单位（张）取余额，可用量恒为 0 的隐式 bug 被消除。
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { test } = require("node:test");
const { PrismaClient } = require("@prisma/client");
const { RawMaterialMovementsService } = require("../../dist/modules/production/raw-material-movements.service.js");
const { InventoryService } = require("../../dist/platform/inventory/inventory.service.js");
const { AuditService } = require("../../dist/platform/audit/audit.service.js");
const { requireTestDatabaseUrl, testRun } = require("../../../../tests/helpers/test-context.cjs");

test("production.issue_supplier_level_stock_separate_suppliers", async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: requireTestDatabaseUrl() } } });
  const run = testRun("supplier-stock");
  const user = { id: randomUUID(), username: "integration", display_name: "集成测试" };
  const audit = new AuditService(prisma);
  const fixtureAudit = { create: () => ({ createdBy: user.id, updatedBy: user.id }) };
  const inventory = new InventoryService();
  const service = new RawMaterialMovementsService(prisma, audit, inventory);
  try {
    const unit = await prisma.unit.create({ data: { name: `张-${run.id}`, ...fixtureAudit.create() } });
    const supplierA = await prisma.supplier.create({ data: { supplierCode: `SUP-A-${run.id}`, name: `供应商A-${run.id}`, ...fixtureAudit.create() } });
    const supplierB = await prisma.supplier.create({ data: { supplierCode: `SUP-B-${run.id}`, name: `供应商B-${run.id}`, ...fixtureAudit.create() } });
    const material = await prisma.material.create({ data: { materialCode: `MAT-${run.id}`, name: `测试原料-${run.id}`, defaultUnitId: unit.id, ...fixtureAudit.create() } });
    const customer = await prisma.customer.create({ data: { customerCode: `C-${run.id}`, name: `客户-${run.id}`, ...fixtureAudit.create() } });
    const salesOrder = await prisma.salesOrder.create({ data: { orderNo: run.orderNo, customerId: customer.id, customerSnapshot: {}, orderDate: new Date(), productName: "测试雨伞", quantity: "10", unit: unit.name, currency: "USD", status: "confirmed", ...fixtureAudit.create() } });
    const version = await prisma.salesOrderVersion.create({ data: { salesOrderId: salesOrder.id, version: 1, snapshot: {}, ...fixtureAudit.create() } });
    const bom = await prisma.bom.create({ data: { orderNo: run.orderNo, salesOrderId: salesOrder.id, salesOrderVersionId: version.id, status: "published", ...fixtureAudit.create() } });
    await prisma.bomItem.create({ data: { bomId: bom.id, materialId: material.id, materialName: material.name, unitId: unit.id, materialSnapshot: {}, requiredQuantity: "50", unit: unit.name, supplierId: supplierA.id, supplierSnapshot: { id: supplierA.id, supplierCode: supplierA.supplierCode, name: supplierA.name }, ...fixtureAudit.create() } });
    await prisma.bomItem.create({ data: { bomId: bom.id, materialId: material.id, materialName: material.name, unitId: unit.id, materialSnapshot: {}, requiredQuantity: "50", unit: unit.name, supplierId: supplierB.id, supplierSnapshot: { id: supplierB.id, supplierCode: supplierB.supplierCode, name: supplierB.name }, ...fixtureAudit.create() } });
    const location = await prisma.productionLocation.create({ data: { name: `车间-${run.id}`, locationType: "workshop", ...fixtureAudit.create() } });
    const productionOrder = await prisma.productionOrder.create({ data: { productionOrderNo: `MO-${run.id}`, orderNo: run.orderNo, salesOrderId: salesOrder.id, bomId: bom.id, bomVersion: 1, bomSnapshot: {}, executionMode: "in_house", executionLocationId: location.id, plannedQuantity: "100", unitId: unit.id, status: "in_progress", ...fixtureAudit.create() } });

    await prisma.inventoryFact.create({ data: { materialId: material.id, unitId: unit.id, supplierId: supplierA.id, inventoryCategory: "raw_material", quantityDelta: "100", sourceType: "raw_material_inbound", sourceId: randomUUID(), orderNo: run.orderNo, createdBy: user.id } });
    await prisma.inventoryFact.create({ data: { materialId: material.id, unitId: unit.id, supplierId: supplierB.id, inventoryCategory: "raw_material", quantityDelta: "200", sourceType: "raw_material_inbound", sourceId: randomUUID(), orderNo: run.orderNo, createdBy: user.id } });

    const preview = await service.preview({ production_order_id: productionOrder.id, lines: [
      { material_id: material.id, quantity: "60", supplier_id: supplierA.id },
      { material_id: material.id, quantity: "100", supplier_id: supplierB.id },
    ] });
    assert.equal(preview.lines[0].available_before.toString(), "100");
    assert.equal(preview.lines[1].available_before.toString(), "200");
    assert.equal(preview.lines[0].available_after.toString(), "40");
    assert.equal(preview.lines[1].available_after.toString(), "100");
    assert.equal(preview.lines[0].available_by_supplier.length, 2);

    const issue = await service.createIssue({ production_order_id: productionOrder.id, lines: [
      { material_id: material.id, quantity: "60", supplier_id: supplierA.id },
      { material_id: material.id, quantity: "100", supplier_id: supplierB.id },
    ] }, user);
    assert.equal(issue.lines.length, 2);

    await service.submitOutbound(issue.id, user);
    await service.postIssue(issue.id, `issue-key-${run.id}`, user);
    const balanceA = await inventory.rawMaterialBalanceBySupplier(prisma, material.id, unit.id, supplierA.id);
    const balanceB = await inventory.rawMaterialBalanceBySupplier(prisma, material.id, unit.id, supplierB.id);
    assert.equal(balanceA.toString(), "40");
    assert.equal(balanceB.toString(), "100");
    const facts = await prisma.inventoryFact.findMany({ where: { productionOrderId: productionOrder.id, sourceType: "material_issue" } });
    assert.equal(facts.length, 2);
    assert.equal(facts.find((f) => f.supplierId === supplierA.id).quantityDelta.toString(), "-60");
    assert.equal(facts.find((f) => f.supplierId === supplierB.id).quantityDelta.toString(), "-100");

    await assert.rejects(() => service.createIssue({ production_order_id: productionOrder.id, lines: [
      { material_id: material.id, quantity: "10", supplier_id: supplierA.id },
      { material_id: material.id, quantity: "10", supplier_id: supplierA.id },
    ] }, user), (error) => error.getResponse().code === "INVALID_MATERIAL_MOVEMENT_LINE");
  } finally {
    const orderNo = run.orderNo.replaceAll("'", "''");
    await prisma.$executeRawUnsafe(`DELETE FROM inventory_facts WHERE order_no = '${orderNo}'`);
    await prisma.$executeRawUnsafe(`DELETE FROM raw_material_movement_risks WHERE movement_id IN (SELECT id FROM raw_material_movements WHERE order_no = '${orderNo}')`);
    await prisma.$executeRawUnsafe(`DELETE FROM raw_material_movement_lines WHERE movement_id IN (SELECT id FROM raw_material_movements WHERE order_no = '${orderNo}')`);
    await prisma.$executeRawUnsafe(`DELETE FROM raw_material_movements WHERE order_no = '${orderNo}'`);
    await prisma.$executeRawUnsafe(`DELETE FROM audit_events WHERE entity_id IN (SELECT id FROM raw_material_movements WHERE order_no = '${orderNo}') OR details->>'order_no' = '${orderNo}'`);
    await prisma.$executeRawUnsafe(`DELETE FROM production_orders WHERE order_no = '${orderNo}'`);
    await prisma.$executeRawUnsafe(`DELETE FROM production_locations WHERE name = '车间-${run.id}'`);
    await prisma.$executeRawUnsafe(`DELETE FROM bom_items WHERE bom_id IN (SELECT id FROM boms WHERE order_no = '${orderNo}')`);
    await prisma.$executeRawUnsafe(`DELETE FROM boms WHERE order_no = '${orderNo}'`);
    await prisma.$executeRawUnsafe(`DELETE FROM sales_order_versions WHERE sales_order_id IN (SELECT id FROM sales_orders WHERE order_no = '${orderNo}')`);
    await prisma.$executeRawUnsafe(`DELETE FROM sales_orders WHERE order_no = '${orderNo}'`);
    await prisma.customer.deleteMany({ where: { customerCode: `C-${run.id}` } });
    await prisma.material.deleteMany({ where: { materialCode: `MAT-${run.id}` } });
    await prisma.supplier.deleteMany({ where: { supplierCode: { in: [`SUP-A-${run.id}`, `SUP-B-${run.id}`] } } });
    await prisma.unit.deleteMany({ where: { name: `张-${run.id}` } });
    await prisma.$disconnect();
  }
});

test("production.issue_umbrella_head_sticker_no_insufficient_inventory", async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: requireTestDatabaseUrl() } } });
  const run = testRun("sticker");
  const user = { id: randomUUID(), username: "integration", display_name: "集成测试" };
  const audit = new AuditService(prisma);
  const fixtureAudit = { create: () => ({ createdBy: user.id, updatedBy: user.id }) };
  const inventory = new InventoryService();
  const service = new RawMaterialMovementsService(prisma, audit, inventory);
  try {
    const unitPiece = await prisma.unit.create({ data: { name: `个-${run.id}`, ...fixtureAudit.create() } });
    const unitSheet = await prisma.unit.create({ data: { name: `张-${run.id}`, ...fixtureAudit.create() } });
    const supplier = await prisma.supplier.create({ data: { supplierCode: `SUP-S-${run.id}`, name: `供应商S-${run.id}`, ...fixtureAudit.create() } });
    const material = await prisma.material.create({ data: { materialCode: `MAT-${run.id}`, name: `伞头贴纸-${run.id}`, defaultUnitId: unitPiece.id, ...fixtureAudit.create() } });
    const customer = await prisma.customer.create({ data: { customerCode: `C-${run.id}`, name: `客户-${run.id}`, ...fixtureAudit.create() } });
    const salesOrder = await prisma.salesOrder.create({ data: { orderNo: run.orderNo, customerId: customer.id, customerSnapshot: {}, orderDate: new Date(), productName: "测试雨伞", quantity: "10", unit: unitSheet.name, currency: "USD", status: "confirmed", ...fixtureAudit.create() } });
    const version = await prisma.salesOrderVersion.create({ data: { salesOrderId: salesOrder.id, version: 1, snapshot: {}, ...fixtureAudit.create() } });
    const bom = await prisma.bom.create({ data: { orderNo: run.orderNo, salesOrderId: salesOrder.id, salesOrderVersionId: version.id, status: "published", ...fixtureAudit.create() } });
    await prisma.bomItem.create({ data: { bomId: bom.id, materialId: material.id, materialName: material.name, unitId: unitSheet.id, materialSnapshot: {}, requiredQuantity: "36000", unit: unitSheet.name, supplierId: supplier.id, supplierSnapshot: { id: supplier.id, supplierCode: supplier.supplierCode, name: supplier.name }, ...fixtureAudit.create() } });
    const location = await prisma.productionLocation.create({ data: { name: `车间-${run.id}`, locationType: "workshop", ...fixtureAudit.create() } });
    const productionOrder = await prisma.productionOrder.create({ data: { productionOrderNo: `MO-${run.id}`, orderNo: run.orderNo, salesOrderId: salesOrder.id, bomId: bom.id, bomVersion: 1, bomSnapshot: {}, executionMode: "in_house", executionLocationId: location.id, plannedQuantity: "100", unitId: unitSheet.id, status: "in_progress", ...fixtureAudit.create() } });

    await prisma.inventoryFact.create({ data: { materialId: material.id, unitId: unitSheet.id, supplierId: supplier.id, inventoryCategory: "raw_material", quantityDelta: "36000", sourceType: "raw_material_inbound", sourceId: randomUUID(), orderNo: run.orderNo, createdBy: user.id } });

    const preview = await service.preview({ production_order_id: productionOrder.id, lines: [
      { material_id: material.id, quantity: "36000", supplier_id: supplier.id },
    ] });
    assert.equal(preview.lines[0].unit_id, unitSheet.id);
    assert.equal(preview.lines[0].available_before.toString(), "36000");
    assert.equal(preview.lines[0].available_after.toString(), "0");

    const issue = await service.createIssue({ production_order_id: productionOrder.id, lines: [
      { material_id: material.id, quantity: "36000", supplier_id: supplier.id },
    ] }, user);
    await service.submitOutbound(issue.id, user);
    await service.postIssue(issue.id, `issue-key-${run.id}`, user);
    const balance = await inventory.rawMaterialBalanceBySupplier(prisma, material.id, unitSheet.id, supplier.id);
    assert.equal(balance.toString(), "0");
  } finally {
    const orderNo = run.orderNo.replaceAll("'", "''");
    await prisma.$executeRawUnsafe(`DELETE FROM inventory_facts WHERE order_no = '${orderNo}'`);
    await prisma.$executeRawUnsafe(`DELETE FROM raw_material_movement_risks WHERE movement_id IN (SELECT id FROM raw_material_movements WHERE order_no = '${orderNo}')`);
    await prisma.$executeRawUnsafe(`DELETE FROM raw_material_movement_lines WHERE movement_id IN (SELECT id FROM raw_material_movements WHERE order_no = '${orderNo}')`);
    await prisma.$executeRawUnsafe(`DELETE FROM raw_material_movements WHERE order_no = '${orderNo}'`);
    await prisma.$executeRawUnsafe(`DELETE FROM audit_events WHERE entity_id IN (SELECT id FROM raw_material_movements WHERE order_no = '${orderNo}') OR details->>'order_no' = '${orderNo}'`);
    await prisma.$executeRawUnsafe(`DELETE FROM production_orders WHERE order_no = '${orderNo}'`);
    await prisma.$executeRawUnsafe(`DELETE FROM production_locations WHERE name = '车间-${run.id}'`);
    await prisma.$executeRawUnsafe(`DELETE FROM bom_items WHERE bom_id IN (SELECT id FROM boms WHERE order_no = '${orderNo}')`);
    await prisma.$executeRawUnsafe(`DELETE FROM boms WHERE order_no = '${orderNo}'`);
    await prisma.$executeRawUnsafe(`DELETE FROM sales_order_versions WHERE sales_order_id IN (SELECT id FROM sales_orders WHERE order_no = '${orderNo}')`);
    await prisma.$executeRawUnsafe(`DELETE FROM sales_orders WHERE order_no = '${orderNo}'`);
    await prisma.customer.deleteMany({ where: { customerCode: `C-${run.id}` } });
    await prisma.material.deleteMany({ where: { materialCode: `MAT-${run.id}` } });
    await prisma.supplier.deleteMany({ where: { supplierCode: `SUP-S-${run.id}` } });
    await prisma.unit.deleteMany({ where: { name: { in: [`个-${run.id}`, `张-${run.id}`] } } });
    await prisma.$disconnect();
  }
});
