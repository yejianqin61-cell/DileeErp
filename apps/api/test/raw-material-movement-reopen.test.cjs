const assert = require("node:assert/strict");
const { test } = require("node:test");
const { Prisma } = require("@prisma/client");
const { RawMaterialMovementsService } = require("../dist/modules/production/raw-material-movements.service.js");

const user = { id: "1f7d261d-0089-4d32-9aa1-19942c41cb1d", username: "operator", display_name: "操作员" };
const audit = { create: () => ({ createdBy: user.id, updatedBy: user.id }), update: () => ({ updatedBy: user.id }), softDelete: () => ({ deletedAt: new Date(), deletedBy: user.id }), record: async () => {} };

// 回退草稿（过账撤销）：InventoryFact 无软删除列，因此用等额冲抵事实实现，且必须可再次过账。
function harness({ status = "posted", documentType = "issue", derived = 0, facts = [{ materialId: "material-1", unitId: "unit-1", inventoryCategory: "raw_material", quantityDelta: new Prisma.Decimal("-5") }] } = {}) {
  const createdFacts = [];
  const updates = [];
  const movement = {
    id: "movement-1", movementNo: "MI-1", documentType, status, productionOrderId: "order-1", orderNo: "DL260001", remark: null,
    lines: [{ id: "line-1", materialId: "material-1", unitId: "unit-1", quantity: new Prisma.Decimal("5"), bomReferenceQuantity: null, remark: null }]
  };
  const tx = {
    $queryRaw: async () => [],
    rawMaterialMovement: {
      findFirst: async () => movement,
      update: async ({ data }) => { updates.push(data); return { ...movement, ...data }; }
    },
    rawMaterialMovementLine: { count: async () => derived },
    inventoryFact: {
      findMany: async () => facts,
      create: async ({ data }) => { createdFacts.push(data); return data; }
    }
  };
  const prisma = {
    $transaction: async (fn) => fn(tx),
    rawMaterialMovement: { findFirst: async () => movement },
    // reversalPreview 会用到这两个委托（回退前必须先确认没有下游引用）
    rawMaterialMovementLine: { count: async () => derived },
    inventoryFact: { findMany: async () => facts },
    productionOrder: { findFirst: async () => ({ id: "order-1", orderNo: "DL260001", executionMode: "in_house", status: "in_progress" }) }
  };
  const service = new RawMaterialMovementsService(prisma, audit, { rawMaterialBalance: async () => new Prisma.Decimal("100") });
  return { service, createdFacts, updates, movement };
}

test("回退草稿：写入等额冲抵事实并把单据退回草稿", async () => {
  const { service, createdFacts, updates } = harness();
  const result = await service.reopen("movement-1", "数量填错，需要改", user);
  assert.equal(result.status, "draft");
  assert.equal(createdFacts.length, 1, "必须写冲抵事实，否则库存不会回补");
  assert.equal(String(createdFacts[0].quantityDelta), "5", "出库是 -5，冲抵应为 +5");
  assert.equal(createdFacts[0].sourceType, "material_movement_reopen");
  assert.equal(createdFacts[0].sourceId, "movement-1", "冲抵事实要挂回原单，便于追溯");
  assert.equal(updates[0].status, "draft");
  assert.match(updates[0].idempotencyKey, /^draft:/, "回退后必须换成草稿幂等键，才能再次过账");
  assert.match(updates[0].remark, /回退过账：数量填错，需要改/);
});

test("回退草稿必须填原因", async () => {
  const { service, createdFacts } = harness();
  await assert.rejects(() => service.reopen("movement-1", "   ", user), (error) => error.getResponse().code === "REOPEN_REASON_REQUIRED");
  assert.equal(createdFacts.length, 0);
});

test("只有已过账的领料/补料单可以回退草稿", async () => {
  const draft = harness({ status: "draft" });
  await assert.rejects(() => draft.service.reopen("movement-1", "改数量", user), (error) => error.getResponse().code === "INVALID_MATERIAL_MOVEMENT_STATE");
  const reversal = harness({ documentType: "reversal" });
  await assert.rejects(() => reversal.service.reopen("movement-1", "改数量", user), (error) => error.getResponse().code === "INVALID_MATERIAL_MOVEMENT_TYPE");
});

test("已存在下游退料/报废时不允许回退草稿", async () => {
  const { service, createdFacts } = harness({ derived: 1 });
  await assert.rejects(() => service.reopen("movement-1", "改数量", user), (error) => error.getResponse().code === "DOWNSTREAM_RECORD_EXISTS");
  assert.equal(createdFacts.length, 0, "被拦住时不得写任何库存事实");
});

// 冲销按净额取反：经历过“过账→回退→再过账”的单据，逐行取反会重复计算回退时的冲抵事实。
test("冲销按净额取反：过账→回退→再过账后冲销，净库存影响为 0", async () => {
  const createdFacts = [];
  // 事实历史：原始出库 -5、回退冲抵 +5、重新出库 -5 → 净额 -5
  const facts = [
    { materialId: "material-1", unitId: "unit-1", inventoryCategory: "raw_material", quantityDelta: new Prisma.Decimal("-5") },
    { materialId: "material-1", unitId: "unit-1", inventoryCategory: "raw_material", quantityDelta: new Prisma.Decimal("5") },
    { materialId: "material-1", unitId: "unit-1", inventoryCategory: "raw_material", quantityDelta: new Prisma.Decimal("-5") }
  ];
  const movement = {
    id: "movement-1", movementNo: "MI-1", documentType: "issue", status: "posted", productionOrderId: "order-1", orderNo: "DL260001",
    lines: [{ id: "line-1", materialId: "material-1", unitId: "unit-1", quantity: new Prisma.Decimal("5"), bomReferenceQuantity: null }]
  };
  const tx = {
    $queryRaw: async () => [],
    rawMaterialMovement: {
      findFirst: async () => movement,
      create: async ({ data }) => ({ id: "reversal-1", ...data, lines: [{ id: "rv-line-1", materialId: "material-1" }] }),
      update: async () => movement
    },
    rawMaterialMovementLine: { count: async () => 0 },
    inventoryFact: { findMany: async () => facts, create: async ({ data }) => { createdFacts.push(data); return data; } }
  };
  const prisma = {
    $transaction: async (fn) => fn(tx),
    rawMaterialMovement: { findFirst: async () => movement },
    rawMaterialMovementLine: { count: async () => 0 },
    inventoryFact: { findMany: async () => facts }
  };
  const service = new RawMaterialMovementsService(prisma, audit, { rawMaterialBalance: async () => new Prisma.Decimal("100") });
  service.get = async () => movement;

  await service.reverse("movement-1", "整单作废", "reverse-key-1", user);
  assert.equal(createdFacts.length, 1, "同一物料只应产生一条冲销事实（按净额），而不是三条");
  assert.equal(String(createdFacts[0].quantityDelta), "5", "净额 -5 取反后是 +5");
  assert.equal(createdFacts[0].sourceType, "material_movement_reversal");
  assert.equal(createdFacts[0].rawMaterialMovementLineId, "rv-line-1", "冲销事实要挂到冲销单明细上");
});
