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
  const filters = { sales: [], purchase: [], summary: [], profit: [], cashDetail: [], cashSummary: [] };
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
          itemLabel: "原材料 成本",
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
          { id: "item-1", label: "备用金" },
          { id: "item-2", label: "货款" },
        ],
        amounts: [
          { itemId: "item-2", currency: "CNY", income: dec("0"), expense: dec("2900") },
          { itemId: "item-2", currency: "USD", income: dec("5428"), expense: dec("0") },
        ],
        currencies: ["CNY", "USD"],
      };
    },
  };
  return { service, filters };
}

/** 最小 Response 桩：只记录被设置的响应头与 body。 */
function stubResponse() {
  return {
    headers: {},
    body: null,
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

test("finance-report.api：查询参数映射到取数条件（下划线转驼峰、include_draft 只认 true）", async () => {
  const { service, filters } = stubReports();
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
    itemId: undefined,
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
  assert.equal(rows.length, 1, "只有表头");
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

test("finance-report.api：收支明细表预览与导出（8 列：老表 6 列 + 收支项目 + 银行账户）", async () => {
  const { service } = stubReports();
  const controller = new FinanceReportController(service);
  const preview = await controller.cashFlowDetail({});
  assert.equal(preview.data.sheet_name, "收支明细");
  assert.equal(preview.data.columns.length, 8);
  assert.deepEqual(preview.data.rows[0], ["2026-09-14", "兴田", "人民币", "原材料 成本", 0, 2900, "农业银行5706", "转账--农业银行5706"]);
  assert.equal(preview.data.totals, null, "收支明细表不给合计（一行一个币种）");

  const response = stubResponse();
  await controller.exportCashFlowDetail({}, response);
  const fileName = decodeURIComponent(/filename\*=UTF-8''(.+)$/.exec(response.headers["Content-Disposition"])[1]);
  assert.match(fileName, /^迪礼ERP-收支明细-\d{14}-1行\.xlsx$/);
  const workbook = XLSX.read(response.body, { type: "buffer" });
  assert.deepEqual(workbook.SheetNames, ["收支明细"]);
});

test("finance-report.api：收支汇总表预览与导出（按币种分行，段末合计）", async () => {
  const { service } = stubReports();
  const controller = new FinanceReportController(service);
  const preview = await controller.cashFlowSummary({});
  assert.equal(preview.data.sheet_name, "收支汇总");
  assert.deepEqual(preview.data.columns.map((column) => column.header), ["项目", "币种", "收入", "支出"]);
  // 2 个项目 × 2 个币种 + 每段 1 行合计 = 6 行
  assert.equal(preview.data.rows.length, 6);
  assert.deepEqual(preview.data.rows[2], ["合计", "人民币", 0, 2900]);
  assert.deepEqual(preview.data.rows[5], ["合计", "美元", 5428, 0]);
  assert.equal(preview.data.footnotes.length, 2, "「不跨币种相加」的说明要一起回给页面");

  const response = stubResponse();
  await controller.exportCashFlowSummary({}, response);
  const fileName = decodeURIComponent(/filename\*=UTF-8''(.+)$/.exec(response.headers["Content-Disposition"])[1]);
  assert.match(fileName, /^迪礼ERP-收支汇总-/);
});

test("finance-report.api：收支报表的 item_id / direction 参数照实映射", async () => {
  const { service, filters } = stubReports();
  const controller = new FinanceReportController(service);
  await controller.cashFlowDetail({ item_id: "item-2", direction: "expense", currency: "CNY" });
  assert.equal(filters.cashDetail[0].itemId, "item-2");
  assert.equal(filters.cashDetail[0].direction, "expense");
  assert.equal(filters.cashDetail[0].currency, "CNY");
});
