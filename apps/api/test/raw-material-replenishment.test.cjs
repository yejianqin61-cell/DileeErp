const assert = require("node:assert/strict");
const { test } = require("node:test");
const { Prisma } = require("@prisma/client");
const { RawMaterialMovementsService } = require("../dist/modules/production/raw-material-movements.service.js");

const user = { id: "1f7d261d-0089-4d32-9aa1-19942c41cb1d", username: "operator", display_name: "操作员" };
const audit = { create: () => ({ createdBy: user.id, updatedBy: user.id }), update: () => ({ updatedBy: user.id }), record: async () => {} };
const activeOperation = { id: "operation-1", productionOrderId: "order-1", operationNameSnapshot: "裁剪", status: "active" };

// 补料单：坏片/生产失误导致的补充领料，归属“生产单-工序”，同样参与原料出库。
function harness(operation = activeOperation) {
  const created = [];
  const prisma = {
    productionOrder: { findFirst: async () => ({ id: "order-1", orderNo: "DL260001", executionMode: "in_house", status: "in_progress" }) },
    productionOrderOperation: { findFirst: async () => operation },
    rawMaterialMovement: { create: async ({ data }) => { created.push(data); return { id: "replenishment-1", ...data }; } }
  };
  const service = new RawMaterialMovementsService(prisma, audit, {});
  service.previewLines = async () => ({ lines: [{ material_id: "material-1", unit_id: "unit-1", quantity: "8", bom_reference_quantity: "10", remark: undefined }] });
  return { service, created };
}

test("补料单必须填写补料原因", async () => {
  const { service, created } = harness();
  await assert.rejects(
    () => service.createReplenishment({ production_order_id: "order-1", production_order_operation_id: "operation-1", reason: "   ", lines: [{ material_id: "material-1", quantity: "8" }] }, user),
    (error) => error.getResponse().code === "REPLENISHMENT_REASON_REQUIRED"
  );
  assert.equal(created.length, 0, "缺原因时不得写入");
});

test("补料单必须归属到本生产单的工序", async () => {
  const noOperation = harness();
  await assert.rejects(
    () => noOperation.service.createReplenishment({ production_order_id: "order-1", reason: "伞布坏片", lines: [{ material_id: "material-1", quantity: "8" }] }, user),
    (error) => error.getResponse().code === "MATERIAL_ISSUE_OPERATION_REQUIRED"
  );
  const foreign = harness(null);
  await assert.rejects(
    () => foreign.service.createReplenishment({ production_order_id: "order-1", production_order_operation_id: "operation-x", reason: "伞布坏片", lines: [{ material_id: "material-1", quantity: "8" }] }, user),
    (error) => error.getResponse().code === "PRODUCTION_OPERATION_NOT_FOUND"
  );
  const cancelled = harness({ ...activeOperation, status: "cancelled" });
  await assert.rejects(
    () => cancelled.service.createReplenishment({ production_order_id: "order-1", production_order_operation_id: "operation-1", reason: "伞布坏片", lines: [{ material_id: "material-1", quantity: "8" }] }, user),
    (error) => error.getResponse().code === "PRODUCTION_OPERATION_CANCELLED"
  );
});

test("补料单以 MC 前缀编号、类型为 replenishment，并记录原因与工序", async () => {
  const { service, created } = harness();
  await service.createReplenishment({ production_order_id: "order-1", production_order_operation_id: "operation-1", reason: " 伞布原始坏片 ", lines: [{ material_id: "material-1", quantity: "8" }] }, user);
  assert.equal(created.length, 1);
  assert.match(created[0].movementNo, /^MC-/);
  assert.equal(created[0].documentType, "replenishment");
  assert.equal(created[0].productionOrderOperationId, "operation-1");
  assert.equal(created[0].reason, "伞布原始坏片", "原因需去空格后保存");
  assert.equal(created[0].lines.create[0].quantity, "8");
});

// 补料是原料出库：过账写库存事实（负数、sourceType=material_replenishment），并受库存不足拦截。
function postHarness({ availableBefore, quantity = "8" }) {
  const facts = [];
  const risks = [];
  const movement = {
    id: "replenishment-1", movementNo: "MC-20260910-AAAABBBB", documentType: "replenishment", status: "draft",
    productionOrderId: "order-1", orderNo: "DL260001", reason: "伞布坏片",
    lines: [{ id: "line-1", materialId: "material-1", unitId: "unit-1", quantity: new Prisma.Decimal(quantity), remark: null }]
  };
  const tx = {
    $queryRaw: async () => [],
    rawMaterialMovement: { findFirst: async () => movement, update: async () => ({ ...movement, status: "posted" }) },
    inventoryFact: { create: async ({ data }) => { facts.push(data); return data; } },
    rawMaterialMovementRisk: { create: async ({ data }) => { risks.push(data); return data; } }
  };
  const prisma = { $transaction: async (fn) => fn(tx) };
  const service = new RawMaterialMovementsService(prisma, audit, {});
  service.get = async () => movement;
  service.requireInHouseOrder = async () => ({ id: "order-1", orderNo: "DL260001" });
  service.previewLines = async () => ({ lines: [{ id: undefined, material_id: "material-1", available_before: new Prisma.Decimal(availableBefore), available_after: new Prisma.Decimal(availableBefore).minus(quantity), risks: [] }] });
  return { service, facts, risks };
}

test("补料过账写原料出库库存事实（负数、来源 material_replenishment）", async () => {
  const { service, facts } = postHarness({ availableBefore: "20" });
  const posted = await service.postReplenishment("replenishment-1", "replenish-key-1", user);
  assert.equal(posted.status, "posted");
  assert.equal(facts.length, 1);
  assert.equal(facts[0].quantityDelta, "-8");
  assert.equal(facts[0].sourceType, "material_replenishment");
  assert.equal(facts[0].inventoryCategory, "raw_material");
});

test("补料过账同样受库存不足拦截，且不写任何库存事实", async () => {
  const { service, facts } = postHarness({ availableBefore: "3" });
  await assert.rejects(() => service.postReplenishment("replenishment-1", "replenish-key-2", user), (error) => error.getResponse().code === "INSUFFICIENT_INVENTORY");
  assert.equal(facts.length, 0);
});

test("补料过账不接受领料单（类型必须匹配）", async () => {
  const { service } = postHarness({ availableBefore: "20" });
  service.get = async () => ({ id: "movement-1", documentType: "issue", status: "draft", reason: null, lines: [] });
  await assert.rejects(() => service.postReplenishment("movement-1", "replenish-key-3", user), (error) => error.getResponse().code === "INVALID_MATERIAL_MOVEMENT_TYPE");
});

test("幂等：同一幂等键重复过账返回同一单据且只写一次库存事实", async () => {
  const { service, facts } = postHarness({ availableBefore: "20" });
  let current = { id: "replenishment-1", movementNo: "MC-1", documentType: "replenishment", status: "draft", productionOrderId: "order-1", orderNo: "DL260001", reason: "坏片", idempotencyKey: "draft:x", lines: [{ id: "line-1", materialId: "material-1", unitId: "unit-1", quantity: new Prisma.Decimal("8"), remark: null }] };
  service.get = async () => current;
  await service.postReplenishment("replenishment-1", "replenish-key-4", user);
  current = { ...current, status: "posted", idempotencyKey: "replenish-key-4" };
  await service.postReplenishment("replenishment-1", "replenish-key-4", user);
  assert.equal(facts.length, 1, "重复点击不应重复扣库存");
});
