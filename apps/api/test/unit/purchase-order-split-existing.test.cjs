// 「按供应商收束一张**已经存在**的采购单」的单元测试（手写假 Prisma，不连数据库）。
//
// 用户 2026-09-17：「导入 BOM 物料之后，用户对采购单进行编辑，填写供应商等等 column。
// 支持保存草稿。然后再根据供应商收束下单。一个采购单内，一个供应商下一个单。」
//
// 生产文件：apps/api/src/modules/procurement/purchase-orders.service.ts 的 splitExisting / collectGroups
// 入口：POST /api/v1/purchase-orders/:id/split（purchase-orders.controller.ts）
//
// 与 POST /purchase-orders/split（createSplit）的差别只有落点，本文件逐条钉住：
//   1. 第一组**沿用这张单**（采购单号不变），其余组新建 —— 草稿从没发给供应商，
//      把它的内容重新组织一次不是一次「取消」业务，不该白烧单号、也不该在列表里留一条作废记录；
//   2. 草稿 + place_order=true 时，原单也要落到「已下单」并补上采购日期；
//   3. 已下单的单收束后**仍是已下单** —— 不能靠「保存草稿」把一张发出去的单悄悄退回草稿；
//   4. 收束已下单的单必须写原因；
//   5. 已有到货的单一律不可收束，且校验在任何写入之前完成。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { PurchaseOrdersService } = require("../../dist/modules/procurement/purchase-orders.service.js");

const user = { id: "user-1" };
const item = (materialId, supplierId, extra = {}) => ({ material_id: materialId, unit_id: "unit-1", bom_item_id: materialId === "material-1" ? "bomItem-1" : undefined, supplier_id: supplierId, quantity: "2", unit_price: "3", expected_date: "2026-09-10", ...extra });

const references = {
  salesOrder: { findFirst: async () => ({ id: "order-1", orderNo: "SO-1" }) },
  bom: { findFirst: async () => ({ id: "bom-1", salesOrderId: "order-1", orderNo: "SO-1", version: 1 }) },
  supplier: { findMany: async () => [{ id: "supplier-1", name: "甲供应商" }, { id: "supplier-2", name: "乙供应商" }] },
  material: { findMany: async () => [{ id: "material-1" }, { id: "material-2" }] },
  unit: { findMany: async () => [{ id: "unit-1" }] },
  bomItem: { findMany: async () => [{ id: "bomItem-1", materialId: "material-1" }] },
};

/**
 * 记下每一次写入；`get()` 会在事务后重新查询，所以假 prisma 维护一张按 id 索引的表。
 * 到货行必须带 `inspections` / `rawMaterialInbounds`：`get()` 会读它们拼批次视图。
 */
function makeService({ status = "draft", receipts = [] } = {}) {
  const writes = { headerUpdates: [], itemDeletes: [], itemCreates: [], orderCreates: [] };
  const audits = [];
  const rows = new Map();
  rows.set("po-1", {
    id: "po-1", purchaseOrderNo: "PO-1", orderNo: "SO-1", status,
    supplierId: "supplier-1", currency: "USD", totalAmount: "2.0000", extensionData: {},
    items: [{ id: "poi-1", materialId: "material-1", supplierId: "supplier-1", quantity: "2", unitPrice: "3", expectedDate: null, receipts }],
  });
  const tx = {
    purchaseOrderItem: {
      updateMany: async (args) => { writes.itemDeletes.push(args); return { count: 1 }; },
      createMany: async (args) => { writes.itemCreates.push(args); return { count: args.data.length }; },
    },
    purchaseOrder: {
      update: async (args) => { writes.headerUpdates.push(args); return { id: args.where.id }; },
      create: async ({ data }) => {
        writes.orderCreates.push(data);
        const row = { id: `po-${rows.size + 1}`, purchaseOrderNo: data.purchaseOrderNo, orderNo: data.orderNo, status: data.status, items: [] };
        rows.set(row.id, row);
        return row;
      },
    },
  };
  const prisma = {
    ...references,
    purchaseOrder: { findFirst: async ({ where }) => rows.get(where.id) ?? null },
    $transaction: async (fn) => fn(tx),
  };
  const service = new PurchaseOrdersService(prisma, {
    create: (actor) => ({ createdBy: actor.id }),
    update: (actor) => ({ updatedBy: actor.id }),
    record: async (...args) => { audits.push(args); },
  });
  return { service, writes, audits };
}

const body = (groups, extra = {}) => ({ order_no: "SO-1", bom_id: "bom-1", currency: "USD", groups, ...extra });
const codeOf = (error) => error.getResponse().code;
const auditOf = (audits, action) => audits.find((args) => args[0] === action);

test("收束已有草稿：第一组沿用原单，其余组新建", async () => {
  const { service, writes } = makeService({ status: "draft" });

  const result = await service.splitExisting("po-1", body([
    { supplier_id: "supplier-1", items: [item("material-1", "supplier-1")] },
    { supplier_id: "supplier-2", items: [item("material-2", "supplier-2", { bom_item_id: undefined, extension_data: { outside_bom_reason: "替代料" } })] },
  ]), user);

  assert.equal(writes.headerUpdates.length, 1, "第一组更新原单，不新建");
  assert.equal(writes.orderCreates.length, 1, "只有第二个供应商新建一张");
  assert.equal(writes.orderCreates[0].supplierId, "supplier-2");
  assert.deepEqual(result.map((row) => row.id), ["po-1", "po-2"], "返回的第一张就是原来那张单");
});

test("收束已有草稿：原单的扩展数据记得下「这次是从哪收束来的」", async () => {
  const { service, writes } = makeService({ status: "draft" });

  await service.splitExisting("po-1", body([
    { supplier_id: "supplier-1", items: [item("material-1", "supplier-1")] },
    { supplier_id: "supplier-2", items: [item("material-2", "supplier-2", { bom_item_id: undefined, extension_data: { outside_bom_reason: "替代料" } })] },
  ]), user);

  const split = writes.headerUpdates[0].data.extensionData.purchase_split;
  assert.equal(split.by, "supplier");
  assert.equal(split.group_index, 0);
  assert.equal(split.group_count, 2);
  assert.equal(split.reused_purchase_order_no, "PO-1");
  const createdSplit = writes.orderCreates[0].extensionData.purchase_split;
  assert.equal(createdSplit.group_index, 1, "新建的组同样带分组序号");
  assert.equal(createdSplit.reused_purchase_order_no, undefined, "只有沿用原单的那一组才带这个标记");
});

test("只有一个分组时收束＝原地保存，不产生任何新单", async () => {
  const { service, writes } = makeService({ status: "draft" });

  await service.splitExisting("po-1", body([{ supplier_id: "supplier-1", items: [item("material-1", "supplier-1")] }]), user);

  assert.equal(writes.headerUpdates.length, 1);
  assert.deepEqual(writes.orderCreates, []);
});

test("草稿收束下单：原单与新建的组都落到已下单，并补上采购日期", async () => {
  const { service, writes } = makeService({ status: "draft" });

  await service.splitExisting("po-1", body([
    { supplier_id: "supplier-1", items: [item("material-1", "supplier-1")] },
    { supplier_id: "supplier-2", items: [item("material-2", "supplier-2", { bom_item_id: undefined, extension_data: { outside_bom_reason: "替代料" } })] },
  ], { place_order: true }), user);

  const data = writes.headerUpdates[0].data;
  assert.equal(data.status, "ordered");
  assert.ok(data.purchaseDate instanceof Date, "草稿转已下单要补采购日期，否则列表里这张单没有下单时间");
  assert.equal(writes.orderCreates[0].status, "ordered");
  assert.ok(writes.orderCreates[0].purchaseDate instanceof Date);
});

test("保存草稿：草稿收束后仍是草稿，且不写采购日期", async () => {
  const { service, writes } = makeService({ status: "draft" });

  await service.splitExisting("po-1", body([{ supplier_id: "supplier-1", items: [item("material-1", "supplier-1")] }]), user);

  assert.equal(writes.headerUpdates[0].data.status, "draft");
  assert.equal("purchaseDate" in writes.headerUpdates[0].data, false);
});

test("已下单的单收束后仍是已下单（不能靠保存草稿把它悄悄退回草稿）", async () => {
  const { service, writes } = makeService({ status: "ordered" });

  await service.splitExisting("po-1", body([{ supplier_id: "supplier-1", items: [item("material-1", "supplier-1")] }], { place_order: false, reason: "供应商拆成两家" }), user);

  assert.equal(writes.headerUpdates[0].data.status, "ordered");
  assert.equal("purchaseDate" in writes.headerUpdates[0].data, false, "已是已下单，采购日期不动");
});

test("收束已下单的单必须写原因", async () => {
  const { service, writes } = makeService({ status: "ordered" });

  await assert.rejects(
    () => service.splitExisting("po-1", body([{ supplier_id: "supplier-1", items: [item("material-1", "supplier-1")] }]), user),
    (error) => codeOf(error) === "CORRECTION_REASON_REQUIRED",
  );
  assert.deepEqual(writes.headerUpdates, []);
  assert.deepEqual(writes.orderCreates, []);
});

test("已有到货的单不可收束", async () => {
  const { service, writes } = makeService({ status: "ordered", receipts: [{ id: "receipt-1", quantity: "1", inspections: [], rawMaterialInbounds: [] }] });

  await assert.rejects(
    () => service.splitExisting("po-1", body([{ supplier_id: "supplier-1", items: [item("material-1", "supplier-1")] }], { reason: "想拆" }), user),
    (error) => codeOf(error) === "PURCHASE_ORDER_NOT_EDITABLE",
  );
  assert.deepEqual(writes.headerUpdates, []);
});

test("审计记录沿用与新建的单号、状态前后值、以及原因", async () => {
  const { service, audits } = makeService({ status: "ordered" });

  await service.splitExisting("po-1", body([
    { supplier_id: "supplier-1", items: [item("material-1", "supplier-1")] },
    { supplier_id: "supplier-2", items: [item("material-2", "supplier-2", { bom_item_id: undefined, extension_data: { outside_bom_reason: "替代料" } })] },
  ], { reason: "供应商拆成两家" }), user);

  const payload = auditOf(audits, "purchase_order.split")[4];
  assert.equal(payload.purchase_order_no, "PO-1");
  assert.equal(payload.reused_purchase_order_no, "PO-1");
  assert.equal(payload.group_count, 2);
  assert.equal(payload.status_before, "ordered");
  assert.equal(payload.status_after, "ordered");
  assert.equal(payload.reason, "供应商拆成两家");
  assert.deepEqual(payload.created_purchase_order_nos.length, 1, "新建的单号来自 create 的返回值");
  assert.match(payload.created_purchase_order_nos[0], /^PO-/, "新建单号由系统生成");
  assert.equal(payload.before.total_amount, "2.0000", "已下单的单改动要留前后值");
  assert.equal(payload.after.total_amount, "6.0000", "after 是收束后沿用原单那一组的金额（2 × 3）");
});

test("结构校验先于任何写入：没有分组 / 空明细都一张不建", async () => {
  const { service, writes } = makeService({ status: "draft" });

  await assert.rejects(() => service.splitExisting("po-1", body([]), user), (error) => codeOf(error) === "PURCHASE_SPLIT_GROUPS_REQUIRED");
  await assert.rejects(() => service.splitExisting("po-1", body([{ supplier_id: "supplier-1", items: [] }]), user), (error) => codeOf(error) === "PURCHASE_SPLIT_ITEMS_REQUIRED");
  await assert.rejects(
    () => service.splitExisting("po-1", body([{ supplier_id: "", items: [item("material-1", "supplier-1")] }], { place_order: true }), user),
    (error) => codeOf(error) === "PURCHASE_SPLIT_SUPPLIER_REQUIRED",
  );

  assert.deepEqual(writes.headerUpdates, []);
  assert.deepEqual(writes.orderCreates, []);
});

// 用户 2026-09-17：「导入 BOM 明细，也视为对采购单的编辑，允许保存」。
// 刚导入时这一组还没选供应商，草稿必须存得下来；下单前必须补齐。
test("未选供应商的组：保存草稿允许，收束下单拒绝", async () => {
  const draft = makeService({ status: "draft" });

  await draft.service.splitExisting("po-1", body([{ supplier_id: "", items: [item("material-1", "supplier-1")] }]), user);

  assert.equal(draft.writes.headerUpdates.length, 1);
  assert.equal(draft.writes.headerUpdates[0].data.supplierId, null, "这张草稿还没有供应商");
  assert.equal(draft.writes.itemCreates[0].data[0].supplierId, null, "明细行也没有供应商");

  const ordered = makeService({ status: "draft" });
  await assert.rejects(
    () => ordered.service.splitExisting("po-1", body([{ supplier_id: "", items: [item("material-1", "supplier-1")] }], { place_order: true }), user),
    (error) => codeOf(error) === "PURCHASE_SPLIT_SUPPLIER_REQUIRED",
  );
  assert.deepEqual(ordered.writes.headerUpdates, []);
});

test("收束下单沿用同一套「下单前必填」校验（缺 BOM 就拦下，且不落任何写入）", async () => {
  const { service, writes } = makeService({ status: "draft" });
  // 明细故意不带 bom_item_id：带了却不给 bom_id 会先撞上 BOM_ITEM_MISMATCH，
  // 那条是「引用了 BOM 行就必须给 BOM」的校验，不是本用例要看的「下单前必填」。
  const noBomItem = [{ supplier_id: "supplier-1", items: [item("material-1", "supplier-1", { bom_item_id: undefined })] }];

  await assert.rejects(
    () => service.splitExisting("po-1", { ...body(noBomItem, { place_order: true }), bom_id: undefined }, user),
    (error) => codeOf(error) === "PURCHASE_ORDER_INCOMPLETE" && error.getResponse().details[0].code === "BOM_REQUIRED",
  );
  assert.deepEqual(writes.headerUpdates, []);
  assert.deepEqual(writes.orderCreates, []);
});

test("收束不存在的采购单 → 404", async () => {
  const { service } = makeService();
  await assert.rejects(
    () => service.splitExisting("po-404", body([{ supplier_id: "supplier-1", items: [item("material-1", "supplier-1")] }]), user),
    (error) => error.getResponse().code === "PURCHASE_ORDER_NOT_FOUND",
  );
});
