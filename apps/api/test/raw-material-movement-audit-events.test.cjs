const assert = require("node:assert/strict");
const { test } = require("node:test");
const { RawMaterialMovementsService } = require("../dist/modules/production/raw-material-movements.service.js");

// 单据审计记录要给界面可读的操作人姓名：审计行只有 actorId，查无此人时补 null，不回落到 UUID。
test("movement audit events carry the actor name and never fall back to the id", async () => {
  const userQueries = [];
  const events = [
    { id: "e-3", action: "raw_material_movement.post", actorId: "user-1" },
    { id: "e-2", action: "raw_material_movement.submit", actorId: "user-gone" },
    { id: "e-1", action: "raw_material_movement.create", actorId: null },
  ];
  const prisma = {
    rawMaterialMovement: { findFirst: async () => ({ id: "movement-1" }) },
    auditEvent: { findMany: async () => events },
    user: { findMany: async (query) => { userQueries.push(query); return [{ id: "user-1", displayName: "张三" }]; } },
  };
  const result = await new RawMaterialMovementsService(prisma, {}, {}).auditEvents("movement-1");

  assert.deepEqual(result.map((event) => [event.id, event.actor_name]), [["e-3", "张三"], ["e-2", null], ["e-1", null]]);
  assert.equal(userQueries.length, 1, "一页只查一次用户表");
  assert.deepEqual(userQueries[0].where.id.in, ["user-1", "user-gone"]);
});
