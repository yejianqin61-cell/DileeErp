const assert = require("node:assert/strict");
const { test } = require("node:test");
const { RawMaterialMovementsService } = require("../../dist/modules/production/raw-material-movements.service.js");

// 业务要求：一个生产单可以建立**多张**领料单与补料单（按需分批领料/补料），前端也必须有入口。
// 这里锁定服务层不退化：同参数重复创建必须各自成单（不同单号、不同幂等键），不能被合并或去重。
const user = { id: "1f7d261d-0089-4d32-9aa1-19942c41cb1d", username: "operator", display_name: "操作员" };
const audit = { create: () => ({ createdBy: user.id, updatedBy: user.id }), update: () => ({ updatedBy: user.id }), record: async () => {} };

function harness() {
  const created = [];
  const prisma = {
    productionOrder: { findFirst: async () => ({ id: "order-1", orderNo: "DL260001", executionMode: "in_house", status: "in_progress" }) },
    productionOrderOperation: { findFirst: async () => null },
    rawMaterialMovement: {
      // 唯一约束只有 movement_no / idempotency_key：这里模拟“重复键会失败”，从而能验证实现确实每次都生成新键。
      create: async ({ data }) => {
        if (created.some((row) => row.movementNo === data.movementNo)) throw new Error("duplicate movement_no");
        if (created.some((row) => row.idempotencyKey === data.idempotencyKey)) throw new Error("duplicate idempotency_key");
        const row = { id: `movement-${created.length + 1}`, ...data };
        created.push(row);
        return row;
      },
    },
  };
  const service = new RawMaterialMovementsService(prisma, audit, {});
  service.previewLines = async () => ({ lines: [{ material_id: "material-1", unit_id: "unit-1", quantity: "8", bom_reference_quantity: "10", remark: undefined }] });
  return { service, created };
}

const issueInput = () => ({ production_order_id: "order-1", lines: [{ material_id: "material-1", quantity: "8" }] });
const replenishmentInput = () => ({ production_order_id: "order-1", reason: "伞布坏片", lines: [{ material_id: "material-1", quantity: "2" }] });

test("同一个生产单可以建多张领料单，且单号/幂等键各不相同", async () => {
  const { service, created } = harness();
  const first = await service.createIssue(issueInput(), user);
  const second = await service.createIssue(issueInput(), user);
  const third = await service.createIssue(issueInput(), user);
  assert.equal(created.length, 3, "同参数重复创建必须各自成单");
  const numbers = new Set(created.map((row) => row.movementNo));
  assert.equal(numbers.size, 3, "每张领料单必须有独立单号");
  for (const row of created) assert.match(row.movementNo, /^MI-/);
  const keys = new Set(created.map((row) => row.idempotencyKey));
  assert.equal(keys.size, 3, "每张领料单必须有独立幂等键，否则第二张会被当成重试");
  assert.notEqual(first.id, second.id);
  assert.notEqual(second.id, third.id);
});

test("同一个生产单可以建多张补料单（各自记录原因）", async () => {
  const { service, created } = harness();
  await service.createReplenishment(replenishmentInput(), user);
  await service.createReplenishment({ ...replenishmentInput(), reason: "缝制失误" }, user);
  assert.equal(created.length, 2);
  assert.equal(new Set(created.map((row) => row.movementNo)).size, 2);
  assert.equal(new Set(created.map((row) => row.idempotencyKey)).size, 2);
  for (const row of created) assert.match(row.movementNo, /^MC-/);
  assert.deepEqual(created.map((row) => row.reason), ["伞布坏片", "缝制失误"]);
});

test("领料单与补料单混用时互不干扰（同一生产单 3 领料 + 2 补料 = 5 张）", async () => {
  const { service, created } = harness();
  await service.createIssue(issueInput(), user);
  await service.createReplenishment(replenishmentInput(), user);
  await service.createIssue(issueInput(), user);
  await service.createReplenishment(replenishmentInput(), user);
  await service.createIssue(issueInput(), user);
  assert.equal(created.length, 5);
  assert.equal(created.filter((row) => row.documentType === "issue").length, 3);
  assert.equal(created.filter((row) => row.documentType === "replenishment").length, 2);
  assert.equal(new Set(created.map((row) => row.movementNo)).size, 5);
  assert.equal(new Set(created.map((row) => row.idempotencyKey)).size, 5);
});
