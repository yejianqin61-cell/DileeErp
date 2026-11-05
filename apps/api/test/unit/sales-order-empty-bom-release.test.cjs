// 销售单 + 空壳 BOM 的自动清理（2026-11-05）：改核心字段 / 回退草稿都不再被「没填过内容的空 BOM」堵死。
//
// 用户现场：已确认销售单 → 采购/生产在 BOM 表页点「新建 BOM 表」但没录任何明细就关掉 →
// 库里留下一张 0 明细的 BOM → 销售单改核心字段被 SALES_ORDER_CORE_FIELDS_LOCKED 挡住、
// 回退草稿被 SALES_ORDER_DOWNSTREAM_EXISTS 挡住，而 BOM 又没有删除入口 —— 一条死路。
// 设计契约：docs/design/bom-delete-and-empty-shell-release-2026-11-05.md D6/D7/D8 + §5。
//
// 本文件钉住六件事（与任务 task-6 / 设计文档 §5 的测试清单逐条对应）：
//   ① 确认单改核心字段 + 全部空壳 BOM → 保存成功，表头与明细行在**同一事务**里软删，
//      响应带 `released_empty_boms`，审计是 `bom.delete` 且 `auto: true` + 固定理由；
//   ② 有明细的 BOM → 仍 422，`details` 说清每张 BOM 的 item_count，且没有任何软删写；
//   ③ 空壳 BOM + 已有采购单/生产单 → 仍 422（已采购/投产的事实不因 BOM 是空壳而消失）；
//   ④ 空壳 BOM 但有采购计划 → 不算空壳（计划是「被用过」的事实），422 且文案提到计划；
//   ⑤ 草稿单 / 只改非核心字段 / 本来就没有 BOM → 一键都不查 BOM 表（既有行为与查询面不变）；
//   ⑥ 回退草稿用**同一条**空壳判定：空壳 → 清理后放行；有明细 → 422。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { UnprocessableEntityException } = require("@nestjs/common");
const { SalesOrdersService } = require("../../dist/modules/sales/sales-orders.service.js");
const { AUTO_RELEASE_EMPTY_BOM_REASON } = require("../../dist/modules/sales/bom-facts.js");

const user = { id: "00000000-0000-0000-0000-0000000000aa", username: "sales", display_name: "销售测试" };
const ORDER_ID = "11111111-1111-1111-1111-111111111111";
const BOM_ID = "22222222-2222-2222-2222-222222222222";
const BOM_ID_2 = "22222222-2222-2222-2222-222222222223";
const PLAN_ID = "33333333-3333-3333-3333-333333333333";
const ORDER_NO = "SO-EMPTY-1";

/**
 * 把 Prisma 的 `where` 当成一个真过滤器用（只支持本文件用到的形状）。
 * 替身必须真的执行 where：`deletedAt: null` / `status: { not: "cancelled" }` 这些条件
 * 本身就是被测口径的一部分，忽略它们等于测了一个和线上不一样的查询。
 */
function matches(row, where = {}) {
  return Object.entries(where).every(([key, value]) => {
    if (value && typeof value === "object" && !Array.isArray(value) && "not" in value) return row[key] !== value.not;
    return row[key] === value;
  });
}

/** `get()` 形状的销售单行（只铺本文件关心的字段，与既有单测的夹具同形）。 */
function orderRow(overrides = {}) {
  return {
    id: ORDER_ID,
    orderNo: ORDER_NO,
    status: "confirmed",
    customerId: "customer-1",
    contactId: null,
    currentVersion: 3,
    orderDate: new Date("2026-11-01T00:00:00.000Z"),
    productName: "三折伞",
    productSpec: null,
    quantity: "100",
    unit: "支",
    deliveryDate: null,
    currency: "USD",
    unitPrice: "8.5",
    totalAmount: "850",
    taxRate: "0.13",
    settlementUnitPrice: null,
    receivableAmount: null,
    settlementMethod: null,
    localCurrencyAmount: null,
    extensionData: {},
    itemNo: null,
    reorderFromOrderNo: null,
    specDetailLabels: {},
    customer: { id: "customer-1", name: "客户" },
    contact: null,
    versions: [],
    boms: [],
    specDetails: [],
    materialRefs: [],
    materialExtras: [],
    slotImages: [],
    ...overrides,
  };
}

/**
 * 一张 BOM 的库内状态 + 它的下游事实。
 *
 * `itemCount` / `plan` / 采购单 / 生产单是 `bom-facts.js` 会去数的四件事：替身按它们回答
 * `bomItem.count`、`purchasePlan.findFirst`、`purchaseOrder.count`、`productionOrder.count`，
 * 于是「空壳」判定走的是与线上**同一份** `isEmptyShellBom`，而不是测试自己另写一条口径。
 */
function bomRow(overrides = {}) {
  return { id: BOM_ID, salesOrderId: ORDER_ID, orderNo: ORDER_NO, version: 1, status: "draft", itemCount: 0, plan: null, deletedAt: null, ...overrides };
}

function createHarness({ order = {}, boms = [], purchaseOrders = [], productionOrders = [] } = {}) {
  const state = orderRow(order);
  const bomRows = boms.map((row) => ({ ...bomRow(), ...row }));
  const calls = {
    locks: [],
    trace: [],
    bomFindMany: [],
    bomUpdate: [],
    bomItemUpdateMany: [],
    bomCount: [],
    purchaseOrderCount: [],
    productionOrderCount: [],
    softDeletes: [],
    orderUpdates: [],
    versionCreates: [],
    records: [],
  };
  const audit = {
    create: () => ({ createdBy: user.id, updatedBy: user.id }),
    update: () => ({ updatedBy: user.id }),
    softDelete: () => {
      const data = { deletedAt: new Date("2026-11-05T00:00:00.000Z"), deletedBy: user.id, updatedBy: user.id };
      calls.softDeletes.push(data);
      return data;
    },
    record: async (...args) => { calls.records.push(args); },
  };
  const tx = {
    $queryRaw: async (strings) => { calls.locks.push(String(strings)); calls.trace.push("lock"); return []; },
    salesOrder: {
      findFirst: async (args) => {
        if (args.select && args.select.status) return { status: state.status };
        return state;
      },
      update: async ({ data }) => { calls.orderUpdates.push(data); Object.assign(state, data); return state; },
    },
    salesOrderVersion: { create: async ({ data }) => { calls.versionCreates.push(data); return data; } },
    // 明细 / 引用 / 「其它」/ 18 格：这次请求一条都没传，服务层应当直接 return；
    // 列在这里只是让替身长得像 Prisma（真被调到也不至于 TypeError，测试另有"没有查询"的断言）。
    salesOrderSpecDetail: { updateMany: async () => ({ count: 0 }), createMany: async () => ({ count: 0 }) },
    salesOrderMaterialRef: { findMany: async () => [], update: async () => ({}), createMany: async () => ({ count: 0 }) },
    salesOrderMaterialExtra: { updateMany: async () => ({ count: 0 }), createMany: async () => ({ count: 0 }) },
    salesOrderSlotImage: { findMany: async () => [], update: async () => ({}), createMany: async () => ({ count: 0 }) },
    bom: {
      findMany: async (args) => {
        calls.bomFindMany.push(args);
        calls.trace.push("bom.findMany");
        return bomRows.filter((row) => matches(row, args.where)).map((row) => ({ id: row.id }));
      },
      findFirst: async (args) => {
        const row = bomRows.find((item) => matches(item, args.where));
        return row ? { id: row.id, orderNo: row.orderNo, version: row.version, status: row.status } : null;
      },
      count: async (args) => { calls.bomCount.push(args); return bomRows.filter((row) => matches(row, args.where)).length; },
      update: async ({ where, data }) => {
        calls.bomUpdate.push({ where, data });
        const row = bomRows.find((item) => item.id === where.id);
        Object.assign(row, data);
        return row;
      },
    },
    bomItem: {
      count: async (args) => {
        const row = bomRows.find((item) => item.id === args.where.bomId);
        return row ? row.itemCount : 0;
      },
      updateMany: async (args) => { calls.bomItemUpdateMany.push(args); return { count: 1 }; },
    },
    purchasePlan: {
      findFirst: async (args) => {
        const row = bomRows.find((item) => item.id === args.where.bomId && item.plan);
        return row ? { id: row.plan.id, planNo: row.plan.planNo } : null;
      },
    },
    purchasePlanItem: { count: async (args) => bomRows.find((item) => item.plan && item.plan.id === args.where.planId)?.plan.ordered_line_count ?? 0 },
    // 采购单 / 生产单：order 级（`salesOrderId`）与 BOM 级（`bomId`）两种 where 都走同一个过滤器。
    purchaseOrder: { count: async (args) => { calls.purchaseOrderCount.push(args); return purchaseOrders.filter((row) => matches(row, args.where)).length; } },
    productionOrder: { count: async (args) => { calls.productionOrderCount.push(args); return productionOrders.filter((row) => matches(row, args.where)).length; } },
  };
  const prisma = {
    salesOrder: { findFirst: async () => ({ ...state, boms: bomRows.filter((row) => row.deletedAt === null).map((row) => ({ id: row.id, version: row.version, status: row.status })) }) },
    customer: { findFirst: async () => ({ id: "customer-1", customerCode: "CUS-1", name: "客户", isActive: true }) },
    customerContact: { findFirst: async () => null },
    material: { findMany: async () => [] },
    $transaction: async (fn) => fn(tx),
  };
  return { service: new SalesOrdersService(prisma, audit), calls, state, bomRows };
}

const eventsOf = (calls, action) => calls.records.filter(([name]) => name === action);
const releasedOf = (calls) => {
  const events = eventsOf(calls, "bom.delete");
  return events.map((event) => ({ entity: event[1], id: event[3], details: event[4] }));
};

// ================================================================== ① 确认单改核心字段：空壳 → 清理并放行

test("确认单改核心字段 + 全部空壳 BOM：保存成功，表头与明细行软删，响应回报 released_empty_boms", async () => {
  const harness = createHarness({ boms: [bomRow()] });
  const result = await harness.service.update(ORDER_ID, { quantity: "120", reason: "客户临时加量" }, user);

  // 保存真的写下去了（不是"报个成功但其实没改"）。
  assert.equal(harness.calls.orderUpdates.length, 1);
  assert.equal(harness.calls.orderUpdates[0].quantity, "120");
  assert.equal(harness.calls.versionCreates[0].version, 4);

  // 空壳 BOM 的表头与明细行**一起**软删（D1：只软删、不物理删）。
  assert.equal(harness.calls.bomItemUpdateMany.length, 1);
  assert.deepEqual(harness.calls.bomItemUpdateMany[0].where, { bomId: BOM_ID, deletedAt: null });
  assert.ok(harness.calls.bomItemUpdateMany[0].data.deletedAt instanceof Date);
  assert.equal(harness.calls.bomItemUpdateMany[0].data.deletedBy, user.id);
  assert.equal(harness.calls.bomUpdate.length, 1);
  assert.deepEqual(harness.calls.bomUpdate[0].where, { id: BOM_ID });
  assert.ok(harness.calls.bomUpdate[0].data.deletedAt instanceof Date);
  assert.equal(harness.calls.bomUpdate[0].data.deletedBy, user.id);
  assert.ok(harness.bomRows[0].deletedAt instanceof Date, "替身里的 BOM 行也真的变成已删除");

  // 响应形状：`[{ bom_id, version }]`（前端拿它在成功提示里说「已自动清理 N 张空 BOM」）。
  assert.deepEqual(result.released_empty_boms, [{ bom_id: BOM_ID, version: 1 }]);
  assert.equal(result.impact_warning, null, "唯一一张 BOM 被清掉之后，不该再提醒物控「已有关联 BOM」");

  // 审计：不是用户点的删除，所以 `auto: true` + 固定理由，事件挂在这张 BOM 上。
  const released = releasedOf(harness.calls);
  assert.equal(released.length, 1);
  assert.equal(released[0].entity, "bom");
  assert.equal(released[0].id, BOM_ID);
  assert.deepEqual(released[0].details, { order_no: ORDER_NO, version: 1, reason: AUTO_RELEASE_EMPTY_BOM_REASON, auto: true });
});

test("确认单改核心字段 + 两张空壳 BOM：一起清理，released_empty_boms 逐张列出版本", async () => {
  const harness = createHarness({ boms: [bomRow(), bomRow({ id: BOM_ID_2, version: 2 })] });
  const result = await harness.service.update(ORDER_ID, { unit_price: "9", reason: "调价" }, user);

  assert.deepEqual(result.released_empty_boms, [
    { bom_id: BOM_ID, version: 1 },
    { bom_id: BOM_ID_2, version: 2 },
  ]);
  assert.equal(harness.calls.bomItemUpdateMany.length, 2);
  assert.equal(harness.calls.bomUpdate.length, 2);
  assert.equal(releasedOf(harness.calls).length, 2);
});

// ================================================================== ② 有明细的 BOM：仍挡住，但说清挡什么

test("确认单改核心字段 + 有明细的 BOM：422 SALES_ORDER_CORE_FIELDS_LOCKED，details 带 item_count，且没有任何软删写", async () => {
  const harness = createHarness({ boms: [bomRow({ itemCount: 3 })] });
  await assert.rejects(
    () => harness.service.update(ORDER_ID, { quantity: "120", reason: "客户临时加量" }, user),
    (error) => {
      assert.ok(error instanceof UnprocessableEntityException);
      const body = error.getResponse();
      assert.equal(body.code, "SALES_ORDER_CORE_FIELDS_LOCKED");
      // D8：不再是笼统的「已有 BOM」，要说清这张 BOM 有几项明细、下一步去哪删。
      assert.match(body.message, /3 项明细/);
      assert.match(body.message, /【采购 → BOM表】/);
      assert.equal(body.details[0].bom_id, BOM_ID);
      assert.equal(body.details[0].item_count, 3);
      assert.equal(body.details[0].has_purchase_plan, false);
      return true;
    },
  );
  assert.deepEqual(harness.calls.orderUpdates, [], "被挡时一个字段都不许写");
  assert.deepEqual(harness.calls.bomItemUpdateMany, [], "非空 BOM 不许被自动清理");
  assert.deepEqual(harness.calls.bomUpdate, []);
  assert.deepEqual(harness.calls.softDeletes, []);
  assert.deepEqual(eventsOf(harness.calls, "bom.delete"), []);
});

test("有明细的 BOM 同时有采购计划：文案与 details 都要提到计划（计划是「被用过」的事实）", async () => {
  const plan = { id: PLAN_ID, planNo: "PP-20261105-ABCDEF12", ordered_line_count: 0 };
  const harness = createHarness({ boms: [bomRow({ itemCount: 2, plan })] });
  await assert.rejects(
    () => harness.service.update(ORDER_ID, { product_name: "另一种伞", reason: "客户改款" }, user),
    (error) => {
      const body = error.getResponse();
      assert.equal(body.code, "SALES_ORDER_CORE_FIELDS_LOCKED");
      assert.match(body.message, /已有采购计划 PP-20261105-ABCDEF12/);
      assert.equal(body.details[0].has_purchase_plan, true);
      assert.equal(body.details[0].purchase_plan_no, "PP-20261105-ABCDEF12");
      return true;
    },
  );
  assert.deepEqual(harness.calls.bomUpdate, []);
});

// ================================================================== ③ 已采购/已投产：空壳也不能清

test("空壳 BOM + 存在采购单：仍 422（先回退下游），且先判采购/生产、再判 BOM", async () => {
  const harness = createHarness({
    boms: [bomRow()],
    purchaseOrders: [{ id: "po-1", salesOrderId: ORDER_ID, bomId: BOM_ID, deletedAt: null, status: "confirmed" }],
  });
  await assert.rejects(
    () => harness.service.update(ORDER_ID, { quantity: "120", reason: "客户临时加量" }, user),
    (error) => {
      const body = error.getResponse();
      assert.equal(body.code, "SALES_ORDER_CORE_FIELDS_LOCKED");
      assert.match(body.message, /1 张采购单/);
      assert.match(body.message, /回退下游/);
      assert.equal(body.details[0].purchase_order_count, 1);
      return true;
    },
  );
  assert.deepEqual(harness.calls.bomFindMany, [], "采购/生产事实先判：有它就当场挡，不必再取 BOM 事实");
  assert.deepEqual(harness.calls.bomUpdate, []);
  assert.deepEqual(harness.calls.orderUpdates, []);
});

test("空壳 BOM + 存在生产单：仍 422，文案说清是生产单挡着", async () => {
  const harness = createHarness({
    boms: [bomRow()],
    productionOrders: [{ id: "mo-1", salesOrderId: ORDER_ID, bomId: BOM_ID, deletedAt: null }],
  });
  await assert.rejects(
    () => harness.service.update(ORDER_ID, { quantity: "120", reason: "客户临时加量" }, user),
    (error) => {
      const body = error.getResponse();
      assert.equal(body.code, "SALES_ORDER_CORE_FIELDS_LOCKED");
      assert.match(body.message, /1 张生产单/);
      return true;
    },
  );
  assert.deepEqual(harness.calls.bomUpdate, []);
});

// ================================================================== ④ 有采购计划：不算空壳

test("空壳 BOM（0 明细）但有采购计划：不算空壳，422 且文案提到计划", async () => {
  const plan = { id: PLAN_ID, planNo: "PP-20261105-ABCDEF12", ordered_line_count: 0 };
  const harness = createHarness({ boms: [bomRow({ plan })] });
  await assert.rejects(
    () => harness.service.update(ORDER_ID, { quantity: "120", reason: "客户临时加量" }, user),
    (error) => {
      const body = error.getResponse();
      assert.equal(body.code, "SALES_ORDER_CORE_FIELDS_LOCKED");
      const message = String(body.message);
      assert.match(message, /采购计划/);
      assert.match(message, /PP-20261105-ABCDEF12/);
      assert.equal(body.details[0].item_count, 0);
      assert.equal(body.details[0].has_purchase_plan, true);
      return true;
    },
  );
  assert.deepEqual(harness.calls.bomUpdate, [], "有计划 = 被用过，不许自动清理");
  assert.deepEqual(harness.calls.softDeletes, []);
});

// ================================================================== ⑤ 既有行为不变：不多查库

test("草稿单改核心字段：一次 BOM/采购/生产查询都不发（守卫只对已确认单生效）", async () => {
  const harness = createHarness({ order: { status: "draft" }, boms: [bomRow()] });
  const result = await harness.service.update(ORDER_ID, { quantity: "120" }, user);

  assert.equal(harness.calls.orderUpdates[0].quantity, "120");
  assert.deepEqual(result.released_empty_boms, []);
  assert.deepEqual(harness.calls.bomFindMany, []);
  assert.deepEqual(harness.calls.purchaseOrderCount, []);
  assert.deepEqual(harness.calls.productionOrderCount, []);
  assert.deepEqual(harness.calls.bomUpdate, []);
  assert.ok(harness.bomRows[0].deletedAt === null, "草稿单的空壳 BOM 一个字都不许动");
});

test("已确认单只改非核心字段（结算方式）：不触发守卫，也不清理 BOM", async () => {
  const harness = createHarness({ boms: [bomRow()] });
  const result = await harness.service.update(ORDER_ID, { settlement_method: "monthly", reason: "客户要求月结" }, user);

  assert.equal(harness.calls.orderUpdates[0].settlementMethod, "monthly");
  assert.deepEqual(result.released_empty_boms, []);
  assert.deepEqual(harness.calls.bomFindMany, []);
  assert.deepEqual(harness.calls.bomUpdate, []);
});

test("已确认单改核心字段 + 本来就没有 BOM：照旧保存成功，released_empty_boms 是空数组", async () => {
  const harness = createHarness();
  const result = await harness.service.update(ORDER_ID, { quantity: "120", reason: "客户临时加量" }, user);

  assert.equal(harness.calls.orderUpdates[0].quantity, "120");
  assert.deepEqual(result.released_empty_boms, []);
  assert.deepEqual(harness.calls.bomFindMany, [], "没有 BOM 时不查 BOM 表（查询面与旧逻辑一致）");
});

// ================================================================== ⑥ 回退草稿：同一条空壳判定

test("回退草稿：锁行后先清空壳 BOM 再放行，返回 released_empty_boms 并写 auto 审计", async () => {
  const harness = createHarness({ boms: [bomRow()] });
  const result = await harness.service.revertToDraft(ORDER_ID, "客户要求先改成草稿", user);

  assert.equal(result.status, "draft");
  assert.deepEqual(result.released_empty_boms, [{ bom_id: BOM_ID, version: 1 }]);
  assert.equal(harness.calls.orderUpdates[0].status, "draft");

  // 顺序不能反：先锁销售单行（与删单/改号同一把锁），再取 BOM 事实并清理。
  assert.equal(harness.calls.locks.length, 1);
  assert.match(harness.calls.locks[0], /SELECT id FROM sales_orders WHERE id = .* FOR UPDATE/);
  assert.ok(harness.calls.trace.indexOf("lock") < harness.calls.trace.indexOf("bom.findMany"), "必须先锁行再取 BOM 事实");

  assert.equal(harness.calls.bomUpdate.length, 1);
  assert.ok(harness.bomRows[0].deletedAt instanceof Date);
  const released = releasedOf(harness.calls);
  assert.equal(released.length, 1);
  assert.deepEqual(released[0].details, { order_no: ORDER_NO, version: 1, reason: AUTO_RELEASE_EMPTY_BOM_REASON, auto: true });
  assert.equal(eventsOf(harness.calls, "sales_order.revert_to_draft").length, 1);
});

test("回退草稿：有明细的 BOM 仍 422 SALES_ORDER_DOWNSTREAM_EXISTS，文案带上明细数，且什么都没写", async () => {
  const harness = createHarness({ boms: [bomRow({ itemCount: 3 })] });
  await assert.rejects(
    () => harness.service.revertToDraft(ORDER_ID, "客户要求先改成草稿", user),
    (error) => {
      assert.ok(error instanceof UnprocessableEntityException);
      const body = error.getResponse();
      assert.equal(body.code, "SALES_ORDER_DOWNSTREAM_EXISTS");
      assert.match(body.message, /3 项明细/);
      assert.equal(body.details[0].item_count, 3);
      return true;
    },
  );
  assert.deepEqual(harness.calls.orderUpdates, [], "回退被挡时状态不许改成 draft");
  assert.deepEqual(harness.calls.bomUpdate, []);
  assert.deepEqual(harness.calls.softDeletes, []);
});

test("回退草稿：空壳 BOM + 已有采购单 → 仍 422（下游事实优先于空壳判定）", async () => {
  const harness = createHarness({
    boms: [bomRow()],
    purchaseOrders: [{ id: "po-1", salesOrderId: ORDER_ID, bomId: BOM_ID, deletedAt: null, status: "confirmed" }],
  });
  await assert.rejects(
    () => harness.service.revertToDraft(ORDER_ID, "客户要求先改成草稿", user),
    (error) => error.getResponse().code === "SALES_ORDER_DOWNSTREAM_EXISTS" && /1 张采购单/.test(error.getResponse().message),
  );
  assert.deepEqual(harness.calls.orderUpdates, []);
  assert.deepEqual(harness.calls.bomFindMany, [], "有采购事实时不必再取 BOM 事实");
});
