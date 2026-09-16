// 原料出库的「两段式」：生产确认提交 → 仓库确认出库（用户 2026-09-16 要求）。
//
// 起因：此前领料单草稿可以直接过账，过账即写库存事实 —— 也就是**生产单方面扣掉了仓库的库存**，
// 仓库连一张单都没看到。现在草稿只能「确认提交」到 `pending_outbound`（待仓库出库），
// 只有仓库那一步（`post`）才真正写原料出库事实。
//
// 这一组断言守的就是这条边界：提交不动库存、出库只认待出库状态、撤回不需要冲抵事实。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { Prisma } = require("@prisma/client");
const { RawMaterialMovementsService } = require("../dist/modules/production/raw-material-movements.service.js");

const user = { id: "1f7d261d-0089-4d32-9aa1-19942c41cb1d", username: "operator" };
const audit = { create: () => ({ createdBy: user.id, updatedBy: user.id }), update: () => ({ updatedBy: user.id }), softDelete: () => ({ deletedAt: new Date(), deletedBy: user.id }), record: async () => {} };

const line = (id, quantity) => ({ id, materialId: "material-1", unitId: "unit-1", quantity: new Prisma.Decimal(quantity), remark: null });

function movementRow(overrides = {}) {
  return {
    id: "movement-1", movementNo: "MI-1", documentType: "issue", status: "draft",
    productionOrderId: "order-1", orderNo: "DL260001", reason: null, remark: null,
    submittedAt: null, lines: [line("line-1", "2")],
    ...overrides,
  };
}

/** 提交/撤回的替身：事务内外都返回同一张单，并记录状态写入。 */
function submitHarness({ movement = movementRow(), availableAfter = "8" } = {}) {
  const updates = [];
  const audits = [];
  const facts = [];
  const tx = {
    $queryRaw: async () => [],
    $executeRaw: async () => 1,
    rawMaterialMovement: {
      findFirst: async () => movement,
      update: async ({ where, data }) => { updates.push({ where, data }); return { ...movement, ...data }; },
    },
    inventoryFact: { create: async ({ data }) => { facts.push(data); return data; } },
  };
  const prisma = { $transaction: async (fn) => fn(tx), inventoryFact: { aggregate: async () => ({ _sum: { quantityDelta: new Prisma.Decimal("0") } }) } };
  const service = new RawMaterialMovementsService(prisma, audit, { rawMaterialBalance: async () => new Prisma.Decimal("10") });
  service.get = async () => movement;
  service.requireInHouseOrder = async () => ({ id: "order-1", orderNo: "DL260001" });
  service.previewLines = async () => ({ lines: [{ id: undefined, material_id: "material-1", available_before: new Prisma.Decimal("10"), available_after: new Prisma.Decimal(availableAfter), risks: [] }] });
  service.audit = { ...audit, record: async (...args) => audits.push(args) };
  return { service, updates, audits, facts };
}

test("确认提交：草稿 → 待仓库出库，写入提交时间，且**不写任何库存事实**", async () => {
  const { service, updates, audits, facts } = submitHarness();
  const submitted = await service.submitOutbound("movement-1", user);
  assert.equal(submitted.status, "pending_outbound");
  assert.equal(updates.length, 1);
  assert.equal(updates[0].data.status, "pending_outbound");
  assert.ok(updates[0].data.submittedAt instanceof Date, "待出库通知要显示「什么时候交过来的」，必须记提交时间");
  assert.equal(facts.length, 0, "提交不动库存：真正出库是仓库那一步");
  assert.equal(audits[0][0], "raw_material_movement.submit");
});

test("确认提交：库存不够时当场拒绝（不让生产白等仓库驳回）", async () => {
  const { service, updates } = submitHarness({ availableAfter: "-1" });
  await assert.rejects(
    () => service.submitOutbound("movement-1", user),
    (error) => error.getResponse().code === "INSUFFICIENT_INVENTORY",
  );
  assert.deepEqual(updates, [], "被拒绝时不得改状态");
});

test("确认提交：只有草稿可以提交（重复提交/已过账都不行）", async () => {
  for (const status of ["pending_outbound", "posted", "reversed"]) {
    const { service } = submitHarness({ movement: movementRow({ status }) });
    await assert.rejects(
      () => service.submitOutbound("movement-1", user),
      (error) => error.getResponse().code === "INVALID_MATERIAL_MOVEMENT_STATE",
      `状态 ${status} 不能被再次提交`,
    );
  }
});

test("确认提交：退料单/报废单不走仓库出库（没有库存需要出）", async () => {
  const { service } = submitHarness({ movement: movementRow({ documentType: "return" }) });
  await assert.rejects(
    () => service.submitOutbound("movement-1", user),
    (error) => error.getResponse().code === "INVALID_MATERIAL_MOVEMENT_TYPE",
  );
});

test("出库：草稿直接被拒，错误信息指向「先确认提交」", async () => {
  const { service } = submitHarness({ movement: movementRow({ status: "draft" }) });
  await assert.rejects(
    () => service.postIssue("movement-1", "key-1", user),
    (error) => error.getResponse().code === "INVALID_MATERIAL_MOVEMENT_STATE" && /确认提交/.test(error.getResponse().message),
  );
});

test("出库：待仓库出库状态才会真正写原料出库事实", async () => {
  const { service, facts } = submitHarness({ movement: movementRow({ status: "pending_outbound" }) });
  service.previewLines = async () => ({ lines: [{ id: undefined, material_id: "material-1", available_before: new Prisma.Decimal("10"), available_after: new Prisma.Decimal("8"), risks: [] }] });
  const posted = await service.postIssue("movement-1", "key-1", user);
  assert.equal(posted.status, "posted");
  assert.equal(facts.length, 1, "出库这一步才写库存事实");
  assert.equal(facts[0].quantityDelta, "-2");
  assert.equal(facts[0].sourceType, "material_issue");
});

test("撤回提交：待仓库出库 → 草稿，不写冲抵事实（还没有任何库存事实）", async () => {
  const { service, updates, facts, audits } = submitHarness({ movement: movementRow({ status: "pending_outbound", submittedAt: new Date(), remark: null }) });
  const withdrawn = await service.reopen("movement-1", "数量填错了", user);
  assert.equal(withdrawn.status, "draft");
  assert.equal(updates[0].data.submittedAt, null, "撤回后提交时间要清掉，否则仓库页还会显示它交过");
  assert.match(updates[0].data.remark, /撤回提交：数量填错了/);
  assert.equal(facts.length, 0, "没有库存事实可冲抵");
  assert.equal(audits[0][0], "raw_material_movement.withdraw");
});

test("撤回提交：必须填原因", async () => {
  const { service } = submitHarness({ movement: movementRow({ status: "pending_outbound" }) });
  await assert.rejects(
    () => service.reopen("movement-1", "  ", user),
    (error) => error.getResponse().code === "REOPEN_REASON_REQUIRED",
  );
});

test("撤回提交：已经被仓库出库时不再撤回（避免两个入口同时改同一张单）", async () => {
  const { service } = submitHarness({ movement: movementRow({ status: "pending_outbound" }) });
  // 事务内读到的已经是 posted（仓库刚点过确认出库）
  service.prisma.$transaction = async (fn) => fn({ $queryRaw: async () => [], rawMaterialMovement: { findFirst: async () => null, update: async () => { throw new Error("must not write"); } } });
  await assert.rejects(
    () => service.reopen("movement-1", "撤回", user),
    (error) => error.getResponse().code === "MATERIAL_MOVEMENT_NOT_PENDING",
  );
});

test("待出库通知清单：只列待出库的领料/补料单，按提交时间正序（仓库按先来后到处理）", async () => {
  let captured = null;
  const prisma = { rawMaterialMovement: { findMany: async (args) => { captured = args; return []; } } };
  await new RawMaterialMovementsService(prisma, audit, {}).pendingOutbound();
  assert.equal(captured.where.status, "pending_outbound");
  assert.equal(captured.where.deletedAt, null);
  assert.deepEqual(captured.where.documentType, { in: ["issue", "replenishment"] }, "退料/报废/冲销单不进待出库通知");
  assert.deepEqual(captured.orderBy, [{ submittedAt: "asc" }, { createdAt: "asc" }]);
  assert.deepEqual(captured.include.productionOrder.select, { productionOrderNo: true, orderNo: true });
  assert.deepEqual(captured.include.lines.where, { deletedAt: null }, "明细要过滤软删除行，否则编辑过的单会重复显示物料");
});
