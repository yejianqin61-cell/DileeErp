// 财务报表接口测试：预览与导出共用同一份 ReportTable，导出响应头与文件名正确。
//
// 分工说明：这里只测「取数 → 表格 → 响应」的接线（用桩替换取数服务），
// 路由鉴权（401/403）与真实 HTTP 信封属于 `apps/api/test/http/*`（需要运行中的服务）。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { Prisma } = require("@prisma/client");
const XLSX = require("xlsx");
const { FinanceReportController } = require("../../dist/modules/finance/finance-report.controller.js");

const dec = (value) => new Prisma.Decimal(value);

/** 取数服务桩：记录收到的筛选条件，返回固定的报表源行。 */
function stubReports(overrides = {}) {
  const filters = { sales: [], purchase: [], summary: [], profit: [], cashDetail: [], cashSummary: [], forex: [] };
  const service = {
    currencyLabels: async () => new Map([["USD", "美元"], ["CNY", "人民币"]]),
    salesReconciliationDetail: async (filter) => {
      filters.sales.push(filter);
      return overrides.salesRows ?? [
        {
          date: new Date("2026-09-07T00:00:00.000Z"),
          orderNo: "XSDD2026090700001",
          customerName: "Matthew Jackson",
          productName: "折叠伞",
          productSpecification: null,
          unit: "打",
          currency: "USD",
          unitPrice: dec("44.685"),
          quantity: dec("41.67"),
          amount: dec("1862.024"),
          order: { currency: "USD", totalAmount: dec("1862.024"), receivableAmount: null, localCurrencyAmount: dec("12475.56") },
        },
      ];
    },
    purchaseReconciliationDetail: async (filter) => {
      filters.purchase.push(filter);
      return overrides.purchaseRows ?? [
        {
          date: new Date("2026-09-08T00:00:00.000Z"),
          purchaseOrderNo: "CGDH1319",
          supplierName: "碧江",
          productName: "23寸*10K 三折自开收",
          materialCode: "WPTM1",
          specification: "黑色电着铁中棒",
          unit: "打",
          currency: "CNY",
          unitPrice: dec("99"),
          quantity: dec("42"),
          amount: dec("4158"),
        },
      ];
    },
    salesReconciliationSummary: async (filter) => {
      filters.summary.push(filter);
      return overrides.summaryRows ?? [
        {
          date: new Date("2026-09-30T00:00:00.000Z"),
          orderNo: "XSDD2026060500002",
          customerName: "中谷ZG",
          currency: "USD",
          salesAmount: dec("24525"),
          adjustmentNet: dec("-500"),
          paidAmount: dec("10000"),
          outstandingAmount: dec("14025"),
        },
      ];
    },
    salesGrossProfit: async (filter) => {
      filters.profit.push(filter);
      return overrides.profit ?? {
        rows: [
          {
            date: new Date("2026-06-05T00:00:00.000Z"),
            orderNo: "XSDD2026060500002",
            customerName: "中谷ZG",
            currency: "USD",
            salesAmount: dec("24525"),
            costAmount: dec("10000"),
            order: { currency: "USD", totalAmount: dec("24525"), receivableAmount: null, localCurrencyAmount: dec("164317.5") },
          },
        ],
        footnotes: overrides.footnotes ?? [],
      };
    },
    cashFlowDetail: async (filter) => {
      filters.cashDetail.push(filter);
      return overrides.cashDetailRows ?? [
        {
          date: new Date("2026-09-14T00:00:00.000Z"),
          counterpartyName: "兴田",
          currency: "CNY",
          direction: "expense",
          amount: dec("2900"),
          category: "损益类",
          subjectName: "主营业务成本",
          bankLabel: "农业银行5706",
          settlementMethod: "转账",
          settlementAccountLabel: "农业银行5706",
        },
      ];
    },
    cashFlowSummary: async (filter) => {
      filters.cashSummary.push(filter);
      return overrides.cashSummary ?? {
        items: [
          { id: "subject-1", category: "资产类", name: "备用金" },
          { id: "subject-2", category: "损益类", name: "主营业务收入" },
        ],
        amounts: [
          { subjectId: "subject-2", currency: "CNY", income: dec("0"), expense: dec("2900") },
          { subjectId: "subject-2", currency: "USD", income: dec("5428"), expense: dec("0") },
        ],
        currencies: ["CNY", "USD"],
      };
    },
    forexReceipts: async (filter) => {
      filters.forex.push(filter);
      return overrides.forex ?? {
        rows: [
          {
            customerName: "中谷",
            currency: "USD",
            orderNo: "DL260002",
            orderQuantity: dec("300"),
            shipmentDate: new Date("2026-05-11T00:00:00.000Z"),
            outboundNo: "OUT-1",
            quantity: dec("100"),
            unit: "打",
            unitPrice: dec("31"),
            amount: dec("3100"),
            depositDate: new Date("2026-05-16T00:00:00.000Z"),
            depositAmount: dec("620"),
            balanceDate: new Date("2026-05-20T00:00:00.000Z"),
            balanceAmount: dec("2480"),
            otherAmount: dec("0"),
            receivedAmount: dec("3100"),
            receivedToDate: dec("3100"),
            outstanding: dec("0"),
            remark: null,
          },
        ],
        footnotes: overrides.forexFootnotes ?? ["另有 1 笔到账（合计 500.00 USD）来自「按对账单一键确认应收」…"],
      };
    },
  };
  return { service, filters };
}

/**
 * 最小 Response 桩：只记录被设置的响应头与 body。
 *
 * `req.currentUser` 是必须的：导出的表尾要写「制表人」（2026-09-16 全站治理），
 * 而 controller 从 `response.req.currentUser` 取当前用户（AuthenticationGuard 挂在 request 上）。
 */
function stubResponse(currentUser = { id: "user-1", username: "caiwu", display_name: "财务小李" }) {
  return {
    headers: {},
    body: null,
    req: { currentUser },
    setHeader(name, value) {
      this.headers[name] = value;
      return this;
    },
    send(body) {
      this.body = body;
      return body;
    },
  };
}

test("finance-report.api：预览返回表格本身（列定义 + 行 + 合计）与行数", async () => {
  const { service } = stubReports();
  const response = await new FinanceReportController(service).salesReconciliationDetail({});
  assert.equal(response.data.sheet_name, "销售对账明细");
  assert.equal(response.data.columns.length, 23);
  assert.equal(response.data.rows.length, 1);
  assert.equal(response.meta.row_count, 1);
  assert.equal(response.data.rows[0][1], "XSDD2026090700001");
  assert.deepEqual(response.data.total_columns, [14, 21]);
  assert.equal(response.data.totals[14], 1862.024, "预览要带合计，否则页面显示「合计」还要前端自己算一遍");
  assert.deepEqual(response.data.columns[0], { header: "日期", num_fmt: null, align: null }, "键名与全站 API 一致用 snake_case，且不把列宽带出去");
  assert.equal(response.data.columns[14].num_fmt, "0.####", "前端据此判断哪一列是数值列");
});

test("finance-report.api：预览与导出的列定义是同一份（看到的和导出的不可能不一致）", async () => {
  const { service } = stubReports();
  const controller = new FinanceReportController(service);
  const preview = await controller.salesReconciliationDetail({});
  const response = stubResponse();
  await controller.exportSalesReconciliationDetail({}, response);

  const workbook = XLSX.read(response.body, { type: "buffer" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const header = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null })[0];
  assert.deepEqual(header, preview.data.columns.map((column) => column.header));
});

test("finance-report.api：导出响应头是 xlsx 附件，文件名是中文并带生成时间与行数", async () => {
  const { service } = stubReports();
  const response = stubResponse();
  await new FinanceReportController(service).exportSalesReconciliationDetail({}, response);

  assert.equal(response.headers["Content-Type"], "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  assert.equal(response.headers["Cache-Control"], "no-store");
  const disposition = response.headers["Content-Disposition"];
  assert.match(disposition, /^attachment; filename\*=UTF-8''/);
  const fileName = decodeURIComponent(/filename\*=UTF-8''(.+)$/.exec(disposition)[1]);
  assert.match(fileName, /^迪礼ERP-销售对账明细-\d{14}-1行\.xlsx$/, `文件名应体现报表名与行数：${fileName}`);
});

test("finance-report.api：导出的 body 是真正的 xlsx 二进制（zip 魔数）", async () => {
  const { service } = stubReports();
  const response = stubResponse();
  await new FinanceReportController(service).exportSalesReconciliationDetail({}, response);
  assert.ok(Buffer.isBuffer(response.body));
  assert.deepEqual([...response.body.subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04], "xlsx 是 zip 容器，前四字节应是 PK\\x03\\x04");
});

test("finance-report.api：采购对账明细表的导出文件名与工作表名", async () => {
  const { service } = stubReports();
  const response = stubResponse();
  await new FinanceReportController(service).exportPurchaseReconciliationDetail({}, response);
  const fileName = decodeURIComponent(/filename\*=UTF-8''(.+)$/.exec(response.headers["Content-Disposition"])[1]);
  assert.match(fileName, /^迪礼ERP-采购对账明细-/);
  const workbook = XLSX.read(response.body, { type: "buffer" });
  assert.deepEqual(workbook.SheetNames, ["采购对账明细"]);
});

test("finance-report.api：外汇一览表预览只回明细那张，但把「客户汇总」作为 extra_sheets 报出来", async () => {
  const { service } = stubReports();
  const response = await new FinanceReportController(service).forexReceipts({});
  assert.equal(response.data.sheet_name, "外汇一览");
  assert.equal(response.data.columns.length, 21, "明细 21 列（老表 19 列 + 币种 + 其他到账）");
  assert.equal(response.meta.row_count, 1);
  // 页面只有一个表格位，所以只预览主表；但必须让人知道导出文件里还有一张表。
  // 汇总行数 = 1 个客户 + 该币种段末的 1 行合计，所以是 2 —— 不是明细的 1。
  assert.deepEqual(response.data.extra_sheets, [{ sheet_name: "客户汇总", row_count: 2 }]);
  assert.equal(response.data.total_columns.length, 0, "一整行一个币种，不给合计列");
  assert.equal(response.data.totals, null);
  assert.ok(response.data.footnotes.some((note) => note.includes("按对账单一键确认应收")), "取数层给的漏项说明要透出来");
});

test("finance-report.api：外汇一览表导出是**一个工作簿两张表**，文件名行数取主表", async () => {
  const { service } = stubReports();
  const response = stubResponse();
  await new FinanceReportController(service).exportForexReceipts({}, response);
  const workbook = XLSX.read(response.body, { type: "buffer" });
  assert.deepEqual(workbook.SheetNames, ["外汇一览", "客户汇总"], "明细与汇总必须在同一个文件里 —— 分开传正是对账对不上的经典原因");
  const fileName = decodeURIComponent(/filename\*=UTF-8''(.+)$/.exec(response.headers["Content-Disposition"])[1]);
  // 行数取**明细**的行数（1），不是汇总的（客户汇总这里只有 1 个客户 + 1 行合计）。
  assert.match(fileName, /^迪礼ERP-外汇一览-.*-1行\.xlsx$/);
});

test("finance-report.api：外汇一览表把筛选条件原样传给取数层（期间/客户/订单号/币种）", async () => {
  const { service, filters } = stubReports();
  await new FinanceReportController(service).forexReceipts({ from: "2026-05-01", to: "2026-05-31", customer_id: "c-1", order_no: "DL260002", currency: "USD" });
  assert.deepEqual(filters.forex[0], {
    from: "2026-05-01",
    to: "2026-05-31",
    customerId: "c-1",
    supplierId: undefined,
    orderNo: "DL260002",
    currency: "USD",
    includeDraft: false,
    subjectId: undefined,
    category: undefined,
    direction: undefined,
  });
});

test("finance-report.api：单张表的报表仍然只写一个工作表（多表能力不是给每张表都加一张）", async () => {
  const { service } = stubReports();
  const response = stubResponse();
  await new FinanceReportController(service).exportCashFlowSummary({}, response);
  const workbook = XLSX.read(response.body, { type: "buffer" });
  assert.deepEqual(workbook.SheetNames, ["收支汇总"]);
});

test("finance-report.api：查询参数映射到取数条件（下划线转驼峰、include_draft 只认 true）", async () => {  const { service, filters } = stubReports();
  const controller = new FinanceReportController(service);
  await controller.salesReconciliationDetail({
    from: "2026-09-01",
    to: "2026-09-30",
    customer_id: "c-1",
    supplier_id: "s-1",
    order_no: "SO-1",
    currency: "USD",
    include_draft: "true",
  });
  assert.deepEqual(filters.sales[0], {
    from: "2026-09-01",
    to: "2026-09-30",
    customerId: "c-1",
    supplierId: "s-1",
    orderNo: "SO-1",
    currency: "USD",
    includeDraft: true,
    subjectId: undefined,
    category: undefined,
    direction: undefined,
  });
});

test("finance-report.api：不给 include_draft 时默认不含草稿", async () => {
  const { service, filters } = stubReports();
  await new FinanceReportController(service).salesReconciliationDetail({});
  assert.equal(filters.sales[0].includeDraft, false);
  assert.equal(filters.sales[0].from, undefined);
});

test("finance-report.api：空结果照样导出表头（能确定「确实是 0 行」，不是导出失败）", async () => {
  const { service } = stubReports({ salesRows: [], purchaseRows: [] });
  const response = stubResponse();
  await new FinanceReportController(service).exportSalesReconciliationDetail({}, response);
  const workbook = XLSX.read(response.body, { type: "buffer" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null });
  assert.ok(rows[0].includes("日期"), "第一行仍是表头：0 行也要能看出是「确实没有数据」");
  // 表头之后没有**数据行**；最后一行是表尾（含 2026-09-16 起加的「制表人 / 制表时间」）。
  const stampIndex = rows.findIndex((row) => Array.isArray(row) && typeof row[0] === "string" && row[0].includes("制表人："));
  assert.ok(stampIndex > 0, "空结果也要写制表人：0 行同样要能看出这份文件是谁、什么时候生成的");
  const dataRows = rows.slice(1, stampIndex).filter((row) => row.some((cell) => cell !== null && cell !== ""));
  assert.deepEqual(dataRows, [], "表头与表尾之间不该有任何数据行");
  const fileName = decodeURIComponent(/filename\*=UTF-8''(.+)$/.exec(response.headers["Content-Disposition"])[1]);
  assert.match(fileName, /-0行\.xlsx$/);
});

/* ------------------------------------------------------------ 二期：汇总表与利润表 */

test("finance-report.api：销售对账汇总表预览与导出（10 列、工作表名、文件名）", async () => {
  const { service } = stubReports();
  const controller = new FinanceReportController(service);
  const preview = await controller.salesReconciliationSummary({});
  assert.equal(preview.data.sheet_name, "销售对账汇总");
  assert.equal(preview.data.columns.length, 10);
  assert.equal(preview.data.rows[0][2], "XSDD2026060500002", "单号 = 销售单号");
  assert.equal(preview.data.rows[0][9], 14025, "欠款");
  assert.deepEqual(preview.data.total_columns, [4, 5, 7, 9]);

  const response = stubResponse();
  await controller.exportSalesReconciliationSummary({}, response);
  const fileName = decodeURIComponent(/filename\*=UTF-8''(.+)$/.exec(response.headers["Content-Disposition"])[1]);
  assert.match(fileName, /^迪礼ERP-销售对账汇总-\d{14}-1行\.xlsx$/);
  const workbook = XLSX.read(response.body, { type: "buffer" });
  assert.deepEqual(workbook.SheetNames, ["销售对账汇总"]);
});

test("finance-report.api：销售利润报表预览带表尾说明（缺采购价物料 / 没有 BOM）", async () => {
  const footnotes = ["缺采购价物料（成本按 0 计入，毛利偏高）（1-1/1）：WPTM9 未知料"];
  const { service } = stubReports({ footnotes });
  const controller = new FinanceReportController(service);
  const preview = await controller.salesGrossProfit({});
  assert.equal(preview.data.sheet_name, "销售利润(毛利)");
  assert.equal(preview.data.rows[0][6], 14525, "销售利润 = 销售金额 − 成本金额");
  assert.deepEqual(preview.data.footnotes, footnotes, "表尾说明要一起回给页面，页面与导出同源");

  const response = stubResponse();
  await controller.exportSalesGrossProfit({}, response);
  const fileName = decodeURIComponent(/filename\*=UTF-8''(.+)$/.exec(response.headers["Content-Disposition"])[1]);
  assert.match(fileName, /^迪礼ERP-销售利润\(毛利\)-/);
});

test("finance-report.api：利润表的筛选条件与其它报表一致地映射", async () => {
  const { service, filters } = stubReports();
  await new FinanceReportController(service).salesGrossProfit({ from: "2026-06-01", customer_id: "c-1", include_draft: "true" });
  assert.equal(filters.profit[0].from, "2026-06-01");
  assert.equal(filters.profit[0].customerId, "c-1");
  assert.equal(filters.profit[0].includeDraft, true);
});

/* ------------------------------------------------------------ 三期：收支两张表 */

test("finance-report.api：收支明细表预览与导出（9 列：老表 6 列 + 分类 + 项目 + 银行账户）", async () => {
  const { service } = stubReports();
  const controller = new FinanceReportController(service);
  const preview = await controller.cashFlowDetail({});
  assert.equal(preview.data.sheet_name, "收支明细");
  assert.equal(preview.data.columns.length, 9);
  assert.deepEqual(preview.data.columns.map((column) => column.header), ["日期", "对方名称", "币种", "分类", "项目", "收入", "支出", "银行账户", "结算方式"]);
  assert.deepEqual(preview.data.rows[0], ["2026-09-14", "兴田", "人民币", "损益类", "主营业务成本", 0, 2900, "农业银行5706", "转账--农业银行5706"]);
  assert.equal(preview.data.totals, null, "收支明细表不给合计（一行一个币种）");

  const response = stubResponse();
  await controller.exportCashFlowDetail({}, response);
  const fileName = decodeURIComponent(/filename\*=UTF-8''(.+)$/.exec(response.headers["Content-Disposition"])[1]);
  assert.match(fileName, /^迪礼ERP-收支明细-\d{14}-1行\.xlsx$/);
  const workbook = XLSX.read(response.body, { type: "buffer" });
  assert.deepEqual(workbook.SheetNames, ["收支明细"]);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const header = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null })[0];
  assert.deepEqual(header, ["日期", "对方名称", "币种", "分类", "项目", "收入", "支出", "银行账户", "结算方式"], "导出的表头与预览同源");
});

test("finance-report.api：收支汇总表预览与导出（分类 × 项目 × 币种，分类段末小计 + 币种段末合计）", async () => {
  const { service } = stubReports();
  const controller = new FinanceReportController(service);
  const preview = await controller.cashFlowSummary({});
  assert.equal(preview.data.sheet_name, "收支汇总");
  assert.deepEqual(preview.data.columns.map((column) => column.header), ["分类", "项目", "币种", "收入", "支出"]);
  // 2 个科目（各属一个分类）× 2 个币种 + 每币种 2 行分类小计 + 每币种 1 行合计 = 10 行
  assert.equal(preview.data.rows.length, 10);
  assert.deepEqual(preview.data.rows[0], ["资产类", "备用金", "人民币", 0, 0]);
  assert.deepEqual(preview.data.rows[1], ["资产类", "小计", "人民币", 0, 0], "分类段末必须给出该分类的小计");
  assert.deepEqual(preview.data.rows[2], ["损益类", "主营业务收入", "人民币", 0, 2900]);
  assert.deepEqual(preview.data.rows[3], ["损益类", "小计", "人民币", 0, 2900]);
  assert.deepEqual(preview.data.rows[4], ["合计", "合计", "人民币", 0, 2900], "币种段末的合计只统计该币种");
  assert.deepEqual(preview.data.rows[5], ["资产类", "备用金", "美元", 0, 0]);
  assert.deepEqual(preview.data.rows[6], ["资产类", "小计", "美元", 0, 0]);
  assert.deepEqual(preview.data.rows[7], ["损益类", "主营业务收入", "美元", 5428, 0]);
  assert.deepEqual(preview.data.rows[8], ["损益类", "小计", "美元", 5428, 0]);
  assert.deepEqual(preview.data.rows[9], ["合计", "合计", "美元", 5428, 0]);
  assert.equal(preview.data.footnotes.length, 3, "「不跨币种相加」与「分类小计」的说明要一起回给页面");

  const response = stubResponse();
  await controller.exportCashFlowSummary({}, response);
  const fileName = decodeURIComponent(/filename\*=UTF-8''(.+)$/.exec(response.headers["Content-Disposition"])[1]);
  assert.match(fileName, /^迪礼ERP-收支汇总-/);
});

test("finance-report.api：收支报表的 subject_id / category / direction 参数照实映射", async () => {
  const { service, filters } = stubReports();
  const controller = new FinanceReportController(service);
  await controller.cashFlowDetail({ subject_id: "subject-2", category: "损益类", direction: "expense", currency: "CNY" });
  assert.equal(filters.cashDetail[0].subjectId, "subject-2");
  assert.equal(filters.cashDetail[0].category, "损益类");
  assert.equal(filters.cashDetail[0].direction, "expense");
  assert.equal(filters.cashDetail[0].currency, "CNY");
});
