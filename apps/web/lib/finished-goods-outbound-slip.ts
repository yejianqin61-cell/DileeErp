/**
 * 成品出库单「导出 Excel / 打印」的前端口径（纯函数 + 路径常量，无 React / 无网络依赖）。
 *
 * 用户 2026-11-02：「针对系统中的出库单，要支持导出 excel，支持打印」。
 *
 * 两条纪律：
 *   1. **打印件与导出件是同一份数据**：都来自 `GET /finished-goods/outbounds/:id/slip-document`
 *      （后端 `buildDocument` 组装），页面不再自己拼字段 —— 两份各拼一次，迟早出现"纸上有、屏幕上少一行"；
 *   2. **单据编号与文件名只在一处生成**：导出件的文件名要带单号，打印标题也要带单号，
 *      两处各写一遍就会出现「导出的文件叫 A、纸头上印的是 B」。
 */

/** 打印件数据（与后端 `FinishedGoodsOutboundDocument` 一一对应）。 */
export type FinishedGoodsOutboundSlip = {
  outboundNo: string;
  status: string;
  statusLabel: string;
  orderNo: string;
  customerName: string;
  productName: string;
  productSpecification: string;
  implementationOrderNo: string;
  outboundNoticeNo: string;
  outboundDate: string;
  quantity: string;
  unitName: string;
  shipmentDate: string;
  carrier: string;
  trackingNo: string;
  packingListNo: string;
  invoiceNo: string;
  signedDate: string;
  signatureReference: string;
  remark: string;
  riskReason: string;
  makerName: string;
  printedAt: string;
};

/** 打印件数据的接口路径（不带 `/api/v1` 前缀：走 `apiGet`，它会补）。 */
export function outboundSlipDocumentPath(id: string): string {
  return `/finished-goods/outbounds/${encodeURIComponent(id)}/slip-document`;
}

/** 导出 xlsx 的完整路径（带 `/api/v1`：走 `downloadFile` 的原生 fetch）。 */
export function outboundSlipExportPath(id: string): string {
  return `/api/v1/finished-goods/outbounds/${encodeURIComponent(id)}/export.xlsx`;
}

/** 文件名：与后端 `Content-Disposition` 里的一致（后端那个优先，这里只是兜底）。 */
export function outboundSlipFileName(outboundNo: string): string {
  return `迪礼ERP-成品出库单-${outboundNo || "未命名"}.xlsx`;
}

/**
 * 纸头标题：**草稿/已取消/已冲销必须在标题上写出来**。
 *
 * 一张"待出库"的单子被当成已发货的凭据拿去跟司机点货，比没有单子更糟；而这张纸一旦打印出去，
 * 系统里再怎么改状态都追不回来 —— 所以状态必须印在纸头上，不能只印在系统列表里。
 */
export function outboundSlipHeading(slip: Pick<FinishedGoodsOutboundSlip, "status" | "statusLabel">): string {
  const suffix = ["draft", "cancelled", "reversed"].includes(slip.status) ? `（${slip.statusLabel}）` : "";
  return `成品出库单${suffix}`;
}

/** 打印件页脚的签字行（空白供手签；导出件里是同样的文字）。 */
export const OUTBOUND_SLIP_SIGN_LINE = "仓库经办：　　　　　　　承运人：　　　　　　　客户签收：　　　　　　　日期：";

/** 明细表头（与后端导出的 xlsx 同一组列名）。 */
export const OUTBOUND_SLIP_COLUMNS = ["序号", "产品名称", "规格型号", "单位", "数量", "备注"] as const;

/**
 * 打印件上的「发货与签收」小格（空值也留格：手写补）。
 *
 * 做成纯函数是为了能被 node:test 钉住：这张纸上"哪几格有、顺序怎样"必须与导出的 xlsx 一致，
 * 而 xlsx 那边是服务端写的 —— 两边靠这组向量对齐。
 */
export function outboundSlipLogisticsRows(slip: FinishedGoodsOutboundSlip): Array<[string, string]> {
  return [
    ["运单号", slip.trackingNo],
    ["装箱单号", slip.packingListNo],
    ["发票号", slip.invoiceNo],
    ["签收日期", slip.signedDate],
    ["签收凭证", slip.signatureReference],
    ["备注", slip.remark],
  ];
}
