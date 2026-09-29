// `PATCH /purchase-orders/:id` 在「采购计划」上线后的行为（手写假 Prisma，不连数据库）。
//
// 2026-09-27 口径 7：**数量/单价/供应商的唯一编辑点是采购计划**。
// 这张单已经发给供应商了，系统里再能改它的明细，就会出现同一批货两份数字 ——
// 而「这张 BOM 还差什么没买」立刻失真，那正是采购计划存在的意义。
// 要改一张已下单的单，正确动作是「退回采购计划」（`PurchasePlansService.revertPurchaseOrder`）。
//
// 生产文件：apps/api/src/modules/procurement/purchase-orders.service.ts 的 update / updatePrintFields
// 入口：PATCH /api/v1/purchase-orders/:id（purchase-orders.controller.ts）
//
// 本文件钉住的核心约定：
//   1. 提交里出现任何明细键 → 422 `PURCHASE_ORDER_DETAIL_READONLY`，**一个字都不写**；
//   2. 老客户端还在发 `items`/`supplier_id`/`reason`，所以要**给一句话**而不是 404 ——
//      报错里要列清是哪几个键被拒（否则前端只能给一句含糊提示）；
//   3. **`expected_date` 与 `remark` 不算明细键**：它们同时是"打印信息"的字段
//      （交货日期 / 备注）。把它们错列进黑名单，打印路径就被打死了 —— 这条是回归。
//   4. 只传打印字段时行为不变（走 `updatePrintFields`）：草稿/已下单/已到货都能填，
//      已取消的拒绝，空 body 不报错也不写。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { PurchaseOrdersService } = require("../../dist/modules/procurement/purchase-orders.service.js");

const user = { id: "user-1" };
const item = () => ({ material_id: "material-1", unit_id: "unit-1", supplier_id: "supplier-1", quantity: "2", unit_price: "3" });
/** 老客户端（2026-09-27 之前的打印页）会发的整套请求体。 */
const legacyBody = (extra = {}) => ({ order_no: "SO-1", bom_id: "bom-1", supplier_id: "supplier-1", currency: "CNY", items: [item()], reason: "单价录错", ...extra });

function makeService({ status = "ordered", missing = false } = {}) {
  const writes = [];
  const audits = [];
  const prisma = {
    purchaseOrder: {
      findFirst: async () => (missing ? null : { id: "po-1", purchaseOrderNo: "PO-1", status }),
      update: async (args) => { writes.push(args); return { id: args.where.id, ...args.data }; },
    },
  };
  const audit = { create: (actor) => ({ createdBy: actor.id }), update: (actor) => ({ updatedBy: actor.id }), record: async (...args) => { audits.push(args); } };
  return { service: new PurchaseOrdersService(prisma, audit), writes, audits };
}

const codeOf = (error) => error.getResponse().code;
const fieldsOf = (error) => error.getResponse().details[0].fields;

test("明细键出现在提交里 → 422 PURCHASE_ORDER_DETAIL_READONLY，并列出被拒的键", async () => {
  const { service, writes } = makeService();

  await assert.rejects(
    () => service.update("po-1", legacyBody(), user),
    (error) => codeOf(error) === "PURCHASE_ORDER_DETAIL_READONLY"
      && fieldsOf(error).includes("items")
      && fieldsOf(error).includes("supplier_id")
      && /退回采购计划/.test(error.getResponse().message),
  );
  assert.deepEqual(writes, [], "拒绝时一个字都不许落库");
});

test("只发一个明细键（例如想偷偷改单价）也会被拒", async () => {
  const { service, writes } = makeService();
  await assert.rejects(() => service.update("po-1", { items: [item({ unit_price: "9" })] }, user), (error) => codeOf(error) === "PURCHASE_ORDER_DETAIL_READONLY");
  assert.deepEqual(writes, []);
});

test("`reason` 单独出现也算明细改动（它只在改明细时有意义）", async () => {
  const { service } = makeService();
  await assert.rejects(() => service.update("po-1", { reason: "单价录错" }, user), (error) => codeOf(error) === "PURCHASE_ORDER_DETAIL_READONLY" && fieldsOf(error).includes("reason"));
});

test("回归：`expected_date` 与 `remark` 是**打印字段**，不算明细键，必须放行", async () => {
  // 同一列两个用途：`purchase_orders.expected_date` 既是"交货日期"（打印信息）
  // 也曾是明细入参。把它们错列进黑名单，打印路径（交货日期/备注）就被打死了。
  const { service, writes } = makeService({ status: "ordered" });

  await service.update("po-1", { expected_date: "2026-10-08", remark: "先发一半", delivery_address: "浙江省金华市" }, user);

  assert.equal(writes.length, 1);
  assert.equal(writes[0].data.expectedDate.toISOString().slice(0, 10), "2026-10-08");
  assert.equal(writes[0].data.remark, "先发一半");
  assert.equal("items" in writes[0].data, false, "不碰明细");
  assert.equal("totalAmount" in writes[0].data, false, "不碰金额");
  assert.equal("status" in writes[0].data, false, "不碰状态");
});

test("只传打印字段：草稿 / 已下单 / 已到货都能填（厂家回签本来就是下单之后才发生的）", async () => {
  for (const status of ["draft", "ordered", "partially_arrived", "arrived_complete"]) {
    const { service, writes } = makeService({ status });
    await service.update("po-1", { supplier_signed: "陈厂长 2026-09-28" }, user);
    assert.equal(writes.length, 1, `${status} 应当可以填打印信息`);
    assert.equal(writes[0].data.supplierSigned, "陈厂长 2026-09-28");
  }
});

test("空 body 不报错（什么也不改），已取消的单仍然拒绝，采购单不存在 404", async () => {
  const empty = makeService();
  await empty.service.update("po-1", {}, user);
  assert.equal(empty.writes.length, 1, "空 body 会写一次 updatedBy（只有审计列），不该抛错");

  const cancelled = makeService({ status: "cancelled" });
  await assert.rejects(() => cancelled.service.update("po-1", { remark: "试试" }, user), (error) => codeOf(error) === "PURCHASE_ORDER_NOT_EDITABLE");

  const missing = makeService({ missing: true });
  await assert.rejects(() => missing.service.update("po-404", { remark: "试试" }, user), (error) => codeOf(error) === "PURCHASE_ORDER_NOT_FOUND");
});
