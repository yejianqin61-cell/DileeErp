// 采购单**列表**的范围（口径 11，2026-09-27）。
//
// 「采购单模块就是所有已经经过供应商收束下单的采购单」—— 所以列表里不该再有草稿
// （采购计划接管了它，搬迁迁移会把历史草稿归并成计划），已取消的单也不进列表
// （它不再对外，留在审计里可查）。
//
// 生产文件：apps/api/src/modules/procurement/purchase-orders.service.ts 的 list
// 入口：GET /api/v1/purchase-orders
//
// 为什么断言的是**查询条件**而不是返回值：列表的过滤发生在数据库里，
// 用假 Prisma 断言返回值只能证明"假数据被过滤了"。这里钉住真正发出去的 where，
// 与 `reorder` 那批的时间线测试同一手法。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { PurchaseOrdersService } = require("../../dist/modules/procurement/purchase-orders.service.js");

const audit = { create: () => ({}), update: () => ({}), record: async () => {} };

function makeService(rows = []) {
  const calls = [];
  const prisma = { purchaseOrder: { findMany: async (args) => { calls.push(args); return rows; } } };
  return { service: new PurchaseOrdersService(prisma, audit), calls };
}

test("列表只查已下单及之后：ordered / partially_arrived / arrived_complete", async () => {
  const { service, calls } = makeService();

  await service.list();

  assert.deepEqual(calls[0].where.status, { in: ["ordered", "partially_arrived", "arrived_complete"] }, "草稿与已取消都不进列表");
  assert.equal(calls[0].where.deletedAt, null, "软删的单也不进列表");
});

test("带 order_no 的深链筛选同样只查已下单及之后（不能把草稿捞出来）", async () => {
  const { service, calls } = makeService();

  await service.list("SO-1");

  assert.equal(calls[0].where.orderNo, "SO-1");
  assert.deepEqual(calls[0].where.status, { in: ["ordered", "partially_arrived", "arrived_complete"] });
});

test("到货已关闭的 arrived_complete 仍按 partially_arrived 显示（既有口径不变）", async () => {
  const row = { id: "po-1", status: "arrived_complete", extensionData: {}, items: [] };
  const { service } = makeService([row]);

  const [mapped] = await service.list();

  assert.equal(mapped.status, "partially_arrived", "没关到货的 completed 是界面上的「部分到货」");
});

test("到货关闭后保持 arrived_complete", async () => {
  const row = { id: "po-1", status: "arrived_complete", extensionData: { arrival_closed: true }, items: [] };
  const { service } = makeService([row]);

  const [mapped] = await service.list();

  assert.equal(mapped.status, "arrived_complete");
});
