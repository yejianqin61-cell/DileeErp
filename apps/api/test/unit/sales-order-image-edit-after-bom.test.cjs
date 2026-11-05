// 已确认销售单「建立 BOM 之后还能编辑图片」（2026-11-05 第二轮）。
//
// 用户原话：「希望在销售单确认后，在系统的 BOM 表中也可以编辑图片。而且当前换图和删除图片都不能实现」，
// 进一步澄清：「不是在 BOM 表里面，而是建立了 BOM 表之后，还能编辑销售单中的图片」。
//
// ## 根因
//
// 编辑器每次保存都把整份表单发上来（11 个核心字段 + 37 个细化标量）：因为「空串 = 清除这一格」
// 必须表达得出来，所以前端不能只发"改过的键"。而旧守卫的判定是
// `coreFields.some((field) => input[field] !== undefined)` —— 请求里带了键就算改核心字段。
// 于是：**只改了图片**的保存也被当成改核心字段 → 一旦有 BOM（非空壳）就被
// `SALES_ORDER_CORE_FIELDS_LOCKED` 挡住 → 换图/删图怎么点都存不上。
//
// ## 本文件钉住什么
//
//   ① 确认单 + 有明细的 BOM + 核心字段**原值整份回传** + 只改图片 → 保存成功，且**一次下游查询都不发**；
//   ② 同一个数量用不同写法（`100` vs `100.0000`）不算改动；
//   ③ 真改了数量 → 仍 422，且一个字段都不写（锁该生效时照旧生效）；
//   ④ 纯函数 `coreFieldsActuallyChanged` 的比较口径（空值/空白/Decimal 规范写法/未传的键）。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { UnprocessableEntityException } = require("@nestjs/common");
const { Prisma } = require("@prisma/client");
const { SalesOrdersService, coreFieldsActuallyChanged } = require("../../dist/modules/sales/sales-orders.service.js");

const user = { id: "00000000-0000-0000-0000-0000000000bb", username: "sales" };
const ORDER_ID = "11111111-1111-1111-1111-111111111111";
const BOM_ID = "22222222-2222-2222-2222-222222222222";
const ORDER_NO = "SO-IMG-1";

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
    quantity: new Prisma.Decimal("100"),
    unit: "支",
    deliveryDate: null,
    currency: "USD",
    unitPrice: new Prisma.Decimal("8.5"),
    totalAmount: new Prisma.Decimal("850"),
    taxRate: new Prisma.Decimal("0.13"),
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
    boms: [{ id: BOM_ID, version: 1, status: "draft" }],
    specDetails: [],
    materialRefs: [],
    materialExtras: [],
    slotImages: [],
    ...overrides,
  };
}

/** 与 orderRow 同值的 11 个核心字段（模拟编辑器整份回传）。 */
const SAME_CORE_FIELDS = {
  product_name: "三折伞",
  product_spec: null,
  quantity: "100",
  unit: "支",
  currency: "USD",
  unit_price: "8.5",
  total_amount: "850",
  tax_rate: "0.13",
  settlement_unit_price: null,
  receivable_amount: null,
  local_currency_amount: null,
};

function createHarness({ order = {}, bomItemCount = 3 } = {}) {
  const state = orderRow(order);
  const calls = { orderUpdates: [], versionCreates: [], purchases: [], productions: [], bomQueries: [], slotCreates: [], records: [] };
  const audit = {
    create: () => ({ createdBy: user.id, updatedBy: user.id }),
    update: () => ({ updatedBy: user.id }),
    softDelete: () => ({ deletedAt: new Date(), deletedBy: user.id, updatedBy: user.id }),
    record: async (...args) => { calls.records.push(args); },
  };
  const tx = {
    salesOrder: { update: async ({ data }) => { calls.orderUpdates.push(data); Object.assign(state, data); return state; } },
    salesOrderVersion: { create: async ({ data }) => { calls.versionCreates.push(data); return data; } },
    salesOrderImage: {
      // assertOrderImages 按「本单 + 这批 id」查；cleanupOrphanImages 按「本单全部图」查（这里返回空 → 直接返回）。
      findMany: async (args) => (Array.isArray(args.where?.id?.in) ? args.where.id.in.map((id) => ({ id })) : []),
    },
    salesOrderSlotImage: {
      findMany: async () => [],
      update: async () => ({}),
      createMany: async ({ data }) => { calls.slotCreates.push(...data); return { count: data.length }; },
    },
    // 这次请求不带明细 / 引用 / 「其它」：服务层应当直接 return，列在这里只是让替身像 Prisma。
    salesOrderSpecDetail: { updateMany: async () => ({ count: 0 }), createMany: async () => ({ count: 0 }), findMany: async () => [] },
    salesOrderMaterialRef: { findMany: async () => [], update: async () => ({}), createMany: async () => ({ count: 0 }) },
    salesOrderMaterialExtra: { updateMany: async () => ({ count: 0 }), createMany: async () => ({ count: 0 }), findMany: async () => [] },
    // 只有「真改核心字段」时才会走到 releaseEmptyShellBoms；这些计数被调用就说明守卫被触发了。
    purchaseOrder: { count: async (args) => { calls.purchases.push(args); return 0; } },
    productionOrder: { count: async (args) => { calls.productions.push(args); return 0; } },
    bom: {
      findMany: async (args) => { calls.bomQueries.push(args); return state.boms.map((row) => ({ id: row.id })); },
      findFirst: async () => ({ id: BOM_ID, orderNo: ORDER_NO, version: 1, status: "draft" }),
      count: async () => state.boms.length,
    },
    bomItem: { count: async () => bomItemCount, updateMany: async () => ({ count: 0 }) },
    purchasePlan: { findFirst: async () => null },
    purchasePlanItem: { count: async () => 0 },
  };
  const prisma = {
    salesOrder: { findFirst: async () => state },
    customer: { findFirst: async () => ({ id: "customer-1", customerCode: "CUS-1", name: "客户", isActive: true }) },
    customerContact: { findFirst: async () => null },
    $transaction: async (fn) => fn(tx),
  };
  return { service: new SalesOrdersService(prisma, audit), calls, state };
}

// ================================================================== ① 只改图片（核心字段原值整份回传）→ 放行

test("确认单 + 有明细的 BOM + 只改图片：核心字段原值回传不算改动，保存成功且一次下游查询都不发", async () => {
  const harness = createHarness();
  const result = await harness.service.update(ORDER_ID, {
    ...SAME_CORE_FIELDS,
    reason: "客户补了 3 张样照",
    slot_images: [{ spec_key: "rib_spec", image_ids: ["img-new-1", "img-new-2"] }],
  }, user);

  // 真的写下去了（不是"报成功但没改"）。
  assert.equal(harness.calls.orderUpdates.length, 1);
  assert.equal(harness.calls.versionCreates[0].version, 4);
  assert.equal(harness.calls.slotCreates.length, 2, "两格图按 slot_index 落库");
  assert.equal(result.id, ORDER_ID);

  // 核心字段没变 → 不该跑 BOM/采购/生产那道守卫（它只为「要重算下游」的改动存在）。
  assert.deepEqual(harness.calls.purchases, []);
  assert.deepEqual(harness.calls.productions, []);
  assert.deepEqual(harness.calls.bomQueries, []);
});

test("核心字段用不同写法表示同一个值（100 vs 100.0000、null vs 缺省）不算改动", async () => {
  const harness = createHarness();
  await harness.service.update(ORDER_ID, {
    ...SAME_CORE_FIELDS,
    quantity: "100.0000",
    total_amount: "850.0000",
    product_spec: "",
    reason: "只换图",
    slot_images: [{ spec_key: "canopy_spec", image_ids: ["img-9"] }],
  }, user);

  assert.equal(harness.calls.orderUpdates.length, 1);
  assert.deepEqual(harness.calls.purchases, [], "写法差异不该触发下游锁");
});

// ================================================================== ② 真改核心字段 → 锁照旧生效

test("确认单 + 有明细的 BOM + 真改数量：仍 422 SALES_ORDER_CORE_FIELDS_LOCKED，且没有任何写", async () => {
  const harness = createHarness();
  await assert.rejects(
    () => harness.service.update(ORDER_ID, { ...SAME_CORE_FIELDS, quantity: "120", reason: "客户加量" }, user),
    (error) => {
      assert.ok(error instanceof UnprocessableEntityException);
      const body = error.getResponse();
      assert.equal(body.code, "SALES_ORDER_CORE_FIELDS_LOCKED");
      assert.match(body.message, /3 项明细/);
      assert.match(body.message, /【采购 → BOM表】/);
      return true;
    },
  );
  assert.deepEqual(harness.calls.orderUpdates, [], "被挡时一个字段都不许写");
  assert.deepEqual(harness.calls.versionCreates, []);
});

test("确认单 + 有明细的 BOM + 只改单价 0.01：能识别为真改动并挡住", async () => {
  const harness = createHarness();
  await assert.rejects(
    () => harness.service.update(ORDER_ID, { ...SAME_CORE_FIELDS, unit_price: "8.51", reason: "调价" }, user),
    (error) => error.getResponse().code === "SALES_ORDER_CORE_FIELDS_LOCKED",
  );
  assert.deepEqual(harness.calls.orderUpdates, []);
});

// ================================================================== ③ 纯函数口径

test("coreFieldsActuallyChanged：按值判定，兼容空值/空白/Decimal 规范写法/未传的键", () => {
  const current = { productName: "三折伞", productSpec: null, quantity: new Prisma.Decimal("100"), unit: "支", currency: "USD", unitPrice: new Prisma.Decimal("8.5"), totalAmount: null, taxRate: null, settlementUnitPrice: null, receivableAmount: null, localCurrencyAmount: null };

  assert.equal(coreFieldsActuallyChanged(current, {}), false, "一个核心字段都没传 = 没改");
  assert.equal(coreFieldsActuallyChanged(current, { product_name: " 三折伞 ", product_spec: "" }), false, "首尾空白与 null/空串同义");
  assert.equal(coreFieldsActuallyChanged(current, { quantity: "100.0000", unit_price: "8.5000" }), false, "同一个数的不同写法不算改");
  assert.equal(coreFieldsActuallyChanged(current, { quantity: "100.5" }), true, "数量真变了");
  assert.equal(coreFieldsActuallyChanged(current, { unit_price: "8.51" }), true, "单价真变了");
  assert.equal(coreFieldsActuallyChanged(current, { product_name: "直杆伞" }), true, "品名真变了");
  assert.equal(coreFieldsActuallyChanged(current, { total_amount: "850" }), true, "null → 有值 是改动");
  assert.equal(coreFieldsActuallyChanged(current, { settlement_unit_price: null }), false, "null → null 不是改动");
});
