// 「已经建好的采购单也能编辑」的单元测试（手写假 Prisma，不连数据库）。
//
// 用户 2026-09-17：「采购板块，要支持对已经建好的采购单进行编辑」。
//
// 生产文件：apps/api/src/modules/procurement/purchase-orders.service.ts 的 update / assertEditable
// 入口：PATCH /api/v1/purchase-orders/:id（purchase-orders.controller.ts）
//
// 本文件钉住的核心约定：
//   1. 草稿自由编辑，**不需要**写原因；
//   2. 已下单但**没有任何有效到货**也能直接编辑，但必须写原因，且审计留下改动前后值
//      —— 用户的规则是「一个供应商一个单」，单发出去之后改单价/供应商是常态，
//      旧规则要求先「回到草稿」等于在系统里假装没下过单，而供应商手里那份单还在；
//   3. 已有到货的单一律不可整体编辑（质检/入库/应付来源都挂在到货上）；
//   4. 整体编辑**不得改变状态** —— 已下单的单改完还是已下单。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { PurchaseOrdersService } = require("../../dist/modules/procurement/purchase-orders.service.js");

const user = { id: "user-1" };
const item = (extra = {}) => ({ material_id: "material-1", unit_id: "unit-1", bom_item_id: "bomItem-1", supplier_id: "supplier-1", quantity: "2", unit_price: "3", expected_date: "2026-09-10", ...extra });

const references = {
  salesOrder: { findFirst: async () => ({ id: "order-1", orderNo: "SO-1" }) },
  bom: { findFirst: async () => ({ id: "bom-1", salesOrderId: "order-1", orderNo: "SO-1", version: 1 }) },
  supplier: { findMany: async () => [{ id: "supplier-1", name: "甲供应商" }] },
  material: { findMany: async () => [{ id: "material-1" }] },
  unit: { findMany: async () => [{ id: "unit-1" }] },
  bomItem: { findMany: async () => [{ id: "bomItem-1", materialId: "material-1" }] },
};

/**
 * `get()` 会重新查询一次，所以假 prisma 用一张按 id 索引的表。
 * 到货行必须带 `inspections` / `rawMaterialInbounds`：`get()` 会读它们拼批次视图（真实 Prisma 的 include 会填上）。
 */
function makeService({ status = "draft", receipts = [] } = {}) {
  const writes = { headerUpdates: [], itemDeletes: [], itemCreates: [] };
  const audits = [];
  const order = {
    id: "po-1", purchaseOrderNo: "PO-1", orderNo: "SO-1", status,
    supplierId: "supplier-1", currency: "CNY", totalAmount: "6.0000",
    bomId: "bom-1", bomVersion: 1, purchaseDate: new Date("2026-09-05"),
    supplier: { id: "supplier-1", name: "甲供应商" }, bom: { id: "bom-1" },
    items: [{
      id: "poi-1", materialId: "material-1", supplierId: "supplier-1",
      quantity: "2", unitPrice: "3", expectedDate: new Date("2026-09-10"), receipts,
    }],
  };
  const tx = {
    purchaseOrderItem: {
      updateMany: async (args) => { writes.itemDeletes.push(args); return { count: 1 }; },
      createMany: async (args) => { writes.itemCreates.push(args); return { count: args.data.length }; },
    },
    purchaseOrder: { update: async (args) => { writes.headerUpdates.push(args); return { id: args.where.id }; } },
  };
  const prisma = {
    ...references,
    purchaseOrder: { findFirst: async () => order },
    $transaction: async (fn) => fn(tx),
  };
  const service = new PurchaseOrdersService(prisma, {
    create: (actor) => ({ createdBy: actor.id }),
    update: (actor) => ({ updatedBy: actor.id }),
    record: async (...args) => { audits.push(args); },
  });
  return { service, writes, audits };
}

const auditOf = (audits, action) => audits.find((args) => args[0] === action);
const body = (extra = {}) => ({ order_no: "SO-1", bom_id: "bom-1", currency: "CNY", items: [item()], ...extra });
const codeOf = (error) => error.getResponse().code;

test("草稿编辑：不需要原因，也不记前后值（没有「之前」可言）", async () => {
  const { service, audits, writes } = makeService({ status: "draft" });

  await service.update("po-1", body(), user);

  assert.equal(writes.headerUpdates.length, 1, "草稿整体替换写一次头部");
  assert.equal(writes.itemDeletes.length, 1, "老明细软删");
  assert.equal(writes.itemCreates.length, 1, "新明细批量建");
  const record = auditOf(audits, "purchase_order.update");
  assert.equal(record[4].reason, undefined);
  assert.equal(record[4].before, undefined);
  assert.equal(record[4].after, undefined);
});

test("已下单未到货：可以直接编辑，但必须写原因", async () => {
  const { service, writes } = makeService({ status: "ordered" });

  await assert.rejects(
    () => service.update("po-1", body(), user),
    (error) => codeOf(error) === "CORRECTION_REASON_REQUIRED",
  );
  assert.deepEqual(writes.headerUpdates, [], "没写原因时一个字都不许落库");
});

test("已下单未到货：只有空白的原因不算填了", async () => {
  const { service, writes } = makeService({ status: "ordered" });

  await assert.rejects(
    () => service.update("po-1", body({ reason: "   " }), user),
    (error) => codeOf(error) === "CORRECTION_REASON_REQUIRED",
  );
  assert.deepEqual(writes.headerUpdates, []);
});

test("已下单未到货：写了原因就能改，状态不变，审计留下前后值", async () => {
  const { service, audits, writes } = makeService({ status: "ordered" });

  await service.update("po-1", body({ reason: "单价录错，供应商报价 3.5", items: [item({ unit_price: "3.5" })] }), user);

  const data = writes.headerUpdates[0].data;
  assert.equal("status" in data, false, "整体编辑不碰状态：改完还是已下单");
  assert.equal(data.totalAmount, "7.0000", "头部金额按新单价重算");

  const record = auditOf(audits, "purchase_order.update");
  const payload = record[4];
  assert.equal(payload.status, "ordered");
  assert.equal(payload.reason, "单价录错，供应商报价 3.5");
  assert.equal(payload.before.supplier_id, "supplier-1");
  assert.equal(payload.before.total_amount, "6.0000");
  assert.equal(payload.before.items[0].unit_price, "3");
  assert.equal(payload.before.items[0].expected_date, "2026-09-10");
  assert.equal(payload.after.total_amount, "7.0000");
  assert.equal(payload.after.items[0].unit_price, "3.5");
});

test("已有到货的采购单一律不可整体编辑（不管什么状态）", async () => {
  for (const status of ["draft", "ordered", "partially_arrived", "arrived_complete"]) {
    const { service, writes } = makeService({ status, receipts: [{ id: "receipt-1", quantity: "1", inspections: [], rawMaterialInbounds: [] }] });
    await assert.rejects(
      () => service.update("po-1", body({ reason: "想改" }), user),
      (error) => codeOf(error) === "PURCHASE_ORDER_NOT_EDITABLE",
      `${status} + 有到货应当拒绝`,
    );
    assert.deepEqual(writes.headerUpdates, []);
  }
});

test("到货之后的中间状态不可编辑（到货事实挂在到货上，改数量会打架）", async () => {
  for (const status of ["partially_arrived", "arrived_complete", "cancelled"]) {
    const { service } = makeService({ status });
    await assert.rejects(
      () => service.update("po-1", body({ reason: "想改" }), user),
      (error) => codeOf(error) === "PURCHASE_ORDER_NOT_EDITABLE",
      `${status} 不在可编辑状态里`,
    );
  }
});

test("编辑仍然复用既有的参照物校验：非 BOM 行必须写新增原因", async () => {
  const { service, writes } = makeService({ status: "draft" });

  await assert.rejects(
    () => service.update("po-1", body({ items: [item({ bom_item_id: undefined })] }), user),
    (error) => codeOf(error) === "PURCHASE_OUTSIDE_BOM_REASON_REQUIRED",
  );
  assert.deepEqual(writes.headerUpdates, [], "校验在事务之前完成");
});
