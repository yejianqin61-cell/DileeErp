// 「操作人姓名」解析的单元测试（手写假 Prisma，不连数据库）。
//
// 生产文件：apps/api/src/platform/audit/audit-actor.service.ts
//
// 本文件钉住四条约定：
//   1. **一次 IN 查询搞定整页**（导出上百张单据不能打出上百次用户查询——现存代码就是这么干的）；
//   2. **取不到姓名补 null，绝不回落到 id**（否则界面出现「制单：6f3a1c8e-…」这种 UUID）；
//   3. `attachAll` 不改变数组长度与顺序（调用方常按下标把行对上别的数据）；
//   4. 空数组不发查询（列表为空时不该白跑一次数据库）。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { AuditActorService, withActorNames } = require("../../dist/platform/audit/audit-actor.service.js");

/** 假 Prisma：只实现 user.findMany，并记录调用次数与入参。 */
function makePrisma(users = []) {
  const calls = [];
  return {
    calls,
    user: {
      findMany: async (args) => {
        calls.push(args);
        const ids = args?.where?.id?.in ?? [];
        return users.filter((user) => ids.includes(user.id));
      }
    }
  };
}

const USERS = [
  { id: "u-1", displayName: "张三" },
  { id: "u-2", displayName: "李四" }
];

test("withActorNames：贴姓名；查无此人补 null，不回落成 UUID", () => {
  const names = new Map([["u-1", "张三"]]);
  const row = withActorNames({ id: "po-1", createdBy: "u-1", updatedBy: "u-9" }, names);
  assert.equal(row.created_by_name, "张三");
  // u-9 不在映射里（用户已删）→ null，而不是 "u-9"
  assert.equal(row.updated_by_name, null);
  assert.equal(row.createdBy, "u-1");
});

test("withActorNames：空 id 给 null（历史数据可能没有 created_by）", () => {
  const row = withActorNames({ createdBy: null, updatedBy: undefined }, new Map([["u-1", "张三"]]));
  assert.deepEqual(row, { createdBy: null, updatedBy: undefined, created_by_name: null, updated_by_name: null });
});

test("namesOf：去重、剔除空值，只发一次查询", async () => {
  const prisma = makePrisma(USERS);
  const service = new AuditActorService(prisma);
  const names = await service.namesOf(["u-1", "u-2", "u-1", null, undefined, ""]);
  assert.equal(prisma.calls.length, 1);
  assert.deepEqual(prisma.calls[0].where.id.in.sort(), ["u-1", "u-2"]);
  assert.equal(names.get("u-1"), "张三");
  assert.equal(names.get("u-2"), "李四");
});

test("attachAll：整页只查一次（这是本文件最要紧的一条）", async () => {
  const prisma = makePrisma(USERS);
  const service = new AuditActorService(prisma);
  const rows = Array.from({ length: 50 }, (_, index) => ({ id: `row-${index}`, createdBy: "u-1", updatedBy: index % 2 ? "u-2" : "u-1" }));
  const decorated = await service.attachAll(rows);
  assert.equal(prisma.calls.length, 1, "50 行必须只发 1 次用户查询");
  assert.equal(decorated.length, 50);
  assert.deepEqual(decorated.map((row) => row.id), rows.map((row) => row.id), "顺序必须保持不变");
  assert.equal(decorated[1].updated_by_name, "李四");
});

test("attachAll：空数组直接返回空，不发查询", async () => {
  const prisma = makePrisma(USERS);
  const service = new AuditActorService(prisma);
  assert.deepEqual(await service.attachAll([]), []);
  assert.equal(prisma.calls.length, 0);
});

test("attachAll：全部行都没有 createdBy 时不发查询", async () => {
  const prisma = makePrisma(USERS);
  const service = new AuditActorService(prisma);
  const decorated = await service.attachAll([{ id: "a", createdBy: null, updatedBy: null }]);
  assert.equal(prisma.calls.length, 0);
  assert.equal(decorated[0].created_by_name, null);
});

test("attach：单行包装", async () => {
  const service = new AuditActorService(makePrisma(USERS));
  const row = await service.attach({ id: "x", createdBy: "u-2", updatedBy: "u-2" });
  assert.equal(row.created_by_name, "李四");
  assert.equal(row.updated_by_name, "李四");
});

test("attachActorToEvents：审计事件的 actorId 换成人名（现在返回的是 UUID，界面没法看）", async () => {
  const service = new AuditActorService(makePrisma(USERS));
  const events = await service.attachActorToEvents([
    { id: "e-1", actorId: "u-1", action: "purchase_order.print_fields" },
    { id: "e-2", actorId: "u-9", action: "x" },
    { id: "e-3", actorId: null, action: "y" }
  ]);
  assert.equal(events[0].actor_name, "张三");
  assert.equal(events[1].actor_name, null);
  assert.equal(events[2].actor_name, null);
  assert.equal(events.length, 3);
});
