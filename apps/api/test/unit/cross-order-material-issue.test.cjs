const assert = require("node:assert/strict");
const { test } = require("node:test");
const { Prisma } = require("@prisma/client");
const { RawMaterialMovementsService } = require("../../dist/modules/production/raw-material-movements.service.js");

const user = { id: "1f7d261d-0089-4d32-9aa1-19942c41cb1d", username: "operator", display_name: "操作员" };
const audit = { create: () => ({ createdBy: user.id, updatedBy: user.id }), update: () => ({ updatedBy: user.id }), softDelete: () => ({ deletedAt: new Date(), deletedBy: user.id }), record: async () => {} };
const order = { id: "order-1", orderNo: "SO-001", executionMode: "in_house", status: "in_progress", bomId: "bom-1" };

/** 有仓库模块权限的角色。 */
const warehouseRoles = [{ role: { key: "qita", permissions: [{ moduleKey: "production" }, { moduleKey: "warehouse" }] } }];

function issueHarness({ roles = warehouseRoles } = {}) {
  const created = [];
  const prisma = {
    userRole: { findMany: async () => roles },
    productionOrder: { findFirst: async () => order },
    rawMaterialMovement: { create: async ({ data }) => { created.push(data); return { id: "movement-1", ...data }; } },
  };
  const service = new RawMaterialMovementsService(prisma, audit, {});
  service.previewLines = async () => ({ lines: [{
    material_id: "material-1",
    unit_id: "unit-1",
    quantity: "2",
    bom_reference_quantity: null,
    remark: undefined,
    supplier_id: "supplier-1",
    source_production_order_id: "order-2",
    source_production_order_no: "MO-002",
    source_order_no: "SO-002",
  }] });
  return { service, created };
}

test("跨订单领料：来源生产单写入风险上下文，明细仍只存物料/单位/供应商", async () => {
  const { service, created } = issueHarness();
  await service.createIssue({ production_order_id: "order-1", lines: [{ material_id: "material-1", quantity: "2", source_production_order_id: "order-2", unit_id: "unit-1", supplier_id: "supplier-1" }] }, user);
  assert.equal(created.length, 1);
  // 明细本身不新增列（不能改 schema），来源留在单据风险里。
  assert.equal(created[0].lines.create[0].materialId, "material-1");
  assert.equal(created[0].lines.create[0].unitId, "unit-1");
  assert.equal(created[0].lines.create[0].sourceProductionOrderId, undefined, "明细表没有来源列，不能假装有");
  const risk = created[0].risks.create.find((row) => row.riskType === "CROSS_ORDER_SOURCE");
  assert.ok(risk, "必须写入 CROSS_ORDER_SOURCE 风险留痕");
  assert.equal(risk.context.source_production_order_id, "order-2");
  assert.equal(risk.context.source_production_order_no, "MO-002");
  assert.equal(risk.context.source_order_no, "SO-002");
  assert.equal(risk.context.material_id, "material-1");
  assert.equal(risk.context.quantity, "2");
});

test("跨订单领料：没有仓库模块权限时服务层直接 403（不能只靠前端隐藏）", async () => {
  const { service } = issueHarness({ roles: [{ role: { key: "qita", permissions: [{ moduleKey: "production" }] } }] });
  await assert.rejects(
    () => service.createIssue({ production_order_id: "order-1", lines: [{ material_id: "material-1", quantity: "2", source_production_order_id: "order-2" }] }, user),
    (error) => error.getStatus?.() === 403,
  );
});

test("补料单拒绝跨订单来源：补料只处理坏片/失误补领", async () => {
  const { service } = issueHarness();
  await assert.rejects(
    () => service.createReplenishment({ production_order_id: "order-1", reason: "坏片", lines: [{ material_id: "material-1", quantity: "2", source_production_order_id: "order-2" }] }, user),
    (error) => error.getResponse?.().code === "CROSS_ORDER_SOURCE_NOT_ALLOWED",
  );
});

test("跨订单库存检索：只列其他生产订单已入库未领用的料，并给出可追溯来源", async () => {
  const prisma = {
    productionOrder: {
      findFirst: async () => order,
      findMany: async () => [{ id: "order-2", productionOrderNo: "MO-002", orderNo: "SO-002", bomId: "bom-2" }],
    },
    material: { findMany: async () => [{ id: "material-1", materialCode: "RM-001", name: "伞布", specificationModel: "58cm", color: "藏青", defaultUnitId: "unit-1" }] },
    bomItem: { findMany: async () => [{ bomId: "bom-2", unitId: "unit-1" }] },
    rawMaterialInbound: { findMany: async () => [{ orderNo: "SO-002", unitId: "unit-1", supplierId: "supplier-1", quantity: new Prisma.Decimal("10"), unit: { name: "码" }, supplier: { name: "供应商甲" } }] },
    rawMaterialMovementRisk: { findMany: async () => [] },
    inventoryFact: { findMany: async () => [
      { productionOrderId: null, unitId: "unit-1", supplierId: "supplier-1", quantityDelta: new Prisma.Decimal("10") },
      { productionOrderId: "order-2", unitId: "unit-1", supplierId: "supplier-1", quantityDelta: new Prisma.Decimal("-4") },
    ] },
  };
  const service = new RawMaterialMovementsService(prisma, audit, {});
  const result = await service.searchCrossOrderStock("order-1", "伞布");
  assert.equal(result.items.length, 1, "只应返回来源订单 order-2 的一条候选");
  const item = result.items[0];
  assert.equal(item.material_name, "伞布");
  assert.equal(item.unit_id, "unit-1");
  assert.equal(item.supplier_name, "供应商甲");
  assert.equal(item.source_production_order_id, "order-2");
  assert.equal(item.source_production_order_no, "MO-002");
  assert.equal(item.source_order_no, "SO-002");
  assert.equal(item.source_available_quantity, "6", "来源可用量 = 已入库 10 − 已领 4");
  assert.equal(item.inventory_quantity, "6");
});

test("跨订单库存检索：被其他生产单借走的数量从来源可用量里扣掉，不能反复借同一批料", async () => {
  const borrowRisk = {
    riskType: "CROSS_ORDER_SOURCE",
    context: {
      material_id: "material-1",
      unit_id: "unit-1",
      supplier_id: "supplier-1",
      source_production_order_id: "order-2",
      source_production_order_no: "MO-002",
      source_order_no: "SO-002",
      quantity: "3",
    },
  };
  const prisma = {
    productionOrder: {
      findFirst: async () => order,
      findMany: async () => [{ id: "order-2", productionOrderNo: "MO-002", orderNo: "SO-002", bomId: "bom-2" }],
    },
    material: { findMany: async () => [{ id: "material-1", materialCode: "RM-001", name: "伞布", specificationModel: "58cm", color: "藏青", defaultUnitId: "unit-1" }] },
    bomItem: { findMany: async () => [{ bomId: "bom-2", unitId: "unit-1" }] },
    rawMaterialInbound: { findMany: async () => [{ orderNo: "SO-002", unitId: "unit-1", supplierId: "supplier-1", quantity: new Prisma.Decimal("10"), unit: { name: "码" }, supplier: { name: "供应商甲" } }] },
    rawMaterialMovementRisk: { findMany: async () => [borrowRisk] },
    // 全局：入库 10、来源单自领 4、领用方跨订单领 3 → 物料级结存 3；来源可用量再扣借走的 3 → 3。
    inventoryFact: { findMany: async () => [
      { productionOrderId: null, unitId: "unit-1", supplierId: "supplier-1", quantityDelta: new Prisma.Decimal("10") },
      { productionOrderId: "order-2", unitId: "unit-1", supplierId: "supplier-1", quantityDelta: new Prisma.Decimal("-4") },
      { productionOrderId: "order-1", unitId: "unit-1", supplierId: "supplier-1", quantityDelta: new Prisma.Decimal("-3") },
    ] },
  };
  const service = new RawMaterialMovementsService(prisma, audit, {});
  const result = await service.searchCrossOrderStock("order-1", "伞布");
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].source_available_quantity, "3", "来源可用量 = 入库 10 − 来源自领 4 − 被借走 3");
  assert.equal(result.items[0].inventory_quantity, "3", "物料级结存同样已扣掉借出的 3");
});

test("来源可用量口径：入库 − 来源单已领 − 已被其他单跨订单借走", async () => {
  const prisma = {
    rawMaterialInbound: { aggregate: async () => ({ _sum: { quantity: new Prisma.Decimal("10") } }) },
    inventoryFact: { aggregate: async () => ({ _sum: { quantityDelta: new Prisma.Decimal("-4") } }) },
    rawMaterialMovementRisk: { findMany: async () => [{ context: {
      material_id: "material-1", unit_id: "unit-1", supplier_id: "supplier-1",
      source_production_order_id: "order-2", quantity: "3",
    } }] },
  };
  const service = new RawMaterialMovementsService(prisma, audit, {});
  const available = await service.crossOrderAvailable(prisma, { id: "order-2", orderNo: "SO-002" }, "material-1", "unit-1", "supplier-1");
  assert.equal(available.toString(), "3");
});

test("跨订单领料硬门禁：超过来源订单可用库存直接 422，不能只告警", async () => {
  const prisma = {
    material: { findFirst: async () => ({ id: "material-1", name: "伞布", materialCode: "RM-001", materialType: "raw_material", defaultUnitId: "unit-1" }) },
    productionOrder: { findFirst: async () => ({ id: "order-2", productionOrderNo: "MO-002", orderNo: "SO-002", status: "in_progress", executionMode: "in_house", bomId: null }) },
    unit: { findFirst: async () => ({ id: "unit-1", name: "码" }) },
    bomItem: { findFirst: async () => null },
    rawMaterialInbound: { aggregate: async () => ({ _sum: { quantity: new Prisma.Decimal("5") } }) },
    inventoryFact: { aggregate: async () => ({ _sum: { quantityDelta: new Prisma.Decimal("-1") } }) },
    rawMaterialMovementRisk: { findMany: async () => [] },
  };
  const service = new RawMaterialMovementsService(prisma, audit, {});
  await assert.rejects(
    () => service.previewLines({ id: "order-1", orderNo: "SO-001", bomId: null }, [{
      material_id: "material-1", quantity: "5", supplier_id: "supplier-1", unit_id: "unit-1", source_production_order_id: "order-2",
    }]),
    (error) => {
      const response = error.getResponse?.();
      assert.equal(response?.code, "CROSS_ORDER_SOURCE_INSUFFICIENT");
      assert.equal(response.details[0].available_quantity, "4", "来源可用量 = 入库 5 − 已领 1");
      assert.equal(response.details[0].requested_quantity, "5");
      return true;
    },
  );
});

test("跨订单领料过账：事务内复核仍带来源单位与来源订单，库存事实按来源单位扣减", async () => {
  const sourceContext = {
    material_id: "material-1", unit_id: "unit-other", supplier_id: "supplier-1",
    source_production_order_id: "order-2", source_production_order_no: "MO-002", source_order_no: "SO-002", quantity: "2",
  };
  const current = {
    id: "movement-1", movementNo: "MI-1", documentType: "issue", status: "pending_outbound",
    productionOrderId: "order-1", orderNo: "SO-001", idempotencyKey: "draft:x", reason: null,
    lines: [{ id: "line-1", materialId: "material-1", unitId: "unit-other", supplierId: "supplier-1", quantity: new Prisma.Decimal("2"), remark: null }],
    risks: [{ riskType: "CROSS_ORDER_SOURCE", context: sourceContext }],
  };
  const facts = [];
  const tx = {
    $executeRaw: async () => 0,
    rawMaterialMovement: {
      findFirst: async () => current,
      update: async ({ data }) => ({ ...current, ...data }),
    },
    productionOrder: { findFirst: async () => order },
    inventoryFact: { create: async ({ data }) => { facts.push(data); return data; } },
    rawMaterialMovementRisk: { create: async ({ data }) => data },
  };
  const prisma = {
    userRole: { findMany: async () => warehouseRoles },
    rawMaterialMovement: { findFirst: async () => current },
    productionOrder: { findFirst: async () => order },
    $transaction: async (fn) => fn(tx),
  };
  const service = new RawMaterialMovementsService(prisma, audit, {});
  let lockedLines = null;
  service.previewLines = async (_order, lines) => { lockedLines = lines; return { lines: [] }; };
  await service.postIssue("movement-1", "idem-1", user);
  assert.equal(lockedLines[0].unit_id, "unit-other", "复核必须用来源库存单位，不能回落到默认单位");
  assert.equal(lockedLines[0].source_production_order_id, "order-2");
  assert.equal(facts.length, 1);
  assert.equal(facts[0].unitId, "unit-other");
  assert.equal(facts[0].productionOrderId, "order-1", "库存事实仍归领用方订单，来源可用量靠风险留痕扣减");
});

test("跨订单库存检索：空关键词不查库，直接返回空列表", async () => {
  const prisma = { productionOrder: { findFirst: async () => order } };
  const service = new RawMaterialMovementsService(prisma, audit, {});
  assert.deepEqual(await service.searchCrossOrderStock("order-1", "   "), { items: [] });
});
