// 工作台批量取数的回归测试（2026-11-22）。
//
// 修的是什么：`list()` 曾经对**每个订单**调一次 `summary()`，而每次 `summary()` 内含 22 个
// 并发查询 —— `page_size=200` 就是 200×22 = **4400 个查询**打向只有 15 个连接的池，
// 单个用户打开工作台就能把池打满（生产实测 "Timed out fetching a new connection"）。
//
// 这里钉住三件事：
//   ① 查询数**与订单数无关**（整批共 22 个）；
//   ② 分组正确（A 单的事实不会跑到 B 单上）；
//   ③ 没有关联数据的订单得到空事实（而不是借用别人的数据或崩掉）。
const assert = require("node:assert/strict");
const { test } = require("node:test");

const { OrderWorkbenchService, MAX_PAGE_SIZE, SUMMARY_QUERY_COUNT } = require("../../dist/modules/order-workbench/order-workbench.service.js");

const MODELS = [
  "bom", "bomItem", "purchaseOrder", "purchaseOrderItem", "purchaseReceipt", "incomingInspection",
  "productionOrder", "operationDailyReport", "rawMaterialMovement", "rawMaterialInbound", "inventoryFact",
  "finishedGoodsQcRecord", "finishedGoodsInbound", "finishedGoodsOutbound", "finishedGoodsInboundNotice",
  "receivableSource", "customerPayment", "receivableAllocation", "payableSource", "supplierPayableEntry",
  "supplierPayment", "supplierPaymentAllocation",
];

/** 造一个假 prisma：记录每个模型的 findMany 调用（含 in 列表大小），按订单号返回数据。 */
function fakePrisma(fixtures = {}) {
  const calls = [];
  const delegate = (model) => ({
    findMany: async (args) => {
      const where = args?.where ?? {};
      // 取「订单号过滤」的 in 列表长度，用来证明是批量而非逐单
      const direct = where.orderNo;
      const viaBom = where.bom?.orderNo;
      const viaPurchase = where.purchaseOrder?.orderNo;
      const viaReceivable = where.receivableSource?.orderNo;
      const filter = direct ?? viaBom ?? viaPurchase ?? viaReceivable ?? {};
      calls.push({ model, inCount: Array.isArray(filter.in) ? filter.in.length : null });
      return fixtures[model] ?? [];
    },
  });
  const prisma = {};
  for (const model of MODELS) prisma[model] = delegate(model);
  prisma.salesOrder = {
    findMany: async (args) => { calls.push({ model: "salesOrder.findMany", take: args?.take }); return fixtures.salesOrder ?? []; },
    count: async () => fixtures.total ?? (fixtures.salesOrder ?? []).length,
    findFirst: async () => fixtures.singleOrder ?? null,
  };
  return { prisma, calls };
}

function order(orderNo, extra = {}) {
  return { orderNo, customerSnapshot: "客户", status: "confirmed", quantity: "10", currency: "CNY", updatedAt: new Date("2026-11-22T00:00:00Z"), ...extra };
}

test("查询数与订单数无关：200 单整批只用 22 个查询（旧实现是 4400 个）", async () => {
  const orders = Array.from({ length: 200 }, (_, index) => order(`SO-${index + 1}`));
  const { prisma, calls } = fakePrisma({ salesOrder: orders, total: 200 });
  const service = new OrderWorkbenchService(prisma);

  const result = await service.list({ page_size: 200 });

  const factQueries = calls.filter((call) => call.model !== "salesOrder.findMany");
  assert.equal(factQueries.length, SUMMARY_QUERY_COUNT, `整批应为 ${SUMMARY_QUERY_COUNT} 个查询，实际 ${factQueries.length}`);
  // 每个查询的 in 列表都覆盖整批 200 单
  for (const call of factQueries) assert.equal(call.inCount, 200, `${call.model} 应带 200 个订单号`);
  assert.equal(result.data.length, 200);
  // 单次查询数不随订单数线性增长：这才是「不会再打满连接池」的量化依据
  assert.ok(factQueries.length < 200, "查询数必须小于订单数（否则就是 N+1）");
});

test("分组正确：A 单的物料不会算到 B 单头上", async () => {
  const orders = [order("SO-A"), order("SO-B")];
  const { prisma } = fakePrisma({
    salesOrder: orders,
    total: 2,
    bom: [{ orderNo: "SO-A", id: "b1", version: 1, status: "released" }],
    bomItem: [{ requiredQuantity: "5", unit: "个", bom: { orderNo: "SO-A" } }],
    purchaseOrder: [{ orderNo: "SO-A", id: "p1", purchaseOrderNo: "PO-A", status: "ordered", totalAmount: "100", currency: "CNY" }],
    purchaseOrderItem: [{ quantity: "5", amount: "100", unitId: "u1", purchaseOrder: { orderNo: "SO-A" } }],
  });
  const service = new OrderWorkbenchService(prisma);

  const result = await service.list({ page_size: 10 });
  const a = result.data.find((row) => row.order_no === "SO-A");
  const b = result.data.find((row) => row.order_no === "SO-B");

  assert.equal(a.bom_status, "completed");
  assert.equal(a.procurement_summary.ordered_quantity, "5");
  assert.equal(a.procurement_summary.counts.records, 1);

  // B 单没有任何关联数据：必须拿到空事实，且触发 BOM 缺失阻塞
  assert.equal(b.bom_status, "not_started");
  assert.equal(b.procurement_summary.ordered_quantity, "0");
  assert.equal(b.procurement_summary.counts.records, 0);
  assert.ok(b.blockers.some((item) => item.code === "BOM_MISSING"), "B 单应报 BOM 缺失");
  assert.ok(!a.blockers.some((item) => item.code === "BOM_MISSING"), "A 单有 BOM，不该报缺失");
});

test("经过父表的三个查询也能正确分组（BOM 明细/采购明细/应收核销）", async () => {
  const orders = [order("SO-A"), order("SO-B")];
  const { prisma } = fakePrisma({
    salesOrder: orders,
    total: 2,
    bomItem: [
      { requiredQuantity: "3", unit: "米", bom: { orderNo: "SO-A" } },
      { requiredQuantity: "4", unit: "米", bom: { orderNo: "SO-B" } },
    ],
    purchaseOrderItem: [
      { quantity: "3", amount: "30", unitId: "u", purchaseOrder: { orderNo: "SO-A" } },
    ],
    receivableAllocation: [
      { amount: "12", receivableSource: { orderNo: "SO-B" } },
    ],
    receivableSource: [{ orderNo: "SO-B", id: "r1", sourceNo: "AR-B", status: "confirmed", amount: "20", currency: "CNY" }],
  });
  const service = new OrderWorkbenchService(prisma);

  const result = await service.list({ page_size: 10 });
  const a = result.data.find((row) => row.order_no === "SO-A");
  const b = result.data.find((row) => row.order_no === "SO-B");

  assert.equal(a.procurement_summary.ordered_quantity, "3");
  assert.equal(b.procurement_summary.ordered_quantity, "0", "B 单不该拿到 A 单的采购明细");
  assert.equal(b.receivable_summary.paid_amount, "12", "B 单的应收核销应按父表归到 B");
  assert.equal(b.receivable_summary.outstanding_amount, "8");
});

test("空页不发任何事实查询（避免 22 个空查询）", async () => {
  const { prisma, calls } = fakePrisma({ salesOrder: [], total: 0 });
  const service = new OrderWorkbenchService(prisma);
  const result = await service.list({ page_size: 200 });
  assert.equal(result.data.length, 0);
  assert.equal(calls.filter((call) => call.model !== "salesOrder.findMany").length, 0);
});

test("page_size 有硬上限，防止调用方把数据库拖死", async () => {
  const orders = [order("SO-1")];
  const { prisma, calls } = fakePrisma({ salesOrder: orders, total: 1 });
  const service = new OrderWorkbenchService(prisma);
  await service.list({ page_size: 100000 });
  const listCall = calls.find((call) => call.model === "salesOrder.findMany");
  assert.equal(listCall.take, MAX_PAGE_SIZE);
});

test("详情与列表走同一套计算（口径不可能分叉）", async () => {
  const single = order("SO-A");
  const { prisma } = fakePrisma({
    singleOrder: single,
    bom: [{ orderNo: "SO-A", id: "b1", version: 1, status: "released" }],
  });
  const service = new OrderWorkbenchService(prisma);
  const detail = await service.detail("SO-A");
  assert.equal(detail.order_no, "SO-A");
  assert.equal(detail.bom_status, "completed");
});

test("订单不存在时详情抛 404 而不是返回空壳", async () => {
  const { prisma } = fakePrisma({ singleOrder: null });
  const service = new OrderWorkbenchService(prisma);
  await assert.rejects(() => service.detail("SO-NOPE"), (error) => error?.getStatus?.() === 404 || /不存在/.test(String(error?.message)));
});
// ── 静态守卫：防止「新增查询忘了 select orderNo」导致数据静默消失 ──────────
// 分组靠 orderNo。若某个查询的 select 里没有 orderNo（也没经父表 orderNo），
// 它的行会被 groupBundle 全部丢弃 —— 工作台数字变 0，且**不报错**。
// 这种错最难发现，所以在源码层拦一道。
test("queryBundle 里每个查询都必须能拿到 orderNo（直接列 或 经父表）", () => {
  const { readFileSync } = require("node:fs");
  const { join } = require("node:path");
  const source = readFileSync(join(__dirname, "../../src/modules/order-workbench/order-workbench.service.ts"), "utf8");
  const start = source.indexOf("export async function queryBundle");
  assert.ok(start > 0, "必须能找到 queryBundle");
  const body = source.slice(start, source.indexOf("return { boms", start));
  // 每个 prisma.xxx.findMany({...}) 一段
  const calls = body.split("prisma.").slice(1);
  assert.equal(calls.length, SUMMARY_QUERY_COUNT, `queryBundle 应有 ${SUMMARY_QUERY_COUNT} 个查询，实际 ${calls.length}`);
  for (const call of calls) {
    const model = call.slice(0, call.indexOf(".findMany"));
    const selectable =
      call.includes("orderNo: true") ||           // 表自身有 orderNo 列
      call.includes("bom: { select: { orderNo: true } }") ||
      call.includes("purchaseOrder: { select: { orderNo: true } }") ||
      call.includes("receivableSource: { select: { orderNo: true } }");
    assert.ok(selectable, `${model} 的 select 必须包含 orderNo（否则该表数据会被静默丢弃）`);
  }
});