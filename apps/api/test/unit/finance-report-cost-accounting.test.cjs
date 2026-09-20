// 核算表（`example/财务/核算表.xlsx`，财务 2026-09-20 交付）的版式与口径测试。
//
// 这张表是三处录入的汇合点：采购录原材料（BOM 原料成本）、物控录计件人工（日报）、
// 财务录月度管理费。所以这里钉住三件事：
//   1. **算术恒等式**：单价 × 数量 = 金额（费率不提前修约）、利润 = 收入金额 − 费用合计；
//   2. **占比是真数值**：0.55 表示 55%，费用合计为 0 时留空（老表那里是 `#DIV/0!`，绝不写那个）；
//      并且**占比与金额同进同出**（8/9、11/12、15/16 三对一致）：金额算不出来时占比也留空，
//      绝不在空白金额旁边写一个 0.00%（那会被读成「这块费用是 0 元」）；
//   3. **缺什么就说什么**：本币收入缺失、单位与分摊单位不一致、没有登记管理费 —— 都必须落到表尾，
//      否则「费用合计少了」在表上完全看不出来。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { Prisma } = require("@prisma/client");
const XLSX = require("xlsx");
const {
  COST_ACCOUNTING_COLUMNS,
  buildCostAccountingTable,
  reportTotalRow,
} = require("../../dist/modules/finance/finance-report.tables.js");
const { renderReportWorkbook } = require("../../dist/modules/finance/finance-report-workbook.js");
const {
  FinanceReportQueryService,
  MAX_REPORT_ROWS,
} = require("../../dist/modules/finance/finance-report-query.service.js");

const dec = (value) => new Prisma.Decimal(value);

/* ================================================================== 一、版式与纯算术 */

/** 一行核算表的取数结果（默认是「人民币订单 + 打 + 已登记费率」的常规行）。 */
function costRow(overrides = {}) {
  return {
    date: new Date("2026-09-08T00:00:00.000Z"),
    orderNo: "XSDD2026090800001",
    customerName: "26805电商",
    productSpecification: "23寸*10K",
    quantity: dec("4000"),
    unit: "打",
    materialAmount: dec("500000"),
    laborAmount: dec("120000"),
    overheadUnit: "打",
    overheadRate: dec("55"),
    order: { currency: "CNY", totalAmount: dec("1000000"), receivableAmount: null, localCurrencyAmount: null },
    ...overrides,
  };
}

test("核算表：20 列，列名与列序照老表并摊平成单行表头", () => {
  assert.deepEqual(COST_ACCOUNTING_COLUMNS.map((column) => column.header), [
    "日期", "订单号", "客户", "规格",
    "收入单价", "收入数量", "收入金额",
    "原材料单价", "原材料总价", "原材料占比",
    "计件人工单价", "计件人工总价", "计件人工占比",
    "分摊单位", "管理费用", "管理费用金额", "管理费用占比",
    "费用合计", "利润", "备注",
  ]);
  assert.equal(COST_ACCOUNTING_COLUMNS.length, 20);
  // 老表是两行合并表头（收入/原材料/计件人工/管理费用 四个大类各带子列），这里必须摊平成一行：
  // 两行表头在 Excel 里筛选/排序/透视都要先手工整理一遍。
  for (const column of COST_ACCOUNTING_COLUMNS) assert.equal(typeof column.header, "string");
});

test("核算表：数值列与占比列都声明了 numFmt（文本型数字会被整表不变量测试拦下）", () => {
  const numericHeaders = [
    "收入单价", "收入数量", "收入金额",
    "原材料单价", "原材料总价", "计件人工单价", "计件人工总价",
    "管理费用", "管理费用金额", "费用合计", "利润",
  ];
  for (const column of COST_ACCOUNTING_COLUMNS) {
    if (numericHeaders.includes(column.header)) assert.equal(column.numFmt, "0.####", column.header);
    if (column.header.endsWith("占比")) assert.equal(column.numFmt, "0.00%", `${column.header} 必须是数值列 + 百分比格式`);
  }
});

test("核算表：管理费金额 = 数量 × 费率，费率不提前修约（220000 ÷ 3700 这类除不尽的费率）", () => {
  // 财务原话的口径：管理费 22 万、本月生产 3700 打 → 费率 59.4594…，逐行金额 = 数量 × 费率。
  const rate = dec("220000").div(dec("3700"));
  const table = buildCostAccountingTable([costRow({ quantity: dec("3700"), overheadRate: rate })], {});
  const row = table.rows[0];

  assert.equal(row[13], "打", "分摊单位列照登记值写（老表没有这一列，是本次补的口径）");
  assert.equal(row[15], 220000, "管理费用金额 = 数量 × 费率，且回到总额本身");
  // 若有人「为了好看」先把费率修约成 2 位（59.46 × 3700 = 220002），下面两条立刻红。
  assert.ok(String(row[14]).startsWith("59.459459"), `费率不能先修约：${row[14]}`);
  assert.equal(dec(String(row[14])).mul(dec("3700")).toDecimalPlaces(4).toString(), "220000");
  // 单价由金额 ÷ 数量反推，因此「单价 × 数量 = 金额」在任何小数位上都成立。
  const revenue = dec("1000000");
  assert.equal(dec(String(row[4])).mul(dec("3700")).toDecimalPlaces(4).toString(), revenue.toString(), "收入单价 × 数量 = 收入金额");
  assert.equal(dec(String(row[7])).mul(dec("3700")).toDecimalPlaces(4).toString(), "500000", "原材料单价 × 数量 = 原材料总价");
  assert.equal(dec(String(row[10])).mul(dec("3700")).toDecimalPlaces(4).toString(), "120000", "计件人工单价 × 数量 = 计件人工总价");
});

test("核算表：占比是真数值（0.55 表示 55%），费用合计为 0 时留空而不是 #DIV/0!", () => {
  // 费用合计 1000 = 原材料 550 + 计件人工 450（本月没有管理费登记）。
  const table = buildCostAccountingTable(
    [costRow({ materialAmount: dec("550"), laborAmount: dec("450"), overheadUnit: null, overheadRate: null })],
    {},
  );
  const row = table.rows[0];
  assert.equal(row[17], 1000, "费用合计 = 原材料 + 计件人工 + 管理费");
  assert.equal(row[9], 0.55, "占比写成小数 0.55，由 Excel 的 0.00% 格式渲染成 55%");
  assert.equal(row[12], 0.45);
  assert.equal(row[16], null, "这一行没套上费率（本月没登记）：金额与占比一起留空，不写 0.00%");

  // 费用合计确实是 0：三块都算得出来但都是 0（数量为 0 → 管理费金额 0）。
  const zero = buildCostAccountingTable(
    [costRow({ quantity: dec("0"), materialAmount: dec("0"), laborAmount: dec("0") })],
    {},
  ).rows[0];
  assert.equal(zero[17], 0, "数量为 0 时管理费金额 = 0，费用合计 = 0（这是一个事实）");
  assert.equal(zero[9], null, "分母为 0 时占比留空：老表这里是 #DIV/0!，我们不写那个");
  assert.equal(zero[12], null, "分母为 0 时占比留空：老表这里是 #DIV/0!，我们不写那个");
  assert.equal(zero[16], null, "分母为 0 时占比留空：老表这里是 #DIV/0!，我们不写那个");
  for (const index of [9, 12, 16]) assert.equal(Number.isNaN(zero[index]), false, "不能出现 NaN");
});

test("核算表：利润 = 收入金额 − 费用合计（成本缺失按 0，收入缺失则留空）", () => {
  // 收入 100 万 = 原材料 50 万 + 计件人工 12 万 + 管理费 22 万 + 利润 16 万 —— 老表的算式形状。
  const row = buildCostAccountingTable([costRow({ overheadRate: dec("55"), quantity: dec("4000") })], {}).rows[0];
  assert.equal(row[6], 1000000, "收入金额取销售单本币金额");
  assert.equal(row[8], 500000);
  assert.equal(row[11], 120000);
  assert.equal(row[15], 220000);
  assert.equal(row[17], 840000, "费用合计 = 8 + 11 + 15");
  assert.equal(row[18], 160000, "利润 = 6 − 17");

  // 外币且没有本币金额：收入留空（不假装是 0），利润跟着留空 —— 成本缺失那一路才是按 0 计。
  const foreign = buildCostAccountingTable(
    [costRow({ order: { currency: "USD", totalAmount: dec("10000"), receivableAmount: null, localCurrencyAmount: null } })],
    {},
  ).rows[0];
  assert.equal(foreign[6], null, "外币没有本币金额时收入金额留空");
  assert.equal(foreign[7], null, "汇率缺失时原材料单价跟着留空");
  assert.equal(foreign[8], null, "汇率缺失时原材料总价留空（不按原币入账）");
  assert.equal(foreign[18], null, "收入缺失时利润留空（沿用 profitAmount 的取舍）");
});

test("核算表：三块费用一块都没有时的空单元格与「占比与金额同进同出」", () => {
  const row = buildCostAccountingTable(
    [costRow({
      materialAmount: null,
      laborAmount: null,
      overheadUnit: null,
      overheadRate: null,
      order: { currency: "USD", totalAmount: dec("10000"), receivableAmount: null, localCurrencyAmount: null },
    })],
    {},
  ).rows[0];
  assert.equal(row[8], null);
  assert.equal(row[11], null);
  assert.equal(row[15], null);
  assert.equal(row[17], null, "三块全缺 = 「这个月没有费用数据」，不是「费用为 0」");
  // 三对「金额 ↔ 占比」必须同进同出：金额空则占比空。`shareOf(null, 合计)` 返回的是 0，
  // 所以这里只能靠表格层的那道闸 —— 一个 0.00% 挨着空白金额，读起来就是「这块费用是 0 元」。
  for (const [amount, share, label] of [[8, 9, "原材料"], [11, 12, "计件人工"], [15, 16, "管理费用"]]) {
    assert.equal(row[amount], null, label);
    assert.equal(row[share], null, `${label}合计为空时占比也必须为空`);
  }
});

test("核算表：单位不一致的行保留分摊单位，但管理费四列留空，且占比与金额同进同出（不跨单位相乘）", () => {
  // 登记单位是「打」，订单单位是「支」：55 元/打 与 55 元/支 差 12 倍，系统刻意不做换算。
  const row = buildCostAccountingTable(
    [costRow({ unit: "支", materialAmount: dec("550"), laborAmount: dec("450") })],
    {},
  ).rows[0];
  assert.equal(row[13], "打", "分摊单位仍要填：读者得知道这个月按什么单位分摊");
  assert.equal(row[14], null, "单位不一致时费率留空");
  assert.equal(row[15], null, "单位不一致时管理费金额留空");
  assert.equal(row[16], null, "单位不一致时管理费占比留空（金额空的列，占比一定空）");
  assert.equal(row[17], 1000, "费用合计只剩原材料 + 计件人工");
  assert.equal(row[18], 999000, "利润 = 收入 − 费用合计");
  // 另外两块费用算得出来：金额与占比都必须是真数（0.55 / 0.45），不能被管理费那一列带成空。
  assert.equal(row[8], 550);
  assert.equal(row[9], 0.55);
  assert.equal(row[11], 450);
  assert.equal(row[12], 0.45);

  // 单位同义的写法（支 / pcs）归一后算一致，不该被误判成不一致。
  const synonym = buildCostAccountingTable([costRow({ unit: "pcs", overheadUnit: "支" })], {}).rows[0];
  assert.equal(synonym[15], 220000, "「支」与「pcs」是同一个单位（归一后相同）");
});

test("核算表：占比与金额同进同出（三列走同一条规则，不因缺失而写成 0.00%）", () => {
  // 常规行：三对都该有值，且两两自洽。
  const normal = buildCostAccountingTable([costRow()], {}).rows[0];
  for (const [amount, share] of [[8, 9], [11, 12], [15, 16]]) {
    assert.notEqual(normal[amount], null, `第 ${amount} 列应有值`);
    assert.equal(typeof normal[share], "number", `第 ${share} 列应是真数值`);
  }
  // 只缺原材料（外币无本币金额）时，原材料占比跟着空，但另外两对不受影响。
  const noMaterial = buildCostAccountingTable(
    [costRow({ order: { currency: "USD", totalAmount: dec("10000"), receivableAmount: null, localCurrencyAmount: null } })],
    {},
  ).rows[0];
  assert.equal(noMaterial[8], null);
  assert.equal(noMaterial[9], null, "原材料总价算不出来时占比留空，不写 0.00%");
  assert.equal(noMaterial[11], 120000);
  assert.equal(noMaterial[15], 220000);
  // 费用合计只剩「计件人工 + 管理费」（原材料那一块没算出来），所以这两块的占比之和仍是 1 ——
  // 占比的分母是费用合计本身，缺的那一块不进来，另外两块也不会被摊薄或摊多。
  assert.equal(noMaterial[17], 340000, "费用合计少了算不出来的那一块");
  assert.equal(Number((noMaterial[12] + noMaterial[16]).toFixed(10)), 1);
});

test("核算表：合计列是 6/8/11/15/17/18，数量、单价、费率、占比都不参与合计", () => {
  const table = buildCostAccountingTable([costRow(), costRow({ orderNo: "SO-2" })], {});
  assert.deepEqual(table.totalColumns, [6, 8, 11, 15, 17, 18]);

  const totals = reportTotalRow(table);
  assert.equal(totals[6], 2000000, "收入金额");
  assert.equal(totals[8], 1000000, "原材料总价");
  assert.equal(totals[11], 240000, "计件人工总价");
  assert.equal(totals[15], 440000, "管理费用金额");
  assert.equal(totals[17], 1680000, "费用合计");
  assert.equal(totals[18], 320000, "利润");
  for (const index of [4, 5, 7, 10, 14, 19]) assert.equal(totals[index], null, `第 ${index} 列不该有合计`);
  // 占比列即使被写进 totalColumns 也不会求和（`reportTotalRow` 只加声明了 numFmt 的列），
  // 但契约是「不声明」—— 声明了会让 Excel 里出现一栏没有意义的百分比之和。
  for (const index of [9, 12, 16]) assert.equal(table.totalColumns.includes(index), false, "占比不合计");
  assert.equal(totals[0], "合计");

  // 0 行的报表不给合计行（不能凭空给一个 0）。
  assert.equal(reportTotalRow(buildCostAccountingTable([], {})), null);
});

test("核算表：备注列恒空（sales_orders 没有备注字段，不编一个出来）", () => {
  const row = buildCostAccountingTable([costRow()], {}).rows[0];
  assert.equal(row[19], null);
  const foreign = buildCostAccountingTable([costRow({ order: { currency: "USD", totalAmount: null, receivableAmount: null, localCurrencyAmount: dec("67000") } })], {}).rows[0];
  assert.equal(foreign[6], 67000, "销售单上填了本币金额就直接用它（即使两个原币金额都空）");
  assert.equal(foreign[19], null, "备注列不塞币种：币种口径写在表尾说明里");
});

test("核算表：落到工作簿后占比列仍是数值单元格，合计公式只落在声明的 6 列上", async () => {
  const table = buildCostAccountingTable([costRow(), costRow({ orderNo: "SO-2" })], {});
  const workbook = XLSX.read(await renderReportWorkbook([table]), { type: "buffer", cellNF: true });
  assert.deepEqual(workbook.SheetNames, ["核算表"]);
  const sheet = workbook.Sheets["核算表"];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null });
  assert.deepEqual(rows[0], COST_ACCOUNTING_COLUMNS.map((column) => column.header), "导出的表头与预览同源");
  // 占比在单元格里是小数 + 百分比格式，**不是**字符串「55.00%」：拼出来的百分号是文本单元格，
  // 那一列就再也参与不了排序与筛选（老表的毛病）。
  assert.equal(sheet.J2.t, "n", "原材料占比必须是数值单元格");
  assert.equal(sheet.J2.z, "0.00%", "格式由 Excel 渲染，单元格值仍是小数");
  assert.equal(rows[1][9], Number(dec("500000").div(dec("840000")).toString()), "数值就是占比本身（0.595…）");
  // 合计公式只落在 [6,8,11,15,17,18] 这 6 列（G/I/L/P/R/S），别的列一个公式都不该有。
  for (const [letter, index] of [["G", 6], ["I", 8], ["L", 11], ["P", 15], ["R", 17], ["S", 18]]) {
    assert.equal(sheet[`${letter}4`].f, `SUM(${letter}2:${letter}3)`, `第 ${index} 列要有求和公式`);
  }
  for (const letter of ["E", "F", "H", "J", "K", "M", "N", "O", "Q", "T"]) {
    assert.equal(sheet[`${letter}4`], undefined, `${letter} 列（数量/单价/占比/费率/单位/备注）不该写求和公式`);
  }
  assert.equal(sheet.A4.v, "合计");
});

/* ================================================================== 二、取数（查询服务） */

/** 桩：销售单 + 计件日报 + 两个外部服务（成本 / 管理费分摊）。 */
function stubQuery({ orders = [], labor = [], costs = new Map(), allocation = null } = {}) {
  const calls = { salesOrder: [], employeeDailyReport: [], materialCosts: [], resolved: [] };
  const prisma = {
    salesOrder: { findMany: async (args) => { calls.salesOrder.push(args); return orders; } },
    employeeDailyReport: { groupBy: async (args) => { calls.employeeDailyReport.push(args); return labor; } },
  };
  const cost = { materialCosts: async (input) => { calls.materialCosts.push(input); return costs; } };
  const overhead = {
    resolved: async (period) => {
      calls.resolved.push(period);
      return allocation ?? { period, record: null, unit: null, auto_quantity: null, quantity: null, rate: null };
    },
  };
  return { service: new FinanceReportQueryService(prisma, cost, overhead), calls };
}

/** 报销行：内部用一个 id + 订单号，其余字段照 salesOrder 的 select 形状。 */
function order(overrides = {}) {
  return {
    id: "so-1",
    orderNo: "SO-1",
    orderDate: new Date("2026-09-07T00:00:00.000Z"),
    currency: "CNY",
    quantity: dec("4000"),
    unit: "打",
    productSpec: "23寸*10K",
    totalAmount: dec("1000000"),
    receivableAmount: null,
    localCurrencyAmount: null,
    customer: { name: "26805电商" },
    ...overrides,
  };
}

function registered(unit = "打", rate = "55") {
  return {
    period: "2026-09",
    record: { id: "oa-1", period: "2026-09", amount: "220000", unit, quantity_override: null, remark: null, created_at: new Date(), updated_at: new Date(), created_by: "u", updated_by: "u" },
    unit,
    auto_quantity: "3700",
    quantity: "4000",
    rate,
  };
}

test("核算表.query：行集与销售利润表一致（已确认/已关闭销售单、按销售单日期筛、按日期+订单号排序）", async () => {
  const { service, calls } = stubQuery();
  await service.costAccounting({ from: "2026-09-01", to: "2026-09-30", customerId: "c-1", orderNo: "SO-1", currency: "CNY" });
  const where = calls.salesOrder[0].where;
  assert.deepEqual(where.status.in, ["confirmed", "closed"], "与销售利润表(毛利)同一份状态口径");
  assert.equal(where.deletedAt, null);
  assert.equal(where.customerId, "c-1");
  assert.equal(where.orderNo, "SO-1");
  assert.equal(where.currency, "CNY");
  assert.equal(where.orderDate.gte.toISOString(), "2026-09-01T00:00:00.000Z");
  assert.equal(where.orderDate.lte.toISOString(), "2026-09-30T23:59:59.999Z", "截止当天要含当天");
  assert.deepEqual(calls.salesOrder[0].orderBy, [{ orderDate: "asc" }, { orderNo: "asc" }]);

  await service.costAccounting({ includeDraft: true });
  assert.deepEqual(calls.salesOrder[1].where.status.in, ["draft", "confirmed", "closed"]);
});

test("核算表.query：计件人工按销售单号**一次**分组取回（不是逐单查询）", async () => {
  const { service, calls } = stubQuery({
    orders: [order(), order({ id: "so-2", orderNo: "SO-2" })],
    labor: [{ orderNo: "SO-1", _sum: { calculatedAmount: dec("120000") } }],
  });
  const { rows } = await service.costAccounting({ from: "2026-09-01", to: "2026-09-30" });

  assert.equal(calls.employeeDailyReport.length, 1, "两个订单也只查一次（N+1 会让一张表打几百次查询）");
  const where = calls.employeeDailyReport[0].where;
  assert.equal(where.deletedAt, null, "已删除的日报不计入");
  assert.deepEqual(where.orderNo.in, ["SO-1", "SO-2"], "按销售单号分组：日报的 order_no 存的就是销售单号");
  assert.equal(where.reportDate.gte.toISOString(), "2026-09-01T00:00:00.000Z");
  assert.equal(where.reportDate.lte.toISOString(), "2026-09-30T23:59:59.999Z", "人工的期间口径与「日期」列同源");
  assert.deepEqual(calls.employeeDailyReport[0]._sum, { calculatedAmount: true });

  assert.equal(rows[0].laborAmount.toString(), "120000", "有日报的订单取合计");
  assert.equal(rows[1].laborAmount.toString(), "0", "没有日报 = 这个月没录人工费，按 0 计入");
});

test("核算表.query：成本一次批量取回，缺 BOM 的订单成本按 0 并在表尾点名", async () => {
  const costs = new Map([
    ["so-1", { salesOrderId: "so-1", cost: dec("500000"), hasBom: true, missingPrice: [{ materialCode: "WPTM9", materialName: "未知料" }] }],
    ["so-2", { salesOrderId: "so-2", cost: dec("0"), hasBom: false, missingPrice: [] }],
  ]);
  const { service, calls } = stubQuery({ orders: [order(), order({ id: "so-2", orderNo: "SO-2" })], costs });
  const { rows, footnotes } = await service.costAccounting({});

  assert.equal(calls.materialCosts.length, 1, "一批订单只调一次成本服务");
  assert.equal(calls.materialCosts[0].length, 2);
  assert.equal(rows[0].materialAmount.toString(), "500000");
  assert.equal(rows[1].materialAmount.toString(), "0", "没有 BOM 时成本按 0（与销售利润表同一口径）");
  assert.ok(footnotes.some((line) => line.startsWith("缺采购价物料") && line.includes("WPTM9 未知料")));
  assert.ok(footnotes.some((line) => line.startsWith("没有 BOM 或 BOM 无明细的销售单") && line.includes("SO-2")));
});

test("核算表.query：管理费按「起始月」取登记值，并把单位与费率发给每一行", async () => {
  const { service, calls } = stubQuery({ orders: [order()], allocation: registered("打", "55") });
  const { rows } = await service.costAccounting({ from: "2026-09-01", to: "2026-09-30" });
  assert.deepEqual(calls.resolved, ["2026-09"], "管理费按月登记：区间取起始月（allocationPeriodOf 的取舍）");
  assert.equal(rows[0].overheadUnit, "打");
  assert.equal(rows[0].overheadRate.toString(), "55");
});

test("核算表.query：没有给期间时不取费率，并在表尾说清管理费四列为什么是空的", async () => {
  const { service, calls } = stubQuery({ orders: [order()] });
  const { rows, footnotes } = await service.costAccounting({});
  assert.deepEqual(calls.resolved, [], "没有期间就不该去查登记表");
  assert.equal(rows[0].overheadUnit, null);
  assert.equal(rows[0].overheadRate, null);
  assert.ok(footnotes.some((line) => line.includes("未指定期间") && line.includes("月度管理费率")), footnotes.join("\n"));
});

test("核算表.query：区间跨月时在表尾说明费率取自起始月", async () => {
  const { service } = stubQuery({ orders: [order()], allocation: registered() });
  const { footnotes } = await service.costAccounting({ from: "2026-09-01", to: "2026-10-31" });
  assert.ok(footnotes.some((line) => line.includes("跨月") && line.includes("2026-09")), footnotes.join("\n"));
});

test("核算表.query：期间没有登记管理费 / 费率算不出来，两种情况的表尾说明不同", async () => {
  const none = await stubQuery({ orders: [order()] }).service.costAccounting({ from: "2026-09-01", to: "2026-09-30" });
  assert.ok(none.footnotes.some((line) => line.includes("2026-09 没有登记管理费")), none.footnotes.join("\n"));

  const zeroQuantity = {
    period: "2026-09",
    record: { id: "oa-1", period: "2026-09", amount: "220000", unit: "打", quantity_override: "0", remark: null, created_at: new Date(), updated_at: new Date(), created_by: "u", updated_by: "u" },
    unit: "打",
    auto_quantity: "3700",
    quantity: "0",
    rate: null,
  };
  const blocked = await stubQuery({ orders: [order()], allocation: zeroQuantity }).service.costAccounting({ from: "2026-09-01", to: "2026-09-30" });
  assert.ok(blocked.footnotes.some((line) => line.includes("费率算不出来") && line.includes("3700")), blocked.footnotes.join("\n"));
  assert.ok(blocked.footnotes.some((line) => line.includes("覆盖")), "要告诉财务可以人工覆盖分摊数量");
});

test("核算表.query：单位与分摊单位不一致的订单号必须出现在表尾（不能被静默漏掉）", async () => {
  const { service } = stubQuery({
    orders: [order({ unit: "打" }), order({ id: "so-2", orderNo: "SO-2", unit: "支" }), order({ id: "so-3", orderNo: "SO-3", unit: null })],
    allocation: registered("打"),
  });
  const { rows, footnotes } = await service.costAccounting({ from: "2026-09-01", to: "2026-09-30" });
  assert.equal(rows[0].unit, "打");
  const mismatch = footnotes.find((line) => line.startsWith("订单单位与分摊单位不一致的订单"));
  assert.ok(mismatch, footnotes.join("\n"));
  assert.ok(mismatch.includes("SO-2"), "单位不同的订单要点名");
  assert.ok(mismatch.includes("SO-3"), "没填单位的订单同样套不上费率，也要点名");
  assert.equal(mismatch.includes("SO-1"), false, "对得上的订单不该出现在清单里");
});

test("核算表.query：外币订单没有本币金额时，收入留空并把订单号写进表尾", async () => {
  const { service } = stubQuery({
    orders: [
      order({ orderNo: "SO-CNY" }),
      order({ id: "so-usd", orderNo: "SO-USD", currency: "USD", totalAmount: dec("10000"), localCurrencyAmount: null }),
    ],
  });
  const { rows, footnotes } = await service.costAccounting({});
  assert.equal(rows[0].order.currency, "CNY");
  assert.equal(rows[1].order.localCurrencyAmount, null);
  const missing = footnotes.find((line) => line.startsWith("本币收入缺失的订单"));
  assert.ok(missing, footnotes.join("\n"));
  assert.ok(missing.includes("SO-USD"), "外币缺本币金额的订单要点名，不能让读者以为它没有收入");
  assert.equal(missing.includes("SO-CNY"), false, "人民币订单能算出来，不该点名");
  assert.ok(footnotes.some((line) => line.includes("人民币本位币口径")), "整表的本币口径要写在表尾");
});

test("核算表.query：超过行数上限时报错，绝不静默截断", async () => {
  const many = Array.from({ length: MAX_REPORT_ROWS + 1 }, (_, index) => order({ id: `so-${index}`, orderNo: `SO-${index}` }));
  const { service } = stubQuery({ orders: many });
  await assert.rejects(() => service.costAccounting({}), /导出范围过大/);
});

test("核算表.query：没有订单时不发人工查询（空 IN 查询纯属浪费）", async () => {
  const { service, calls } = stubQuery({ orders: [] });
  const { rows, footnotes } = await service.costAccounting({ from: "2026-09-01", to: "2026-09-30" });
  assert.deepEqual(rows, []);
  assert.equal(calls.employeeDailyReport.length, 0);
  assert.equal(calls.materialCosts.length, 1, "成本服务自己会短路空数组");
  assert.ok(footnotes.length > 0, "0 行也要留口径说明");
});
