"use client";

import { Fragment } from "react";

// 成品出库单的**纸面版式**（2026-11-02）。
//
// 用户原话：「针对系统中的出库单，要支持导出 excel，支持打印」。这里是"打印"的那一半：
// 一张 A4 竖版的出库单，屏幕上就是这张纸，`window.print()` 只留它（见 globals.css 的 @media print）。
//
// 三个取舍：
//   1. 内容与导出的 xlsx 逐行一致（同一份 `slip-document` 数据、同一组字段与"发货与签收"小格）——
//      仓库是拿着这张纸跟司机点货的，纸与 Excel 有半点不同，两边就会吵起来；
//   2. 空值印**空格**而不是 "-"：纸上的空格子要留给手写补（运单号常常是发货时才填）；
//   3. 草稿/已取消/已冲销写在标题上：一张"待出库"的单子被当成发货凭据拿出去，比没有单子更糟。
import {
  OUTBOUND_SLIP_COLUMNS, OUTBOUND_SLIP_SIGN_LINE, outboundSlipHeading,
  type FinishedGoodsOutboundSlip,
} from "../../lib/finished-goods-outbound-slip";

/** 空白格：用不换行空格撑住行高（打印时 `&nbsp;` 才不会被折叠成 0 高）。 */
const blank = (value: string | null | undefined) => (value && value.trim() ? value : "\u00a0");

export function FinishedGoodsOutboundSlipSheet({ slip }: { slip: FinishedGoodsOutboundSlip }) {
  // 明细只有一行（一次出库 = 一个产品的一批数量），备注把"本单备注 + 风险原因"合在一起印，
  // 与后端 `outboundLines()` 同一口径。
  const lineRemark = [slip.remark, slip.riskReason ? `风险原因：${slip.riskReason}` : ""].filter(Boolean).join("；");
  // 表头四组「标签 | 值」并排（与导出 xlsx 的 8 列同一块版式）；第三个元素是给单元测试用的 testid。
  const headRows: Array<Array<[string, string, string?]>> = [
    [["出库单号：", slip.outboundNo, "outbound-slip-no"], ["单据日期：", slip.outboundDate], ["状态：", slip.statusLabel], ["客户名称：", slip.customerName]],
    [["订单号：", slip.orderNo], ["生产单号：", slip.implementationOrderNo], ["产品名称：", slip.productName], ["规格型号：", slip.productSpecification]],
    [["本批数量：", `${slip.quantity}${slip.unitName ? ` ${slip.unitName}` : ""}`, "outbound-slip-quantity"], ["发货日期：", slip.shipmentDate], ["承运商：", slip.carrier], ["出库通知：", slip.outboundNoticeNo]],
  ];
  // 发货与签收：与导出件同样的两行（第二行的「备注」吃掉剩下 5 列）。
  const logisticsRows: Array<Array<[string, string, number]>> = [
    [["运单号：", slip.trackingNo, 1], ["装箱单号：", slip.packingListNo, 1], ["发票号：", slip.invoiceNo, 1], ["签收日期：", slip.signedDate, 1]],
    [["签收凭证：", slip.signatureReference, 1], ["备注：", slip.remark, 5]],
  ];
  return (
    <div className="outbound-slip-sheet" data-testid="outbound-slip-sheet">
      <p className="outbound-slip-company">厦门迪礼伞业有限公司</p>
      <h2 className="outbound-slip-title">{outboundSlipHeading(slip)}</h2>
      <table className="outbound-slip-head">
        <tbody>
          {headRows.map((fields, rowIndex) => (
            <tr key={rowIndex}>
              {fields.map(([label, value, testId], index) => (
                <Fragment key={`${label}-${index}`}>
                  <th>{label}</th>
                  <td data-testid={testId}>{blank(value)}</td>
                </Fragment>
              ))}
            </tr>
          ))}
        </tbody>
      </table>

      <table className="outbound-slip-table">
        <thead>
          <tr>{OUTBOUND_SLIP_COLUMNS.map((label) => <th key={label}>{label}</th>)}</tr>
        </thead>
        <tbody>
          <tr>
            <td>1</td>
            <td>{blank(slip.productName)}</td>
            <td>{blank(slip.productSpecification)}</td>
            <td>{blank(slip.unitName)}</td>
            <td className="num">{blank(slip.quantity)}</td>
            <td>{blank(lineRemark)}</td>
          </tr>
          <tr className="outbound-slip-total">
            <td>合计</td>
            <td colSpan={3} />
            <td className="num" data-testid="outbound-slip-total">{slip.quantity}</td>
            <td />
          </tr>
        </tbody>
      </table>

      <table className="outbound-slip-logistics">
        <tbody>
          {logisticsRows.map((fields, rowIndex) => (
            <tr key={rowIndex}>
              {fields.map(([label, value, span], index) => (
                <Fragment key={`${label}-${index}`}>
                  <th>{label}</th>
                  <td colSpan={span}>{blank(value)}</td>
                </Fragment>
              ))}
            </tr>
          ))}
        </tbody>
      </table>

      <p className="outbound-slip-sign">{OUTBOUND_SLIP_SIGN_LINE}</p>
      <p className="outbound-slip-footer">制单：{blank(slip.makerName)}　　打印时间：{blank(slip.printedAt)}（北京时间）</p>
    </div>
  );
}
