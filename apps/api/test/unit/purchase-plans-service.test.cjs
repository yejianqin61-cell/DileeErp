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
const { planStatusOf, purchasePlanNo, countBomMaterialsMissingFromPlan } = require("../../dist/modules/procurement/purchase-plans.domain.js");

const audit = {
  create: () => ({ createdBy: "user-1", updatedBy: "user-1" }),
  update: () => ({ updatedBy: "user-1" }),
  softDelete: () => ({ deletedAt: new Date("2026-09-27T03:00:00Z"), deletedBy: "user-1" }),
  record: async () => {},
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
});

/**
 * 组装服务。
 *
 * 假 Prisma **按 where 真的过滤**（不是无脑返回全部）：本文件要验证的正是
 * 「只用已确认销售单的 BOM」「排除已有计划的 BOM」「排除已软删的计划」这几条查询口径，
 * 一个恒返回全部数据的桩会把断言变成永远通过。
 */
function makeService({ boms = [], bomItems = [], plans = [], planItems = [], purchaseOrderItems = [], missingBom = false } = {}) {
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

  const hydrateItem = (item) => ({
    ...item,
    // 真 Prisma 的 Decimal 列读出来是 Decimal 对象（`toFixed` 是它的方法），假 Prisma 要一样。
    quantity: new Prisma.Decimal(item.quantity ?? "0"),
    unitPrice: new Prisma.Decimal(item.unitPrice ?? "0"),
    material: materialOf(item.materialId),
    unit: units.find((unit) => unit.id === item.unitId) ?? null,
    supplier: item.supplierId ? { id: item.supplierId, supplierCode: "SUP-1", name: "五金厂", contactName: "张伟", phone: "13800000000", address: "浙江省金华市", isActive: true, deletedAt: null } : null,
    purchaseOrderItem: item.purchaseOrderItemId ? orderItemById.get(item.purchaseOrderItemId) ?? null : null,
  });
  const hydratePlan = (plan) => ({
    ...plan,
    salesOrder: salesOrders.get(plan.orderNo) ?? null,
    bom: { id: plan.bomId, version: plan.bomVersion ?? 1, status: "draft", deletedAt: null },
    items: planItems.filter((item) => item.planId === plan.id && item.deletedAt === null).map(hydrateItem),
  });

  const prisma = {
    bom: {
      findFirst: async ({ where }) => {
        if (missingBom) return null;
        if (where.id) return boms.find((bom) => bom.id === where.id && bom.deletedAt === null) ?? null;
        return boms[0] ?? null;
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
        const hit = planItems.filter((row) => row.planId === where.planId && row.deletedAt === null && (where.purchaseOrderItemId === null ? row.purchaseOrderItemId === null : true));
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
    },
    $queryRaw: async () => [],
    $transaction: async (fn) => fn(prisma),
  };
  return { service: new PurchasePlansService(prisma, audit), plans, planItems };
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
