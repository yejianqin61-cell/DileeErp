const assert = require("node:assert/strict");
const { test } = require("node:test");
const { Prisma } = require("@prisma/client");
const { RawMaterialMovementsService } = require("../dist/modules/production/raw-material-movements.service.js");

const user = { id: "1f7d261d-0089-4d32-9aa1-19942c41cb1d", username: "operator", display_name: "操作员" };
const audit = { create: () => ({ createdBy: user.id, updatedBy: user.id }), update: () => ({ updatedBy: user.id }), softDelete: () => ({ deletedAt: new Date(), deletedBy: user.id }), record: async () => {} };

// 领料单：只绑定生产单，不再绑定工序；一个生产单可以开多张领料单（按需分批领料）。
function harness() {
  const created = [];
  let sequence = 0;
  const prisma = {
    productionOrder: { findFirst: async () => ({ id: "order-1", orderNo: "DL260001", executionMode: "in_house", status: "in_progress" }) },
    // 如果实现又去查工序，这里会返回 null 从而让测试失败（说明退回旧行为）。
    productionOrderOperation: { findFirst: async () => null },
    rawMaterialMovement: {
      create: async ({ data }) => { created.push(data); sequence += 1; return { id: `movement-${sequence}`, ...data }; }
    }
  };
  const service = new RawMaterialMovementsService(prisma, audit, {});
  service.previewLines = async () => ({ lines: [{ material_id: "material-1", unit_id: "unit-1", quantity: "2", bom_reference_quantity: "5", remark: undefined }] });
  return { service, created };
}

test("新建领料单只需要生产单，不再要求工序", async () => {
  const { service, created } = harness();
  const movement = await service.createIssue({ production_order_id: "order-1", lines: [{ material_id: "material-1", quantity: "2" }] }, user);
  assert.equal(created.length, 1, "没有工序也必须能建领料单");
  assert.equal(movement.productionOrderId, "order-1");
  assert.equal(created[0].productionOrderOperationId, undefined, "领料单不再写入工序字段");
  assert.match(created[0].movementNo, /^MI-/);
});

test("即使请求里带了工序字段也被忽略（不再绑定工序）", async () => {
  const { service, created } = harness();
  await service.createIssue({ production_order_id: "order-1", production_order_operation_id: "operation-x", lines: [{ material_id: "material-1", quantity: "2" }] }, user);
  assert.equal(created.length, 1);
  assert.equal(created[0].productionOrderOperationId, undefined);
});

test("同一个生产单可以连续开多张领料单，各自独立编号", async () => {
  const { service, created } = harness();
  await service.createIssue({ production_order_id: "order-1", lines: [{ material_id: "material-1", quantity: "2" }] }, user);
  await service.createIssue({ production_order_id: "order-1", lines: [{ material_id: "material-1", quantity: "3" }] }, user);
  await service.createIssue({ production_order_id: "order-1", lines: [{ material_id: "material-1", quantity: "4" }] }, user);
  assert.equal(created.length, 3, "一个生产单必须能有多张领料单");
  assert.equal(new Set(created.map((row) => row.movementNo)).size, 3, "每张领料单单号必须唯一");
  assert.equal(new Set(created.map((row) => row.idempotencyKey)).size, 3);
});

// 生成后可编辑保存：草稿领料单允许改明细并保存，且保存走的是同一张单（不新建）。
test("领料单生成后可再次编辑保存", async () => {
  const updated = [];
  const current = {
    id: "movement-1", movementNo: "MI-1", documentType: "issue", status: "draft", productionOrderId: "order-1", orderNo: "DL260001",
    lines: [{ id: "line-1", materialId: "material-1", unitId: "unit-1", quantity: new Prisma.Decimal("2"), remark: null }]
  };
  const tx = {
    $queryRaw: async () => [],
    rawMaterialMovement: {
      findFirst: async () => ({ ...current, lines: undefined }),
      update: async ({ where, data }) => { updated.push({ where, data }); return { ...current, ...data }; }
    },
    rawMaterialMovementLine: { updateMany: async () => ({ count: 1 }) }
  };
  const prisma = { $transaction: async (fn) => fn(tx), rawMaterialMovement: { findFirst: async () => current }, productionOrder: { findFirst: async () => ({ id: "order-1", orderNo: "DL260001", executionMode: "in_house", status: "in_progress" }) } };
  const service = new RawMaterialMovementsService(prisma, audit, {});
  service.previewLines = async () => ({ lines: [{ material_id: "material-1", unit_id: "unit-1", quantity: "7", bom_reference_quantity: "5", remark: "改数量" }] });

  await service.updateIssue("movement-1", { lines: [{ material_id: "material-1", quantity: "7", remark: "改数量" }] }, user);
  assert.equal(updated.length, 1, "编辑保存应更新原单，而不是新建");
  assert.equal(updated[0].where.id, "movement-1");
  assert.equal(updated[0].data.lines.create[0].quantity, "7", "新明细数量必须写入");
  assert.equal(updated[0].data.productionOrderOperationId, undefined, "编辑保存不得再写工序");
});

test("已过账的领料单不可编辑", async () => {
  const current = { id: "movement-1", documentType: "issue", status: "posted", productionOrderId: "order-1", orderNo: "DL260001", lines: [] };
  const prisma = { rawMaterialMovement: { findFirst: async () => current }, productionOrder: { findFirst: async () => ({ id: "order-1", executionMode: "in_house", status: "in_progress" }) } };
  const service = new RawMaterialMovementsService(prisma, audit, {});
  await assert.rejects(() => service.updateIssue("movement-1", { lines: [{ material_id: "material-1", quantity: "7" }] }, user), (error) => error.getResponse().code === "MATERIAL_MOVEMENT_NOT_EDITABLE");
});

// 领料单与补料单都只绑定生产单（本次业务变更）。
test("补料单同样只需要生产单，不再要求工序", async () => {
  const { service, created } = harness();
  await service.createReplenishment({ production_order_id: "order-1", reason: "伞布坏片", lines: [{ material_id: "material-1", quantity: "2" }] }, user);
  assert.equal(created.length, 1, "没有工序也必须能建补料单");
  assert.equal(created[0].productionOrderOperationId, undefined);
});
