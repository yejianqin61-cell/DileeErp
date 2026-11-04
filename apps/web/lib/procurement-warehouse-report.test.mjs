// 采购与仓储报表「九列 / 数字 / 文案」口径的纯函数测试（node --test）。
//
// 设计：docs/design/procurement-warehouse-report-2026-11-04.md。这一份钉住四件事：
//   ① 九列的列名、顺序、宽度（合计必须 100%）—— 屏幕、打印、导出共用这一组，抄第二遍就会漂；
//   ② 两个筛选参数拼出来的查询串（空条件不拼一个光秃秃的 `?`）；
//   ③ 数量显示：去无意义尾零、`-0` 归一成 `0`、空颜色显示 `-`；
//   ④ 口径说明三条规则与打印副标题的固定文案（用户会拿打印件核对，文案不能各写一套）。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  REPORT_COLUMNS, REPORT_COLUMN_NOTES, REPORT_EXPORT_FILE_NAME, REPORT_ROW_LIMIT, REPORT_SCOPE_RULES,
  displayReportColor, displayReportText, formatReportQuantity, isNegativeReportQuantity,
  reportDataUrl, reportExportUrl, reportFilterSummary, reportPrintSubtitle, reportQueryString,
} from "./procurement-warehouse-report.ts";

/** 契约 §3.1 的字段顺序（后端 JSON 的字段名，不能被前端改名）。 */
const CONTRACT_FIELDS = [
  "order_no", "material_name", "color", "unit",
  "purchase_quantity", "inbound_quantity", "pending_inbound_quantity", "production_issue_quantity", "stock_quantity",
];

test("九列：列名与顺序与设计文档 §4 一致，字段名与接口契约 §3.1 逐一对应", () => {
  assert.deepEqual(REPORT_COLUMNS.map((column) => column.label), [
    "订单号", "物料名称", "颜色", "单位", "采购数量", "采购入库量", "采购未入库数", "生产领用数量", "库存量",
  ]);
  assert.deepEqual(REPORT_COLUMNS.map((column) => column.key), CONTRACT_FIELDS);
});

test("九列宽度合计正好 100%（DataTable 是 table-layout: fixed，缺一列都会被均分）", () => {
  const widths = REPORT_COLUMNS.map((column) => Number(column.width.replace("%", "")));
  assert.deepEqual(widths, [9, 26, 8, 6, 9, 10, 11, 11, 10]);
  const total = widths.reduce((sum, width) => sum + width, 0);
  assert.equal(total, 100, `九列宽度合计应为 100%，实际 ${total}%`);
  for (const column of REPORT_COLUMNS) assert.match(column.width, /^\d+(\.\d+)?%$/, `${column.label} 的宽度必须是百分比`);
});

test("数字列：五个数量列右对齐；只有「采购未入库数」「库存量」允许为负并标红", () => {
  const numeric = REPORT_COLUMNS.filter((column) => column.numeric).map((column) => column.label);
  assert.deepEqual(numeric, ["采购数量", "采购入库量", "采购未入库数", "生产领用数量", "库存量"]);
  const alert = REPORT_COLUMNS.filter((column) => column.negativeIsAlert).map((column) => column.label);
  assert.deepEqual(alert, ["采购未入库数", "库存量"], "只有超收（未入库为负）与负库存要标红");
  for (const label of ["订单号", "物料名称", "颜色", "单位"]) {
    const column = REPORT_COLUMNS.find((item) => item.label === label);
    assert.equal(column?.numeric, false, `${label} 不是数字列`);
  }
});

test("筛选查询串：只拼非空参数；两个都空时不带 `?`；中文与特殊字符要编码", () => {
  assert.equal(reportQueryString({ order_no: "", material: "" }), "");
  assert.equal(reportQueryString({ order_no: "  ", material: "  " }), "", "空白串等于不筛");
  assert.equal(reportQueryString({ order_no: "260119", material: "" }), "?order_no=260119");
  assert.equal(reportQueryString({ order_no: "", material: "伞布" }), `?material=${encodeURIComponent("伞布")}`);
  assert.equal(
    reportQueryString({ order_no: "260119", material: "伞&布 黑" }),
    `?order_no=260119&${new URLSearchParams({ material: "伞&布 黑" }).toString()}`,
    "物料名里的 & 与空格必须被编码，否则筛选条件会被截断",
  );
  // 前后空白在拼串前要去掉：复制粘贴订单号常带空格。
  assert.equal(reportQueryString({ order_no: " 260119 ", material: "" }), "?order_no=260119");
});

test("两条接口路径：屏幕取数走 apiGet（不带 /api/v1），导出走原生下载（带 /api/v1 与筛选参数）", () => {
  const filters = { order_no: "260119", material: "伞布" };
  assert.equal(reportDataUrl(filters), `/reports/procurement-warehouse${reportQueryString(filters)}`);
  assert.equal(reportExportUrl(filters), `/api/v1/reports/procurement-warehouse/export.xlsx${reportQueryString(filters)}`);
  assert.equal(reportExportUrl({ order_no: "", material: "" }), "/api/v1/reports/procurement-warehouse/export.xlsx");
  assert.equal(REPORT_EXPORT_FILE_NAME, "迪礼ERP-采购与仓储报表.xlsx");
  assert.equal(REPORT_ROW_LIMIT, 5000);
});

test("数量显示：去无意义尾零、负数原样、`-0` 归一成 0、空值显示 `-`", () => {
  assert.equal(formatReportQuantity("4700"), "4700");
  assert.equal(formatReportQuantity("4700.0000"), "4700", "尾零没有信息量");
  assert.equal(formatReportQuantity("0.5000"), "0.5");
  assert.equal(formatReportQuantity("12.3400"), "12.34");
  assert.equal(formatReportQuantity("0"), "0");
  assert.equal(formatReportQuantity("-0"), "0", "负零没有业务含义");
  assert.equal(formatReportQuantity("-0.000"), "0");
  assert.equal(formatReportQuantity("-3.5"), "-3.5", "超收为负，必须显示负号");
  assert.equal(formatReportQuantity("002.100"), "2.1", "前导零也归一");
  assert.equal(formatReportQuantity(""), "-");
  assert.equal(formatReportQuantity(null), "-");
  assert.equal(formatReportQuantity(undefined), "-");
  assert.equal(formatReportQuantity(12.3), "12.3", "接口之外塞进来 number 也不炸");
});

test("负值判断按数值判断，不按首字符（`-0` 不算负、负数才算）", () => {
  assert.equal(isNegativeReportQuantity("-0.5"), true);
  assert.equal(isNegativeReportQuantity("-4700"), true);
  assert.equal(isNegativeReportQuantity("-0"), false);
  assert.equal(isNegativeReportQuantity("0"), false);
  assert.equal(isNegativeReportQuantity("4700"), false);
  assert.equal(isNegativeReportQuantity(""), false);
  assert.equal(isNegativeReportQuantity(null), false);
});

test("颜色为空显示 `-`；订单号/物料名/单位空值同样显示 `-`", () => {
  assert.equal(displayReportColor("黑色"), "黑色");
  assert.equal(displayReportColor(""), "-");
  assert.equal(displayReportColor("   "), "-");
  assert.equal(displayReportText("260119"), "260119");
  assert.equal(displayReportText(""), "-");
  assert.equal(displayReportText(null), "-");
});

test("口径说明：三条必须写进页面/打印/导出的业务规则，且只写业务口径不写表名字段名", () => {
  assert.equal(REPORT_SCOPE_RULES.length, 3);
  assert.match(REPORT_SCOPE_RULES[0], /不跨单位相加/);
  assert.match(REPORT_SCOPE_RULES[1], /库存量不按订单拆账/);
  assert.match(REPORT_SCOPE_RULES[2], /不设合计行/);
  const text = REPORT_SCOPE_RULES.join("\n");
  for (const forbidden of ["purchase_order_items", "inventory_facts", "raw_material_inbounds", "quantity_delta", "deleted_at"]) {
    assert.equal(text.includes(forbidden), false, `口径说明不能出现表名/字段名：${forbidden}`);
  }
  // 五个数量列各有一句来源说明，顺序与表格列顺序一致。
  assert.deepEqual(REPORT_COLUMN_NOTES.map((item) => item.label), ["采购数量", "采购入库量", "采购未入库数", "生产领用数量", "库存量"]);
  for (const item of REPORT_COLUMN_NOTES) assert.ok(item.note.trim().length >= 8, `${item.label} 的来源说明太短`);
});

test("打印副标题：筛选条件 + 行数 + 打印时间（北京时间）", () => {
  assert.equal(reportFilterSummary({ order_no: "", material: "" }), "订单号：全部；物料：全部");
  assert.equal(reportFilterSummary({ order_no: "260119", material: "" }), "订单号：260119；物料：全部");
  assert.equal(
    reportPrintSubtitle({ filters: { order_no: "260119", material: "伞布" }, rowCount: 11, printedAt: "2026-11-04 22:30:05" }),
    "筛选条件：订单号：260119；物料：伞布　行数：11 行　打印时间：2026-11-04 22:30:05（北京时间）",
  );
  // 空打印时间兜底成 `-`，不能印出「打印时间：（北京时间）」这种半截话。
  assert.match(
    reportPrintSubtitle({ filters: { order_no: "", material: "" }, rowCount: 0, printedAt: "" }),
    /打印时间：-（北京时间）$/,
  );
});
