// 「BOM 明细行的下单情况」的单元测试（手写假 Prisma，不连数据库）。
//
// 用户 2026-09-17：「已经选中并下单的 BOM 物料，再新建采购单中要显示已下单。因此要多一个 column」。
//
// 生产文件：apps/api/src/modules/procurement/purchase-orders.service.ts 的 bomItemOrderStatus
// 入口：GET /api/v1/purchase-orders/bom-item-status?bom_id=…（purchase-orders.controller.ts）
//
// 本文件钉住的核心约定：
//   1. 四态：未下单 / 草稿中 / 部分下单 / 已下单足量；
//   2. 草稿**不算**已下单，但要单独累计并标出来 —— 已经有草稿覆盖的行同样不该再开一张；
//   3. 已取消的采购单不参与（它不再对外）；
//   4. 只算未删除的明细行（改单时老行是软删的，不能重复计入）；
//   5. 需求量为 0 的行不因为「0 已下单」被判成已下单足量。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { PurchaseOrdersService } = require("../../dist/modules/procurement/purchase-orders.service.js");

const audit = { create: () => ({}), update: () => ({}), record: async () => {} };

/**
 * 组装服务。
 *
 * 假 Prisma **按 where 里的条件真的过滤**（而不是无脑返回全部）：
 * 本文件要验证的正是「已取消的采购单被排除」「软删的明细行被排除」「按采购单的 BOM 而不是
 * 按当前行 ID 归集」这几条查询口径，用一个恒返回全部数据的桩会把断言变成永远通过。
 */
function makeService({ bomItems = [], rows = [], missing = false } = {}) {
  const prisma = {
    bom: { findFirst: async () => (missing ? null : { id: "bom-1" }) },
    bomItem: { findMany: async ({ where }) => bomItems.filter((item) => item.deletedAt === null && item.bomId === where.bomId) },
    purchaseOrderItem: {
      findMany: async ({ where }) => rows.filter((row) => {
        if (row.deletedAt !== null) return false;
        if (where.bomItemId?.in && !where.bomItemId.in.includes(row.bomItemId)) return false;
        if (where.bomItemId?.not === null && row.bomItemId === null) return false;
        const order = row.purchaseOrder;
        if (order.deletedAt !== null) return false;
        if (where.purchaseOrder?.status?.not && order.status === where.purchaseOrder.status.not) return false;
        // 2026-09-20：归集范围改成「采购单挂的那张 BOM」——占位断言见文件末尾的回归用例。
        if (where.purchaseOrder?.bomId && order.bomId !== where.purchaseOrder.bomId) return false;
        return true;
      }),
    },
  };
  return new PurchaseOrdersService(prisma, audit);
}

/** 一行 BOM 明细需求的默认形态（需求量 5，未删除）。 */
const need = (id, requiredQuantity = "5", materialId = undefined) => ({ id, bomId: "bom-1", requiredQuantity, materialId, deletedAt: null });
/** 一条采购明细行：指向某个 BOM 行，挂在某个状态的采购单上。 */
const ordered = (bomItemId, quantity, status = "ordered", purchaseOrderNo = "PO-1", deletedAt = null, materialId = undefined) => ({ bomItemId, materialId, quantity, deletedAt, purchaseOrder: { purchaseOrderNo, status, deletedAt: null, bomId: "bom-1" } });

const byId = (result, id) => result.find((row) => row.bom_item_id === id);

test("四态：未下单 / 草稿中 / 部分下单 / 已下单足量", async () => {
  const service = makeService({
    bomItems: [need("bi-1"), need("bi-2"), need("bi-3"), need("bi-4")],
    rows: [
      ordered("bi-1", "5"),                 // 需求 5，已下单 5 → 足量
      ordered("bi-2", "2"),                 // 需求 5，已下单 2 → 部分
      ordered("bi-3", "3", "draft", "PO-9"), // 只有草稿 → 草稿中
      // bi-4 什么都没有 → 未下单
    ],
  });

  const result = await service.bomItemOrderStatus("bom-1");

  assert.deepEqual(result.map((row) => row.state), ["ordered", "partial", "draft", "none"]);
  assert.equal(byId(result, "bi-1").ordered_quantity, "5.0000");
  assert.equal(byId(result, "bi-2").ordered_quantity, "2.0000");
  assert.equal(byId(result, "bi-3").ordered_quantity, "0.0000");
  assert.equal(byId(result, "bi-3").draft_quantity, "3.0000");
});

test("草稿不计入已下单，但单独累计并带上草稿单号", async () => {
  const service = makeService({
    bomItems: [need("bi-1")],
    rows: [ordered("bi-1", "5", "draft", "PO-9")],
  });

  const row = (await service.bomItemOrderStatus("bom-1"))[0];

  assert.equal(row.state, "draft", "已经有草稿覆盖的行不该显示成「未下单」，否则会被重复开单");
  assert.equal(row.ordered_quantity, "0.0000");
  assert.deepEqual(row.draft_purchase_order_nos, ["PO-9"]);
  assert.deepEqual(row.ordered_purchase_order_nos, []);
});

test("同一 BOM 行被多张单覆盖时数量相加、单号去重且全部列出", async () => {
  const service = makeService({
    bomItems: [need("bi-1")],
    rows: [
      ordered("bi-1", "2", "ordered", "PO-1"),
      ordered("bi-1", "1", "partially_arrived", "PO-2"),
      ordered("bi-1", "1", "ordered", "PO-1"),
    ],
  });

  const row = (await service.bomItemOrderStatus("bom-1"))[0];

  assert.equal(row.ordered_quantity, "4.0000", "已下单/部分到货/到货完成的单都算已下单");
  assert.deepEqual(row.ordered_purchase_order_nos, ["PO-1", "PO-2"], "同一张单出现两次只记一个单号");
});

test("已下单量超过需求量仍是「已下单足量」（超买不该显示成未完成）", async () => {
  const service = makeService({ bomItems: [need("bi-1")], rows: [ordered("bi-1", "7")] });
  const row = (await service.bomItemOrderStatus("bom-1"))[0];
  assert.equal(row.state, "ordered");
  assert.equal(row.ordered_quantity, "7.0000");
});

test("部分已下单 + 另有草稿时按「部分下单」显示（已下单优先于草稿）", async () => {
  const service = makeService({
    bomItems: [need("bi-1")],
    rows: [ordered("bi-1", "2", "ordered", "PO-1"), ordered("bi-1", "3", "draft", "PO-9")],
  });

  const row = (await service.bomItemOrderStatus("bom-1"))[0];

  assert.equal(row.state, "partial");
  assert.equal(row.ordered_quantity, "2.0000");
  assert.equal(row.draft_quantity, "3.0000");
});

test("已取消的采购单不参与统计", async () => {
  const service = makeService({ bomItems: [need("bi-1")], rows: [ordered("bi-1", "5", "cancelled", "PO-1")] });
  const row = (await service.bomItemOrderStatus("bom-1"))[0];
  assert.equal(row.state, "none", "取消掉的采购单不再占用这一行的需求量");
  assert.deepEqual(row.ordered_purchase_order_nos, []);
});

test("软删的明细行不参与统计（改单时老行是软删的）", async () => {
  const service = makeService({ bomItems: [need("bi-1")], rows: [ordered("bi-1", "5", "ordered", "PO-1", new Date("2026-09-16"))] });
  const row = (await service.bomItemOrderStatus("bom-1"))[0];
  assert.equal(row.state, "none");
});

test("需求量为 0 的行不判成「已下单足量」", async () => {
  const service = makeService({ bomItems: [need("bi-1", "0")], rows: [] });
  const row = (await service.bomItemOrderStatus("bom-1"))[0];
  assert.equal(row.state, "none", "0 ≥ 0 会让空行显示成已买齐，那是假象");
});

test("BOM 不存在 → 404；BOM 没有明细行 → 空数组", async () => {
  await assert.rejects(
    () => makeService({ missing: true }).bomItemOrderStatus("bom-404"),
    (error) => error.getResponse().code === "BOM_NOT_FOUND",
  );
  assert.deepEqual(await makeService({ bomItems: [] }).bomItemOrderStatus("bom-1"), []);
});

test("返回需求量，界面才能显示「已下单 2 / 需求 5」", async () => {
  const service = makeService({ bomItems: [need("bi-1", "12.5")], rows: [ordered("bi-1", "2")] });
  const row = (await service.bomItemOrderStatus("bom-1"))[0];
  assert.equal(row.required_quantity, "12.5000");
});

// ---------------------------------------------------------------------------------------------
// 回归 2026-09-20：用户「有些物料已经下单了，但新建采购单里下单状态还是未下单」。

test("回归：BOM 表存过一次之后（明细整体替换 = 行 ID 全换），已下单量仍要看得见", async () => {
  // 现场机制：`PUT /boms/:id/items`（界面上的「保存 BOM 表」，采购单页里就有「编辑BOM表」入口）
  // 是「软删全部旧行 + 整批建新行」，**存一次 BOM，所有行 ID 都换掉**；
  // 而采购明细里存的 `bom_item_id` 是**下单当时那一版**的 ID。
  // 按「当前未删除的行 ID」去 `in` 一下，那些量会整块消失 → 显示「未下单」→ 采购员再下一张。
  const service = makeService({
    bomItems: [need("bi-new", "5", "material-1")],                                  // 现在的 BOM 行
    rows: [ordered("bi-old", "5", "ordered", "PO-1", null, "material-1")],           // 采购单还指着老行
  });

  const row = (await service.bomItemOrderStatus("bom-1"))[0];

  assert.equal(row.state, "ordered", "已经下过单的物料不许显示成「未下单」——那会让人再下一张，重复采购");
  assert.equal(row.ordered_quantity, "5.0000");
  assert.deepEqual(row.ordered_purchase_order_nos, ["PO-1"], "单号也要带出来，采购员才知道是哪一张");
});

test("回归：BOM 行被换掉后仍按行 ID 精确归集（行还在的照旧，不许被摊到别的行上）", async () => {
  // 分摊只针对「行 ID 已经不在了」的历史量；当前行 ID 还在的必须逐行精确。
  const service = makeService({
    bomItems: [need("bi-1", "5", "material-1"), need("bi-2", "5", "material-2")],
    rows: [ordered("bi-2", "3", "ordered", "PO-2", null, "material-2")],
  });

  const result = await service.bomItemOrderStatus("bom-1");

  assert.equal(byId(result, "bi-1").state, "none", "material-1 没有被下过单");
  assert.equal(byId(result, "bi-2").ordered_quantity, "3.0000");
});

test("回归：物料已经从 BOM 里删掉了，那条历史下单不摊到别的行上（宁可不显示，也不能张冠李戴）", async () => {
  const service = makeService({
    bomItems: [need("bi-new", "5", "material-1")],
    rows: [ordered("bi-old", "5", "ordered", "PO-1", null, "material-999")],
  });

  const row = (await service.bomItemOrderStatus("bom-1"))[0];

  assert.equal(row.state, "none");
  assert.equal(row.ordered_quantity, "0.0000");
});

test("回归：BOM 外新增行（bom_item_id 为空）不占 BOM 行的需求量", async () => {
  // 补料/替代料行没有 BOM 行号：即使物料相同，也不算「这一行的需求已经买过了」。
  const service = makeService({
    bomItems: [need("bi-1", "5", "material-1")],
    rows: [ordered(null, "5", "ordered", "PO-1", null, "material-1")],
  });

  const row = (await service.bomItemOrderStatus("bom-1"))[0];
  assert.equal(row.state, "none");
});
