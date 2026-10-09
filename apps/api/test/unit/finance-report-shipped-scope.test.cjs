// 报表的行集只含**已出货**的销售单（用户 2026-10-08）。
//
// 用户原话：「2.财务，财务报表，核算表，用户要求出了货才要进核算表。改进！」
// 三处口径（每题给推荐项、等他选）：
//   ① 「出了货」的判据 = 任一 posted/shipped/signed 的成品出库单，**或** dispatched 的外加工直装柜；
//   ② 部分出货也算出了货（一行仍是整单的数，但必须在表尾点名没出完）；
//   ③ **核算表与销售利润表(毛利)两张表一起改** —— 它们的行集本来就"故意完全一致、要能逐行对上"，
//      只改一张就会把这条对齐关系悄悄弄断。
//
// 为什么这个文件单独存在：行集是**口径**，不是版式。`finance-report-cost-accounting.test.cjs` 与
// `finance-report-query-service.test.cjs` 的桩默认「每张订单都已出完」，它们测的是算数与取数形状；
// 谁进表、谁不进表由这里专门钉住。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { Prisma } = require("@prisma/client");
const { FinanceReportQueryService, MAX_REPORT_ROWS } = require("../../dist/modules/finance/finance-report-query.service.js");

const dec = (value) => new Prisma.Decimal(value);
const SRC = path.join(__dirname, "..", "..", "src");

/** 订单桩：其余字段照 `salesOrder` 的 select 形状。 */
function order(overrides = {}) {
  return {
    id: "so-1",
    orderNo: "SO-1",
    orderDate: new Date("2026-09-07T00:00:00.000Z"),
    currency: "CNY",
    quantity: dec("100"),
    unit: "打",
    productSpec: "23寸*10K",
    totalAmount: dec("24525"),
    receivableAmount: null,
    localCurrencyAmount: dec("24525"),
    customer: { name: "中谷ZG" },
    ...overrides,
  };
}

/**
 * 桩：销售单 + 出货事实 + 两个外部服务。
 * `outbounds` 是成品出库单的查询结果（形状 `{ salesOrderId, quantity }`），
 * `directShipments` 是外加工直装柜的（形状 `{ orderNo, quantity }`）。
 */
function stub({ orders = [], outbounds = [], directShipments = [] } = {}) {
  const calls = { salesOrder: [], finishedGoodsOutbound: [], outsourceDirectShipment: [], employeeDailyReport: [], materialCosts: [] };
  const prisma = {
    salesOrder: { findMany: async (args) => { calls.salesOrder.push(args); return orders; } },
    finishedGoodsOutbound: { findMany: async (args) => { calls.finishedGoodsOutbound.push(args); return outbounds; } },
    outsourceDirectShipment: { findMany: async (args) => { calls.outsourceDirectShipment.push(args); return directShipments; } },
    employeeDailyReport: { groupBy: async (args) => { calls.employeeDailyReport.push(args); return []; } },
  };
  const cost = { materialCosts: async (input) => { calls.materialCosts.push(input); return new Map(); } };
  const overhead = { resolved: async (period) => ({ period, record: null, unit: null, auto_quantity: null, quantity: null, rate: null }) };
  return { service: new FinanceReportQueryService(prisma, cost, overhead), calls };
}

/* ------------------------------------------------------------ 一、查询条件 */

test("已出货判据：成品出库单取 posted/shipped/signed（草稿与红冲/取消都不算），且只查这批订单", async () => {
  const { service, calls } = stub({ orders: [order(), order({ id: "so-2", orderNo: "SO-2" })] });
  await service.costAccounting({});
  const where = calls.finishedGoodsOutbound[0].where;
  assert.deepEqual(where.status.in, ["posted", "shipped", "signed"], "草稿出库单是待出库，不是出了货");
  assert.equal(where.deletedAt, null, "软删的出库单不算");
  assert.deepEqual(where.salesOrderId.in, ["so-1", "so-2"], "一次 IN 查询读回这批订单的出货事实（不逐单查）");
  assert.deepEqual(calls.finishedGoodsOutbound[0].select, { salesOrderId: true, quantity: true }, "要数量才能判断「只出了一部分」");
});

test("已出货判据：外加工直装柜按**订单号**关联（那张表没有 sales_order_id），只认 dispatched", async () => {
  const { service, calls } = stub({ orders: [order(), order({ id: "so-2", orderNo: "SO-2" })] });
  await service.costAccounting({});
  const where = calls.outsourceDirectShipment[0].where;
  assert.deepEqual(where.status.in, ["dispatched"], "draft 还没发、corrected 已冲销，都不算出货");
  assert.equal(where.deletedAt, null);
  assert.deepEqual(where.orderNo.in, ["SO-1", "SO-2"], "直装柜表上没有销售单 id，只能按订单号关联");
});

test("已出货判据：与返单模块的 SHIPPED_OUTBOUND_STATUSES 同值（镜像两份常量，用这条守住）", () => {
  const read = (...parts) => fs.readFileSync(path.join(SRC, ...parts), "utf8");
  const listOf = (source) => JSON.parse((/SHIPPED_OUTBOUND_STATUSES\s*=\s*(\[[^\]]*\])/.exec(source)?.[1] ?? "[]").replace(/'/g, '"'));
  const reorder = listOf(read("modules", "reorder", "reorder.domain.ts"));
  const finance = listOf(read("modules", "finance", "finance-report-query.service.ts"));
  assert.ok(reorder.length > 0 && finance.length > 0, "两处都要能解析出常量");
  assert.deepEqual(finance, reorder, "「已出库」的取值两边必须一致，否则报表与返单会各算一套");
});

test("已出货判据：没有订单时不发空 IN 查询", async () => {
  const { service, calls } = stub({ orders: [] });
  await service.costAccounting({});
  assert.equal(calls.finishedGoodsOutbound.length, 0);
  assert.equal(calls.outsourceDirectShipment.length, 0);
});

/* ------------------------------------------------------------ 二、行集与表尾 */

test("核算表：没出过货的订单不进表，但仍被表尾点名（否则「这单怎么不在」只能靠人回忆）", async () => {
  const { service } = stub({
    orders: [order({ id: "so-1", orderNo: "SO-1" }), order({ id: "so-2", orderNo: "SO-2" })],
    outbounds: [{ salesOrderId: "so-1", quantity: dec("100") }],
  });
  const { rows, footnotes } = await service.costAccounting({});
  assert.deepEqual(rows.map((row) => row.orderNo), ["SO-1"]);
  const excluded = footnotes.find((line) => line.startsWith("尚未出货的销售单（未计入本表）"));
  assert.ok(excluded, footnotes.join("\n"));
  assert.match(excluded, /SO-2/);
  assert.equal(excluded.includes("SO-1"), false, "已出货的单不该出现在「未出货」名单里");
});

test("核算表：只出了一部分的订单**照旧进表**，但表尾写清「已出多少 / 订单多少」", async () => {
  const { service } = stub({
    orders: [order({ id: "so-1", orderNo: "SO-1", quantity: dec("100"), unit: "打" })],
    // 同一张单分两次出库：出库量按销售单累计（两张出库单相加 = 30）。
    outbounds: [{ salesOrderId: "so-1", quantity: dec("20") }, { salesOrderId: "so-1", quantity: dec("10") }],
  });
  const { rows, footnotes } = await service.costAccounting({});
  assert.equal(rows.length, 1, "出了一部分就算出了货，整单进表");
  const partial = footnotes.find((line) => line.startsWith("部分出货的销售单（本表按整单计入）"));
  assert.ok(partial, footnotes.join("\n"));
  assert.ok(partial.includes("SO-1（已出 30 / 订单 100 打）"), partial);
});

test("核算表：出完了（出货量 = 订单量）就不进「部分出货」名单；超发同样不列", async () => {
  const { service } = stub({
    orders: [order({ id: "so-1", orderNo: "SO-1", quantity: dec("100") }), order({ id: "so-2", orderNo: "SO-2", quantity: dec("50") })],
    outbounds: [{ salesOrderId: "so-1", quantity: dec("100") }, { salesOrderId: "so-2", quantity: dec("60") }],
  });
  const { rows, footnotes } = await service.costAccounting({});
  assert.equal(rows.length, 2);
  assert.equal(footnotes.some((line) => line.startsWith("部分出货的销售单")), false, "出完与超发都不是「只出了一部分」");
});

test("外加工直发的订单（没有成品出库单）也能进表 —— 只看出库单会把它们整批漏掉", async () => {
  const { service } = stub({
    orders: [order({ id: "so-1", orderNo: "SO-1" }), order({ id: "so-2", orderNo: "SO-2" })],
    outbounds: [{ salesOrderId: "so-1", quantity: dec("100") }],
    directShipments: [{ orderNo: "SO-2", quantity: dec("100") }],
  });
  const { rows, footnotes } = await service.costAccounting({});
  assert.deepEqual(rows.map((row) => row.orderNo), ["SO-1", "SO-2"], "直装柜已发出的单必须进表");
  assert.equal(footnotes.some((line) => line.startsWith("尚未出货的销售单")), false, "两张单都出了货，谁也不该被点名");
});

test("两张表（销售利润表 / 核算表）的行集与表尾说明完全一致 —— 它们必须能逐行对上", async () => {
  const facts = {
    orders: [order({ id: "so-1", orderNo: "SO-1" }), order({ id: "so-2", orderNo: "SO-2" }), order({ id: "so-3", orderNo: "SO-3" })],
    outbounds: [{ salesOrderId: "so-1", quantity: dec("100") }, { salesOrderId: "so-3", quantity: dec("40") }],
  };
  const gross = await stub(facts).service.salesGrossProfit({});
  const cost = await stub(facts).service.costAccounting({});
  assert.deepEqual(gross.rows.map((row) => row.orderNo), ["SO-1", "SO-3"]);
  assert.deepEqual(cost.rows.map((row) => row.orderNo), ["SO-1", "SO-3"]);
  const scopeOf = (footnotes) => footnotes.filter((line) => /^(尚未出货的销售单|部分出货的销售单)/.test(line));
  assert.deepEqual(scopeOf(gross.footnotes), scopeOf(cost.footnotes), "两张表的行集说明必须逐字相同");
  assert.equal(scopeOf(cost.footnotes).length, 2, "一张没出货（SO-2）+ 一张只出一部分（SO-3）");
});

test("行集说明排在表尾**最前面**：读者第一个问题是「这张单怎么不在表里」", async () => {
  const { service } = stub({
    orders: [order({ id: "so-1", orderNo: "SO-1" }), order({ id: "so-2", orderNo: "SO-2" })],
    outbounds: [{ salesOrderId: "so-1", quantity: dec("100") }],
  });
  const gross = await service.salesGrossProfit({});
  const cost = await service.costAccounting({});
  assert.match(gross.footnotes[0], /^尚未出货的销售单（未计入本表）/);
  assert.match(cost.footnotes[0], /^尚未出货的销售单（未计入本表）/);
  assert.ok(cost.footnotes.some((line) => line.includes("人民币本位币口径")), "其余口径说明仍然在（只是排在后面）");
});

test("过滤在行数上限之后：上限管的是「这次查询规模」，不是过滤后剩几行", async () => {
  // 全部都没出货：过滤后 0 行，但查询规模仍然超限，必须照旧报错（否则一次拖 10 万单进内存）。
  const many = Array.from({ length: MAX_REPORT_ROWS + 1 }, (_, index) => order({ id: `so-${index}`, orderNo: `SO-${index}` }));
  const { service } = stub({ orders: many });
  await assert.rejects(() => service.costAccounting({}), /导出范围过大/);
});
