// 货号详情（T08）：该货号的每一批 + 跨批汇总 + 能不能返单。
//
// 设计：docs/design/reorder-item-no-and-summary-2026-09-26.md §三.2
// 边界（本文件要钉住的）：**不重算工作台那套阻塞与配平** —— 只给货号轴上的汇总 + 每批状态，
// 推进状态给一个 workbench_href 让人去工作台看。两套阻塞计算一定会漂移。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { NotFoundException } = require("@nestjs/common");
const { Prisma } = require("@prisma/client");
const { ReorderService } = require("../../dist/modules/reorder/reorder.service.js");

const decimal = (value) => new Prisma.Decimal(value);

function orderRow(overrides = {}) {
  return {
    id: `order-${overrides.orderNo ?? "X"}`, orderNo: "DL260001-1", itemNo: "27621 流水花扇",
    orderDate: new Date("2026-06-18T00:00:00.000Z"), deliveryDate: new Date("2026-07-30T00:00:00.000Z"),
    status: "closed", currentVersion: 2, quantity: decimal("1960"), unit: "支", currency: "USD",
    productName: "三折伞", customerId: "customer-1", customerSnapshot: { name: "FLOWER1" }, reorderFromOrderNo: null,
    ...overrides,
  };
}

function fakePrisma({ orders = [], purchases = [], receivables = [], qc = [], production = [], boms = [], inbounds = [], outbounds = [] } = {}) {
  return {
    salesOrder: { findMany: async () => orders },
    purchaseOrder: { findMany: async () => purchases },
    receivableSource: { findMany: async () => receivables },
    finishedGoodsQcRecord: { findMany: async () => qc },
    productionOrder: { findMany: async () => production },
    bom: { findMany: async () => boms },
    finishedGoodsInbound: { findMany: async () => inbounds },
    finishedGoodsOutbound: { findMany: async () => outbounds },
  };
}

test("详情：三批订单按**下单日升序**（时间线从最早到最近），同日按订单号升序", async () => {
  const service = new ReorderService(fakePrisma({
    orders: [
      orderRow({ orderNo: "B-2", orderDate: new Date("2026-08-01") }),
      orderRow({ orderNo: "A-1", orderDate: new Date("2026-01-01") }),
      orderRow({ orderNo: "B-1", orderDate: new Date("2026-08-01") }),
    ],
  }));
  const detail = await service.articleDetail("27621 流水花扇");
  assert.deepEqual(detail.orders.map((order) => order.order_no), ["A-1", "B-1", "B-2"]);
});

test("详情：用归一键匹配 —— 大小写/空白变体都能取到同一组批次", async () => {
  const service = new ReorderService(fakePrisma({ orders: [orderRow({ itemNo: "DL27621" })] }));
  for (const spelling of ["DL27621", "dl27621", " dl27621 "]) {
    const detail = await service.articleDetail(spelling);
    assert.equal(detail.order_count, 1, `${spelling} 应取到同一组`);
  }
});

test("详情：货号不存在 → 404 ARTICLE_NOT_FOUND（只选一种形状，前端不必写两套分支）", async () => {
  const service = new ReorderService(fakePrisma({ orders: [orderRow()] }));
  await assert.rejects(
    () => service.articleDetail("不存在的货号"),
    (error) => error instanceof NotFoundException && error.getResponse().code === "ARTICLE_NOT_FOUND",
  );
});

test("详情：跨批汇总按单位/币种分行，QC 与在制批次数来自全部批次", async () => {
  const service = new ReorderService(fakePrisma({
    orders: [
      orderRow({ orderNo: "A-1", quantity: decimal("1000"), unit: "支" }),
      orderRow({ orderNo: "A-2", quantity: decimal("100"), unit: "打", orderDate: new Date("2026-07-01") }),
    ],
    purchases: [
      { orderNo: "A-1", totalAmount: decimal("100"), currency: "CNY" },
      { orderNo: "A-2", totalAmount: decimal("50"), currency: "CNY" },
    ],
    receivables: [{ orderNo: "A-1", amount: decimal("2352"), currency: "USD" }],
    qc: [
      { orderNo: "A-1", inspectedQuantity: decimal("1000"), qualifiedQuantity: decimal("990"), conditionalAcceptQuantity: decimal("0"), rejectedQuantity: decimal("10") },
      { orderNo: "A-2", inspectedQuantity: decimal("100"), qualifiedQuantity: decimal("100"), conditionalAcceptQuantity: decimal("0"), rejectedQuantity: decimal("0") },
    ],
    production: [{ orderNo: "A-1", status: "completed" }, { orderNo: "A-2", status: "in_progress" }],
  }));
  const detail = await service.articleDetail("27621 流水花扇");
  assert.equal(detail.order_count, 2);
  assert.equal(detail.open_order_count, 1, "A-2 还在生产");
  assert.deepEqual(detail.quantities, [{ unit: "打", quantity: "100" }, { unit: "支", quantity: "1000" }], "不跨单位相加");
  assert.deepEqual(detail.purchase_amounts, [{ currency: "CNY", amount: "150" }]);
  assert.deepEqual(detail.receivable_amounts, [{ currency: "USD", amount: "2352" }]);
  assert.deepEqual(detail.qc, { inspected: "1100", qualified: "1090", conditional: "0", rejected: "10", qualified_rate: "0.9909" });
  assert.equal(detail.first_order_date, "2026-06-18T00:00:00.000Z");
  assert.equal(detail.last_order_date, "2026-07-01T00:00:00.000Z");
});

test("详情：无 QC 事实时合格率是 null；0 值给字符串 0，不给 null", async () => {
  const service = new ReorderService(fakePrisma({ orders: [orderRow()], qc: [] }));
  const detail = await service.articleDetail("27621 流水花扇");
  assert.equal(detail.qc.qualified_rate, null);
  assert.equal(detail.qc.inspected, "0", "没有事实给 \"0\"，不是 null —— null 表示「查不到」");
  assert.equal(detail.orders[0].qc_qualified_quantity, "0");
});

test("详情：每批带上 BOM 版本、采购/生产单数、QC、成品入库与**已出库**（只算真发出去的）", async () => {
  const service = new ReorderService(fakePrisma({
    orders: [orderRow({ orderNo: "A-1" })],
    purchases: [{ orderNo: "A-1", totalAmount: decimal("1"), currency: "CNY" }, { orderNo: "A-1", totalAmount: decimal("2"), currency: "CNY" }],
    qc: [{ orderNo: "A-1", inspectedQuantity: decimal("100"), qualifiedQuantity: decimal("95"), conditionalAcceptQuantity: decimal("3"), rejectedQuantity: decimal("2") }],
    production: [{ orderNo: "A-1", status: "completed" }, { orderNo: "A-1", status: "closed" }],
    boms: [{ orderNo: "A-1", version: 2 }, { orderNo: "A-1", version: 1 }],
    inbounds: [{ orderNo: "A-1", quantity: decimal("95") }],
    outbounds: [
      { orderNo: "A-1", quantity: decimal("95"), status: "posted" },
      { orderNo: "A-1", quantity: decimal("30"), status: "draft" }, // 待出库不算
      { orderNo: "A-1", quantity: decimal("10"), status: "cancelled" }, // 取消不算
    ],
  }));
  const order = (await service.articleDetail("27621 流水花扇")).orders[0];
  assert.deepEqual(order.bom_versions, [1, 2], "版本按升序");
  assert.equal(order.purchase_order_count, 2);
  assert.equal(order.production_order_count, 2);
  assert.equal(order.qc_qualified_quantity, "95");
  assert.equal(order.qc_rejected_quantity, "2");
  assert.equal(order.finished_inbound_quantity, "95");
  assert.equal(order.outbound_quantity, "95", "只算 posted/shipped/signed：草稿是待出库、取消不算");
});

test("详情：can_reorder 由服务端判定并给出中文理由（按钮亮了却 422 是最难查的一类问题）", async () => {
  const service = new ReorderService(fakePrisma({
    orders: [
      orderRow({ orderNo: "OK-1", status: "closed" }),
      orderRow({ orderNo: "DRAFT-1", status: "draft", orderDate: new Date("2026-07-01") }),
    ],
  }));
  const detail = await service.articleDetail("27621 流水花扇");
  const byNo = Object.fromEntries(detail.orders.map((order) => [order.order_no, order]));
  assert.equal(byNo["OK-1"].can_reorder, true);
  assert.equal(byNo["OK-1"].can_reorder_reason, null);
  assert.equal(byNo["DRAFT-1"].can_reorder, false);
  assert.match(byNo["DRAFT-1"].can_reorder_reason, /草稿/);
});

test("详情：每批带 workbench_href（要看推进状态去工作台，不在本页重算阻塞）", async () => {
  const service = new ReorderService(fakePrisma({ orders: [orderRow({ orderNo: "DL260001-1" })] }));
  const order = (await service.articleDetail("27621 流水花扇")).orders[0];
  assert.equal(order.workbench_href, "/?order_no=DL260001-1");
  // 本模块不该出现工作台那套阻塞字段 —— 两套阻塞计算一定会漂移。
  for (const key of ["blockers", "overall_status", "procurement_summary"]) assert.equal(key in order, false, `不该有 ${key}`);
});

test("详情：customers 按批次数降序，取快照里的客户名", async () => {
  const service = new ReorderService(fakePrisma({
    orders: [
      orderRow({ orderNo: "A-1", customerId: "c-1", customerSnapshot: { name: "FLOWER1" } }),
      orderRow({ orderNo: "A-2", customerId: "c-2", customerSnapshot: { name: "家百纳" }, orderDate: new Date("2026-07-01") }),
      orderRow({ orderNo: "A-3", customerId: "c-1", customerSnapshot: { name: "FLOWER1" }, orderDate: new Date("2026-08-01") }),
    ],
  }));
  const detail = await service.articleDetail("27621 流水花扇");
  assert.deepEqual(detail.customers, [
    { customer_id: "c-1", name: "FLOWER1", order_count: 2 },
    { customer_id: "c-2", name: "家百纳", order_count: 1 },
  ]);
});

test("详情：软删批次默认排除；include_deleted=true 纳入；已关闭默认纳入", async () => {
  const calls = [];
  const prisma = fakePrisma({ orders: [orderRow()] });
  const original = prisma.salesOrder.findMany;
  prisma.salesOrder.findMany = (arguments_) => { calls.push(arguments_.where); return original(arguments_); };
  const service = new ReorderService(prisma);
  await service.articleDetail("27621 流水花扇");
  assert.equal(calls[0].deletedAt, null);
  assert.equal("status" in calls[0], false, "已关闭订单默认纳入");
  await service.articleDetail("27621 流水花扇", { include_deleted: "true", include_closed: "false" });
  assert.equal("deletedAt" in calls[1], false);
  assert.deepEqual(calls[1].status, { not: "closed" });
});

test("详情：批次带返单来源单号（这批是从哪返来的，回看时答得出来）", async () => {
  const service = new ReorderService(fakePrisma({ orders: [orderRow({ orderNo: "A-2", reorderFromOrderNo: "DL260001-1" })] }));
  const order = (await service.articleDetail("27621 流水花扇")).orders[0];
  assert.equal(order.reorder_from_order_no, "DL260001-1");
});
