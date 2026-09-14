import { displayStatus } from "../../lib/display-text";

/**
 * 财务对象的状态中文名。
 *
 * 为什么不直接复用 lib/display-text：`partially_paid` / `paid` 在应收侧是「部分收款 / 已收清」，
 * 在应付侧是「部分付款 / 已付清」，同一个英文枚举在两侧语义不同；`matched` / `difference`
 * 只出现在对账上。因此这里按侧别区分，未登记的枚举回落到全站通用字典。
 */
const RECEIVABLE_LABELS: Record<string, string> = {
  draft: "草稿", confirmed: "已确认", partially_paid: "部分收款", paid: "已收清", cancelled: "已取消", closed: "已关闭", reversed: "已冲销",
};
const PAYABLE_LABELS: Record<string, string> = {
  draft: "应付草稿", confirmed: "应付已确认", partially_paid: "部分付款", paid: "已付清", reversed: "已冲销", voided: "已作废",
};
const SOURCE_LABELS: Record<string, string> = {
  pending_finance: "待财务接收", received: "已接收", confirmed: "已接收", voided: "已作废",
};
const RECONCILIATION_LABELS: Record<string, string> = {
  pending: "待处理", matched: "已对平", difference: "有差异", resolved: "差异已处理",
};

export type FinanceSide = "receivable" | "payable" | "source" | "reconciliation" | "generic";

export function financeStatus(value: string | null | undefined, side: FinanceSide = "generic") {
  if (!value) return "-";
  const table = side === "receivable" ? RECEIVABLE_LABELS : side === "payable" ? PAYABLE_LABELS : side === "source" ? SOURCE_LABELS : side === "reconciliation" ? RECONCILIATION_LABELS : {};
  return table[value] ?? String(displayStatus(value));
}
