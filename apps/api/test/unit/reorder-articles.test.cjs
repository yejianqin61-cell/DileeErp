// 货号清单（T07）：归并、分行汇总、筛选、分页。
//
// 老板原话：「可以调取该货号。查看当时该批货号的采购，生产，QC 的所有表单，信息」——
// 本文件钉住「调取」这一步的口径。设计：docs/design/reorder-item-no-and-summary-2026-09-26.md §三.2
//
// 最要紧的一条：**归并必须在内存里做**（`groupBy` 按列值分组，`27621` 与 `27621␠` 会各成一组）。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { Prisma } = require("@prisma/client");
const { ReorderService } = require("../../dist/modules/reorder/reorder.service.js");
const { mergeArticles, qualifiedRate, sumByUnit, sumByCurrency } = require("../../dist/modules/reorder/reorder.domain.js");
const { itemNoKey } = require("../../dist/modules/sales/item-no.js");

const decimal = (value) => new Prisma.Decimal(value);

/** 一张订单的轻字段行（与 service 的 LIGHT_SELECT 同形状）。 */
function orderRow(overrides = {}) {
  return {
    id: overrides.id ?? `order-${overrides.orderNo ?? "X"}`,
    orderNo: "DL260001-1", itemNo: "27621", orderDate: new Date("2026-06-18T00:00:00.000Z"), deliveryDate: new Date("2026-07-30T00:00:00.000Z"),
    status: "confirmed", quantity: decimal("1960"), unit: "支", currency: "USD", productName: "三折伞",
    customerSnapshot: { name: "FLOWER1" },
    ...overrides,
  };
}

/** 假 Prisma：只实现本模块用到的五张表，可按调用记录断言 where。 */
function fakePrisma({ orders = [], purchases = [], receivables = [], qc = [], production = [], calls = {} } = {}) {
  const record = (name) => (arguments_) => { calls[name] = arguments_; return Promise.resolve(); };
  return {
    salesOrder: { findMany: (arguments_) => { calls.salesOrder = arguments_; return Promise.resolve(orders); } },
    purchaseOrder: { findMany: (arguments_) => { calls.purchaseOrder = arguments_; return Promise.resolve(typeof purchases === "function" ? purchases(arguments_) : purchases); } },
    receivableSource: { findMany: (arguments_) => { calls.receivableSource = arguments_; return Promise.resolve(receivables); } },
    finishedGoodsQcRecord: { findMany: (arguments_) => { calls.qc = arguments_; return Promise.resolve(qc); } },
    productionOrder: { findMany: (arguments_) => { calls.production = arguments_; return Promise.resolve(production); } },
    ...record,
  };
}

// ------------------------------------------------------------------ 纯函数：分行汇总

test("分行汇总：数量按单位分行，**不跨单位相加**（支 + 打 相加没有意义）", () => {
  const totals = sumByUnit([{ unit: "支", quantity: decimal("100") }, { unit: "打", quantity: decimal("5") }, { unit: "支", quantity: decimal("50") }]);
  // 顺序按码位（不用 localeCompare —— 它受环境 ICU/locale 影响，会让响应顺序变成环境相关）。
  assert.deepEqual(totals, [{ unit: "打", quantity: "5" }, { unit: "支", quantity: "150" }]);
});

test("分行汇总：金额按币种分行，不跨币种相加", () => {
  const totals = sumByCurrency([{ currency: "USD", amount: decimal("100.50") }, { currency: "CNY", amount: decimal("700") }, { currency: "USD", amount: decimal("0.50") }]);
  assert.deepEqual(totals, [{ currency: "CNY", amount: "700" }, { currency: "USD", amount: "101" }]);
});

test("合格率：受检为 0 时是 null（不是 0）—— 没有质检事实 ≠ 全部不合格", () => {
  assert.equal(qualifiedRate(decimal("0"), decimal("0")), null);
  assert.equal(qualifiedRate(null, null), null);
  assert.equal(qualifiedRate(decimal("1960"), decimal("1930")), "0.9847");
  assert.equal(qualifiedRate(decimal("100"), decimal("0")), "0", "真的一个都不合格时才是 0");
});

// ------------------------------------------------------------------ 纯函数：归并

test("归并：同一个货号的几种写法（大小写/尾空格/全角空格）必须归到一组", () => {
  const rows = [
    orderRow({ orderNo: "A-1", itemNo: "27621" }),
    orderRow({ orderNo: "A-2", itemNo: " 27621 " }),
    orderRow({ orderNo: "A-3", itemNo: "27621\u3000" }),
  ];
  const merged = mergeArticles(rows, itemNoKey);
  assert.equal(merged.length, 1, "三种写法是同一个货号：不归并就会出现「同一个货号两个分组」");
  assert.equal(merged[0].itemNoKey, "27621");
  assert.equal(merged[0].orderCount, 3);
  assert.deepEqual(merged[0].orderNos, ["A-1", "A-2", "A-3"]);
});

test("归并：展示用的写法取组内出现最多的那一种（存原样，不改大小写）", () => {
  // 写入侧已经做过归一（trim + 折叠空白），所以库里能同时存在的"同键不同写法"实际只有**大小写**差异。
  const merged = mergeArticles([
    orderRow({ orderNo: "A-1", itemNo: "DL27621" }),
    orderRow({ orderNo: "A-2", itemNo: "dl27621" }),
    orderRow({ orderNo: "A-3", itemNo: "dl27621" }),
  ], itemNoKey);
  assert.equal(merged.length, 1, "大小写不同但是同一个货号");
  assert.equal(merged[0].itemNo, "dl27621", "展示取出现次数多的那种写法");
  assert.equal(merged[0].itemNoKey, "DL27621");
});

test("归并：没有货号的订单不进任何货号组", () => {
  assert.deepEqual(mergeArticles([orderRow({ itemNo: null })], itemNoKey), []);
});

test("归并：按最近下单倒序、同时间按归一键升序（分页要稳）", () => {
  const merged = mergeArticles([
    orderRow({ orderNo: "A-1", itemNo: "B-货", orderDate: new Date("2026-01-01") }),
    orderRow({ orderNo: "A-2", itemNo: "A-货", orderDate: new Date("2026-05-01") }),
    orderRow({ orderNo: "A-3", itemNo: "C-货", orderDate: new Date("2026-05-01") }),
  ], itemNoKey);
  assert.deepEqual(merged.map((article) => article.itemNo), ["A-货", "C-货", "B-货"]);
});

test("归并：首末下单日与最近交期都从组内订单算出来", () => {
  const merged = mergeArticles([
    orderRow({ orderNo: "A-1", orderDate: new Date("2026-01-01"), deliveryDate: new Date("2026-03-01") }),
    orderRow({ orderNo: "A-2", orderDate: new Date("2026-05-01"), deliveryDate: null }),
    orderRow({ orderNo: "A-3", orderDate: new Date("2026-03-01"), deliveryDate: new Date("2026-06-01") }),
  ], itemNoKey);
  assert.equal(merged[0].firstOrderDate, "2026-01-01T00:00:00.000Z");
  assert.equal(merged[0].lastOrderDate, "2026-05-01T00:00:00.000Z");
  assert.equal(merged[0].lastDeliveryDate, "2026-06-01T00:00:00.000Z", "交期为空的那批不参与取最大");
});

// ------------------------------------------------------------------ 服务：筛选与分页

test("清单：已关闭订单默认纳入；include_closed=false 时排除", async () => {
  const calls = {};
  const service = new ReorderService(fakePrisma({ orders: [], calls }));
  await service.listArticles({});
  assert.equal("status" in calls.salesOrder.where, false, "默认不按状态过滤（已关闭也是历史事实）");
  await service.listArticles({ include_closed: "false" });
  assert.deepEqual(calls.salesOrder.where.status, { not: "closed" });
});

test("清单：软删订单默认排除；include_deleted=true 时纳入", async () => {
  const calls = {};
  const service = new ReorderService(fakePrisma({ calls }));
  await service.listArticles({});
  assert.equal(calls.salesOrder.where.deletedAt, null);
  await service.listArticles({ include_deleted: "true" });
  assert.equal("deletedAt" in calls.salesOrder.where, false);
});

test("清单：只取有货号的订单（没有货号的走待补录那条路）", async () => {
  const calls = {};
  await new ReorderService(fakePrisma({ calls })).listArticles({});
  assert.deepEqual(calls.salesOrder.where.itemNo, { not: null });
});

test("清单：q 按**归一键**匹配（大小写与空白不敏感）", async () => {
  const service = new ReorderService(fakePrisma({ orders: [orderRow({ itemNo: "27621 流水花扇" }), orderRow({ orderNo: "B-1", itemNo: "88001 新版" })] }));
  assert.equal((await service.listArticles({ q: "27621" })).total, 1);
  assert.equal((await service.listArticles({ q: " 27621 " })).total, 1, "q 自己也要归一（前后空格不该把结果滤没）");
  assert.equal((await service.listArticles({ q: "流水" })).total, 1);
  assert.equal((await service.listArticles({ q: "88001" })).data[0].itemNo, "88001 新版");
  assert.equal((await service.listArticles({})).total, 2);
});

test("清单：分页的 total 是**归并后的货号数**，第 2 页不重不漏", async () => {
  const orders = [
    orderRow({ orderNo: "A-1", itemNo: "A", orderDate: new Date("2026-01-01") }),
    orderRow({ orderNo: "A-2", itemNo: "A", orderDate: new Date("2026-01-02") }),
    orderRow({ orderNo: "B-1", itemNo: "B", orderDate: new Date("2026-02-01") }),
    orderRow({ orderNo: "C-1", itemNo: "C", orderDate: new Date("2026-03-01") }),
  ];
  const service = new ReorderService(fakePrisma({ orders }));
  const first = await service.listArticles({ page: 1, page_size: 2 });
  const second = await service.listArticles({ page: 2, page_size: 2 });
  assert.equal(first.total, 3, "total 是货号数（3），不是销售单数（4）");
  assert.deepEqual(first.data.map((article) => article.itemNo), ["C", "B"]);
  assert.deepEqual(second.data.map((article) => article.itemNo), ["A"]);
  assert.equal(first.data.length + second.data.length, 3);
});

test("清单：空结果给 data: [] 与 total: 0，不报错", async () => {
  const result = await new ReorderService(fakePrisma({ orders: [] })).listArticles({});
  assert.deepEqual(result.data, []);
  assert.equal(result.total, 0);
});

// ------------------------------------------------------------------ 服务：下游汇总

test("清单：采购/应收金额按币种分行，QC 汇总与合格率来自当前页的订单", async () => {
  const orders = [orderRow({ orderNo: "A-1", itemNo: "27621", quantity: decimal("1000"), unit: "支" }), orderRow({ orderNo: "A-2", itemNo: "27621", quantity: decimal("500"), unit: "支" })];
  const service = new ReorderService(fakePrisma({
    orders,
    purchases: [
      { orderNo: "A-1", totalAmount: decimal("100"), currency: "CNY" },
      { orderNo: "A-2", totalAmount: decimal("200.5"), currency: "CNY" },
      { orderNo: "A-2", totalAmount: decimal("30"), currency: "USD" },
    ],
    receivables: [{ orderNo: "A-1", amount: decimal("2352"), currency: "USD" }],
    qc: [
      { orderNo: "A-1", inspectedQuantity: decimal("1000"), qualifiedQuantity: decimal("990"), conditionalAcceptQuantity: decimal("0"), rejectedQuantity: decimal("10") },
      { orderNo: "A-2", inspectedQuantity: decimal("500"), qualifiedQuantity: decimal("490"), conditionalAcceptQuantity: decimal("10"), rejectedQuantity: decimal("0") },
    ],
  }));
  const article = (await service.listArticles({})).data[0];
  assert.deepEqual(article.quantities, [{ unit: "支", quantity: "1500" }]);
  assert.deepEqual(article.purchase_amounts, [{ currency: "CNY", amount: "300.5" }, { currency: "USD", amount: "30" }]);
  assert.deepEqual(article.receivable_amounts, [{ currency: "USD", amount: "2352" }]);
  assert.deepEqual(article.qc, { inspected: "1500", qualified: "1480", conditional: "10", rejected: "10", qualified_rate: "0.9867" });
});

test("清单：没有 QC 事实时合格率是 null（前端显示 -，不是 0%）", async () => {
  const service = new ReorderService(fakePrisma({ orders: [orderRow()], qc: [] }));
  const article = (await service.listArticles({})).data[0];
  assert.equal(article.qc.inspected, "0");
  assert.equal(article.qc.qualified_rate, null);
});

test("清单：在制批次数只数未走完的生产单，且按订单去重", async () => {
  const service = new ReorderService(fakePrisma({
    orders: [orderRow({ orderNo: "A-1" }), orderRow({ orderNo: "A-2" })],
    production: [
      { orderNo: "A-1", status: "in_progress" },
      { orderNo: "A-1", status: "draft" },
      { orderNo: "A-2", status: "completed" },
    ],
  }));
  const article = (await service.listArticles({})).data[0];
  assert.equal(article.open_order_count, 1, "A-1 有两条未完成生产单，但只有 1 个批次在制");
});

test("清单：下游聚合只查当前页的订单号（不是全部匹配订单）", async () => {
  const calls = {};
  const orders = [1, 2, 3, 4, 5].map((index) => orderRow({ orderNo: `A-${index}`, itemNo: `货-${index}`, orderDate: new Date(2026, 0, index) }));
  await new ReorderService(fakePrisma({ orders, calls })).listArticles({ page: 1, page_size: 2 });
  assert.equal(calls.salesOrder.select.itemNo, true, "轻字段里必须带 itemNo（归并靠它）");
  assert.equal(calls.purchaseOrder.where.orderNo.in.length, 2, "只对当前页的 2 个货号做下游聚合");
});

// ------------------------------------------------------------------ 待补录清单

test("待补录：只取没有货号的订单，且返回的是订单行而不是货号组", async () => {
  const calls = {};
  const service = new ReorderService(fakePrisma({
    calls,
    orders: [orderRow({ orderNo: "A-1", itemNo: null, productName: "三折伞", quantity: decimal("1960"), status: "confirmed" })],
  }));
  const result = await service.listUnassignedOrders({});
  assert.deepEqual(calls.salesOrder.where.itemNo, null);
  assert.equal(result.total, 1);
  assert.deepEqual(result.data[0], {
    sales_order_id: "order-A-1", order_no: "A-1", customer_name: "FLOWER1", product_name: "三折伞",
    quantity: "1960", unit: "支", order_date: "2026-06-18T00:00:00.000Z", status: "confirmed",
  });
});

test("待补录：最近下单的排前面（要补的通常是刚做完的那几批）", async () => {
  const service = new ReorderService(fakePrisma({
    orders: [
      orderRow({ orderNo: "OLD", itemNo: null, orderDate: new Date("2025-01-01") }),
      orderRow({ orderNo: "NEW", itemNo: null, orderDate: new Date("2026-09-01") }),
    ],
  }));
  const result = await service.listUnassignedOrders({});
  assert.deepEqual(result.data.map((row) => row.order_no), ["NEW", "OLD"]);
});

test("待补录：支持按订单号/产品名/客户名搜索", async () => {
  const service = new ReorderService(fakePrisma({
    orders: [
      orderRow({ orderNo: "DL260001-1", itemNo: null, productName: "三折伞", customerSnapshot: { name: "FLOWER1" } }),
      orderRow({ orderNo: "DL260002-1", itemNo: null, productName: "直骨伞", customerSnapshot: { name: "家百纳" } }),
    ],
  }));
  assert.deepEqual((await service.listUnassignedOrders({ q: "家百纳" })).data.map((row) => row.order_no), ["DL260002-1"]);
  assert.deepEqual((await service.listUnassignedOrders({ q: "DL260001" })).data.map((row) => row.order_no), ["DL260001-1"]);
});
