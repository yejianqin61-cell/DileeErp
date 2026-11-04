"use client";

// 采购与仓储报表的**纸面版式**（2026-11-04）。
//
// 用户原话：「用户需要一份采购与仓储报表…然后设计这份报表并支持导出与打印」。这是"打印"的那一半：
// 屏幕弹窗里就是这张 A4 横向的纸，`window.print()` 只留它（见 globals.css 的 @media print）。
//
// 四个取舍：
//   1. **渲染全部行、不分页**：弹窗里的纸是独立组件，直接遍历 `rows`，不受屏幕上 DataTable 的
//      客户端分页影响 —— 屏幕上每页 50 行是为了能看，纸上少一行就是漏账；
//   2. 数据＝屏幕上当前这份（同一次接口返回），不额外请求、不前端自算：屏幕 11 行、纸 10 行
//      是最难解释的 bug；
//   3. 表头用 `<thead>`：浏览器打印时跨页会**自动重复表头**，几百行时第二页仍然知道每列是什么；
//   4. **不设合计行**：行是不同单位组成的，跨单位合计没有意义（设计 §1 第 3 条，纸上也印了这句）。
import {
  REPORT_COLUMN_NOTES, REPORT_COLUMNS, REPORT_COMPANY, REPORT_SCOPE_INTRO, REPORT_SCOPE_RULES, REPORT_TITLE,
  displayReportColor, displayReportText, formatReportQuantity, isNegativeReportQuantity, reportPrintSubtitle,
  type ProcurementWarehouseFilters, type ProcurementWarehouseRow,
} from "../../lib/procurement-warehouse-report";

/**
 * 纸上的数字格：右对齐 + 等宽数字；只有允许为负的两列（超收 / 负库存）才标红。
 *
 * ⚠️ 这个 class **只能挂在单元格里的 `<span>` 上，不能挂 `<td>`**：`.procurement-warehouse-num`
 * 带 `display: block`（屏幕表格里用它把数字撑满单元格做右对齐），挂到 `<td>` 上会把表格单元格
 * 从表格布局里摘出来 —— 实测后果是每个数字竖着叠成一列、后面几列被挤出纸外
 * （2026-11-04 视觉验证截图 docs/test/results/procurement-warehouse-report/print-media-before-fix.png）。
 */
function quantityClass(columnKey: string, value: string): string {
  const negative = columnKey === "pending_inbound_quantity" || columnKey === "stock_quantity";
  return negative && isNegativeReportQuantity(value) ? "procurement-warehouse-num status-error" : "procurement-warehouse-num";
}

export function ProcurementWarehousePrintSheet({ rows, filters, printedAt }: {
  rows: ProcurementWarehouseRow[];
  filters: ProcurementWarehouseFilters;
  printedAt: string;
}) {
  return (
    <div className="procurement-warehouse-sheet" data-testid="procurement-warehouse-sheet">
      <p className="procurement-warehouse-company">{REPORT_COMPANY}</p>
      <h2 className="procurement-warehouse-title">{REPORT_TITLE}</h2>
      <p className="procurement-warehouse-meta" data-testid="procurement-warehouse-print-subtitle">
        {reportPrintSubtitle({ filters, rowCount: rows.length, printedAt })}
      </p>
      <table className="procurement-warehouse-table">
        {/* 列宽只写一次：与屏幕 DataTable 的 meta.width 同一组百分比（合计 100%），纸与屏幕逐列对齐。 */}
        <colgroup>
          {REPORT_COLUMNS.map((column) => <col key={column.key} style={{ width: column.width }} />)}
        </colgroup>
        <thead>
          <tr>{REPORT_COLUMNS.map((column) => <th key={column.key}>{column.label}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={`${row.order_no}-${row.material_name}-${row.unit}-${index}`} data-testid="procurement-warehouse-sheet-row">
              <td>{displayReportText(row.order_no)}</td>
              <td>{displayReportText(row.material_name)}</td>
              <td>{displayReportColor(row.color)}</td>
              <td>{displayReportText(row.unit)}</td>
              {(["purchase_quantity", "inbound_quantity", "pending_inbound_quantity", "production_issue_quantity", "stock_quantity"] as const).map((key) => (
                <td key={key}><span className={quantityClass(key, row[key])}>{formatReportQuantity(row[key])}</span></td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="procurement-warehouse-notes">
        <p className="procurement-warehouse-notes-title">口径说明</p>
        <p>{REPORT_SCOPE_INTRO}</p>
        {REPORT_SCOPE_RULES.map((rule) => <p key={rule}>{rule}</p>)}
        {REPORT_COLUMN_NOTES.map((item) => <p key={item.label}>{item.label}：{item.note}</p>)}
      </div>
    </div>
  );
}
