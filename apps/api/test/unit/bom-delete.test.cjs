// BOM 删除（2026-11-05）：删除预览 + DELETE /boms/:id 的软删/下游守卫/原因审计。
//
// 生产文件：apps/api/src/modules/sales/boms.service.ts 的 deletePreview / delete，
// 判定口径全部来自 apps/api/src/modules/sales/bom-facts.ts（与销售单自动清理空壳同一份定义）。
// 契约：docs/design/bom-delete-and-empty-shell-release-2026-11-05.md §4。
//
// 为什么用轻量 Prisma 替身而不是连库：
//   这几条规则是**判定顺序**问题（先锁 → 重算 → 判下游 → 判原因 → 才写），
//   连库只能看到最终状态，看不到「被拒时一行都没写」；替身能把写入序列与审计参数一起钉住。
// 替身按真实查询形状实现计数（含 `{ not: x }` 过滤），所以「已取消采购单不计数」这类口径是真的在验。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { NotFoundException, UnprocessableEntityException } = require("@nestjs/common");
const { BomsService } = require("../../dist/modules/sales/boms.service.js");

const user = { id: "00000000-0000-0000-0000-000000000001", username: "operator" };
const DELETED_AT = new Date("2026-11-05T02:00:00.000Z");
const ORDER_NO = "SO-20261105-0001";

/** 审计替身：把每次 record 的参数原样收下来，供断言「审计里到底记了什么」。 */
function auditSpy() {
  const events = [];
  return {
    events,
    create: () => ({}),
    update: () => ({ updatedBy: user.id }),
    softDelete: (actor) => ({ deletedAt: DELETED_AT, deletedBy: actor.id, updatedBy: actor.id }),
    record: async (action, entityType, actorId, entityId, details) => {
      events.push({ action, entityType, actorId, entityId, details });
    },
  };
}

/** 只实现本用例用到的 where 形状：等值 与 `{ not: x }`。不引入查询引擎，够用即可。 */
function matches(row, where = {}) {
  return Object.entries(where).every(([key, expected]) => {
    if (expected && typeof expected === "object" && "not" in expected) return row[key] !== expected.not;
    return row[key] === expected;
  });
}

/**
 * 假 Prisma + 交易客户端：数据放内存表里，写入同时记进 `writes`（按发生顺序）。
 * 写入序列是对外契约的一部分（明细先删、表头后删、被拒时一行不写），所以逐条记录。
 */
function fixture(seed = {}) {
  const state = {
    boms: [{ id: "bom-1", orderNo: ORDER_NO, version: 1, status: "draft", deletedAt: null, ...seed.bom }],
    items: seed.items ?? [],
    plans: seed.plans ?? [],
    planItems: seed.planItems ?? [],
    purchaseOrders: seed.purchaseOrders ?? [],
    productionOrders: seed.productionOrders ?? [],
  };
  const writes = [];

  const read = {
    bom: { findFirst: async ({ where }) => state.boms.find((row) => matches(row, where)) ?? null },
    bomItem: { count: async ({ where }) => state.items.filter((row) => matches(row, where)).length },
    purchasePlan: { findFirst: async ({ where }) => state.plans.find((row) => matches(row, where)) ?? null },
    purchasePlanItem: { count: async ({ where }) => state.planItems.filter((row) => matches(row, where)).length },
    purchaseOrder: { count: async ({ where }) => state.purchaseOrders.filter((row) => matches(row, where)).length },
    productionOrder: { count: async ({ where }) => state.productionOrders.filter((row) => matches(row, where)).length },
  };

  const tx = {
    ...read,
    // 行锁：真实实现是 SELECT ... FOR UPDATE，这里只记录「锁发生在写入之前」。
    $queryRaw: async () => {
      writes.push({ kind: "lock" });
      return state.boms.filter((row) => row.deletedAt === null).map((row) => ({ id: row.id }));
    },
    bom: {
      ...read.bom,
      update: async ({ where, data }) => {
        writes.push({ kind: "bom.softDelete", where, data });
        const row = state.boms.find((item) => item.id === where.id);
        Object.assign(row, data);
        return row;
      },
    },
    bomItem: {
      ...read.bomItem,
      updateMany: async ({ where, data }) => {
        writes.push({ kind: "bomItem.softDelete", where, data });
        const hit = state.items.filter((row) => matches(row, where));
        for (const row of hit) Object.assign(row, data);
        return { count: hit.length };
      },
    },
    // 采购计划不该被连带软删：把「碰了计划」也记成一条写入，用例断言它不存在。
    purchasePlan: {
      ...read.purchasePlan,
      update: async () => { writes.push({ kind: "purchasePlan.softDelete" }); return {}; },
      updateMany: async () => { writes.push({ kind: "purchasePlan.softDelete" }); return { count: 0 }; },
    },
    purchasePlanItem: {
      ...read.purchasePlanItem,
      updateMany: async () => { writes.push({ kind: "purchasePlanItem.softDelete" }); return { count: 0 }; },
    },
  };

  return { state, writes, prisma: { ...read, $transaction: async (fn) => fn(tx) } };
}

// ---------------------------------------------------------------------------
// 删除预览（§4.1）
// ---------------------------------------------------------------------------

test("delete-preview: 空壳 BOM 可删、不需要原因", async () => {
  const { prisma } = fixture();
  const service = new BomsService(prisma, auditSpy());
  const preview = await service.deletePreview("bom-1");
  assert.deepEqual(preview, {
    bom_id: "bom-1",
    order_no: ORDER_NO,
    version: 1,
    status: "draft",
    item_count: 0,
    purchase_plan: null,
    purchase_order_count: 0,
    production_order_count: 0,
    deletable: true,
    blocked_reason: null,
    reason_required: false,
  });
});

test("delete-preview: 明细只数未删除行；采购计划存在即要求原因（ordered_line_count 只是诊断）", async () => {
  const { prisma } = fixture({
    items: [
      { bomId: "bom-1", deletedAt: null },
      { bomId: "bom-1", deletedAt: null },
      { bomId: "bom-1", deletedAt: DELETED_AT },
    ],
    plans: [{ id: "plan-1", bomId: "bom-1", planNo: "PP-20261105-0001", deletedAt: null }],
    planItems: [
      { planId: "plan-1", deletedAt: null, purchaseOrderItemId: "po-item-1" },
      { planId: "plan-1", deletedAt: null, purchaseOrderItemId: null },
      { planId: "plan-1", deletedAt: DELETED_AT, purchaseOrderItemId: "po-item-2" },
    ],
  });
  const service = new BomsService(prisma, auditSpy());
  const preview = await service.deletePreview("bom-1");
  assert.equal(preview.item_count, 2, "已软删的明细行不算");
  assert.deepEqual(preview.purchase_plan, { id: "plan-1", plan_no: "PP-20261105-0001", ordered_line_count: 1 }, "只数未删除、已下单的行");
  assert.equal(preview.reason_required, true, "计划存在时即使 0 行也算「被用过」，删它要留原因");
  assert.equal(preview.deletable, true, "采购计划不阻止删除（既有设计 D5）");
});

test("delete-preview: 已取消的采购单不计数，未删除的生产单（任何状态）计数", async () => {
  const { prisma } = fixture({
    purchaseOrders: [
      { bomId: "bom-1", deletedAt: null, status: "ordered" },
      { bomId: "bom-1", deletedAt: null, status: "cancelled" },
      { bomId: "bom-1", deletedAt: DELETED_AT, status: "ordered" },
    ],
    productionOrders: [
      { bomId: "bom-1", deletedAt: null, status: "in_progress" },
      { bomId: "bom-1", deletedAt: DELETED_AT, status: "draft" },
    ],
  });
  const service = new BomsService(prisma, auditSpy());
  const preview = await service.deletePreview("bom-1");
  assert.equal(preview.purchase_order_count, 1, "已取消/已删除的采购单不是事实");
  assert.equal(preview.production_order_count, 1, "生产单只有草稿能删，非草稿引用即视为在用");
  assert.equal(preview.deletable, false);
  assert.match(preview.blocked_reason, /1 张采购单/);
  assert.match(preview.blocked_reason, /1 张生产单/);
  assert.match(preview.blocked_reason, /请先回退下游单据/);
  assert.equal(preview.reason_required, false, "被下游挡住与要不要填原因是两件事：先解决下游");
});

test("delete-preview: BOM 不存在或已软删都是 404 BOM_NOT_FOUND", async () => {
  const missing = fixture();
  await assert.rejects(
    () => new BomsService(missing.prisma, auditSpy()).deletePreview("bom-other"),
    (error) => error instanceof NotFoundException && error.getResponse().code === "BOM_NOT_FOUND",
  );
  const softDeleted = fixture({ bom: { deletedAt: DELETED_AT } });
  await assert.rejects(
    () => new BomsService(softDeleted.prisma, auditSpy()).deletePreview("bom-1"),
    (error) => error instanceof NotFoundException && error.getResponse().code === "BOM_NOT_FOUND",
  );
});

// ---------------------------------------------------------------------------
// DELETE /boms/:id（§4.2）
// ---------------------------------------------------------------------------

test("delete: 空壳 BOM 不填原因一键删；表头软删、审计记全参数", async () => {
  const { prisma, state, writes } = fixture();
  const audit = auditSpy();
  const service = new BomsService(prisma, audit);

  const result = await service.delete("bom-1", undefined, user);

  assert.deepEqual(result, { id: "bom-1", order_no: ORDER_NO, version: 1, deleted: true, item_count: 0 });
  assert.equal(state.boms[0].deletedAt.toISOString(), DELETED_AT.toISOString(), "表头是软删（deleted_at 有值），行还在");
  assert.deepEqual(writes.map((row) => row.kind), ["lock", "bomItem.softDelete", "bom.softDelete"], "先锁、再删明细、最后删表头");
  assert.deepEqual(writes[2].data, { deletedAt: DELETED_AT, deletedBy: user.id, updatedBy: user.id }, "软删字段来自 audit.softDelete(user)");

  assert.equal(audit.events.length, 1);
  const event = audit.events[0];
  assert.equal(event.action, "bom.delete");
  assert.equal(event.entityType, "bom");
  assert.equal(event.actorId, user.id);
  assert.equal(event.entityId, "bom-1");
  assert.deepEqual(event.details, {
    order_no: ORDER_NO,
    version: 1,
    item_count: 0,
    reason: null,
    purchase_plan_id: null,
    purchase_order_count: 0,
    production_order_count: 0,
  });
});

test("delete: 有明细不填原因 → 422 BOM_DELETE_REASON_REQUIRED，且一行都没写", async () => {
  const { prisma, writes, state } = fixture({ items: [{ bomId: "bom-1", deletedAt: null }] });
  const service = new BomsService(prisma, auditSpy());
  await assert.rejects(
    () => service.delete("bom-1", "   ", user),
    (error) => {
      assert.ok(error instanceof UnprocessableEntityException);
      const response = error.getResponse();
      assert.equal(response.code, "BOM_DELETE_REASON_REQUIRED");
      assert.equal(response.details[0].item_count, 1);
      assert.equal(response.details[0].has_purchase_plan, false);
      return true;
    },
  );
  assert.deepEqual(writes.map((row) => row.kind), ["lock"], "被拒时不能留下「明细已删、表头还在」的半张 BOM");
  assert.equal(state.items[0].deletedAt, null);
  assert.equal(state.boms[0].deletedAt, null);
});

test("delete: 有明细填了原因 → 成功；明细行与表头一起软删，原因 trim 后进审计", async () => {
  const { prisma, state, writes } = fixture({
    items: [
      { bomId: "bom-1", deletedAt: null },
      { bomId: "bom-1", deletedAt: null },
    ],
  });
  const audit = auditSpy();
  const service = new BomsService(prisma, audit);

  const result = await service.delete("bom-1", "  建错销售单，重做  ", user);

  assert.equal(result.deleted, true);
  assert.equal(result.item_count, 2);
  assert.ok(state.items.every((row) => row.deletedAt?.toISOString() === DELETED_AT.toISOString()), "全部未删明细行都要软删");
  assert.equal(state.boms[0].deletedAt.toISOString(), DELETED_AT.toISOString());
  assert.equal(writes.filter((row) => row.kind === "bomItem.softDelete").length, 1);
  assert.equal(audit.events[0].details.reason, "建错销售单，重做", "原因要 trim，审计里不能是前后带空格的原串");
  assert.equal(audit.events[0].details.item_count, 2);
});

test("delete: 有未取消采购单引用 → 422 BOM_HAS_DOWNSTREAM，message 用共享判定文案、details 带计数", async () => {
  const { prisma, writes } = fixture({
    items: [{ bomId: "bom-1", deletedAt: null }],
    purchaseOrders: [
      { bomId: "bom-1", deletedAt: null, status: "ordered" },
      { bomId: "bom-1", deletedAt: null, status: "partially_arrived" },
      { bomId: "bom-1", deletedAt: null, status: "cancelled" },
      { bomId: "bom-1", deletedAt: DELETED_AT, status: "ordered" },
    ],
  });
  const audit = auditSpy();
  const service = new BomsService(prisma, audit);
  await assert.rejects(
    // 即使填了原因也不放行：下游事实不能靠一句理由撤销。
    () => service.delete("bom-1", "客户取消订单", user),
    (error) => {
      assert.ok(error instanceof UnprocessableEntityException);
      const response = error.getResponse();
      assert.equal(response.code, "BOM_HAS_DOWNSTREAM");
      assert.match(response.message, /2 张采购单/, "文案要让人知道在挡什么、下一步去哪（D8）");
      assert.match(response.message, /请先回退下游单据/);
      assert.deepEqual(response.details[0], {
        bom_id: "bom-1",
        order_no: ORDER_NO,
        purchase_order_count: 2,
        production_order_count: 0,
      });
      return true;
    },
  );
  assert.deepEqual(writes.map((row) => row.kind), ["lock"]);
  assert.deepEqual(audit.events, [], "没删成就不该留下删除审计");
});

test("delete: 有未删除生产单引用 → 422 BOM_HAS_DOWNSTREAM", async () => {
  const { prisma } = fixture({ productionOrders: [{ bomId: "bom-1", deletedAt: null, status: "draft" }] });
  const service = new BomsService(prisma, auditSpy());
  await assert.rejects(
    () => service.delete("bom-1", undefined, user),
    (error) => {
      const response = error.getResponse();
      assert.equal(response.code, "BOM_HAS_DOWNSTREAM");
      assert.match(response.message, /1 张生产单/);
      assert.equal(response.details[0].production_order_count, 1);
      return true;
    },
  );
});

test("delete: 只有已取消的采购单不阻止删除", async () => {
  const { prisma, state } = fixture({ purchaseOrders: [{ bomId: "bom-1", deletedAt: null, status: "cancelled" }] });
  const service = new BomsService(prisma, auditSpy());
  const result = await service.delete("bom-1", undefined, user);
  assert.equal(result.deleted, true);
  assert.notEqual(state.boms[0].deletedAt, null);
});

test("delete: 采购计划存在 → 必须填原因；填了可以删，且计划不被连带软删（D5）", async () => {
  const plan = { id: "plan-1", bomId: "bom-1", planNo: "PP-20261105-0001", deletedAt: null };

  const noReason = fixture({ plans: [plan] });
  await assert.rejects(
    () => new BomsService(noReason.prisma, auditSpy()).delete("bom-1", undefined, user),
    (error) => {
      const response = error.getResponse();
      assert.equal(response.code, "BOM_DELETE_REASON_REQUIRED");
      assert.equal(response.details[0].has_purchase_plan, true);
      assert.equal(response.details[0].item_count, 0);
      return true;
    },
  );

  const withReason = fixture({ plans: [plan] });
  const audit = auditSpy();
  const result = await new BomsService(withReason.prisma, audit).delete("bom-1", "选错了 BOM 版本", user);
  assert.equal(result.deleted, true);
  assert.equal(withReason.state.plans[0].deletedAt, null, "计划是独立历史记录，BOM 软删后它继续存活");
  assert.deepEqual(withReason.writes.filter((row) => row.kind.startsWith("purchasePlan")), [], "不能顺手把计划也删了");
  assert.equal(audit.events[0].details.purchase_plan_id, "plan-1");
  assert.equal(audit.events[0].details.reason, "选错了 BOM 版本");
});

test("delete: 重复删除（已软删）→ 404 BOM_NOT_FOUND，不再写任何行", async () => {
  const { prisma, writes } = fixture({ bom: { deletedAt: DELETED_AT } });
  const audit = auditSpy();
  const service = new BomsService(prisma, audit);
  await assert.rejects(
    () => service.delete("bom-1", "再删一次", user),
    (error) => error instanceof NotFoundException && error.getResponse().code === "BOM_NOT_FOUND",
  );
  assert.deepEqual(writes.map((row) => row.kind), ["lock"]);
  assert.deepEqual(audit.events, []);
});

test("delete: 事务内重算的事实覆盖旧判断（取锁期间补建的采购单不会被穿透）", async () => {
  // 模拟「用户看预览之后、我们拿到行锁之前，采购那边已经把单子建好并提交了」：
  // 若 delete 用的是事务外的旧快照，就会把这张已被引用的 BOM 删掉；只有锁后重读才看得见。
  const base = fixture({ items: [{ bomId: "bom-1", deletedAt: null }] });
  const { prisma } = base;
  const originalTransaction = prisma.$transaction;
  let transactionCount = 0;
  prisma.$transaction = async (fn) =>
    originalTransaction(async (tx) => {
      const lock = tx.$queryRaw;
      tx.$queryRaw = async () => {
        const locked = await lock();
        base.state.purchaseOrders.push({ bomId: "bom-1", deletedAt: null, status: "ordered" });
        return locked;
      };
      transactionCount += 1;
      return fn(tx);
    });
  const service = new BomsService(prisma, auditSpy());
  await assert.rejects(
    () => service.delete("bom-1", "建错了", user),
    (error) => error.getResponse().code === "BOM_HAS_DOWNSTREAM",
  );
  assert.equal(transactionCount, 1);
  assert.equal(base.state.boms[0].deletedAt, null, "并发补建下游单据时，删除必须被挡住而不是穿透");
});
