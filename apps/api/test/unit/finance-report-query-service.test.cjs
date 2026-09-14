// 财务报表取数测试：筛选口径、期间边界、行数上限、以及应付明细的字段回退。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { Prisma } = require("@prisma/client");
const {
  FinanceReportQueryService,
  MAX_REPORT_ROWS,
} = require("../../dist/modules/finance/finance-report-query.service.js");

const dec = (value) => new Prisma.Decimal(value);

/** 记录每次调用的参数，便于断言 where/include 的形状。 */
function stubPrisma(overrides = {}) {
  const calls = { dictionaryItem: [], receivableSource: [], supplierPayableEntry: [] };
  const prisma = {
    dictionaryItem: {
      findMany: async (args) => {
        calls.dictionaryItem.push(args);
        return overrides.currencies ?? [{ key: "USD", label: "美元" }, { key: "CNY", label: "人民币" }];
      },
    },
    receivableSource: {
      findMany: async (args) => {
        calls.receivableSource.push(args);
        return overrides.salesRows ?? [];
      },
    },
    supplierPayableEntry: {
      findMany: async (args) => {
        calls.supplierPayableEntry.push(args);
        return overrides.purchaseRows ?? [];
      },
    },
  };
  return { prisma, calls };
}

function salesRow(overrides = {}) {
  return {
    orderNo: "XSDD2026090700001",
    sourceNo: "AR-1",
    unit: "打",
    currency: "USD",
    unitPrice: dec("44.685"),
    quantity: dec("41.67"),
    amount: dec("1862.024"),
    customer: { name: "Matthew Jackson" },
    outbound: { productNameSnapshot: "折叠伞", productSpecificationSnapshot: null },
    salesOrder: { orderDate: new Date("2026-09-07T00:00:00.000Z"), currency: "USD", totalAmount: dec("1862.024"), receivableAmount: null, localCurrencyAmount: dec("12475.56") },
    ...overrides,
  };
}

test("finance-report.query：默认只取已确认及之后的应收，草稿与已取消不进报表", async () => {
  const { prisma, calls } = stubPrisma();
  await new FinanceReportQueryService(prisma).salesReconciliationDetail({});
  assert.deepEqual(calls.receivableSource[0].where.status.in, ["confirmed", "partially_paid", "paid"]);
  assert.equal(calls.receivableSource[0].where.deletedAt, null);
});

test("finance-report.query：includeDraft 才把草稿纳入", async () => {
  const { prisma, calls } = stubPrisma();
  await new FinanceReportQueryService(prisma).salesReconciliationDetail({ includeDraft: true });
  assert.deepEqual(calls.receivableSource[0].where.status.in, ["draft", "confirmed", "partially_paid", "paid"]);
});

test("finance-report.query：应付款项同样默认不含草稿", async () => {
  const { prisma, calls } = stubPrisma();
  await new FinanceReportQueryService(prisma).purchaseReconciliationDetail({});
  assert.deepEqual(calls.supplierPayableEntry[0].where.status.in, ["confirmed", "partially_paid", "paid"]);
});

test("finance-report.query：期间过滤落在销售单日期上（与「日期」列同源）", async () => {
  const { prisma, calls } = stubPrisma();
  await new FinanceReportQueryService(prisma).salesReconciliationDetail({ from: "2026-09-01", to: "2026-09-30" });
  const range = calls.receivableSource[0].where.salesOrder.orderDate;
  assert.equal(range.gte.toISOString(), "2026-09-01T00:00:00.000Z");
  assert.equal(range.lte.toISOString(), "2026-09-30T23:59:59.999Z", "截止当天必须包含当天，否则「截止今天」会漏掉今天的单据");
});

test("finance-report.query：不给期间就不加日期条件", async () => {
  const { prisma, calls } = stubPrisma();
  await new FinanceReportQueryService(prisma).salesReconciliationDetail({ customerId: "c-1" });
  assert.equal(calls.receivableSource[0].where.salesOrder, undefined);
  assert.equal(calls.receivableSource[0].where.customerId, "c-1");
});

test("finance-report.query：期间无效时报 INVALID_REPORT_PERIOD 而不是把坏日期丢给数据库", async () => {
  const { prisma } = stubPrisma();
  await assert.rejects(
    () => new FinanceReportQueryService(prisma).salesReconciliationDetail({ from: "2026-13-45" }),
    /不是有效日期/,
  );
});

test("finance-report.query：采购明细按客户/供应商/订单号/币种过滤", async () => {
  const { prisma, calls } = stubPrisma();
  await new FinanceReportQueryService(prisma).purchaseReconciliationDetail({ supplierId: "s-1", orderNo: "SO-1", currency: "USD" });
  const where = calls.supplierPayableEntry[0].where;
  assert.equal(where.supplierId, "s-1");
  assert.equal(where.orderNo, "SO-1");
  assert.equal(where.currency, "USD");
});

test("finance-report.query：采购期间过滤覆盖「采购日期 + 空采购日期 + 无采购单」三种情况", async () => {
  const { prisma, calls } = stubPrisma();
  await new FinanceReportQueryService(prisma).purchaseReconciliationDetail({ from: "2026-09-01", to: "2026-09-30" });
  const branches = calls.supplierPayableEntry[0].where.OR;
  assert.equal(branches.length, 3, "少一个分支就会把采购日期为空的历史条目静默漏掉");
  assert.deepEqual(Object.keys(branches[0]), ["purchaseOrder"]);
  assert.deepEqual(Object.keys(branches[1]), ["purchaseOrder", "createdAt"]);
  assert.deepEqual(Object.keys(branches[2]), ["purchaseOrderId", "createdAt"]);
});

test("finance-report.query：销售明细行映射到报表字段（含销售单事实）", async () => {
  const { prisma } = stubPrisma({ salesRows: [salesRow()] });
  const rows = await new FinanceReportQueryService(prisma).salesReconciliationDetail({});
  assert.equal(rows.length, 1);
  assert.equal(rows[0].orderNo, "XSDD2026090700001");
  assert.equal(rows[0].customerName, "Matthew Jackson");
  assert.equal(rows[0].productName, "折叠伞");
  assert.equal(rows[0].date.toISOString(), "2026-09-07T00:00:00.000Z");
  assert.equal(rows[0].order.localCurrencyAmount.toString(), "12475.56");
});

test("finance-report.query：销售单缺失时行仍然取出来（只是本币列会留空）", async () => {
  const { prisma } = stubPrisma({ salesRows: [salesRow({ salesOrder: null })] });
  const rows = await new FinanceReportQueryService(prisma).salesReconciliationDetail({});
  assert.equal(rows[0].order, null);
  assert.equal(rows[0].date, null);
});

test("finance-report.query：采购明细的物料取采购明细，采购单缺失时回退外加工物流批次", async () => {
  const fromPurchase = {
    currency: "CNY",
    unitPrice: dec("99"),
    quantity: dec("42"),
    amount: dec("4158"),
    createdAt: new Date("2026-09-08T00:00:00.000Z"),
    supplier: { name: "碧江" },
    purchaseOrder: { purchaseOrderNo: "CGDH1319", purchaseDate: new Date("2026-09-08T00:00:00.000Z") },
    payableSource: {
      purchaseOrder: { purchaseOrderNo: "CGDH1319", purchaseDate: new Date("2026-09-08T00:00:00.000Z") },
      purchaseOrderItem: {
        materialSnapshot: { name: "快照名", specificationModel: "快照规格" },
        material: { materialCode: "WPTM1", name: "23寸*10K 三折自开收", specificationModel: "黑色电着铁中棒" },
        unit: { name: "打" },
      },
    },
    outsourcePayableSource: null,
  };
  const fromOutsource = {
    currency: "CNY",
    unitPrice: dec("10"),
    quantity: dec("5"),
    amount: dec("50"),
    createdAt: new Date("2026-09-09T00:00:00.000Z"),
    supplier: { name: "大田" },
    purchaseOrder: null,
    payableSource: null,
    outsourcePayableSource: {
      purchaseOrder: { purchaseOrderNo: "CGDH2000", purchaseDate: null },
      logisticsBatch: { material: { materialCode: "WPTM2", name: "外加工料", specificationModel: "规格2" }, unit: { name: "个" } },
    },
  };
  const { prisma } = stubPrisma({ purchaseRows: [fromPurchase, fromOutsource] });
  const rows = await new FinanceReportQueryService(prisma).purchaseReconciliationDetail({});

  assert.equal(rows[0].productName, "23寸*10K 三折自开收");
  assert.equal(rows[0].materialCode, "WPTM1");
  assert.equal(rows[0].specification, "黑色电着铁中棒");
  assert.equal(rows[0].unit, "打");
  assert.equal(rows[0].purchaseOrderNo, "CGDH1319");

  assert.equal(rows[1].productName, "外加工料", "外加工签收没有采购明细，物料挂在物流批次的原料上");
  assert.equal(rows[1].materialCode, "WPTM2");
  assert.equal(rows[1].unit, "个");
  assert.equal(rows[1].purchaseOrderNo, "CGDH2000");
  assert.equal(rows[1].date.toISOString(), "2026-09-09T00:00:00.000Z", "采购日期为空时日期回落条目创建时间");
});

test("finance-report.query：采购明细在物料缺失时回退到采购快照", async () => {
  const row = {
    currency: "CNY",
    unitPrice: dec("1"),
    quantity: dec("1"),
    amount: dec("1"),
    createdAt: new Date("2026-09-08T00:00:00.000Z"),
    supplier: { name: "碧江" },
    purchaseOrder: null,
    payableSource: { purchaseOrder: null, purchaseOrderItem: { materialSnapshot: { name: "快照名", specificationModel: "快照规格" }, material: null, unit: null } },
    outsourcePayableSource: null,
  };
  const { prisma } = stubPrisma({ purchaseRows: [row] });
  const rows = await new FinanceReportQueryService(prisma).purchaseReconciliationDetail({});
  assert.equal(rows[0].productName, "快照名");
  assert.equal(rows[0].specification, "快照规格");
  assert.equal(rows[0].materialCode, null);
});

test("finance-report.query：币种标签包含已停用币种（历史单据不能回落成代码）", async () => {
  const { prisma, calls } = stubPrisma();
  await new FinanceReportQueryService(prisma).currencyLabels();
  const where = calls.dictionaryItem[0].where;
  assert.equal(where.type.key, "currency");
  assert.equal(where.deletedAt, null);
  assert.equal("isActive" in where, false, "停用币种也要能显示成中文");
});

test("finance-report.query：超过行数上限时报错，绝不静默截断", async () => {
  const many = Array.from({ length: MAX_REPORT_ROWS + 1 }, (_, index) => salesRow({ orderNo: `SO-${index}` }));
  const { prisma } = stubPrisma({ salesRows: many });
  await assert.rejects(
    () => new FinanceReportQueryService(prisma).salesReconciliationDetail({}),
    (error) => {
      assert.equal(error.getResponse().code, "REPORT_TOO_LARGE");
      assert.match(error.getResponse().message, /20000/);
      return true;
    },
  );
});

test("finance-report.query：正好等于上限时放行", async () => {
  const boundary = Array.from({ length: MAX_REPORT_ROWS }, (_, index) => salesRow({ orderNo: `SO-${index}` }));
  const { prisma } = stubPrisma({ salesRows: boundary });
  const rows = await new FinanceReportQueryService(prisma).salesReconciliationDetail({});
  assert.equal(rows.length, MAX_REPORT_ROWS);
});

/* ------------------------------------------------------------ 二期：汇总表与利润表 */

/** 二期取数需要的桩：应收来源 + 已过账调整 + 销售单 + BOM 成本服务。 */
function stubPhase2({ sources = [], adjustments = [], orders = [], costs = new Map() } = {}) {
  const calls = { receivableSource: [], receivableAdjustment: [], salesOrder: [] };
  const costCalls = [];
  const prisma = {
    receivableSource: { findMany: async (args) => { calls.receivableSource.push(args); return sources; } },
    receivableAdjustment: { findMany: async (args) => { calls.receivableAdjustment.push(args); return adjustments; } },
    salesOrder: { findMany: async (args) => { calls.salesOrder.push(args); return orders; } },
  };
  const cost = { materialCosts: async (input) => { costCalls.push(input); return costs; } };
  return { service: new FinanceReportQueryService(prisma, cost), calls, costCalls };
}

function summarySource(overrides = {}) {
  return {
    orderNo: "SO-1",
    amount: dec("1000"),
    currency: "USD",
    customer: { name: "中谷ZG" },
    salesOrder: { orderDate: new Date("2026-09-30T00:00:00.000Z") },
    allocations: [],
    ...overrides,
  };
}

function profitOrder(overrides = {}) {
  return {
    id: "so-1",
    orderNo: "SO-1",
    orderDate: new Date("2026-06-05T00:00:00.000Z"),
    currency: "USD",
    quantity: dec("100"),
    totalAmount: dec("24525"),
    receivableAmount: null,
    localCurrencyAmount: dec("164317.5"),
    customer: { name: "中谷ZG" },
    ...overrides,
  };
}

test("finance-report.query：汇总表按销售单分组，销售金额等于该单各来源之和", async () => {
  const { service } = stubPhase2({ sources: [summarySource({ amount: dec("1000") }), summarySource({ amount: dec("500") })] });
  const rows = await service.salesReconciliationSummary({});
  assert.equal(rows.length, 1, "同一销售单的两条应收来源要合成一行");
  assert.equal(rows[0].salesAmount.toString(), "1500");
  assert.equal(rows[0].orderNo, "SO-1");
  assert.equal(rows[0].customerName, "中谷ZG");
  assert.equal(rows[0].currency, "USD");
});

test("finance-report.query：已收只算「有效核销 + 已过账付款」", async () => {
  const { service } = stubPhase2({
    sources: [summarySource({ allocations: [
      { amount: dec("300"), status: "active", payment: { status: "posted" } },
      { amount: dec("100"), status: "active", payment: { status: "draft" } },
      { amount: dec("200"), status: "reversed", payment: { status: "posted" } },
    ] })],
  });
  const rows = await service.salesReconciliationSummary({});
  assert.equal(rows[0].paidAmount.toString(), "300", "草稿付款与已冲销核销都不算已收");
});

test("finance-report.query：调整只取已过账的，欠款 = 应收 + 调整净额 − 已收", async () => {
  const { service, calls } = stubPhase2({
    sources: [summarySource({ amount: dec("1000"), allocations: [{ amount: dec("200"), status: "active", payment: { status: "posted" } }] })],
    adjustments: [{ orderNo: "SO-1", effect: "decrease", amount: dec("100") }],
  });
  const rows = await service.salesReconciliationSummary({});
  assert.equal(calls.receivableAdjustment[0].where.status, "posted", "草稿调整未生效、冲销后的调整也不该计入");
  assert.equal(rows[0].adjustmentNet.toString(), "-100");
  assert.equal(rows[0].outstandingAmount.toString(), "700", "1000 − 100 − 200");
});

test("finance-report.query：调整按订单号分组，不会串到别的销售单", async () => {
  const { service } = stubPhase2({
    sources: [summarySource({ orderNo: "SO-1" }), summarySource({ orderNo: "SO-2" })],
    adjustments: [{ orderNo: "SO-1", effect: "decrease", amount: dec("100") }],
  });
  const rows = await service.salesReconciliationSummary({});
  const byOrder = new Map(rows.map((row) => [row.orderNo, row]));
  assert.equal(byOrder.get("SO-1").adjustmentNet.toString(), "-100");
  assert.equal(byOrder.get("SO-2").adjustmentNet.toString(), "0");
});

test("finance-report.query：汇总表的期间筛选同样落在销售单日期上", async () => {
  const { service, calls } = stubPhase2();
  await service.salesReconciliationSummary({ from: "2026-09-01", to: "2026-09-30" });
  assert.equal(calls.receivableSource[0].where.salesOrder.orderDate.gte.toISOString(), "2026-09-01T00:00:00.000Z");
  assert.equal(calls.receivableSource[0].where.status.in.join(","), "confirmed,partially_paid,paid");
});

test("finance-report.query：利润表按销售单取数，销售金额取销售单总额", async () => {
  const costs = new Map([["so-1", { salesOrderId: "so-1", cost: dec("10000"), hasBom: true, missingPrice: [] }]]);
  const { service } = stubPhase2({ orders: [profitOrder()], costs });
  const { rows, footnotes } = await service.salesGrossProfit({});
  assert.equal(rows[0].orderNo, "SO-1");
  assert.equal(rows[0].salesAmount.toString(), "24525");
  assert.equal(rows[0].costAmount.toString(), "10000");
  assert.equal(rows[0].date.toISOString(), "2026-06-05T00:00:00.000Z");
  assert.deepEqual(footnotes, []);
});

test("finance-report.query：利润表把销售数量交给成本服务（漏传会让成本恒为 0）", async () => {
  const { service, costCalls } = stubPhase2({ orders: [profitOrder(), profitOrder({ id: "so-2", orderNo: "SO-2", quantity: dec("25") })] });
  await service.salesGrossProfit({});
  assert.equal(costCalls.length, 1, "一批订单只调一次成本服务，避免逐单 N+1");
  assert.deepEqual(costCalls[0].map((item) => [item.salesOrderId, item.quantity.toString()]), [["so-1", "100"], ["so-2", "25"]]);
});

test("finance-report.query：利润表默认不含草稿销售单，include_draft 才带上", async () => {
  const { service, calls } = stubPhase2({ orders: [] });
  await service.salesGrossProfit({});
  assert.deepEqual(calls.salesOrder[0].where.status.in, ["confirmed", "closed"]);
  await service.salesGrossProfit({ includeDraft: true });
  assert.deepEqual(calls.salesOrder[1].where.status.in, ["draft", "confirmed", "closed"]);
});

test("finance-report.query：利润表缺 BOM 或缺采购价时成本按 0 计入，并在表尾说清缺什么", async () => {
  const costs = new Map([
    ["so-1", { salesOrderId: "so-1", cost: dec("0"), hasBom: false, missingPrice: [] }],
    ["so-2", { salesOrderId: "so-2", cost: dec("0"), hasBom: true, missingPrice: [{ materialCode: "WPTM9", materialName: "未知料" }] }],
  ]);
  const { service } = stubPhase2({ orders: [profitOrder({ id: "so-1", orderNo: "SO-1" }), profitOrder({ id: "so-2", orderNo: "SO-2" })], costs });
  const { rows, footnotes } = await service.salesGrossProfit({});
  assert.equal(rows.length, 2, "缺成本不能让整行消失");
  assert.equal(rows[0].costAmount.toString(), "0");
  assert.equal(footnotes.length, 2);
  assert.match(footnotes[0], /^缺采购价物料（成本按 0 计入，毛利偏高）/);
  assert.match(footnotes[0], /WPTM9 未知料/);
  assert.match(footnotes[1], /^没有 BOM 或 BOM 无明细的销售单/);
  assert.match(footnotes[1], /SO-1/);
});

test("finance-report.query：利润表期间/客户/订单号/币种筛选", async () => {
  const { service, calls } = stubPhase2({ orders: [] });
  await service.salesGrossProfit({ from: "2026-06-01", to: "2026-06-30", customerId: "c-1", orderNo: "SO-9", currency: "USD" });
  const where = calls.salesOrder[0].where;
  assert.equal(where.customerId, "c-1");
  assert.equal(where.orderNo, "SO-9");
  assert.equal(where.currency, "USD");
  assert.equal(where.orderDate.gte.toISOString(), "2026-06-01T00:00:00.000Z");
  assert.equal(where.orderDate.lte.toISOString(), "2026-06-30T23:59:59.999Z");
});

test("finance-report.query：利润表超过行数上限同样报错", async () => {
  const many = Array.from({ length: MAX_REPORT_ROWS + 1 }, (_, index) => profitOrder({ id: `so-${index}`, orderNo: `SO-${index}` }));
  const { service } = stubPhase2({ orders: many });
  await assert.rejects(() => service.salesGrossProfit({}), /导出范围过大/);
});

/* ------------------------------------------------------------ 三期：收支明细 / 收支汇总 */

function stubPhase3({ entries = [], items = [], retired = [] } = {}) {
  const calls = { cashFlowEntry: [], dictionaryItem: [] };
  const prisma = {
    cashFlowEntry: { findMany: async (args) => { calls.cashFlowEntry.push(args); return entries; } },
    dictionaryItem: {
      findMany: async (args) => {
        calls.dictionaryItem.push(args);
        // 两次查询：带 type 过滤的是「启用的项目」，按 id 查的是「本期出现过的停用项目」。
        return args?.where?.type ? items : retired;
      },
    },
  };
  return { service: new FinanceReportQueryService(prisma, { materialCosts: async () => new Map() }), calls };
}

function cashRow(overrides = {}) {
  return {
    entryDate: new Date("2026-09-14T00:00:00.000Z"),
    counterpartyName: "兴田",
    currency: "CNY",
    direction: "expense",
    amount: dec("2900"),
    itemId: "item-2",
    settlementMethod: "转账",
    settlementAccount: { label: "农业银行5706" },
    ...overrides,
  };
}

test("finance-report.query：收支明细只取生效流水，并按期间/项目/币种/方向筛选", async () => {
  const { service, calls } = stubPhase3({ entries: [] });
  await service.cashFlowDetail({ from: "2026-09-01", to: "2026-09-30", itemId: "item-2", currency: "CNY", direction: "expense" });
  const where = calls.cashFlowEntry[0].where;
  assert.equal(where.status, "posted", "已冲销的流水不进报表");
  assert.equal(where.deletedAt, null);
  assert.equal(where.itemId, "item-2");
  assert.equal(where.currency, "CNY");
  assert.equal(where.direction, "expense");
  assert.equal(where.entryDate.lte.toISOString(), "2026-09-30T23:59:59.999Z");
});

test("finance-report.query：收支明细行映射（含结算账户标签）", async () => {
  const { service } = stubPhase3({ entries: [cashRow()] });
  const rows = await service.cashFlowDetail({});
  assert.equal(rows[0].counterpartyName, "兴田");
  assert.equal(rows[0].direction, "expense");
  assert.equal(rows[0].amount.toString(), "2900");
  assert.equal(rows[0].settlementMethod, "转账");
  assert.equal(rows[0].settlementAccountLabel, "农业银行5706");
});

test("finance-report.query：收支汇总按「项目 × 币种」聚合，收入与支出分别累计", async () => {
  const { service } = stubPhase3({
    items: [{ id: "item-2", label: "货款" }],
    entries: [
      cashRow({ currency: "USD", direction: "income", amount: dec("1000") }),
      cashRow({ currency: "USD", direction: "income", amount: dec("4428") }),
      cashRow({ currency: "CNY", direction: "expense", amount: dec("2900") }),
    ],
  });
  const { amounts, currencies } = await service.cashFlowSummary({});
  assert.deepEqual(currencies, ["CNY", "USD"]);
  const usd = amounts.find((row) => row.currency === "USD");
  const cny = amounts.find((row) => row.currency === "CNY");
  assert.equal(usd.income.toString(), "5428", "同项目同币种的收入要累加");
  assert.equal(usd.expense.toString(), "0");
  assert.equal(cny.expense.toString(), "2900");
});

test("finance-report.query：收支汇总的项目清单 = 启用项目 ∪ 本期出现过的停用项目", async () => {
  const { service } = stubPhase3({
    items: [{ id: "item-2", label: "货款" }],
    retired: [{ id: "item-retired", label: "旧项目" }],
    entries: [cashRow({ itemId: "item-retired" })],
  });
  const { items } = await service.cashFlowSummary({});
  // 停用项目的旧流水不能丢：明细表里有、汇总表里没有就是对不上账。
  assert.deepEqual(items, [
    { id: "item-2", label: "货款" },
    { id: "item-retired", label: "旧项目（已停用）" },
  ]);
});

test("finance-report.query：本期全部是启用项目时不再多查一次停用清单", async () => {
  const { service, calls } = stubPhase3({ items: [{ id: "item-2", label: "货款" }], entries: [cashRow({ itemId: "item-2" })] });
  const { items } = await service.cashFlowSummary({});
  assert.equal(items.length, 1);
  assert.equal(calls.dictionaryItem.length, 1, "没有停用项目时不该发第二次字典查询");
});

test("finance-report.query：本期没有流水时按本位币给一段（37 个项目全列、全为 0）", async () => {
  const { service } = stubPhase3({ items: [{ id: "item-2", label: "货款" }], entries: [] });
  const result = await service.cashFlowSummary({});
  assert.deepEqual(result.currencies, ["CNY"], "没有数据也给出本位币这一段，让人能确定是「确实是 0」而不是没跑出来");
  assert.deepEqual(result.amounts, []);
  assert.equal(result.items.length, 1);
});

