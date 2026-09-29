// 返单建单（T05）：复制语义 + 三条守卫 + 预览接口。
//
// 老板原话：「以后客户返单，从系统里面调取，返单客户货号不变。可以调取该货号。」
// 设计：docs/design/reorder-item-no-and-summary-2026-09-26.md §三.1、§五
// 口径：**复制「这一单卖的是什么」，不复制「卖多少 / 什么时候交 / 走到哪了 / 由数量派生的金额」**。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { UnprocessableEntityException, NotFoundException } = require("@nestjs/common");
const { Prisma } = require("@prisma/client");
const { SalesOrdersService, SPEC_SCALAR_FIELDS } = require("../../dist/modules/sales/sales-orders.service.js");

const user = { id: "1f7d261d-0089-4d32-9aa1-19942c41cb1d", username: "sales", display_name: "销售测试" };
const recorded = [];
const audit = { create: () => ({ createdBy: user.id, updatedBy: user.id }), update: () => ({ updatedBy: user.id }), record: async (...arguments_) => { recorded.push(arguments_); } };

/** 来源单：已关闭、有货号、带 37 个细化标量（只填关心的几个，其余为 undefined）。 */
function sourceOrder(overrides = {}) {
  return {
    id: "source-1", orderNo: "DL260001-1", status: "closed", itemNo: "27621 流水花扇",
    customerId: "customer-1", contactId: null, productName: "50cm*5K 三折手开碳纤维伞", productSpec: "50cm*5K",
    unit: "支", currency: "USD", customerPoNo: "PO#32366-1", externalContractNo: "EXT-1",
    unitPrice: new Prisma.Decimal("1.2"), settlementUnitPrice: new Prisma.Decimal("1.15"),
    taxRate: new Prisma.Decimal("0.13"), settlementMethod: "tt", quantity: new Prisma.Decimal("1960"),
    deliveryDate: new Date("2026-07-30T00:00:00.000Z"), orderDate: new Date("2026-06-18T00:00:00.000Z"),
    totalAmount: new Prisma.Decimal("2352"), receivableAmount: new Prisma.Decimal("2254"), localCurrencyAmount: new Prisma.Decimal("16300"),
    extensionData: { source: "老单" }, currentVersion: 3, reorderFromOrderNo: null,
    ribSpec: "双碳纤骨", canopySpec: "30D 全遮光", qcRequirement: "所有材料都要质检报告",
    fabricUsageCanopy: new Prisma.Decimal("1.2"), attentionNote: "注意防水线",
    specDetails: [
      { groupName: "伞布明细", name: "27621 流水花扇PKGY", color: "PKGY", barcode: null, quantity: new Prisma.Decimal("100"), unit: "pcs", sortOrder: 0 },
      { groupName: "伞布明细", name: "27622 流水花扇PKBK", color: "PKBK", barcode: "690123", quantity: new Prisma.Decimal("200"), unit: "pcs", sortOrder: 1 },
    ],
    materialRefs: [{ specKey: "rib_spec", materialId: "material-1", material: { id: "material-1", materialCode: "MAT-1", name: "伞骨", specificationModel: "58cm", color: null, image: null } }],
    ...overrides,
  };
}

/** 返单建单的假 Prisma：来源单与「建完再 get 一次」共用同一个 findFirst。 */
function createHarness(source, created = {}, options = {}) {
  const existingMaterials = options.existingMaterials ?? ["material-1"];
  const captured = { createData: undefined, versionData: undefined, specDetailRows: undefined, refRows: undefined };
  const createdRow = { id: "order-new", orderNo: "DL260300-1", status: "draft", currentVersion: 1, customerId: "customer-1", extensionData: {}, orderDate: new Date(), productName: "伞", quantity: "10", unit: "支", currency: "USD", contactId: null, boms: [], versions: [], specDetails: [], ...created };
  const tx = {
    salesOrder: { create: async ({ data }) => { captured.createData = data; return createdRow; } },
    salesOrderVersion: { create: async ({ data }) => { captured.versionData = data; return data; } },
    salesOrderSpecDetail: { updateMany: async () => ({}), createMany: async ({ data }) => { captured.specDetailRows = data; return { count: data.length }; } },
    salesOrderMaterialRef: { findMany: async () => [], update: async () => ({}), createMany: async ({ data }) => { captured.refRows = data; return { count: data.length }; } },
  };
  const prisma = {
    customer: { findFirst: async () => ({ id: "customer-1", customerCode: "CUS-1", name: "家百纳", isActive: true }) },
    customerContact: { findFirst: async () => null },
    // 材料引用要过 assertMaterialsExist：引用的物料必须真实存在（默认全部存在）。
    material: { findMany: async ({ where }) => existingMaterials.filter((id) => where.id.in.includes(id)).map((id) => ({ id })) },
    salesOrder: { findFirst: async () => (captured.createData ? { ...createdRow, customer: { id: "customer-1" }, contact: null } : source) },
    $transaction: async (fn) => fn(tx),
  };
  return { service: new SalesOrdersService(prisma, audit), captured, createdRow };
}

/** 返单请求的最小载荷：**只给必须重填的四个键**（数量/下单日/交期 + 新单号），其它全靠复制。 */
const reorderRequest = { order_no: "DL260300-1", order_date: "2026-09-26T00:00:00.000Z", quantity: "2500", delivery_date: "2026-11-30T00:00:00.000Z", reorder_from_order_no: "DL260001-1" };

// ------------------------------------------------------------------ 三条守卫

test("返单守卫：来源不存在或已删除 → 404 REORDER_SOURCE_NOT_FOUND", async () => {
  const service = new SalesOrdersService({ salesOrder: { findFirst: async () => null } }, audit);
  await assert.rejects(
    () => service.create({ ...reorderRequest }, user),
    (error) => error instanceof NotFoundException && error.getResponse().code === "REORDER_SOURCE_NOT_FOUND",
  );
});

test("返单守卫：草稿来源 → 422 REORDER_SOURCE_NOT_CONFIRMED（草稿还没下给工厂）", async () => {
  for (const status of ["draft", "something_new"]) {
    const { service } = createHarness(sourceOrder({ status }));
    await assert.rejects(
      () => service.create({ ...reorderRequest }, user),
      (error) => error instanceof UnprocessableEntityException && error.getResponse().code === "REORDER_SOURCE_NOT_CONFIRMED",
    );
  }
});

test("返单守卫：来源没有货号 → 422 REORDER_SOURCE_ITEM_NO_MISSING，文案带单号", async () => {
  const { service } = createHarness(sourceOrder({ itemNo: null }));
  await assert.rejects(
    () => service.create({ ...reorderRequest }, user),
    (error) => {
      const response = error.getResponse();
      return error instanceof UnprocessableEntityException && response.code === "REORDER_SOURCE_ITEM_NO_MISSING" && response.message.includes("DL260001-1");
    },
  );
});

test("返单守卫：已确认单与已关闭单都可以作为来源", async () => {
  for (const status of ["confirmed", "closed"]) {
    const { service, captured } = createHarness(sourceOrder({ status }));
    await service.create({ ...reorderRequest }, user);
    assert.equal(captured.createData.reorderFromOrderNo, "DL260001-1", `${status} 应可作为返单来源`);
  }
});

// ------------------------------------------------------------------ 复制什么

test("返单复制：货号沿用来源（老板要求「返单客户货号不变」）", async () => {
  const { service, captured } = createHarness(sourceOrder());
  await service.create({ ...reorderRequest }, user);
  assert.equal(captured.createData.itemNo, "27621 流水花扇");
  assert.equal(captured.createData.reorderFromOrderNo, "DL260001-1");
  assert.equal(captured.versionData.snapshot.item_no, "27621 流水花扇", "v1 快照也要记货号");
  assert.equal(captured.versionData.snapshot.reorder_from_order_no, "DL260001-1", "v1 快照要记来源（回看时能回答从哪返的）");
});

test("返单复制：37 个细化标量**逐键**都带过来（抽查 3 个不够，漏一个就是纸上少一行）", async () => {
  const { service, captured } = createHarness(sourceOrder());
  await service.create({ ...reorderRequest }, user);
  assert.equal(captured.createData.ribSpec, "双碳纤骨");
  assert.equal(captured.createData.canopySpec, "30D 全遮光");
  assert.equal(captured.createData.qcRequirement, "所有材料都要质检报告");
  assert.equal(captured.createData.attentionNote, "注意防水线");
  assert.equal(String(captured.createData.fabricUsageCanopy), "1.2");
  // 快照里每个细化键都在（没填的记 null）——与普通建单同一口径。
  for (const [key] of SPEC_SCALAR_FIELDS) assert.ok(key in captured.versionData.snapshot, `快照缺 ${key}`);
});

test("返单复制：明细行与材料引用整块带过来", async () => {
  const { service, captured } = createHarness(sourceOrder());
  await service.create({ ...reorderRequest }, user);
  assert.equal(captured.specDetailRows.length, 2);
  assert.equal(captured.specDetailRows[0].groupName, "伞布明细");
  assert.equal(captured.specDetailRows[0].name, "27621 流水花扇PKGY");
  assert.equal(String(captured.specDetailRows[0].quantity), "100");
  assert.equal(captured.specDetailRows[1].barcode, "690123");
  assert.deepEqual(captured.refRows.map((row) => [row.specKey, row.materialId]), [["rib_spec", "material-1"]]);
});

test("返单复制：客户/产品/单位/币种/结算口径带过来，请求给了就按请求的（前端可改）", async () => {
  const { service, captured } = createHarness(sourceOrder());
  await service.create({ ...reorderRequest }, user);
  assert.equal(captured.createData.customerId, "customer-1");
  assert.equal(captured.createData.productName, "50cm*5K 三折手开碳纤维伞");
  assert.equal(captured.createData.unit, "支");
  assert.equal(captured.createData.currency, "USD");
  assert.equal(captured.createData.unitPrice, "1.2");
  assert.equal(captured.createData.settlementUnitPrice, "1.15");
  assert.equal(captured.createData.taxRate, "0.13");
  assert.equal(captured.createData.settlementMethod, "tt");
  assert.deepEqual(captured.createData.extensionData, { source: "老单" });

  const overridden = createHarness(sourceOrder());
  await overridden.service.create({ ...reorderRequest, unit_price: "1.35", product_spec: "50cm*5K 加强" }, user);
  assert.equal(overridden.captured.createData.unitPrice, "1.35", "请求给了单价就用请求的");
  assert.equal(overridden.captured.createData.productSpec, "50cm*5K 加强");
});

// ------------------------------------------------------------------ 不复制什么

test("返单不复制：数量/下单日/交期用请求的值（必须重填）", async () => {
  const { service, captured } = createHarness(sourceOrder());
  await service.create({ ...reorderRequest }, user);
  assert.equal(captured.createData.quantity, "2500");
  assert.equal(captured.createData.orderDate.toISOString(), "2026-09-26T00:00:00.000Z");
  assert.equal(captured.createData.deliveryDate.toISOString(), "2026-11-30T00:00:00.000Z");
  assert.notEqual(captured.createData.quantity, "1960", "绝不能悄悄沿用旧数量");
});

test("返单不复制：由数量派生的三个金额（总额/应收/本币）—— 抄过来必然与新数量矛盾", async () => {
  const { service, captured } = createHarness(sourceOrder());
  await service.create({ ...reorderRequest }, user);
  assert.equal(captured.createData.totalAmount, undefined);
  assert.equal(captured.createData.receivableAmount, undefined);
  assert.equal(captured.createData.localCurrencyAmount, undefined);
});

test("返单不复制：状态与版本 —— 新单从 draft / v1 开始", async () => {
  const { service, captured } = createHarness(sourceOrder());
  await service.create({ ...reorderRequest }, user);
  assert.equal(captured.createData.status, undefined, "不显式写状态，由数据库默认 draft");
  assert.equal(captured.createData.currentVersion, undefined, "版本从默认 1 开始（不继承来源的 v3）");
  assert.equal(captured.versionData.version, 1);
});

test("返单不复制：来源单本身零改动（版本数/状态/明细都没被碰）", async () => {
  const source = sourceOrder();
  const { service } = createHarness(source);
  await service.create({ ...reorderRequest }, user);
  assert.equal(source.currentVersion, 3, "来源单的版本号不该被改写");
  assert.equal(source.status, "closed");
  assert.equal(source.specDetails.length, 2);
  assert.equal(source.itemNo, "27621 流水花扇");
});

test("返单：不带 reorder_from_order_no 时行为与普通建单完全一致", async () => {
  const source = sourceOrder();
  const { service, captured } = createHarness(source);
  await service.create({ order_no: "DL260400-1", customer_id: "customer-1", order_date: "2026-09-26T00:00:00.000Z", product_name: "普通单", quantity: "10", unit: "支", currency: "USD" }, user);
  assert.equal(captured.createData.reorderFromOrderNo, null);
  assert.equal(captured.createData.itemNo, null);
  assert.equal(captured.createData.productName, "普通单");
});

// ------------------------------------------------------------------ 审计与预览

test("返单：审计事件带上来源单号（返单链的第二个落点）", async () => {
  recorded.length = 0;
  const { service } = createHarness(sourceOrder());
  await service.create({ ...reorderRequest }, user);
  const event = recorded.find(([action]) => action === "sales_order.create");
  assert.ok(event, "必须写 sales_order.create 审计");
  assert.equal(event[4].order_no, "DL260300-1");
  assert.equal(event[4].reorder_from_order_no, "DL260001-1");
});

test("预览：返回会带过来什么、必须重填什么、以及要复核的警告", async () => {
  const { service } = createHarness(sourceOrder());
  const preview = await service.reorderPreview("DL260001-1");
  assert.equal(preview.source_order_no, "DL260001-1");
  assert.equal(preview.source_order_id, "source-1");
  assert.equal(preview.item_no, "27621 流水花扇");
  assert.deepEqual(preview.must_fill, ["order_no", "order_date", "quantity", "delivery_date"]);
  assert.equal(preview.copy.product_name, "50cm*5K 三折手开碳纤维伞");
  assert.equal(preview.copy.unit_price, "1.2");
  assert.equal(preview.copy.rib_spec, "双碳纤骨");
  assert.equal(preview.copy.spec_details.length, 2);
  assert.deepEqual(preview.copy.material_refs.map((ref) => [ref.spec_key, ref.material_id]), [["rib_spec", "material-1"]]);
  assert.equal(preview.copy.material_refs[0].material.name, "伞骨", "引用要带物料摘要：前端才能显示「引的是哪个物料」");
  assert.equal("quantity" in preview.copy, false, "数量不在「会带过来」里 —— 它必须重填");
  assert.equal("total_amount" in preview.copy, false);
  assert.ok(preview.warnings.some((warning) => warning.includes("单价沿用上次")), "单价沿用必须给警告");
  assert.ok(preview.warnings.some((warning) => warning.includes("应收金额")), "金额不沿用要说清");
});

test("预览：三条守卫与建单**共用**同一个判定（预览能过，建单才可能过）", async () => {
  for (const [overrides, code] of [[{ status: "draft" }, "REORDER_SOURCE_NOT_CONFIRMED"], [{ itemNo: null }, "REORDER_SOURCE_ITEM_NO_MISSING"]]) {
    const { service } = createHarness(sourceOrder(overrides));
    await assert.rejects(
      () => service.reorderPreview("DL260001-1"),
      (error) => error.getResponse().code === code,
      `预览必须与建单给出同一个拒绝理由（${code}）`,
    );
  }
});

test("返单：来源单引用了已删除的物料时，剔掉那一格而不是把整张单卡死", async () => {
  // 物料主数据可以被删，而几年前的来源单可能引用过它。不过滤的话整张返单会被一个
  // 用户看不见的旧引用卡死（assertMaterialsExist 抛 MATERIAL_NOT_FOUND，还叫人「重选」——
  // 而复制的这条路上根本没有重选这个动作）。
  const { service, captured } = createHarness(sourceOrder(), {}, { existingMaterials: [] });
  const result = await service.create({ ...reorderRequest }, user);
  assert.equal(captured.refRows, undefined, "过期引用不该被写进去");
  assert.ok(Array.isArray(result.reorder_warnings), "剔掉了就要回报，不能静默");
  assert.match(result.reorder_warnings[0], /rib_spec/);
});

test("返单：请求自己带了 material_refs 就不过滤 —— 缺物料要当场报错，让用户在界面上重选", async () => {
  const { service, captured } = createHarness(sourceOrder(), {}, { existingMaterials: [] });
  await assert.rejects(
    () => service.create({ ...reorderRequest, material_refs: [{ spec_key: "rib_spec", material_id: "gone-1" }] }, user),
    (error) => error instanceof NotFoundException && error.getResponse().code === "MATERIAL_NOT_FOUND",
  );
  // 断言「引用没被写进去」而不是「订单没被创建」：真实实现里 `salesOrder.create` 与引用校验
  // 在**同一个事务**里，先后顺序是 create → 校验，靠回滚保证不落库；
  // 假 tx 不会回滚，所以拿 createData 判"没落库"会得出错误结论。
  assert.equal(captured.refRows, undefined, "引用校验没过，就不该写引用行");
});

test("预览：路由顺序 —— reorder-preview 必须声明在 :id 之前", () => {
  const source = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "..", "src", "modules", "sales", "sales-orders.controller.ts"), "utf8");
  const preview = source.indexOf('@Get("reorder-preview")');
  const byId = source.indexOf('@Get(":id") async');
  assert.ok(preview > 0, "reorder-preview 路由必须存在");
  assert.ok(preview < byId, "Nest 按声明顺序匹配：reorder-preview 必须在 :id 之前");
});
