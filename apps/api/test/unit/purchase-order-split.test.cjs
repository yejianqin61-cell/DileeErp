// 「一张销售订单 → 多张采购单（按供应商拆分）」的单元测试（手写假 Prisma，不连数据库）。
//
// 生产文件：apps/api/src/modules/procurement/purchase-orders.service.ts 的 createSplit
// 入口：POST /api/v1/purchase-orders/split（purchase-orders.controller.ts）
//
// 业务约定（本用例逐条钉住）：
//   1. 一组 = 一张采购单；组内明细的供应商一律取组供应商（拆分的语义就是「一组一个供应商」）；
//   2. 所有分组在同一个事务里写入：校验失败时一张都不写；
//   3. place_order=true 时复用「下单前必填」校验（BOM、明细完整、物料/单位/供应商/数量/单价）；
//   4. 每张采购单都带 purchase_split 扩展数据，便于事后追溯它是被拆分出来的；
//   5. 分组缺失供应商 / 空明细在进入 refs 之前就被 422 挡住。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { UnprocessableEntityException } = require("@nestjs/common");
const { PurchaseOrdersService } = require("../../dist/modules/procurement/purchase-orders.service.js");

const refsPrisma = (suppliers) => ({
  salesOrder: { findFirst: async () => ({ id: "order-1", orderNo: "SO-1" }) },
  bom: { findFirst: async () => ({ id: "bom-1", salesOrderId: "order-1", orderNo: "SO-1", version: 1 }) },
  supplier: { findMany: async () => suppliers },
  material: { findMany: async () => [{ id: "material-1" }, { id: "material-2" }] },
  unit: { findMany: async () => [{ id: "unit-1" }, { id: "unit-2" }] },
  bomItem: { findMany: async () => [{ id: "bomItem-1", materialId: "material-1" }] },
});

const item = (materialId, supplierId, extra = {}) => ({ material_id: materialId, unit_id: "unit-1", bom_item_id: materialId === "material-1" ? "bomItem-1" : undefined, supplier_id: supplierId, quantity: "2", unit_price: "3", expected_date: "2026-09-10", ...extra });

const audit = { create: () => ({}), update: () => ({}), record: async () => {} };

/** 组装服务：captured 收集每次 purchaseOrder.create 的 data。 */
function makeService(suppliers = [{ id: "supplier-2", name: "乙供应商" }, { id: "supplier-3", name: "丙供应商" }], currencies) {
  const captured = [];
  const tx = { purchaseOrder: { create: async ({ data }) => { captured.push(data); return { id: `purchase-${captured.length}`, orderNo: data.orderNo, purchaseOrderNo: data.purchaseOrderNo, status: data.status, items: [], extensionData: data.extensionData }; } } };
  const prisma = {
    ...refsPrisma(suppliers),
    $transaction: async (fn) => fn(tx),
    // get(id) 会在返回前重新查询：按 create 的返回值兜底（items 用空数组，create 的 items 是嵌套写对象）
    purchaseOrder: { findFirst: async ({ where }) => { const index = Number(String(where.id).split("-")[1]) - 1; const data = captured[index]; return data ? { id: where.id, items: [], orderNo: data.orderNo, purchaseOrderNo: data.purchaseOrderNo, status: data.status, currency: data.currency, extensionData: data.extensionData } : null; } },
  };
  return { service: new PurchaseOrdersService(prisma, audit, currencies), captured, prisma };
}

const input = (groups, extra = {}) => ({ order_no: "SO-1", bom_id: "bom-1", purchase_date: "2026-09-08", currency: "USD", groups, ...extra });

test("split creates one purchase order per supplier group in a single transaction", async () => {
  const { service, captured } = makeService();
  const created = await service.createSplit(input([
    { supplier_id: "supplier-2", items: [item("material-1", "supplier-2")] },
    { supplier_id: "supplier-3", items: [item("material-2", "supplier-3", { bom_item_id: undefined, extension_data: { outside_bom_reason: "临时新增" } })] },
  ]), { id: "user-1" });

  assert.equal(captured.length, 2, "两个供应商分组 → 两张采购单");
  assert.deepEqual(captured.map((data) => data.supplierId), ["supplier-2", "supplier-3"]);
  assert.deepEqual(captured.map((data) => data.items.create.length), [1, 1]);
  assert.equal(captured[0].currency, "USD", "组未指定币种时继承请求级币种（整单一个币种）");
  assert.equal(captured[1].currency, "USD");
  assert.deepEqual(created.map((row) => row.id), ["purchase-1", "purchase-2"]);
});

test("split forces the group supplier onto every item of that group", async () => {
  const { service, captured } = makeService();
  // 行上故意写另一个供应商：拆分语义下必须被组供应商覆盖
  await service.createSplit(input([
    { supplier_id: "supplier-2", items: [item("material-1", "supplier-3")] },
  ]), { id: "user-1" });
  assert.equal(captured[0].items.create[0].supplierId, "supplier-2");
  assert.equal(captured[0].supplierId, "supplier-2");
  assert.equal(captured[0].items.create[0].supplierSnapshot.name, "乙供应商");
});

test("split stamps purchase_split metadata on every generated purchase order", async () => {
  const { service, captured } = makeService();
  await service.createSplit(input([
    { supplier_id: "supplier-2", items: [item("material-1", "supplier-2")] },
    { supplier_id: "supplier-3", items: [item("material-2", "supplier-3", { bom_item_id: undefined, extension_data: { outside_bom_reason: "临时新增" } })] },
  ], { extension_data: { source: "bom-import" } }), { id: "user-1" });

  for (const [index, data] of captured.entries()) {
    assert.equal(data.extensionData.source, "bom-import", "调用方扩展数据必须保留");
    assert.deepEqual(data.extensionData.purchase_split.by, "supplier");
    assert.equal(data.extensionData.purchase_split.group_index, index);
    assert.equal(data.extensionData.purchase_split.group_count, 2);
  }
  assert.equal(captured[0].extensionData.purchase_split.supplier_id, "supplier-2");
  assert.equal(captured[1].extensionData.purchase_split.supplier_id, "supplier-3");
});

test("split keeps drafts as drafts and orders them only when place_order is true", async () => {
  const draft = makeService();
  await draft.service.createSplit(input([{ supplier_id: "supplier-2", items: [item("material-1", "supplier-2")] }]), { id: "user-1" });
  assert.equal(draft.captured[0].status, "draft");

  const ordered = makeService();
  await ordered.service.createSplit(input([{ supplier_id: "supplier-2", items: [item("material-1", "supplier-2")] }], { place_order: true }), { id: "user-1" });
  assert.equal(ordered.captured[0].status, "ordered");
});

test("split rejects an item that refs() rejects, before any write", async () => {
  const { service, captured } = makeService();
  await assert.rejects(
    // 单价为空：refs() 的明细合法性校验先拦下（草稿可以缺，但请求体里的数量/单价必须合法）
    () => service.createSplit(input([{ supplier_id: "supplier-2", items: [item("material-1", "supplier-2", { unit_price: "" })] }]), { id: "user-1" }),
    (error) => error instanceof UnprocessableEntityException && error.getResponse().code === "INVALID_PURCHASE_ITEM",
  );
  assert.deepEqual(captured, [], "校验失败时同一事务里一张采购单都不能生成");
});

test("split requires a bom when placing orders", async () => {
  const { service, captured } = makeService();
  // 明细不带 bom_item_id，且请求不带 bom_id：refs 通过，下单前校验以 BOM_REQUIRED 拦下
  await assert.rejects(
    () => service.createSplit({ ...input([{ supplier_id: "supplier-2", items: [item("material-2", "supplier-2", { bom_item_id: undefined })] }], { place_order: true }), bom_id: undefined }, { id: "user-1" }),
    (error) => error instanceof UnprocessableEntityException && error.getResponse().code === "PURCHASE_ORDER_INCOMPLETE" && error.getResponse().details[0].code === "BOM_REQUIRED",
  );
  assert.deepEqual(captured, []);
});

test("split rejects groups without a supplier or without items before reading references", async () => {
  const { service, prisma, captured } = makeService();
  let referenceReads = 0;
  const original = prisma.salesOrder.findFirst;
  prisma.salesOrder.findFirst = async (...args) => { referenceReads += 1; return original(...args); };

  await assert.rejects(
    () => service.createSplit(input([{ supplier_id: "", items: [item("material-1", "supplier-2")] }]), { id: "user-1" }),
    (error) => error.getResponse().code === "PURCHASE_SPLIT_SUPPLIER_REQUIRED",
  );
  await assert.rejects(
    () => service.createSplit(input([{ supplier_id: "supplier-2", items: [] }]), { id: "user-1" }),
    (error) => error.getResponse().code === "PURCHASE_SPLIT_ITEMS_REQUIRED",
  );
  await assert.rejects(
    () => service.createSplit(input([]), { id: "user-1" }),
    (error) => error.getResponse().code === "PURCHASE_SPLIT_GROUPS_REQUIRED",
  );
  assert.equal(referenceReads, 0, "结构性校验在 refs 之前完成，不产生任何业务查询");
  assert.deepEqual(captured, []);
});

test("split validates the currency of every group against the currency dictionary", async () => {
  const currencies = { assertSupported: async (code, field) => { if (code === "RMB") throw new UnprocessableEntityException({ code: "CURRENCY_NOT_SUPPORTED", message: `${field}不支持`, details: [] }); } };
  const { service, captured } = makeService(undefined, currencies);
  await assert.rejects(
    () => service.createSplit(input([{ supplier_id: "supplier-2", currency: "RMB", items: [item("material-1", "supplier-2")] }]), { id: "user-1" }),
    (error) => error.getResponse().code === "CURRENCY_NOT_SUPPORTED",
  );
  assert.deepEqual(captured, [], "币种校验失败发生在写入之前");
});

test("split skips dictionary validation when no currency service is injected", async () => {
  // 单测直接 new Service(prisma, audit) 时 currencies 为 undefined：不校验、不报错。
  const { service, captured } = makeService(undefined, undefined);
  await service.createSplit(input([{ supplier_id: "supplier-2", currency: "RMB", items: [item("material-1", "supplier-2")] }]), { id: "user-1" });
  assert.equal(captured.length, 1);
  assert.equal(captured[0].currency, "RMB");
});
