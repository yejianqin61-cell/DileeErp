"use client";

// 领料单 / 补料单的**纸面版式**（2026-11-02）。
//
// 用户原话：「针对系统中的出库单，要支持导出 excel，支持打印」。原料侧的出库单据是领料单/补料单，
// 导出早就有（`production/reports/material-issue.xlsx`），这一轮补「打印」：屏幕上就是这张纸，
// `window.print()` 只留它（见 globals.css 的 @media print）。
//
// 版式照 `docs/samples/领料单-样例.xlsx` / `补料单-样例.xlsx`：标题（含状态）、三行表头、明细表、
// 小计、备注。数据来自 `GET /production/material-movements/:id/slip-document`（导出服务组装的同一份），
// 页面不再自己算一遍四个数量 —— 2026-10-29 那次「页面与纸面对不上」就是各算一遍来的。
import { Fragment } from "react";
import {
  materialSlipHeadRows, materialSlipPrintColumns, materialSlipPrintHeading, materialSlipPrintSubtotal,
  type MaterialSlipPrint,
} from "../../lib/material-slip-print";

/** 纸上空格：用不换行空格撑住行高（打印时空白格不能被折叠成 0 高）。 */
const blank = (value: unknown) => {
  if (value === null || value === undefined) return "\u00a0";
  const text = String(value);
  return text.trim() ? text : "\u00a0";
};

export function MaterialSlipPrintSheet({ slip }: { slip: MaterialSlipPrint }) {
  const kind = slip.document_type;
  const columns = materialSlipPrintColumns(kind);
  const lines = slip.document.lines ?? [];
  const subtotal = materialSlipPrintSubtotal(kind, lines);
  // 小计落在「本次领料量」（补料单是「补领数量」）这一列下：与导出件的小计行同一个位置。
  const subtotalIndex = kind === "replenishment" ? columns.length - 1 : columns.findIndex((column) => column.key === "currentQuantity");
  return (
    <div className="material-slip-sheet" data-testid="material-slip-sheet">
      <h2 className="material-slip-title" data-testid="material-slip-print-title">{materialSlipPrintHeading(slip)}</h2>
      <table className="material-slip-head">
        <tbody>
          {materialSlipHeadRows(slip).map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map(([label, value], index) => (
                <Fragment key={`${label}-${index}`}>
                  <th>{label}</th>
                  <td>{blank(value)}</td>
                </Fragment>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <table className="material-slip-table">
        <thead>
          <tr>{columns.map((column) => <th key={column.label}>{column.label}</th>)}</tr>
        </thead>
        <tbody>
          {lines.map((line) => (
            <tr key={line.sequence}>
              {columns.map((column) => (
                <td key={column.label} className={column.numeric ? "num" : undefined}>
                  {column.key === "image" ? "\u00a0" : blank((line as unknown as Record<string, unknown>)[column.key])}
                </td>
              ))}
            </tr>
          ))}
          <tr className="material-slip-total">
            {columns.map((column, index) => (
              <td key={column.label} className={column.numeric ? "num" : undefined}>
                {index === 0 ? "小计" : index === subtotalIndex ? subtotal : "\u00a0"}
              </td>
            ))}
          </tr>
        </tbody>
      </table>
      {slip.document.remark ? <p className="material-slip-remark">备注：{slip.document.remark}</p> : null}
    </div>
  );
}
