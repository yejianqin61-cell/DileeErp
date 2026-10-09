// 采购计划服务（新建 / 详情 / 列表 / 候选）的单元测试（手写假 Prisma，不连数据库）。
//
// 用户 2026-09-27：「采购模块那边多一个采购计划栏目。采购计划就承接的是原来的采购单草稿。
// 在采购计划里面，每个销售单对应一份的 BOM 对应一份的采购计划。还要加上供应商，供应商地址，
// 联系人这些 column。」
//
// 生产文件：apps/api/src/modules/procurement/purchase-plans.service.ts
// 入口：POST/GET /api/v1/purchase-plans（purchase-plans.controller.ts）
//
// 本文件钉住的核心约定：
//   1. 新建计划**自动带出该 BOM 全部明细行**（数量取 BOM 需求量、单价 0）—— 这是"漏买"唯一的防法；
//   2. 供应商从 BOM 行**预填**，但只填**启用中**的（停用的预填下去注定在下单时被拒）；
//   3. 单位解析不到时**整体拒绝**，不静默跳过那一行（静默跳过 = 计划少一个部件）；
//   4. 一个 BOM 只能有一份计划（服务层 409 + 数据库部分唯一索引兜并发）；
//   5. 状态是**派生**的（未下单 / 部分下单 / 已完成），空计划算"未下单"而不是"已完成"；
//   6. 供应商的地址/联系人**实时联查主数据**；供应商停用/删除后仍用快照显示当时记的是哪一家；
//   7. 「BOM 比计划多几个物料」按**物料**比，不按 BOM 行 ID（存一次 BOM 会换掉全部行 ID）。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { Prisma } = require("@prisma/client");
const { PurchasePlansService } = require("../../dist/modules/procurement/purchase-plans.service.js");
const { planStatusOf, purchasePlanNo, countBomMaterialsMissingFromPlan, planLineAmount, sumPlanAmounts, DEFAULT_PLAN_CURRENCY } = require("../../dist/modules/procurement/purchase-plans.domain.js");

const audit = {
  create: () => ({ createdBy: "user-1", updatedBy: "user-1" }),
  update: () => ({ updatedBy: "user-1" }),
  softDelete: () => ({ deletedAt: new Date("2026-09-27T03:00:00Z"), deletedBy: "user-1" }),
  record: async (...args) => { audit.events.push(args); },
  events: [],
};

/** 一行 BOM 明细的默认形态。 */
const bomRow = (id, overrides = {}) => ({
  id,
  bomId: "bom-1",
  materialId: overrides.materialId ?? `mat-${id}`,
  materialName: overrides.materialName ?? `物料 ${id}`,
  materialSnapshot: { id: overrides.materialId ?? `mat-${id}`, name: overrides.materialName ?? `物料 ${id}` },
  model: overrides.model ?? null,
  specificationModel: null,
  unitId: overrides.unitId === undefined ? "unit-pcs" : overrides.unitId,
  unit: overrides.unit ?? "个",
  requiredQuantity: { toFixed: () => overrides.requiredQuantity ?? "5.0000" },
  sequence: overrides.sequence ?? 1,
  deletedAt: null,
  supplierId: overrides.supplierId ?? null,
  supplier: overrides.supplier ?? null,
  // 参考单价（2026-10-08）：真实 `Decimal` —— 服务里会 `.gt(0)` 与 `.toFixed(4)`；
  // 默认 `null` = 没填（历史 BOM 行都是这个形状）。
  referenceUnitPrice: overrides.referenceUnitPrice ?? null,
  referenceCurrency: overrides.referenceCurrency ?? null,
});

/**
 * 组装服务。
 *
 * 假 Prisma **按 where 真的过滤**（不是无脑返回全部）：本文件要验证的正是
 * 「只用已确认销售单的 BOM」「排除已有计划的 BOM」「排除已软删的计划」这几条查询口径，
 * 一个恒返回全部数据的桩会把断言变成永远通过。
 */
function makeService({ boms = [], bomItems = [], plans = [], planItems = [], purchaseOrderItems = [], purchaseOrders = [], missingBom = false, bomDeleted = false } = {}) {
  const units = [
    { id: "unit-pcs", name: "个", isActive: true, deletedAt: null },
    { id: "unit-m", name: "米", isActive: true, deletedAt: null },
  ];
  const salesOrders = new Map([
    ["SO-1", { orderNo: "SO-1", itemNo: "27621", customerSnapshot: { name: "流水花扇客户" }, deliveryDate: null, status: "confirmed", deletedAt: null }],
    ["SO-2", { orderNo: "SO-2", itemNo: "27621 ", customerSnapshot: { name: "另一个客户" }, deliveryDate: null, status: "confirmed", deletedAt: null }],
  ]);
  const materialOf = (id) => ({ id, materialCode: `M-${id}`, name: `物料 ${id}`, specificationModel: null, color: null });
  const orderItemById = new Map(purchaseOrderItems.map((row) => [row.id, row]));
  // 「收束下单」落库的采购单与采购明细（假的采购单服务写进来的）。
  const createdOrders = [];
  const createdOrderItems = [];
  let recordedSplit = null;
  const findOrderItem = (id) => orderItemById.get(id) ?? createdOrderItems.find((row) => row.id === id) ?? null;

  const hydrateItem = (item) => ({
    ...item,
    // 真 Prisma 的 Decimal 列读出来是 Decimal 对象（`toFixed` 是它的方法），假 Prisma 要一样。
    quantity: new Prisma.Decimal(item.quantity ?? "0"),
    unitPrice: new Prisma.Decimal(item.unitPrice ?? "0"),
    // 真 Prisma 里这一列是 `NOT NULL DEFAULT 'CNY'`，所以桩也不能返回 undefined。
    currency: item.currency ?? "CNY",
    material: materialOf(item.materialId),
    unit: units.find((unit) => unit.id === item.unitId) ?? null,
    supplier: item.supplierId ? { id: item.supplierId, supplierCode: "SUP-1", name: "五金厂", contactName: "张伟", phone: "13800000000", address: "浙江省金华市", isActive: true, deletedAt: null } : null,
    purchaseOrderItem: item.purchaseOrderItemId ? findOrderItem(item.purchaseOrderItemId) : null,
  });
  const hydratePlan = (plan) => ({
    ...plan,
    salesOrder: salesOrders.get(plan.orderNo) ?? null,
    // `bomDeleted`：计划可以比 BOM 活得久（BOM 软删后计划独立存活，页面上有告警条）。
    bom: { id: plan.bomId, version: plan.bomVersion ?? 1, status: "draft", deletedAt: bomDeleted ? new Date("2026-10-01T00:00:00Z") : null },
    items: planItems.filter((item) => item.planId === plan.id && item.deletedAt === null).map(hydrateItem),
  });

  const prisma = {
    bom: {
      findFirst: async ({ where }) => {
        if (missingBom) return null;
        // 按 where 真的过滤：`deletedAt: null` 只有调用方要求时才生效 ——
        // 「退回采购计划」读 BOM 时**不看软删**（那条路不该被堵死）。
        const match = (bom) => bom.id === where.id
          && (where.deletedAt === null ? bom.deletedAt === null : true)
          && (where.salesOrder?.status ? bom.salesOrder?.status === where.salesOrder.status : true);
        if (where.id) return boms.find(match) ?? null;
        return boms.find((bom) => bom.deletedAt === null) ?? null;
      },
      findMany: async () => boms.filter((bom) => bom.deletedAt === null && (bom.salesOrder?.status === "confirmed") && !plans.some((plan) => plan.bomId === bom.id && plan.deletedAt === null)).map((bom) => ({ ...bom, items: bomItems.filter((item) => item.bomId === bom.id && item.deletedAt === null) })),
    },
    bomItem: { findMany: async ({ where }) => bomItems.filter((item) => item.bomId === where.bomId && item.deletedAt === null) },
    unit: { findMany: async () => units },
    purchasePlan: {
      findMany: async ({ where }) => plans.filter((plan) => plan.deletedAt === null && (!where.orderNo || plan.orderNo === where.orderNo)).map(hydratePlan),
      findFirst: async ({ where }) => {
        const plan = plans.find((row) => row.deletedAt === null && ((where.id && row.id === where.id) || (where.bomId && row.bomId === where.bomId)));
        return plan ? hydratePlan(plan) : null;
      },
      create: async ({ data }) => {
        const plan = { id: `plan-${plans.length + 1}`, deletedAt: null, createdAt: new Date("2026-09-27T02:00:00Z"), updatedAt: new Date("2026-09-27T02:00:00Z"), createdBy: "user-1", updatedBy: "user-1", ...data };
        plans.push(plan);
        return plan;
      },
      update: async ({ where, data }) => {
        const plan = plans.find((row) => row.id === where.id);
        Object.assign(plan, data);
        return plan;
      },
    },
    purchasePlanItem: {
      // 「退回采购计划」要先找出认领了这张单明细的计划行。
      findMany: async ({ where }) => planItems.filter((row) => row.deletedAt === null && (where.purchaseOrderItemId?.in ?? []).includes(row.purchaseOrderItemId)),
      createMany: async ({ data }) => {
        for (const row of data) planItems.push({ id: `item-${planItems.length + 1}`, purchaseOrderItemId: null, deletedAt: null, ...row, quantity: new Prisma.Decimal(row.quantity), unitPrice: new Prisma.Decimal(row.unitPrice) });
        return { count: data.length };
      },
      create: async ({ data }) => {
        const row = { id: `item-${planItems.length + 1}`, purchaseOrderItemId: null, deletedAt: null, ...data, quantity: new Prisma.Decimal(data.quantity), unitPrice: new Prisma.Decimal(data.unitPrice) };
        planItems.push(row);
        return row;
      },
      // 假 Prisma 按 where 真的过滤（写路径的软删范围正是本文件要验证的口径之一）。
      updateMany: async ({ where, data }) => {
        const hit = planItems.filter((row) => {
          if (where.id?.in) return where.id.in.includes(row.id) && row.deletedAt === null;
          if (row.planId !== where.planId || row.deletedAt !== null) return false;
          return where.purchaseOrderItemId === null ? row.purchaseOrderItemId === null : true;
        });
        for (const row of hit) Object.assign(row, data);
        return { count: hit.length };
      },
      update: async ({ where, data }) => {
        const row = planItems.find((candidate) => candidate.id === where.id);
        Object.assign(row, data);
        return row;
      },
    },
    material: { findMany: async ({ where }) => (where.id?.in ?? []).map(materialOf) },
    supplier: { findMany: async () => [] },
    // 预计到货的同步写在这一侧（已下单行的"预期"改了要跟着进采购明细）。
    purchaseOrderItem: {
      update: async ({ where, data }) => {
        const row = purchaseOrderItems.find((candidate) => candidate.id === where.id);
        if (!row) throw new Error(`测试桩：找不到采购明细 ${where.id}`);
        Object.assign(row, data);
        return row;
      },
      // 「收束下单」落库后按 `extension_data.purchase_plan_item_id` 回写计划行的链接，
      // 所以这里要能把刚建出来的采购明细读回来。
      findMany: async ({ where }) => createdOrderItems.filter((row) => (where.purchaseOrderId?.in ?? []).includes(row.purchaseOrderId) && row.deletedAt === null),
      updateMany: async ({ where, data }) => {
        // 明细可能来自 `purchaseOrderItems`（直接种的）或 `purchaseOrders[].items`（整单种的）。
        const pool = [...purchaseOrderItems, ...purchaseOrders.flatMap((row) => row.items ?? [])];
        const hit = pool.filter((row) => row.purchaseOrderId === where.purchaseOrderId && row.deletedAt === null);
        for (const row of hit) Object.assign(row, data);
        return { count: hit.length };
      },
    },
    // 「退回采购计划」要读那张采购单、软删它的明细、把它标成已取消。
    purchaseOrder: {
      findFirst: async ({ where }) => purchaseOrders.find((row) => row.id === where.id && row.deletedAt === null) ?? null,
      update: async ({ where, data }) => {
        const row = purchaseOrders.find((candidate) => candidate.id === where.id);
        Object.assign(row, data);
        return row;
      },
    },
    $queryRaw: async () => [],
    $transaction: async (fn) => fn(prisma),
  };
  /**
   * 假的采购单服务：只记录**收到什么**并造出采购单/明细。
   *
   * 收束与建单的真实逻辑在 `purchase-orders.service.ts`（它自己有 20+ 条单测），
   * 这里要验证的是**计划这一侧把什么交给了它**：分组、按组币种、行映射、
   * 以及写进采购明细的 `purchase_plan_item_id` 认领标记。
   */
  const fakeOrders = {
    collectGroups: async (input, placeOrder) => {
      recordedSplit = { input, placeOrder };
      return input.groups.map((group) => ({ input: { ...input, supplier_id: group.supplier_id, currency: group.currency, items: group.items }, prepared: { refs: {}, items: group.items, total: "0" } }));
    },
    createOrdersFromGroups: async (tx, merged, status) => {
      const rows = merged.map((entry) => {
        const order = { id: `po-${createdOrders.length + 1}`, purchaseOrderNo: `PO-20260927-${createdOrders.length + 1}`, currency: entry.input.currency ?? "CNY", status, totalAmount: new Prisma.Decimal("0") };
        createdOrders.push(order);
        for (const item of entry.input.items ?? []) createdOrderItems.push({ id: `poi-${createdOrderItems.length + 1}`, purchaseOrderId: order.id, deletedAt: null, extensionData: item.extension_data, purchaseOrder: { purchaseOrderNo: order.purchaseOrderNo, status, currency: order.currency } });
        return order;
      });
      return rows;
    },
  };
  return { service: new PurchasePlansService(prisma, audit, fakeOrders, { namesOf: async () => new Map([["user-1", "张三"]]) }), plans, planItems, split: () => recordedSplit, createdOrders, createdOrderItems };
}

const bomFixture = { id: "bom-1", orderNo: "SO-1", salesOrderId: "so-1", version: 3, status: "draft", deletedAt: null, salesOrder: { status: "confirmed", deletedAt: null } };
const user = { id: "user-1" };

test("新建：自动带出该 BOM 全部明细行，数量取 BOM 需求量、单价 0、供应商从 BOM 行预填", async () => {
  const { service, planItems } = makeService({
    boms: [bomFixture],
    bomItems: [
      bomRow("bi-1", { materialId: "mat-1", requiredQuantity: "12.5000", supplierId: "sup-1", supplier: { id: "sup-1", supplierCode: "SUP-1", name: "五金厂", isActive: true, deletedAt: null } }),
      bomRow("bi-2", { materialId: "mat-2", requiredQuantity: "3.0000" }),
    ],
  });

  const plan = await service.create({ bom_id: "bom-1" }, user);

  assert.equal(plan.lineCount, 2, "带出全部 BOM 明细行 —— 计划的身份是「这张 BOM 的采购工作面」");
  assert.equal(plan.unorderedCount, 2);
  assert.equal(plan.status, "unordered");
  assert.equal(plan.planNo.startsWith("PP-"), true);
  assert.equal(plan.itemNo, "27621");
  assert.equal(plan.customerName, "流水花扇客户");
  const first = plan.items.find((item) => item.materialId === "mat-1");
  assert.equal(first.quantity, "12.5000");
  assert.equal(first.unitPrice, "0.0000", "单价一律从 0 起（还没询价）");
  assert.equal(first.supplierId, "sup-1", "BOM 上标过的供应商要预填，采购员只处理例外");
  // 快照是落库形状（`get()` 出去的是给人看的 supplierName/supplierCode，不含原始快照）。
  assert.deepEqual(planItems.find((item) => item.materialId === "mat-1").supplierSnapshot, { id: "sup-1", supplierCode: "SUP-1", name: "五金厂" });
  const second = plan.items.find((item) => item.materialId === "mat-2");
  assert.equal(second.supplierId, null);
  assert.equal(planItems.find((item) => item.materialId === "mat-2").supplierSnapshot, Prisma.DbNull, "没有供应商要写 SQL NULL，不是 JSON 的 null 字面量");
});

/**
 * 参考单价预填（2026-10-08，用户：「采购计划要下单需要填写单价，但是BOM表没办法填写单价」）。
 *
 * 口径（用户选定）：BOM 行上手填的参考单价**预填**到计划行的单价，采购员按实际报价改；
 * 没填或填 0 时仍是 0（0 价不能下单，所以 0 与"没填"在这里等价）。币种跟着价一起来 ——
 * 不带币种的话，"计划合计按币种分列"会把一笔美元报价当成人民币。
 */
test("新建：BOM 行上的参考单价预填到计划行（含币种）；没填/填 0 仍是 0 价人民币", async () => {
  const { service, planItems } = makeService({
    boms: [bomFixture],
    bomItems: [
      bomRow("bi-1", { materialId: "mat-1", referenceUnitPrice: new Prisma.Decimal("12.5000"), referenceCurrency: "USD" }),
      bomRow("bi-2", { materialId: "mat-2", referenceUnitPrice: new Prisma.Decimal("0.0000"), referenceCurrency: "USD" }),
      bomRow("bi-3", { materialId: "mat-3" }),
    ],
  });

  const plan = await service.create({ bom_id: "bom-1" }, user);

  assert.equal(plan.lineCount, 3);
  assert.deepEqual(
    planItems.map((item) => [item.unitPrice.toFixed(4), item.currency]),
    [["12.5000", "USD"], ["0.0000", "CNY"], ["0.0000", "CNY"]],
    "第一条带价带币种；填 0 与没填都退回 0 价人民币",
  );
  assert.equal(plan.items[0].unitPrice, "12.5000", "计划详情里也要看得见预填的价（不只是落库值）");
});

test("新建：停用中的 BOM 供应商不预填（预填下去注定在下单时被拒）", async () => {
  const { service, planItems } = makeService({
    boms: [bomFixture],
    bomItems: [bomRow("bi-1", { supplierId: "sup-9", supplier: { id: "sup-9", supplierCode: "SUP-9", name: "停用的厂", isActive: false, deletedAt: null } })],
  });

  const plan = await service.create({ bom_id: "bom-1" }, user);

  assert.equal(plan.items[0].supplierId, null);
  assert.equal(planItems[0].supplierSnapshot, Prisma.DbNull);
});

test("新建：某个 BOM 行的单位解析不到 → 整体 422，不静默跳过那一行", async () => {
  // 静默跳过的表现是「计划少了一个部件」，等发现时采购单已经发出去了 —— 这是漏买的另一种形态。
  const { service } = makeService({
    boms: [bomFixture],
    bomItems: [bomRow("bi-1", { unitId: null, unit: "不存在的单位" })],
  });

  await assert.rejects(
    () => service.create({ bom_id: "bom-1" }, user),
    (error) => error.getResponse().code === "PURCHASE_PLAN_UNIT_UNRESOLVED" && /物料 bi-1/.test(error.getResponse().message),
  );
});

test("新建：单位按名字兜底（BOM 行的 unit_id 为空但有单位名）", async () => {
  const { service } = makeService({ boms: [bomFixture], bomItems: [bomRow("bi-1", { unitId: null, unit: "米" })] });
  const plan = await service.create({ bom_id: "bom-1" }, user);
  assert.equal(plan.items[0].unitId, "unit-m");
});

test("新建：一个 BOM 只能有一份计划（409），并发由数据库部分唯一索引兜底", async () => {
  const { service } = makeService({
    boms: [bomFixture],
    bomItems: [bomRow("bi-1")],
    plans: [{ id: "plan-1", planNo: "PP-20260927-AAAA1111", orderNo: "SO-1", bomId: "bom-1", bomVersion: 3, deletedAt: null }],
  });

  await assert.rejects(
    () => service.create({ bom_id: "bom-1" }, user),
    (error) => error.getResponse().code === "PURCHASE_PLAN_ALREADY_EXISTS" && /PP-20260927-AAAA1111/.test(error.getResponse().message),
  );
});

test("新建：BOM 不存在或所属销售单未确认 → 404", async () => {
  await assert.rejects(
    () => makeService({ missingBom: true }).service.create({ bom_id: "bom-404" }, user),
    (error) => error.getResponse().code === "BOM_NOT_FOUND",
  );
});

test("新建：没给 bom_id → 422（计划必须挂在 BOM 上，这是「一个销售单一份计划」的前提）", async () => {
  await assert.rejects(
    () => makeService().service.create({}, user),
    (error) => error.getResponse().code === "PURCHASE_PLAN_BOM_REQUIRED",
  );
});

test("详情：状态派生 —— 全部未下单 / 部分下单 / 已完成", async () => {
  const plans = [{ id: "plan-1", planNo: "PP-1", orderNo: "SO-1", bomId: "bom-1", bomVersion: 3, deletedAt: null, createdAt: new Date(), updatedAt: new Date(), createdBy: "user-1", updatedBy: "user-1" }];
  const base = { planId: "plan-1", materialId: "mat-1", unitId: "unit-pcs", quantity: "5", deletedAt: null };
  const withLink = (id, link) => ({ id, ...base, purchaseOrderItemId: link });

  const cases = [
    { items: [withLink("i-1", null)], expected: "unordered" },
    { items: [withLink("i-1", "poi-1")], expected: "completed" },
    { items: [withLink("i-1", "poi-1"), withLink("i-2", null)], expected: "partial" },
  ];
  for (const item of cases) {
    const { service } = makeService({ plans, planItems: item.items, purchaseOrderItems: [{ id: "poi-1", purchaseOrderId: "po-1", purchaseOrder: { purchaseOrderNo: "PO-1", status: "ordered" } }] });
    const plan = await service.get("plan-1");
    assert.equal(plan.status, item.expected);
  }
});

test("详情：空计划算「未下单」，不算「已完成」（否则会让人以为这张 BOM 已经买齐了）", async () => {
  const { service } = makeService({ plans: [{ id: "plan-1", planNo: "PP-1", orderNo: "SO-1", bomId: "bom-1", bomVersion: 3, deletedAt: null, createdAt: new Date(), updatedAt: new Date(), createdBy: "u", updatedBy: "u" }] });
  const plan = await service.get("plan-1");
  assert.equal(plan.lineCount, 0);
  assert.equal(plan.status, "unordered");
});

test("详情：已下单的行带出采购单号，未下单的行为空", async () => {
  const plans = [{ id: "plan-1", planNo: "PP-1", orderNo: "SO-1", bomId: "bom-1", bomVersion: 3, deletedAt: null, createdAt: new Date(), updatedAt: new Date(), createdBy: "u", updatedBy: "u" }];
  const { service } = makeService({
    plans,
    planItems: [
      { id: "i-1", planId: "plan-1", materialId: "mat-1", unitId: "unit-pcs", quantity: "5", deletedAt: null, purchaseOrderItemId: "poi-1" },
      { id: "i-2", planId: "plan-1", materialId: "mat-2", unitId: "unit-pcs", quantity: "5", deletedAt: null, purchaseOrderItemId: null },
    ],
    purchaseOrderItems: [{ id: "poi-1", purchaseOrderId: "po-1", purchaseOrder: { purchaseOrderNo: "PO-20260927-1", status: "ordered" } }],
  });

  const plan = await service.get("plan-1");

  assert.equal(plan.items[0].purchaseOrderNo, "PO-20260927-1", "下过的行留在计划里，并且看得见落到了哪张单");
  assert.equal(plan.items[1].purchaseOrderNo, null);
  assert.equal(plan.orderedCount, 1);
  assert.equal(plan.unorderedCount, 1);
});

test("详情：供应商地址/联系人实时联查主数据；供应商停用后仍用快照显示当时记的是哪一家", async () => {
  const plans = [{ id: "plan-1", planNo: "PP-1", orderNo: "SO-1", bomId: "bom-1", bomVersion: 3, deletedAt: null, createdAt: new Date(), updatedAt: new Date(), createdBy: "u", updatedBy: "u" }];
  const { service } = makeService({
    plans,
    planItems: [
      { id: "i-1", planId: "plan-1", materialId: "mat-1", unitId: "unit-pcs", quantity: "5", deletedAt: null, purchaseOrderItemId: null, supplierId: "sup-1", supplierSnapshot: { id: "sup-1", supplierCode: "SUP-1", name: "五金厂" } },
      // 供应商后来被删了：关系为空，但快照还在。
      { id: "i-2", planId: "plan-1", materialId: "mat-2", unitId: "unit-pcs", quantity: "5", deletedAt: null, purchaseOrderItemId: null, supplierId: null, supplierSnapshot: { id: "sup-9", supplierCode: "SUP-9", name: "已删除的厂" } },
    ],
  });

  const plan = await service.get("plan-1");

  assert.equal(plan.items[0].supplierAddress, "浙江省金华市", "地址是主数据的事实，实时联查");
  assert.equal(plan.items[0].supplierContact, "张伟 / 13800000000", "联系人与电话合成一列");
  assert.equal(plan.items[1].supplierName, "已删除的厂", "关系断了也要看得见当时记的是哪一家，否则一保存就把记录抹掉");
});

test("详情：「BOM 比计划多几个物料」按物料比 —— 行 ID 换了也算不出差异，同一物料多行只算一次", async () => {
  const plans = [{ id: "plan-1", planNo: "PP-1", orderNo: "SO-1", bomId: "bom-1", bomVersion: 3, deletedAt: null, createdAt: new Date(), updatedAt: new Date(), createdBy: "u", updatedBy: "u" }];
  const { service } = makeService({
    plans,
    bomItems: [bomRow("bi-new-1", { materialId: "mat-1" }), bomRow("bi-new-2", { materialId: "mat-1" }), bomRow("bi-new-3", { materialId: "mat-9" })],
    planItems: [{ id: "i-1", planId: "plan-1", materialId: "mat-1", unitId: "unit-pcs", quantity: "5", deletedAt: null, purchaseOrderItemId: null, bomItemId: "bi-OLD" }],
  });

  const plan = await service.get("plan-1");

  assert.equal(plan.bomExtraMaterialCount, 1, "mat-9 没进计划；mat-1 在 BOM 里两行但只算一次");
});

test("详情：计划不存在 → 404", async () => {
  await assert.rejects(
    () => makeService().service.get("plan-404"),
    (error) => error.getResponse().code === "PURCHASE_PLAN_NOT_FOUND",
  );
});

test("列表：货号按归一后的键筛（27621 与「27621␠」是同一个货号）", async () => {
  const plans = [
    { id: "plan-1", planNo: "PP-1", orderNo: "SO-1", bomId: "bom-1", bomVersion: 1, deletedAt: null, createdAt: new Date(), updatedAt: new Date(), createdBy: "u", updatedBy: "u" },
    { id: "plan-2", planNo: "PP-2", orderNo: "SO-2", bomId: "bom-2", bomVersion: 1, deletedAt: null, createdAt: new Date(), updatedAt: new Date(), createdBy: "u", updatedBy: "u" },
  ];
  const { service } = makeService({ plans, planItems: [{ id: "i-1", planId: "plan-1", materialId: "mat-1", unitId: "unit-pcs", quantity: "5", deletedAt: null, purchaseOrderItemId: null }] });

  const all = await service.list({ item_no: "27621" });

  assert.deepEqual(all.map((row) => row.planNo).sort(), ["PP-1", "PP-2"], "两个销售单的货号是同一个（一个带尾空格）");
  assert.equal((await service.list({ item_no: "99999" })).length, 0);
});

test("列表：状态筛选与关键词筛选", async () => {
  const plans = [
    { id: "plan-1", planNo: "PP-1", orderNo: "SO-1", bomId: "bom-1", bomVersion: 1, deletedAt: null, createdAt: new Date(), updatedAt: new Date(), createdBy: "u", updatedBy: "u" },
    { id: "plan-2", planNo: "PP-2", orderNo: "SO-2", bomId: "bom-2", bomVersion: 1, deletedAt: null, createdAt: new Date(), updatedAt: new Date(), createdBy: "u", updatedBy: "u" },
  ];
  const { service } = makeService({
    plans,
    planItems: [
      { id: "i-1", planId: "plan-1", materialId: "mat-1", unitId: "unit-pcs", quantity: "5", deletedAt: null, purchaseOrderItemId: "poi-1" },
      { id: "i-2", planId: "plan-2", materialId: "mat-2", unitId: "unit-pcs", quantity: "5", deletedAt: null, purchaseOrderItemId: null },
    ],
    purchaseOrderItems: [{ id: "poi-1", purchaseOrderId: "po-1", purchaseOrder: { purchaseOrderNo: "PO-1", status: "ordered" } }],
  });

  assert.deepEqual((await service.list({ status: "completed" })).map((row) => row.planNo), ["PP-1"]);
  assert.deepEqual((await service.list({ status: "unordered" })).map((row) => row.planNo), ["PP-2"]);
  assert.deepEqual((await service.list({ status: "all" })).length, 2);
  assert.deepEqual((await service.list({ q: "另一个客户" })).map((row) => row.planNo), ["PP-2"], "客户名可以搜");
  assert.deepEqual((await service.list({ q: "pp-1" })).map((row) => row.planNo), ["PP-1"], "计划编号可以搜（大小写不敏感）");
});

test("列表：最后更新带上**人名**（不是 UUID）—— 列表那一列是「人 + 北京时间」", async () => {
  const plans = [{ id: "plan-1", planNo: "PP-1", orderNo: "SO-1", bomId: "bom-1", bomVersion: 1, deletedAt: null, createdAt: new Date(), updatedAt: new Date(), createdBy: "user-1", updatedBy: "user-1" }];
  const { service } = makeService({ plans });

  const [row] = await service.list();

  assert.equal(row.updatedByName, "张三");
  assert.equal(row.createdByName, "张三");
});

test("列表：已经软删的计划不出现", async () => {
  const { service } = makeService({ plans: [{ id: "plan-1", planNo: "PP-1", orderNo: "SO-1", bomId: "bom-1", bomVersion: 1, deletedAt: new Date(), createdAt: new Date(), updatedAt: new Date(), createdBy: "u", updatedBy: "u" }] });
  assert.deepEqual(await service.list(), []);
});

test("候选：只有「已确认销售单 + 未删 BOM + 还没有计划」的 BOM 才出现", async () => {
  const { service } = makeService({
    boms: [
      { id: "bom-1", orderNo: "SO-1", salesOrderId: "so-1", version: 1, deletedAt: null, salesOrder: { orderNo: "SO-1", itemNo: "27621", customerSnapshot: { name: "客户甲" }, deliveryDate: null, status: "confirmed", deletedAt: null } },
      { id: "bom-2", orderNo: "SO-2", salesOrderId: "so-2", version: 1, deletedAt: null, salesOrder: { orderNo: "SO-2", itemNo: null, customerSnapshot: { name: "客户乙" }, deliveryDate: null, status: "confirmed", deletedAt: null } },
      // 销售单还没确认：`salesOrder.status !== "confirmed"`（假 Prisma 的 findMany 会滤掉）
      { id: "bom-3", orderNo: "SO-3", salesOrderId: "so-3", version: 1, deletedAt: null, salesOrder: { orderNo: "SO-3", itemNo: null, customerSnapshot: { name: "客户丙" }, status: "draft", deletedAt: null } },
    ],
    bomItems: [bomRow("bi-1"), bomRow("bi-2")],
    plans: [{ id: "plan-1", planNo: "PP-1", orderNo: "SO-2", bomId: "bom-2", bomVersion: 1, deletedAt: null }],
  });

  const candidates = await service.candidates();

  assert.deepEqual(candidates.map((row) => row.bomId), ["bom-1"], "已经有计划的（bom-2）与未确认销售单的（bom-3）都不该出现在下拉里");
  assert.equal(candidates[0].itemNo, "27621");
  assert.equal(candidates[0].customerName, "客户甲");
});

// ---------------------------------------------------------------------------------------------
// 保存（整体替换 + 已下单行保护 + 乐观锁）与软删。

const SAVED_AT = new Date("2026-09-27T02:00:00Z");
const thePlan = { id: "plan-1", planNo: "PP-1", orderNo: "SO-1", bomId: "bom-1", bomVersion: 3, extensionData: {}, deletedAt: null, createdAt: SAVED_AT, updatedAt: SAVED_AT, createdBy: "u", updatedBy: "u" };
/** 两行：i-ordered 已经下过单（挂在 poi-1），i-free 还没有。 */
function seededItems() {
  return [
    { id: "i-ordered", planId: "plan-1", materialId: "mat-1", unitId: "unit-pcs", supplierId: "sup-1", quantity: new Prisma.Decimal("5.0000"), unitPrice: new Prisma.Decimal("3.5000"), model: null, expectedDate: null, purchaseOrderItemId: "poi-1", bomItemId: "bi-1", deletedAt: null, sequence: 1, extensionData: {} },
    { id: "i-free", planId: "plan-1", materialId: "mat-2", unitId: "unit-pcs", supplierId: null, quantity: new Prisma.Decimal("2.0000"), unitPrice: new Prisma.Decimal("0.0000"), model: null, expectedDate: null, purchaseOrderItemId: null, bomItemId: "bi-2", deletedAt: null, sequence: 2, extensionData: {} },
  ];
}
const bomRows = () => [bomRow("bi-1", { materialId: "mat-1" }), bomRow("bi-2", { materialId: "mat-2" })];
const orderedPoItem = [{ id: "poi-1", purchaseOrderId: "po-1", purchaseOrder: { purchaseOrderNo: "PO-1", status: "ordered" } }];
/** 把一行按前端的方式回传（`id` 带上 = 这是已有行）。 */
const lineOf = (item, overrides = {}) => ({ id: item.id, material_id: item.materialId, unit_id: item.unitId, bom_item_id: item.bomItemId ?? undefined, supplier_id: item.supplierId ?? undefined, quantity: item.quantity.toFixed(4), unit_price: item.unitPrice.toFixed(4), ...overrides });
/** 一行 BOM 外的补料（必须带原因）。 */
const outsideLine = (overrides = {}) => ({ material_id: "mat-3", unit_id: "unit-pcs", quantity: "1.0000", unit_price: "2.0000", extension_data: { outside_bom_reason: "原物料缺货，改用替代料" }, ...overrides });

test("保存：未下单的行整体替换，已下单的行原样留下（含数量不动）", async () => {
  const items = seededItems();
  const { service, planItems } = makeService({ plans: [thePlan], planItems: items, bomItems: bomRows(), purchaseOrderItems: orderedPoItem });

  const updated = await service.update("plan-1", {
    expected_updated_at: SAVED_AT.toISOString(),
    items: [lineOf(items[0]), lineOf(items[1], { quantity: "7.0000", unit_price: "1.5000" }), outsideLine()],
  }, user);

  assert.equal(updated.lineCount, 3);
  assert.equal(updated.orderedCount, 1, "已下单的那一行还在");
  assert.ok(items[1].deletedAt, "未下单的老行是软删的，不是硬删");
  const freshFree = planItems.filter((row) => row.deletedAt === null && row.materialId === "mat-2").pop();
  assert.equal(freshFree.quantity.toString(), "7", "未下单的行被替换成新的数量");
  assert.equal(items[0].quantity.toString(), "5", "已下单的行内容不许被动");
  assert.equal(planItems.filter((row) => row.deletedAt === null).length, 3);
  assert.deepEqual(planItems.filter((row) => row.deletedAt === null).map((row) => row.sequence).sort(), [1, 2, 3]);
});

test("保存：已下单的行没带 id 回来 → 422（不能从计划里悄悄移除一张已经发出的单）", async () => {
  const items = seededItems();
  const { service } = makeService({ plans: [thePlan], planItems: items, bomItems: bomRows(), purchaseOrderItems: orderedPoItem });

  await assert.rejects(
    () => service.update("plan-1", { items: [lineOf(items[1])] }, user),
    (error) => error.getResponse().code === "PURCHASE_PLAN_ORDERED_LINE_REMOVED" && /退回采购计划/.test(error.getResponse().message),
  );
});

test("保存：已下单的行被改内容 → 422，并说清是哪个字段（物料/单位/数量/单价/供应商/型号都要拦）", async () => {
  for (const [field, override] of [["数量", { quantity: "6.0000" }], ["单价", { unit_price: "9.9000" }], ["供应商", { supplier_id: "sup-2" }], ["物料", { material_id: "mat-9" }], ["单位", { unit_id: "unit-m" }], ["型号", { model: "X-1" }]]) {
    const items = seededItems();
    const { service } = makeService({ plans: [thePlan], planItems: items, bomItems: bomRows(), purchaseOrderItems: orderedPoItem });
    await assert.rejects(
      () => service.update("plan-1", { items: [lineOf(items[0], override), lineOf(items[1])] }, user),
      (error) => error.getResponse().code === "PURCHASE_PLAN_ORDERED_LINE_LOCKED" && error.getResponse().message.includes(field),
      `${field} 必须在计划里被锁住 —— 那张单已经发给供应商了，要改得先退回计划`,
    );
  }
});

test("保存：已下单行的**预计到货**可以改，并且同步进采购明细（「预期」不是「既成事实」）", async () => {
  // 口径 7 把采购单页的明细编辑关掉之后，如果这里也锁死，系统里就**再没有任何地方**能改这个日期。
  // 而供应商说"这周到不了、下周到"是每天都发生的事。同步是为了不让同一行有两个预计到货。
  const items = seededItems();
  const poItems = [{ id: "poi-1", purchaseOrderId: "po-1", expectedDate: null, purchaseOrder: { purchaseOrderNo: "PO-1", status: "ordered" } }];
  const { service } = makeService({ plans: [thePlan], planItems: items, bomItems: bomRows(), purchaseOrderItems: poItems });

  await service.update("plan-1", { items: [lineOf(items[0], { expected_date: "2026-10-08" }), lineOf(items[1])] }, user);

  assert.equal(items[0].expectedDate.toISOString().slice(0, 10), "2026-10-08", "计划行记下新的预计到货");
  assert.equal(poItems[0].expectedDate.toISOString().slice(0, 10), "2026-10-08", "采购明细同步，否则采购员拿去跟供应商对的是另一份");
  assert.equal(items[0].quantity.toString(), "5", "同步日期不等于放开了别的列");
});

test("保存：已下单行的**序号**允许重排（序号是展示，不是业务内容）", async () => {
  const items = seededItems();
  const { service, planItems } = makeService({ plans: [thePlan], planItems: items, bomItems: bomRows(), purchaseOrderItems: orderedPoItem });

  await service.update("plan-1", { items: [lineOf(items[1], { quantity: "7.0000" }), lineOf(items[0])] }, user);

  const orderedRow = planItems.find((row) => row.id === "i-ordered");
  assert.equal(orderedRow.sequence, 2, "顺序跟着提交走，行本身没有被替换");
  assert.equal(orderedRow.deletedAt, null);
  assert.equal(orderedRow.quantity.toString(), "5");
});

test("保存：乐观锁 —— 令牌不一致 422 且不写入；一致则通过", async () => {
  const items = seededItems();
  const { service, planItems } = makeService({ plans: [thePlan], planItems: items, bomItems: bomRows(), purchaseOrderItems: orderedPoItem });

  await assert.rejects(
    () => service.update("plan-1", { expected_updated_at: new Date("2026-09-27T05:00:00Z").toISOString(), items: [lineOf(items[0]), lineOf(items[1])] }, user),
    (error) => error.getResponse().code === "PURCHASE_PLAN_UPDATE_CONFLICT",
  );
  assert.equal(items[1].deletedAt, null, "冲突时一个字都不能写");

  await service.update("plan-1", { expected_updated_at: SAVED_AT.toISOString(), items: [lineOf(items[0]), lineOf(items[1])] }, user);
  assert.ok(items[1].deletedAt, "令牌一致就正常保存");
});

test("保存：BOM 行 ID 被换掉之后仍然能保存（按物料找回当前 BOM 的对应行）", async () => {
  // 现场机制：`BomsService.replaceItems` 存一次 BOM 就软删全部旧行 + 建新行，**所有行 ID 都换**。
  // 计划是长期存在的（不像草稿是一次性的），不做这一步的话，BOM 改过一次这份计划**再也存不了**。
  const items = seededItems();
  items[1].bomItemId = "bi-old-2"; // 计划里记的是上一版 BOM 的行 ID
  const { service, planItems } = makeService({ plans: [thePlan], planItems: items, bomItems: bomRows(), purchaseOrderItems: orderedPoItem });

  await service.update("plan-1", { items: [lineOf(items[0]), lineOf(items[1], { bom_item_id: "bi-old-2" })] }, user);

  const fresh = planItems.filter((row) => row.deletedAt === null && row.materialId === "mat-2").pop();
  assert.equal(fresh.bomItemId, "bi-2", "按物料找回当前 BOM 的行号");
});

test("保存：BOM 外的行必须写原因（与采购单同一条规则，在计划这一侧就拦住）", async () => {
  const items = seededItems();
  const { service } = makeService({ plans: [thePlan], planItems: items, bomItems: bomRows(), purchaseOrderItems: orderedPoItem });

  await assert.rejects(
    () => service.update("plan-1", { items: [lineOf(items[0]), outsideLine({ extension_data: {} })] }, user),
    (error) => error.getResponse().code === "PURCHASE_OUTSIDE_BOM_REASON_REQUIRED",
  );
});

test("删除：有任何一行已下单 → 422；全部未下单 → 软删计划与全部行", async () => {
  const withOrder = seededItems();
  const first = makeService({ plans: [thePlan], planItems: withOrder, bomItems: bomRows(), purchaseOrderItems: orderedPoItem });
  await assert.rejects(
    () => first.service.remove("plan-1", user),
    (error) => error.getResponse().code === "PURCHASE_PLAN_HAS_ORDERED_LINES" && /退回采购计划/.test(error.getResponse().message),
  );

  const onlyFree = seededItems().filter((row) => row.purchaseOrderItemId === null);
  const second = makeService({ plans: [Object.assign({}, thePlan)], planItems: onlyFree });
  const result = await second.service.remove("plan-1", user);

  assert.equal(result.deleted, true);
  assert.equal(result.planNo, "PP-1");
  assert.ok(second.plans[0].deletedAt, "计划是软删（还要留痕）");
  assert.ok(onlyFree.every((row) => row.deletedAt), "行一起软删");
  assert.deepEqual(await second.service.list(), [], "删掉的计划不再出现在列表里");
});

test("保存/删除：计划不存在 → 404", async () => {
  await assert.rejects(() => makeService().service.update("plan-404", { items: [] }, user), (error) => error.getResponse().code === "PURCHASE_PLAN_NOT_FOUND");
  await assert.rejects(() => makeService().service.remove("plan-404", user), (error) => error.getResponse().code === "PURCHASE_PLAN_NOT_FOUND");
});

// ---------------------------------------------------------------------------------------------
// 收束下单（T4）：按供应商分组、按组币种、多波次、回写 1:1 链接。

/** 一份两行都还没下单的计划。 */
function freePlanFixture() {
  return {
    plan: { ...thePlan },
    items: [
      { id: "i-1", planId: "plan-1", materialId: "mat-1", unitId: "unit-pcs", supplierId: "sup-1", quantity: new Prisma.Decimal("5.0000"), unitPrice: new Prisma.Decimal("3.5000"), model: "M-9", expectedDate: new Date("2026-10-08T00:00:00Z"), purchaseOrderItemId: null, bomItemId: "bi-1", deletedAt: null, sequence: 1, extensionData: {} },
      { id: "i-2", planId: "plan-1", materialId: "mat-2", unitId: "unit-m", supplierId: "sup-2", quantity: new Prisma.Decimal("2.0000"), unitPrice: new Prisma.Decimal("1.0000"), model: null, expectedDate: null, purchaseOrderItemId: null, bomItemId: "bi-2", deletedAt: null, sequence: 2, extensionData: {} },
    ],
  };
}

test("收束下单：两个供应商 → 两张采购单（按组币种），计划行的链接被回写、状态变成已完成", async () => {
  const { plan, items } = freePlanFixture();
  const s = makeService({ plans: [plan], planItems: items, bomItems: bomRows() });

  const result = await s.service.order("plan-1", {
    groups: [{ supplier_id: "sup-1", currency: "CNY", items: ["i-1"] }, { supplier_id: "sup-2", currency: "USD", items: ["i-2"] }],
  }, user);

  assert.equal(result.orders.length, 2, "一个供应商一张单");
  assert.deepEqual(result.orders.map((order) => order.currency), ["CNY", "USD"], "币种按组给（口径 10）");
  assert.equal(result.plan.status, "completed");
  assert.equal(items[0].purchaseOrderItemId, "poi-1", "链接回写 = 这一行已下单");
  assert.equal(items[1].purchaseOrderItemId, "poi-2");
  assert.equal(result.plan.items[0].purchaseOrderNo, "PO-20260927-1", "计划里看得见落到了哪张单");
  assert.equal(s.split().placeOrder, true, "交给采购单服务的必须是下单态");
  // 落成**已下单**而不是草稿。这一条是用户 2026-09-30 问的「采购计划下单之后，能不能自动流转到
  // 采购单那边去」的核心：草稿不在采购单列表的范围里（`LISTED_PURCHASE_STATUSES`），
  // 落成草稿就等于"下了单但采购单模块里看不见"，而界面上不会有任何报错。
  assert.deepEqual(s.createdOrders.map((order) => order.status), ["ordered", "ordered"], "两张单都要是已下单态，才看得见");
  assert.deepEqual(s.createdOrders.map((order) => order.purchaseOrderNo), ["PO-20260927-1", "PO-20260927-2"], "计划行回写的采购单号就是这两张");
});

test("多波次：只下一部分行，其余留在计划里，状态是部分下单", async () => {
  const { plan, items } = freePlanFixture();
  const s = makeService({ plans: [plan], planItems: items, bomItems: bomRows() });

  const result = await s.service.order("plan-1", { groups: [{ supplier_id: "sup-1", currency: "CNY", items: ["i-1"] }] }, user);

  assert.equal(result.orders.length, 1);
  assert.equal(items[0].purchaseOrderItemId, "poi-1");
  assert.equal(items[1].purchaseOrderItemId, null, "没勾的行留在计划里 —— 分批下单是采购现实");
  assert.equal(result.plan.status, "partial");
  assert.equal(result.plan.unorderedCount, 1);
});

test("收束下单：行映射带上物料/单位/数量/单价/型号/预计到货，并写 purchase_plan_item_id 认领标记", async () => {
  const { plan, items } = freePlanFixture();
  const s = makeService({ plans: [plan], planItems: items, bomItems: bomRows() });

  await s.service.order("plan-1", { groups: [{ supplier_id: "sup-1", currency: "CNY", items: ["i-1"] }] }, user);

  const sent = s.split().input.groups[0].items[0];
  assert.equal(sent.material_id, "mat-1");
  assert.equal(sent.unit_id, "unit-pcs");
  assert.equal(sent.quantity, "5.0000");
  assert.equal(sent.unit_price, "3.5000");
  assert.equal(sent.model, "M-9");
  assert.equal(sent.expected_date, new Date("2026-10-08T00:00:00Z").toISOString(), "行级预计到货要带过去");
  assert.equal(sent.supplier_id, "sup-1", "组供应商盖到每一行（一个供应商一张单）");
  assert.equal(sent.extension_data.purchase_plan_item_id, "i-1", "认领标记：不靠嵌套 create 的返回顺序");
  assert.equal(sent.extension_data.purchase_plan_no, "PP-1");
});

test("收束下单：组里没选供应商 / 空组 / 一个组都没有 → 422", async () => {
  const cases = [
    [{ groups: [] }, "PURCHASE_PLAN_ORDER_GROUPS_REQUIRED"],
    [{ groups: [{ currency: "CNY", items: ["i-1"] }] }, "PURCHASE_PLAN_ORDER_SUPPLIER_REQUIRED"],
    [{ groups: [{ supplier_id: "sup-1", items: [] }] }, "PURCHASE_PLAN_ORDER_ITEMS_REQUIRED"],
  ];
  for (const [body, code] of cases) {
    const { plan, items } = freePlanFixture();
    const s = makeService({ plans: [plan], planItems: items, bomItems: bomRows() });
    await assert.rejects(() => s.service.order("plan-1", body, user), (error) => error.getResponse().code === code, code);
  }
});

test("收束下单：已下过单的行、不属于本计划的行、被分到两组同一行 → 422", async () => {
  // 已下过单
  const a = freePlanFixture();
  a.items[0].purchaseOrderItemId = "poi-1";
  await assert.rejects(
    () => makeService({ plans: [a.plan], planItems: a.items, bomItems: bomRows(), purchaseOrderItems: orderedPoItem }).service.order("plan-1", { groups: [{ supplier_id: "sup-1", items: ["i-1"] }] }, user),
    (error) => error.getResponse().code === "PURCHASE_PLAN_ORDER_LINE_ALREADY_ORDERED",
  );
  // 不属于本计划
  const b = freePlanFixture();
  await assert.rejects(
    () => makeService({ plans: [b.plan], planItems: b.items, bomItems: bomRows() }).service.order("plan-1", { groups: [{ supplier_id: "sup-1", items: ["i-999"] }] }, user),
    (error) => error.getResponse().code === "PURCHASE_PLAN_ORDER_LINE_INVALID",
  );
  // 同一行分两组
  const c = freePlanFixture();
  await assert.rejects(
    () => makeService({ plans: [c.plan], planItems: c.items, bomItems: bomRows() }).service.order("plan-1", { groups: [{ supplier_id: "sup-1", items: ["i-1"] }, { supplier_id: "sup-2", items: ["i-1"] }] }, user),
    (error) => error.getResponse().code === "PURCHASE_PLAN_ORDER_LINE_DUPLICATE",
  );
});

test("收束下单：计划里记的是上一版 BOM 的行 ID → 按物料找回当前行 ID 再下单", async () => {
  // 不这么做的话，`refs()` 会以 PURCHASE_BOM_ITEM_MISMATCH 拒绝整张单 ——
  // 而 BOM 被改过一次是常态（存一次 BOM 就换掉全部行 ID）。
  const { plan, items } = freePlanFixture();
  items[0].bomItemId = "bi-old-1";
  const s = makeService({ plans: [plan], planItems: items, bomItems: bomRows() });

  await s.service.order("plan-1", { groups: [{ supplier_id: "sup-1", items: ["i-1"] }] }, user);

  assert.equal(s.split().input.groups[0].items[0].bom_item_id, "bi-1");
});

test("收束下单：物料已经不在 BOM 里、又没写「BOM 外新增原因」→ 422 且说清要先在计划里补原因", async () => {
  const { plan, items } = freePlanFixture();
  items[0].materialId = "mat-gone";
  items[0].bomItemId = "bi-old-gone";
  const s = makeService({ plans: [plan], planItems: items, bomItems: bomRows() });

  await assert.rejects(
    () => s.service.order("plan-1", { groups: [{ supplier_id: "sup-1", items: ["i-1"] }] }, user),
    (error) => error.getResponse().code === "PURCHASE_OUTSIDE_BOM_REASON_REQUIRED" && /BOM 外新增原因/.test(error.getResponse().message),
  );
});

// ---------------------------------------------------------------------------------------------
// 退回采购计划（T5）：可逆、不丢数据、与既有不变式同一条线。

/** 一张已下单（无到货）的采购单，它的明细 poi-1 被计划行 i-1 认领着。 */
function orderedOrderFixture({ bomId = "bom-1", status = "ordered", receipts = [] } = {}) {
  return {
    id: "po-1", purchaseOrderNo: "PO-1", orderNo: "SO-1", bomId, status, deletedAt: null,
    // 采购单头的币种是 NOT NULL（一张单一个币种）。退回时镜像出来的计划行要沿用它。
    currency: "CNY",
    items: [{
      id: "poi-1", purchaseOrderId: "po-1", materialId: "mat-1", unitId: "unit-pcs", supplierId: "sup-1",
      quantity: new Prisma.Decimal("5.0000"), unitPrice: new Prisma.Decimal("3.5000"), model: "M-9", expectedDate: null,
      bomItemId: "bi-1", materialSnapshot: { id: "mat-1", name: "物料 1" }, unitSnapshot: { id: "unit-pcs", name: "个" },
      supplierSnapshot: { id: "sup-1", name: "五金厂" }, extensionData: {}, deletedAt: null, receipts,
    }],
  };
}
/** 计划行：i-1 已经下单（认领着 poi-1），i-2 还没下。 */
const linkItems = () => [
  { id: "i-1", planId: "plan-1", materialId: "mat-1", unitId: "unit-pcs", supplierId: "sup-1", quantity: new Prisma.Decimal("5.0000"), unitPrice: new Prisma.Decimal("3.5000"), model: "M-9", expectedDate: null, purchaseOrderItemId: "poi-1", bomItemId: "bi-1", deletedAt: null, sequence: 1, extensionData: {} },
  { id: "i-2", planId: "plan-1", materialId: "mat-2", unitId: "unit-pcs", supplierId: null, quantity: new Prisma.Decimal("2.0000"), unitPrice: new Prisma.Decimal("0.0000"), model: null, expectedDate: null, purchaseOrderItemId: null, bomItemId: "bi-2", deletedAt: null, sequence: 2, extensionData: {} },
];

test("退回采购计划：断开链接、单作废、数据全留（可逆，不用重录）", async () => {
  audit.events.length = 0;
  const order = orderedOrderFixture();
  const items = linkItems();
  const s = makeService({ plans: [{ ...thePlan }], planItems: items, purchaseOrders: [order], bomItems: bomRows() });

  const result = await s.service.revertPurchaseOrder("po-1", "供应商说做不了", user);

  assert.equal(items[0].purchaseOrderItemId, null, "行回到未下单 —— 数量/单价/供应商都还在");
  assert.equal(items[0].quantity.toString(), "5");
  assert.equal(items[0].unitPrice.toString(), "3.5");
  assert.equal(items[0].supplierId, "sup-1");
  assert.equal(order.status, "cancelled", "那张单作废（不进采购单列表，审计里留痕）");
  assert.ok(order.items[0].deletedAt, "明细软删，不是硬删");
  assert.equal(result.planNo, "PP-1");
  assert.equal(result.returnedLineCount, 1);
  assert.equal(result.restoredLineCount, 0);
  assert.equal(s.planItems.length, 2, "没有多出计划行");
  const record = audit.events.find((args) => args[0] === "purchase_order.revert_to_plan");
  assert.ok(record, "留一条审计");
  assert.equal(record[4].reason, "供应商说做不了");
  assert.equal(record[4].purchase_order_no, "PO-1");
});

test("退回采购计划：已有到货事实 / 状态不是已下单 → 422，且什么都没写", async () => {
  for (const [label, order] of [
    ["有到货", orderedOrderFixture({ receipts: [{ id: "gr-1" }] })],
    ["部分到货", orderedOrderFixture({ status: "partially_arrived" })],
    ["到货完成", orderedOrderFixture({ status: "arrived_complete" })],
    ["已取消", orderedOrderFixture({ status: "cancelled" })],
  ]) {
    const items = linkItems();
    const statusBefore = order.status;
    const s = makeService({ plans: [{ ...thePlan }], planItems: items, purchaseOrders: [order], bomItems: bomRows() });
    await assert.rejects(
      () => s.service.revertPurchaseOrder("po-1", "想退", user),
      (error) => error.getResponse().code === "PURCHASE_ORDER_NOT_REVERTIBLE",
      label,
    );
    assert.equal(items[0].purchaseOrderItemId, "poi-1", `${label}：一个字都不该写`);
    assert.equal(order.status, statusBefore, `${label}：状态不能变`);
    assert.equal(order.items[0].deletedAt, null, `${label}：明细不能被动`);
  }
});

test("退回采购计划：没有 BOM / 原因为空 / 单不存在 → 各自的错误码", async () => {
  const blank = makeService({ plans: [{ ...thePlan }], planItems: linkItems(), purchaseOrders: [orderedOrderFixture()], bomItems: bomRows() });
  await assert.rejects(() => blank.service.revertPurchaseOrder("po-1", "   ", user), (error) => error.getResponse().code === "CORRECTION_REASON_REQUIRED");

  const noBom = makeService({ plans: [{ ...thePlan }], planItems: linkItems(), purchaseOrders: [orderedOrderFixture({ bomId: null })], bomItems: bomRows() });
  await assert.rejects(() => noBom.service.revertPurchaseOrder("po-1", "想退", user), (error) => error.getResponse().code === "PURCHASE_ORDER_WITHOUT_BOM_NOT_REVERTIBLE");

  const missing = makeService({ purchaseOrders: [] });
  await assert.rejects(() => missing.service.revertPurchaseOrder("po-404", "想退", user), (error) => error.getResponse().code === "PURCHASE_ORDER_NOT_FOUND");
});

test("退回采购计划：计划不存在时**自动补建**一份（历史单也能退回）", async () => {
  const order = orderedOrderFixture();
  const s = makeService({ plans: [], planItems: [], purchaseOrders: [order], bomItems: bomRows(), boms: [bomFixture] });

  const result = await s.service.revertPurchaseOrder("po-1", "历史单退回", user);

  assert.equal(s.plans.length, 1, "补建一份计划");
  assert.match(result.planNo, /^PP-\d{8}-/);
  assert.ok(s.planItems.length >= 1, "补建的计划带上了这张 BOM 的需求行");
  assert.equal(order.status, "cancelled");
});

test("退回采购计划：BOM 已被软删、销售单已关闭也照样能退（不把唯一的出路堵死）", async () => {
  const order = orderedOrderFixture();
  const softDeletedBom = { ...bomFixture, deletedAt: new Date("2026-09-20"), salesOrder: { status: "closed", deletedAt: null } };
  const s = makeService({ plans: [], planItems: [], purchaseOrders: [order], bomItems: [], boms: [softDeletedBom] });

  const result = await s.service.revertPurchaseOrder("po-1", "这批不做了", user);

  assert.match(result.planNo, /^PP-\d{8}-/);
  assert.equal(result.restoredLineCount, 1, "BOM 行没了，退回的明细以镜像行落进计划");
  assert.equal(s.planItems[0].materialId, "mat-1");
});

test("退回采购计划：历史单的明细没有计划行认领 → 按原值镜像成新的计划行（不丢采购员填过的数据）", async () => {
  // 2026-09-27 之前建的已下单采购单没有计划行链接。退回时不能只是作废那张单 ——
  // 那等于"这批货不用买了"，而用户的意思是"回到计划里重来"。
  const order = orderedOrderFixture();
  const s = makeService({ plans: [{ ...thePlan }], planItems: [], purchaseOrders: [order], bomItems: bomRows() });

  const result = await s.service.revertPurchaseOrder("po-1", "下错了", user);

  assert.equal(result.restoredLineCount, 1);
  const restored = s.planItems.find((row) => row.materialId === "mat-1");
  assert.equal(restored.quantity.toString(), "5", "数量照搬");
  assert.equal(restored.unitPrice.toString(), "3.5", "单价照搬");
  assert.equal(restored.supplierId, "sup-1", "供应商照搬");
  assert.equal(restored.bomItemId, "bi-1");
  assert.equal(restored.purchaseOrderItemId ?? null, null, "镜像出来的行是未下单的");
  assert.equal(restored.extensionData.restored_from_reverted_order, "PO-1", "留一条来路");
});

test("详情：老快照没有地址/联系人也不炸（2026-09-27 之前的供应商快照只有 id/name）", async () => {
  // BOM 明细行 / 采购明细的快照形状变过；计划的读侧对"快照里没有那一格"必须容忍，
  // 否则一条历史行会让整页 500。
  const plans = [{ id: "plan-1", planNo: "PP-1", orderNo: "SO-1", bomId: "bom-1", bomVersion: 3, deletedAt: null, createdAt: new Date(), updatedAt: new Date(), createdBy: "u", updatedBy: "u" }];
  const legacyItem = { id: "i-1", planId: "plan-1", materialId: "mat-1", unitId: "unit-pcs", quantity: new Prisma.Decimal("5"), deletedAt: null, purchaseOrderItemId: null, supplierId: null, supplierSnapshot: { name: "老快照的五金厂" } };
  const { service } = makeService({ plans, planItems: [legacyItem], bomItems: [] });

  const plan = await service.get("plan-1");

  assert.equal(plan.items[0].supplierName, "老快照的五金厂");
  assert.equal(plan.items[0].supplierAddress, null, "老快照没有地址 → null，不是抛错");
  assert.equal(plan.items[0].supplierContact, null);
  assert.equal(plan.items[0].supplierCode, null);
});

test("软删之后可以再建一份同 BOM 的计划（部分唯一索引存在的理由）", async () => {
  // 全量唯一索引会让"软删一份计划之后再建一份"直接撞约束 —— 那正是要允许的操作
  // （录错了删掉重来）。数据库侧靠 `purchase_plans_bom_id_active_key ... WHERE deleted_at IS NULL`，
  // 服务侧的"已存在"检查也必须只看未删的那一份。
  const { plan, items } = freePlanFixture();
  const s = makeService({ plans: [plan], planItems: items, bomItems: [bomRow("bi-1", { materialId: "mat-1" }), bomRow("bi-2", { materialId: "mat-2" })], boms: [bomFixture] });

  await s.service.remove("plan-1", user);
  const rebuilt = await s.service.create({ bom_id: "bom-1" }, user);

  assert.notEqual(rebuilt.id, "plan-1");
  assert.equal(s.plans.filter((row) => row.deletedAt === null).length, 1, "未删的计划只有新的那一份");
});

// ---------------------------------------------------------------------------------------------
// 口径纯函数（domain）：状态派生、编号格式、BOM 差异计数。

test("domain：状态派生的边界", () => {
  assert.equal(planStatusOf(0, 0), "unordered", "空计划是「未下单」，不是「已完成」");
  assert.equal(planStatusOf(2, 2), "unordered");
  assert.equal(planStatusOf(2, 1), "partial");
  assert.equal(planStatusOf(2, 0), "completed");
});

test("domain：计划编号与采购单号同格式，前缀 PP", () => {
  assert.equal(purchasePlanNo(new Date("2026-09-27T10:00:00Z"), "ab12cd34"), "PP-20260927-AB12CD34");
  assert.match(purchasePlanNo(), /^PP-\d{8}-[0-9A-F]{8}$/);
});

test("domain：BOM 差异计数按物料去重", () => {
  assert.equal(countBomMaterialsMissingFromPlan(["m1", "m1", "m2"], ["m1"]), 1);
  assert.equal(countBomMaterialsMissingFromPlan([], []), 0);
  assert.equal(countBomMaterialsMissingFromPlan(["m1"], ["m1", "m2"]), 0, "计划里有 BOM 没有的行（补料）不算差异");
});

// ---------------------------------------------------------------------------------------------
// 金额口径（T01/T02/T03，2026-09-30）：
// 用户原话「针对当前的采购计划，要求添加价格字段，单价，总价。不然财务没法付钱。」
//
// 三件必须钉住的事：
//   1. 行总价与计划合计都是**派生**的（数量 × 单价），不落列 —— 落列就会有第二个真源；
//   2. 合计**按币种分列**（仓库约定「金额不跨币种合计」）：一张计划里既有人民币行又有美元行时，
//      加成一个数得到的是没有会计意义的数，而它看起来是对的；
//   3. **单价 0 的行不能下单** —— 上面那条「财务没法付钱」指的正是这个：BOM 带出来的行单价是 0，
//      原来只校验「不为负」，于是 0 元采购单 → 0 元应付，而全链路不报错。

test("domain：行总价 = 数量 × 单价（Decimal 精度，不走浮点）", () => {
  assert.equal(planLineAmount("5.0000", "3.5000").toFixed(4), "17.5000");
  // 0.1 + 0.2 那种浮点误差在这里必须不存在：金额是拿来对账的。
  assert.equal(planLineAmount(new Prisma.Decimal("0.1"), new Prisma.Decimal("3")).toFixed(4), "0.3000");
  assert.equal(planLineAmount("2", "1.1111").toFixed(4), "2.2222");
});

test("domain：计划合计按币种分组，绝不跨币种相加", () => {
  const rows = [
    { quantity: "5", unitPrice: "3.5000", currency: "USD" },
    { quantity: "2", unitPrice: "1.0000", currency: "CNY" },
    { quantity: "3", unitPrice: "2.0000", currency: "USD" },
  ];
  assert.deepEqual(sumPlanAmounts(rows), [
    { currency: "CNY", amount: "2.0000" },
    { currency: "USD", amount: "23.5000" },
  ], "美元那两行加起来是 23.5，不能与人民币的 2 合成 25.5");
  // 币种缺省按人民币算（`NOT NULL DEFAULT 'CNY'` 的读侧兜底），空输入不返回一行假合计。
  assert.deepEqual(sumPlanAmounts([{ quantity: "1", unitPrice: "9", currency: null }]), [{ currency: DEFAULT_PLAN_CURRENCY, amount: "9.0000" }]);
  assert.deepEqual(sumPlanAmounts([]), []);
});

test("详情/列表：返回按币种分列的金额，并分出「未下单金额」", async () => {
  const { service } = makeService({
    plans: [{ ...thePlan }],
    planItems: [
      { id: "i-1", planId: "plan-1", materialId: "mat-1", unitId: "unit-pcs", supplierId: "sup-1", quantity: new Prisma.Decimal("5"), unitPrice: new Prisma.Decimal("3.5"), currency: "CNY", deletedAt: null, purchaseOrderItemId: "poi-1", bomItemId: "bi-1" },
      { id: "i-2", planId: "plan-1", materialId: "mat-2", unitId: "unit-pcs", supplierId: "sup-2", quantity: new Prisma.Decimal("2"), unitPrice: new Prisma.Decimal("10"), currency: "USD", deletedAt: null, purchaseOrderItemId: null, bomItemId: "bi-2" },
    ],
    bomItems: bomRows(),
    purchaseOrderItems: [{ id: "poi-1", purchaseOrderId: "po-1", purchaseOrder: { purchaseOrderNo: "PO-1", status: "ordered", currency: "CNY" } }],
  });

  const plan = await service.get("plan-1");

  // 5 × 3.5 = 17.5（人民币，已下单）；2 × 10 = 20（美元，未下单）
  assert.deepEqual(plan.amounts, [{ currency: "CNY", amount: "17.5000" }, { currency: "USD", amount: "20.0000" }], "计划合计 = 全部行");
  assert.deepEqual(plan.unorderedAmounts, [{ currency: "USD", amount: "20.0000" }], "还要花多少 = 只有未下单的行");
  const line = plan.items.find((item) => item.id === "i-2");
  assert.equal(line.amount, "20.0000", "行总价 = 数量 × 单价");
  assert.equal(line.currency, "USD");

  const [row] = await service.list();
  assert.deepEqual(row.amounts, plan.amounts, "列表与详情必须是同一口径（同一个纯函数）");
  assert.deepEqual(row.unorderedAmounts, plan.unorderedAmounts);
});

test("详情：每行都带上币种，老行没有值时兜底人民币（列是 NOT NULL DEFAULT 'CNY'）", async () => {
  const { service } = makeService({
    plans: [{ ...thePlan }],
    planItems: [{ id: "i-legacy", planId: "plan-1", materialId: "mat-1", unitId: "unit-pcs", quantity: new Prisma.Decimal("5"), unitPrice: new Prisma.Decimal("3.5"), deletedAt: null, purchaseOrderItemId: null, bomItemId: "bi-1" }],
    bomItems: bomRows(),
  });

  const plan = await service.get("plan-1");

  assert.equal(plan.items[0].currency, "CNY");
  assert.equal(plan.items[0].amount, "17.5000");
});

/**
 * 已有计划拿到 BOM 参考单价的路径（2026-10-08 第二轮）。
 *
 * 用户原话：「为什么BOM表保存了单价之后，采购计划显示不了单价，下单不了」——
 * 根因是计划为**建立时的快照**，BOM 之后填的价不会回头进已有计划。修法：详情把**当前 BOM 的参考单价**
 * 随行下发（只读），由前端对「未下单 + 单价还是 0」的行预填；落库仍只在保存计划时。
 * 这里钉的是取数侧：按**物料**匹配（BOM 存一次行 ID 全换）、没填/为 0/不在 BOM 上时给 null。
 */
test("详情：随行下发 BOM 上的参考单价（按物料匹配；没填、为 0、物料不在 BOM 上都给 null）", async () => {
  const { service } = makeService({
    plans: [{ ...thePlan }],
    planItems: [
      { id: "i-1", planId: "plan-1", materialId: "mat-1", unitId: "unit-pcs", quantity: new Prisma.Decimal("5"), unitPrice: new Prisma.Decimal("0"), deletedAt: null, purchaseOrderItemId: null, bomItemId: "bi-OLD" },
      { id: "i-2", planId: "plan-1", materialId: "mat-2", unitId: "unit-pcs", quantity: new Prisma.Decimal("2"), unitPrice: new Prisma.Decimal("0"), deletedAt: null, purchaseOrderItemId: null, bomItemId: "bi-2" },
      { id: "i-3", planId: "plan-1", materialId: "mat-3", unitId: "unit-pcs", quantity: new Prisma.Decimal("1"), unitPrice: new Prisma.Decimal("0"), deletedAt: null, purchaseOrderItemId: null, bomItemId: null },
      { id: "i-4", planId: "plan-1", materialId: "mat-4", unitId: "unit-pcs", quantity: new Prisma.Decimal("1"), unitPrice: new Prisma.Decimal("0"), deletedAt: null, purchaseOrderItemId: null, bomItemId: null },
    ],
    bomItems: [
      // 计划里记的是上一版 BOM 的行 ID（bi-OLD）：必须按**物料**找回当前那一行。
      bomRow("bi-new-1", { materialId: "mat-1", referenceUnitPrice: new Prisma.Decimal("12.5000"), referenceCurrency: "USD" }),
      // 填了 0 = 还没谈价：与没填一样，不下发（前端据此跳过预填）。
      bomRow("bi-2", { materialId: "mat-2", referenceUnitPrice: new Prisma.Decimal("0.0000"), referenceCurrency: "USD" }),
      // 有价但没填币种：兜底人民币（与计划行同一套默认值）。
      bomRow("bi-3", { materialId: "mat-3", referenceUnitPrice: new Prisma.Decimal("7.0000") }),
      // mat-4 不在 BOM 上（补料/替代料）：没有参考价。
    ],
  });

  const plan = await service.get("plan-1");
  const byMaterial = new Map(plan.items.map((item) => [item.materialId, item]));

  assert.equal(byMaterial.get("mat-1").bomReferenceUnitPrice, "12.5000", "按物料匹配：BOM 存一次行 ID 就全换了");
  assert.equal(byMaterial.get("mat-1").bomReferenceCurrency, "USD");
  assert.equal(byMaterial.get("mat-2").bomReferenceUnitPrice, null, "参考价 0 = 还没谈价");
  assert.equal(byMaterial.get("mat-3").bomReferenceUnitPrice, "7.0000");
  assert.equal(byMaterial.get("mat-3").bomReferenceCurrency, "CNY", "没填币种时兜底人民币");
  assert.equal(byMaterial.get("mat-4").bomReferenceUnitPrice, null, "不在 BOM 上的行没有参考价");
  // 只读：它不改变计划行自己的单价（唯一真源仍是 unitPrice，落库只在保存计划时）。
  assert.equal(byMaterial.get("mat-1").unitPrice, "0.0000");
});

test("详情：BOM 被软删时不下发参考单价（那份 BOM 已经不是当前事实）", async () => {
  const { service } = makeService({
    plans: [{ ...thePlan }],
    planItems: [{ id: "i-1", planId: "plan-1", materialId: "mat-1", unitId: "unit-pcs", quantity: new Prisma.Decimal("5"), unitPrice: new Prisma.Decimal("0"), deletedAt: null, purchaseOrderItemId: null, bomItemId: "bi-1" }],
    bomItems: [bomRow("bi-1", { materialId: "mat-1", referenceUnitPrice: new Prisma.Decimal("12.5000"), referenceCurrency: "USD" })],
    bomDeleted: true,
  });

  const plan = await service.get("plan-1");
  assert.equal(plan.items[0].bomReferenceUnitPrice, null);
  assert.equal(plan.bomDeleted, true, "前提：这一份计划确实挂在一张已删的 BOM 上");
});

test("收束下单：按供应商组选的币种**写回**这一组的每一行（一次输入、两处记录）", async () => {
  const { plan, items } = freePlanFixture();
  const s = makeService({ plans: [plan], planItems: items, bomItems: bomRows() });

  await s.service.order("plan-1", { groups: [{ supplier_id: "sup-1", currency: "CNY", items: ["i-1"] }, { supplier_id: "sup-2", currency: "USD", items: ["i-2"] }] }, user);

  assert.deepEqual(items.map((row) => row.currency), ["CNY", "USD"], "写回之后，已下单行的币种永远等于那张采购单的币种");
  const after = await s.service.get("plan-1");
  // 5 × 3.5 = 17.5（人民币那张单）；2 × 1 = 2（美元那张单）
  assert.deepEqual(after.amounts, [{ currency: "CNY", amount: "17.5000" }, { currency: "USD", amount: "2.0000" }]);
});

test("收束下单：单价 0 的行不能下单（BOM 带出来的行单价就是 0）", async () => {
  // 这条链原来是能走通的：计划行单价 0 → 采购单总额 0 → 到货入库 → 应付金额 0（应付 = 入库数量 × 单价）
  // → 财务收到一条没法付的应付，而全链路没有任何一处报错。
  const { plan, items } = freePlanFixture();
  items[0].unitPrice = new Prisma.Decimal("0");
  const s = makeService({ plans: [plan], planItems: items, bomItems: bomRows() });

  await assert.rejects(
    () => s.service.order("plan-1", { groups: [{ supplier_id: "sup-1", currency: "CNY", items: ["i-1"] }] }, user),
    (error) => error.getResponse().code === "PURCHASE_PLAN_PRICE_REQUIRED"
      && /第 1 行/.test(error.getResponse().message)
      && /单价/.test(error.getResponse().message),
  );
  assert.equal(s.createdOrders.length, 0, "校验在写之前：一张采购单都不该建出来");
  assert.equal(s.split(), null, "连收束校验都不该走到");
  assert.equal(items[0].purchaseOrderItemId, null);
});

test("保存：未下单行的币种从库里带过来（行是整体替换的，不能把美元重置成人民币）", async () => {
  const items = seededItems();
  items[1].currency = "USD";
  const { service, planItems } = makeService({ plans: [thePlan], planItems: items, bomItems: bomRows(), purchaseOrderItems: orderedPoItem });

  await service.update("plan-1", { expected_updated_at: SAVED_AT.toISOString(), items: [lineOf(items[0]), lineOf(items[1], { unit_price: "1.5000" })] }, user);

  const fresh = planItems.filter((row) => row.deletedAt === null && row.materialId === "mat-2").pop();
  assert.equal(fresh.currency, "USD", "客户端不传币种，服务端要从老行带过来");
  assert.equal(fresh.unitPrice.toString(), "1.5", "带币种不等于放开了别的内容");
});

test("保存：新建的行默认人民币（币种不由客户端决定）", async () => {
  const items = seededItems();
  // 就算调用方硬塞一个 currency，也不该被采纳 —— `PlanItemDto` 里根本没有这个字段。
  const forged = { ...outsideLine({ extension_data: { outside_bom_reason: "缺货替代" } }), currency: "JPY" };
  const { service, planItems } = makeService({ plans: [thePlan], planItems: items, bomItems: bomRows(), purchaseOrderItems: orderedPoItem });

  await service.update("plan-1", { expected_updated_at: SAVED_AT.toISOString(), items: [lineOf(items[0]), lineOf(items[1]), forged] }, user);

  const created = planItems.filter((row) => row.deletedAt === null).find((row) => row.materialId === "mat-3");
  assert.equal(created.currency, DEFAULT_PLAN_CURRENCY, "新行一律默认人民币，币种只在下单时由服务端写回");
});
