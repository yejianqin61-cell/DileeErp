// 领料/补料过账的 advisory lock 回归测试。
//
// 线上故障：postOutbound 用 `tx.$queryRaw` 执行 `SELECT pg_advisory_xact_lock(...)`。
// 该函数返回 void，Prisma 无法反序列化该列，于是**每次过账都抛**
// "Failed to deserialize column of type 'void'"，表现为仓库页「过账」和
// 编辑页「保存并出库」都是 500 服务器内部错误。
//
// 本测试把 $queryRaw 模拟成真实 Prisma 的报错行为、$executeRaw 模拟成正常返回：
// 只要代码回退到 $queryRaw，这里就会失败。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { Prisma } = require("@prisma/client");
const { RawMaterialMovementsService } = require("../dist/modules/production/raw-material-movements.service.js");

const user = { id: "1f7d261d-0089-4d32-9aa1-19942c41cb1d", username: "operator" };
const audit = { create: () => ({ createdBy: user.id, updatedBy: user.id }), update: () => ({ updatedBy: user.id }), softDelete: () => ({ deletedAt: new Date(), deletedBy: user.id }), record: async () => {} };
const VOID_ERROR = "Failed to deserialize column of type 'void'. If you're using $queryRaw and this column is explicitly marked as `Unsupported`";

function harness({ status = "draft", documentType = "issue" } = {}) {
  const executeRawCalls = [];
  const createdFacts = [];
  const movement = {
    id: "movement-1", movementNo: "MI-1", documentType, status, productionOrderId: "order-1", orderNo: "DL260001",
    remark: null, reason: null, idempotencyKey: null,
    lines: [{ id: "line-1", materialId: "material-1", unitId: "unit-1", quantity: new Prisma.Decimal("5"), bomReferenceQuantity: null, remark: null, material: { name: "原料A" }, unit: { name: "个" }, risks: [] }],
    productionOrder: { id: "order-1", orderNo: "DL260001", executionMode: "in_house", status: "in_progress" },
    risks: [],
  };
  const order = { id: "order-1", orderNo: "DL260001", executionMode: "in_house", status: "in_progress", bomId: "bom-1", bom: { id: "bom-1" }, executionLocation: null };
  const tx = {
    // 真实 Prisma 对 pg_advisory_xact_lock（返回 void）就是这种失败
    $queryRaw: async () => { throw new Error(VOID_ERROR); },
    $executeRaw: async () => { executeRawCalls.push("lock"); return 1; },
    rawMaterialMovement: { findFirst: async () => movement, update: async ({ data }) => ({ ...movement, ...data }) },
    rawMaterialMovementRisk: { create: async () => ({}) },
    inventoryFact: { create: async ({ data }) => { createdFacts.push(data); return data; }, aggregate: async () => ({ _sum: { quantityDelta: new Prisma.Decimal("0") } }) },
    material: { findFirst: async () => ({ id: "material-1", name: "原料A", materialCode: "MAT-1", defaultUnitId: "unit-1", materialType: "raw_material", isActive: true }) },
    bomItem: { findFirst: async () => ({ requiredQuantity: new Prisma.Decimal("10"), approvedUsage: null, specificationModel: null, model: null, color: null, unit: "个" }) },
    purchaseOrderItem: { aggregate: async () => ({ _sum: { quantity: new Prisma.Decimal("0") } }) },
    rawMaterialInbound: { aggregate: async () => ({ _sum: { quantity: new Prisma.Decimal("0") } }) },
    productionOrder: { findFirst: async () => order },
  };
  // previewLines 在事务外也会用 this.prisma 查物料/BOM，所以这些委托两边都要有。
  const prisma = {
    $transaction: async (fn) => fn(tx),
    rawMaterialMovement: { findFirst: async () => movement },
    productionOrder: { findFirst: async () => order },
    material: tx.material,
    bomItem: tx.bomItem,
    purchaseOrderItem: tx.purchaseOrderItem,
    rawMaterialInbound: tx.rawMaterialInbound,
    inventoryFact: tx.inventoryFact,
  };
  const service = new RawMaterialMovementsService(prisma, audit, { rawMaterialBalance: async () => new Prisma.Decimal("100") });
  return { service, executeRawCalls, createdFacts };
}

test("领料单过账用 $executeRaw 取 advisory lock，不再 500", async () => {
  const { service, executeRawCalls, createdFacts } = harness();
  const posted = await service.postIssue("movement-1", "key-1", user);
  assert.equal(posted.status, "posted");
  assert.deepEqual(executeRawCalls, ["lock"], "必须用 $executeRaw 执行 pg_advisory_xact_lock");
  assert.equal(createdFacts.length, 1, "过账必须写入原料出库事实");
  assert.equal(createdFacts[0].quantityDelta, "-5");
});

test("补料单过账同样走 $executeRaw", async () => {
  const { service, executeRawCalls } = harness({ documentType: "replenishment" });
  const posted = await service.postReplenishment("movement-1", "key-2", user);
  assert.equal(posted.status, "posted");
  assert.equal(executeRawCalls.length, 1);
});
