// 销售单「普通复制」快照（`GET /sales-orders/:id/copy-snapshot`）。
//
// 用户原话：「就是订单描述基本差不多，可以直接用原有的复制，然后我们改下单号和里面的细节就行了」。
//
// 与返单（`sales-order-reorder.test.cjs`）的关系：**复制清单是同一份**，差别只有用户拍板的三处口径：
//   1. 任何状态都能复制（含草稿）—— 草稿也放行，因为复制不是"拿一张下过工厂的单再返"；
//   2. 不要求货号 —— 普通复制不归组，货号不是前提；
//   3. **不记来源** —— 新建载荷里不写 `reorder_from_order_no`，否则新单会被归进返单分组，
//      销售会以为这是客户返单。这一条是本文件里最要紧的断言。
//
// 另外钉住：数量/下单日/交期/订单号与由数量派生的金额三兄弟**不带**；失效物料引用**剔掉并回报**。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { NotFoundException } = require("@nestjs/common");
const { Prisma } = require("@prisma/client");
const { SalesOrdersService, SPEC_SCALAR_FIELDS } = require("../../dist/modules/sales/sales-orders.service.js");

const audit = { create: () => ({ createdBy: "u1", updatedBy: "u1" }), update: () => ({ updatedBy: "u1" }), record: async () => {} };

/**
 * 来源单夹具。
 *
 * 默认取**最容易踩坑的那一版**：`status: "draft"` + `itemNo: null` —— 返单会在这两处直接拒掉，
 * 普通复制必须照样能复制（这正是两者口径的差别，用默认值钉住比每条用例各写一遍可靠）。
 */
function sourceOrder(overrides = {}) {
  return {
    id: "source-1", orderNo: "DL260001-1", status: "draft", itemNo: null,
    customerId: "customer-1", contactId: "contact-1", customerSnapshot: { id: "customer-1", name: "家百纳" },
    productName: "50cm*5K 三折手开碳纤维伞", productSpec: "50cm*5K",
    unit: "支", currency: "USD", customerPoNo: "PO#32366-1", externalContractNo: "EXT-1",
    unitPrice: new Prisma.Decimal("1.2"), settlementUnitPrice: new Prisma.Decimal("1.15"), taxRate: new Prisma.Decimal("0.13"),
    settlementMethod: "tt", quantity: new Prisma.Decimal("1960"),
    orderDate: new Date("2026-06-18T00:00:00.000Z"), deliveryDate: new Date("2026-07-30T00:00:00.000Z"),
    totalAmount: new Prisma.Decimal("2352"), receivableAmount: new Prisma.Decimal("2254"), localCurrencyAmount: new Prisma.Decimal("16300"),
    extensionData: { source: "老单" }, currentVersion: 3, reorderFromOrderNo: null,
    ribSpec: "双碳纤骨", canopySpec: "30D 全遮光", qcRequirement: "所有材料都要质检报告",
    fabricUsageCanopy: new Prisma.Decimal("1.2"), attentionNote: "注意防水线",
    // 明细列名的自定义覆盖（属于工艺口径的一部分，跟着来源单）。
    specDetailLabels: { name: "品番" },
    specDetails: [
      { groupName: "伞布明细", name: "27621 流水花扇PKGY", color: "PKGY", barcode: null, quantity: new Prisma.Decimal("100"), unit: "pcs", sortOrder: 0 },
      { groupName: "伞布明细", name: "27622 流水花扇PKBK", color: "PKBK", barcode: "690123", quantity: new Prisma.Decimal("200"), unit: "pcs", sortOrder: 1 },
    ],
    materialRefs: [
      { specKey: "rib_spec", materialId: "material-1", material: { id: "material-1", materialCode: "MAT-1", name: "伞骨", specificationModel: "58cm", color: null, image: null } },
      { specKey: "handle_spec", materialId: "material-gone", material: { id: "material-gone", materialCode: "MAT-2", name: "伞头", specificationModel: null, color: null, image: null } },
    ],
    materialExtras: [
      { label: "弹簧", content: "5cm 不锈钢", materialId: "material-1", sortOrder: 0, material: { id: "material-1", materialCode: "MAT-1", name: "伞骨", specificationModel: "58cm", color: null, image: null } },
      { label: "胶袋", content: "按上次那批", materialId: "material-gone", sortOrder: 1, material: { id: "material-gone", materialCode: "MAT-2", name: "伞头", specificationModel: null, color: null, image: null } },
    ],
    ...overrides,
  };
}

/** 只读快照：假 Prisma 只需要「查来源单」与「查物料是否存在」两条。 */
function createHarness(source, options = {}) {
  const existingMaterials = options.existingMaterials ?? ["material-1"];
  const prisma = {
    salesOrder: { findFirst: async () => source },
    material: { findMany: async ({ where }) => existingMaterials.filter((id) => where.id.in.includes(id)).map((id) => ({ id })) },
  };
  return { service: new SalesOrdersService(prisma, audit) };
}

// ------------------------------------------------------------------ 三处口径差别

test("普通复制：任何状态都能复制（草稿也放行）—— 与返单的三条守卫无关", async () => {
  for (const status of ["draft", "confirmed", "closed", "whatever_new"]) {
    const { service } = createHarness(sourceOrder({ status }));
    const snapshot = await service.copySnapshot("source-1");
    assert.equal(snapshot.source_status, status);
    assert.equal(snapshot.source_order_no, "DL260001-1");
    assert.equal(snapshot.copy.product_name, "50cm*5K 三折手开碳纤维伞", `${status} 应可复制`);
  }
});

test("普通复制：没有货号也能复制（货号只是照抄，不是前提）", async () => {
  const { service } = createHarness(sourceOrder({ itemNo: null }));
  const snapshot = await service.copySnapshot("source-1");
  assert.equal(snapshot.copy.item_no, null);

  const withItemNo = createHarness(sourceOrder({ itemNo: "27621 流水花扇" }));
  assert.equal((await withItemNo.service.copySnapshot("source-1")).copy.item_no, "27621 流水花扇", "有货号就照抄");
});

test("普通复制：**不记来源** —— 快照里根本没有 reorder_from_order_no 这个键", async () => {
  // 这是复制这条路上最容易埋错的一格：一旦写入来源，新单会被归进【返单与总结】的返单分组，
  // 销售会以为这是客户返单。快照是建单载荷的唯一来源，所以在这里就断掉。
  const { service } = createHarness(sourceOrder({ reorderFromOrderNo: "DL259999-1" }));
  const snapshot = await service.copySnapshot("source-1");
  assert.equal("reorder_from_order_no" in snapshot.copy, false);
  assert.equal("reorder_from_order_no" in snapshot, false);
  // 来源单自己就是一张返单来的单时，那条来源也不该被连带着抄过来（新单与那张返单没有关系）。
  assert.equal(JSON.stringify(snapshot.copy).includes("DL259999-1"), false);
});

test("普通复制：来源单不存在 → 404 COPY_SOURCE_NOT_FOUND（文案能定位「哪一张」）", async () => {
  const service = new SalesOrdersService({ salesOrder: { findFirst: async () => null } }, audit);
  await assert.rejects(
    () => service.copySnapshot("order-ghost"),
    (error) => error instanceof NotFoundException && error.getResponse().code === "COPY_SOURCE_NOT_FOUND" && error.getResponse().details[0].id === "order-ghost",
  );
});

// ------------------------------------------------------------------ 复制什么

test("普通复制：客户/产品/单位/币种/结算口径/货号照抄", async () => {
  const { service } = createHarness(sourceOrder({ itemNo: "27621 流水花扇" }));
  const snapshot = await service.copySnapshot("source-1");
  assert.equal(snapshot.customer_id, "customer-1");
  assert.equal(snapshot.contact_id, "contact-1");
  assert.deepEqual(snapshot.customer, { id: "customer-1", name: "家百纳" });
  assert.equal(snapshot.copy.item_no, "27621 流水花扇");
  assert.equal(snapshot.copy.unit, "支");
  assert.equal(snapshot.copy.currency, "USD");
  assert.equal(snapshot.copy.customer_po_no, "PO#32366-1");
  assert.equal(snapshot.copy.external_contract_no, "EXT-1");
  assert.equal(snapshot.copy.settlement_method, "tt");
  assert.equal(snapshot.copy.unit_price, "1.2");
  assert.equal(snapshot.copy.settlement_unit_price, "1.15");
  assert.equal(snapshot.copy.tax_rate, "0.13");
  assert.deepEqual(snapshot.copy.extension_data, { source: "老单" });
});

test("普通复制：37 个细化标量**逐键**都带过来（抽查几个不够，漏一个就是纸上少一行）", async () => {
  const { service } = createHarness(sourceOrder());
  const snapshot = await service.copySnapshot("source-1");
  assert.equal(snapshot.copy.rib_spec, "双碳纤骨");
  assert.equal(snapshot.copy.canopy_spec, "30D 全遮光");
  assert.equal(snapshot.copy.qc_requirement, "所有材料都要质检报告");
  assert.equal(snapshot.copy.attention_note, "注意防水线");
  assert.equal(snapshot.copy.fabric_usage_canopy, "1.2");
  for (const [key, column] of SPEC_SCALAR_FIELDS) {
    assert.ok(key in snapshot.copy, `copy 里缺 ${key}`);
    if (column === "ribSpec") assert.equal(snapshot.copy[key], "双碳纤骨", `${key} 的取值要走 specScalarRow，不能直接吃 Prisma 列名`);
  }
});

test("普通复制：明细 / 材料引用（带物料摘要）/「其它」行 / 明细列名整块带过来", async () => {
  const { service } = createHarness(sourceOrder());
  const snapshot = await service.copySnapshot("source-1");
  assert.equal(snapshot.copy.spec_details.length, 2);
  assert.equal(snapshot.copy.spec_details[0].group_name, "伞布明细");
  assert.equal(snapshot.copy.spec_details[0].name, "27621 流水花扇PKGY");
  assert.equal(snapshot.copy.spec_details[1].barcode, "690123");
  // 引用要带物料摘要：前端才能把「引的是哪个物料」直接显示出来，不必再赌物料池那一次请求成功。
  assert.equal(snapshot.copy.material_refs.length, 1);
  assert.deepEqual([snapshot.copy.material_refs[0].spec_key, snapshot.copy.material_refs[0].material_id], ["rib_spec", "material-1"]);
  assert.equal(snapshot.copy.material_refs[0].material.name, "伞骨");
  assert.equal(snapshot.copy.material_extras.length, 2);
  assert.equal(snapshot.copy.material_extras[0].label, "弹簧");
  assert.equal(snapshot.copy.material_extras[0].material.name, "伞骨");
  assert.deepEqual(snapshot.copy.spec_detail_labels, { name: "品番" });
});

test("普通复制：must_fill 就是那四格，单价沿用要给警告", async () => {
  const { service } = createHarness(sourceOrder());
  const snapshot = await service.copySnapshot("source-1");
  assert.deepEqual(snapshot.must_fill, ["order_no", "order_date", "quantity", "delivery_date"]);
  assert.ok(snapshot.warnings.some((warning) => warning.includes("单价沿用上次")), "单价沿用必须给警告（与返单同一条）");
  assert.ok(snapshot.warnings.some((warning) => warning.includes("应收金额")), "金额不沿用要说清");
});

// ------------------------------------------------------------------ 不复制什么

test("普通复制：数量/下单日/交期/订单号四格不在 copy 里（必须重填，抄过来就是错的下单数据）", async () => {
  const { service } = createHarness(sourceOrder());
  const snapshot = await service.copySnapshot("source-1");
  for (const key of ["order_no", "order_date", "quantity", "delivery_date"]) {
    assert.equal(key in snapshot.copy, false, `${key} 不该出现在「会带过来」里`);
  }
});

test("普通复制：由数量派生的金额三兄弟不返回 —— 抄过来必然与新数量矛盾", async () => {
  const { service } = createHarness(sourceOrder());
  const snapshot = await service.copySnapshot("source-1");
  for (const key of ["total_amount", "receivable_amount", "local_currency_amount"]) {
    assert.equal(key in snapshot.copy, false, `${key} 不该被复制`);
  }
  // 状态/版本/BOM 等「这一单走到哪了」同样不带（快照里连键都没有，前端无从误用）。
  for (const key of ["status", "current_version", "boms"]) assert.equal(key in snapshot.copy, false, `${key} 不该被复制`);
});

test("普通复制：只读 —— 来源单本身零改动", async () => {
  const source = sourceOrder();
  const { service } = createHarness(source);
  await service.copySnapshot("source-1");
  assert.equal(source.currentVersion, 3);
  assert.equal(source.status, "draft");
  assert.equal(source.specDetails.length, 2);
  assert.equal(source.materialRefs.length, 2);
});

// ------------------------------------------------------------------ 失效物料

test("普通复制：来源单引用的物料已被删 → 剔掉那一格并回报（复制这条路没有「重选」动作）", async () => {
  const { service } = createHarness(sourceOrder(), { existingMaterials: ["material-1"] });
  const snapshot = await service.copySnapshot("source-1");
  assert.deepEqual(snapshot.copy.material_refs.map((row) => row.spec_key), ["rib_spec"], "失效引用不该被带进新建页（否则 MATERIAL_NOT_FOUND 卡死整张单）");
  assert.deepEqual(snapshot.dropped.material_refs, ["handle_spec"], "剔掉了就要回报，不能静默");
  assert.ok(snapshot.warnings.some((warning) => warning.includes("handle_spec")), "警告里要能看见是哪一格");
});

test("普通复制：「其它」行引用的物料已被删 → 只摘引用、保留那一行，并回报类目名", async () => {
  const { service } = createHarness(sourceOrder(), { existingMaterials: ["material-1"] });
  const snapshot = await service.copySnapshot("source-1");
  assert.deepEqual(snapshot.copy.material_extras.map((row) => [row.label, row.material_id]), [["弹簧", "material-1"], ["胶袋", null]]);
  assert.equal(snapshot.copy.material_extras[1].content, "按上次那批", "物料被删不该把用户写的规格说明一起丢掉");
  assert.deepEqual(snapshot.dropped.material_extras, ["胶袋"]);
});

// ------------------------------------------------------------------ 路由

test("路由顺序：copy-snapshot 必须声明在 :id 之前", () => {
  const source = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "..", "src", "modules", "sales", "sales-orders.controller.ts"), "utf8");
  const copy = source.indexOf('@Get(":id/copy-snapshot")');
  const byId = source.indexOf('@Get(":id") async');
  assert.ok(copy > 0, "copy-snapshot 路由必须存在");
  assert.ok(copy < byId, "Nest 按声明顺序匹配：具体路径必须在 :id 之前");
});
