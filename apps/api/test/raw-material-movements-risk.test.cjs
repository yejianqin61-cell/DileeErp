const assert = require("node:assert/strict");
const { test } = require("node:test");
const { Prisma } = require("@prisma/client");
const { RawMaterialMovementsService } = require("../dist/modules/production/raw-material-movements.service.js");

const user = { id: "1f7d261d-0089-4d32-9aa1-19942c41cb1d", username: "operator", display_name: "操作员" };
const audit = { create: () => ({ createdBy: user.id, updatedBy: user.id }), update: () => ({ updatedBy: user.id }), record: async () => {} };

// 业务确认“超领或非 BOM 物料必须填写原因”没有必要，已取消该门禁；
// 但风险仍要留痕：RawMaterialMovementRisk.reason 是非空列，须写入占位说明。
test("超领/非BOM领料未填原因也能过账，风险仍留痕", async () => {
  const risks = [];
  const facts = [];
  const movement = { id: "movement-1", movementNo: "MI-1", documentType: "issue", status: "pending_outbound", productionOrderId: "order-1", orderNo: "DL260001", reason: null, lines: [{ id: "line-1", materialId: "material-1", unitId: "unit-1", quantity: new Prisma.Decimal("2"), remark: null }] };
  const tx = {
    $queryRaw: async () => [],
    $executeRaw: async () => 1,
    rawMaterialMovement: { findFirst: async () => movement, update: async () => ({ ...movement, status: "posted" }) },
    inventoryFact: { create: async ({ data }) => { facts.push(data); return data; } },
    rawMaterialMovementRisk: { create: async ({ data }) => { risks.push(data); return data; } }
  };
  const prisma = { $transaction: async (fn) => fn(tx) };
  const service = new RawMaterialMovementsService(prisma, audit, {});
  service.get = async () => movement;
  service.requireInHouseOrder = async () => ({ id: "order-1", orderNo: "DL260001" });
  service.previewLines = async () => ({ lines: [{ id: undefined, material_id: "material-1", available_before: new Prisma.Decimal(10), available_after: new Prisma.Decimal(8), risks: [{ type: "MATERIAL_NOT_IN_BOM_WARNING", context: { material_id: "material-1" } }] }] });

  const posted = await service.postIssue("movement-1", "issue-key-1", user);

  assert.equal(posted.status, "posted");
  assert.equal(facts.length, 1, "库存事实必须照常写入");
  assert.equal(facts[0].quantityDelta, "-2");
  assert.equal(risks.length, 1, "风险仍应留痕");
  assert.equal(risks[0].riskType, "MATERIAL_NOT_IN_BOM_WARNING");
  assert.equal(risks[0].lineId, "line-1");
  assert.match(risks[0].reason, /门禁已取消/, "未填原因时写入占位说明，满足非空列约束");
});

test("填写了原因时风险记录保留人工原因", async () => {
  const risks = [];
  const movement = { id: "movement-2", movementNo: "MI-2", documentType: "issue", status: "pending_outbound", productionOrderId: "order-1", orderNo: "DL260001", reason: "临时替代物料", lines: [{ id: "line-2", materialId: "material-1", unitId: "unit-1", quantity: new Prisma.Decimal("1"), remark: null }] };
  const tx = {
    $queryRaw: async () => [],
    $executeRaw: async () => 1,
    rawMaterialMovement: { findFirst: async () => movement, update: async () => ({ ...movement, status: "posted" }) },
    inventoryFact: { create: async () => ({}) },
    rawMaterialMovementRisk: { create: async ({ data }) => { risks.push(data); return data; } }
  };
  const service = new RawMaterialMovementsService({ $transaction: async (fn) => fn(tx) }, audit, {});
  service.get = async () => movement;
  service.requireInHouseOrder = async () => ({ id: "order-1", orderNo: "DL260001" });
  service.previewLines = async () => ({ lines: [{ id: undefined, material_id: "material-1", available_before: new Prisma.Decimal(10), available_after: new Prisma.Decimal(9), risks: [{ type: "OVER_ISSUE_WARNING", context: {} }] }] });

  await service.postIssue("movement-2", "issue-key-2", user);
  assert.equal(risks[0].reason, "临时替代物料");
});

test("库存不足仍然必须拦截（该门禁保留）", async () => {
  const movement = { id: "movement-3", movementNo: "MI-3", documentType: "issue", status: "pending_outbound", productionOrderId: "order-1", orderNo: "DL260001", reason: null, lines: [{ id: "line-3", materialId: "material-1", unitId: "unit-1", quantity: new Prisma.Decimal("99"), remark: null }] };
  const service = new RawMaterialMovementsService({ $transaction: async () => { throw new Error("must not post"); } }, audit, {});
  service.get = async () => movement;
  service.requireInHouseOrder = async () => ({ id: "order-1", orderNo: "DL260001" });
  service.previewLines = async () => ({ lines: [{ id: undefined, material_id: "material-1", available_before: new Prisma.Decimal(1), available_after: new Prisma.Decimal(-98), risks: [] }] });

  await assert.rejects(() => service.postIssue("movement-3", "issue-key-3", user), (error) => error.getResponse().code === "INSUFFICIENT_INVENTORY");
});
