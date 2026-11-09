// 挂账状态（2026-11-09 R3-6 / R3-13）：后端应付、应收的 list/get 返回 `accrual_status`。
//
// 取值：`posted`（挂账凭证已过账）/ `draft`（挂账凭证还是草稿）/ `reversed`（挂账凭证已红冲）/
// `none`（没有挂账，含「无挂账概念」的历史行）。**reversed 是需要处理的异常**：挂账凭证被红冲后
// 这笔往来在总账上没有对应分录，页面要给警示色并给「按来源重算」入口（后端 `reaccrue` 会重建 posted）。
//
// 兼容：旧响应/旧接口没有这个字段 —— 一律按 `none` 处理，页面永远显示得出一个确定状态，
// 不会因为字段缺失把标签渲染成 undefined。
export type AccrualStatus = "posted" | "draft" | "reversed" | "none";

/** 界面文案：四个状态的唯一出处（列表标签、详情、测试都从这里取词）。 */
export const ACCRUAL_STATUS_LABELS: Record<AccrualStatus, string> = {
  posted: "已挂账",
  draft: "草稿挂账",
  reversed: "挂账已红冲",
  none: "未挂账",
};

/** 后端字段 → 四态：无法识别/缺失都归 `none`（历史行按未挂账处理）。 */
export function accrualStatusOf(value?: string | null): AccrualStatus {
  return value === "posted" || value === "draft" || value === "reversed" ? value : "none";
}

/** 后端字段 → 界面文案（总是有词，不存在 undefined）。 */
export function accrualStatusLabel(value?: string | null): string {
  return ACCRUAL_STATUS_LABELS[accrualStatusOf(value)];
}

/** 挂账已红冲 = 需要财务处理的异常状态（列表警示色 + 「按来源重算」按钮的门槛）。 */
export function isAccrualReversed(value?: string | null): boolean {
  return accrualStatusOf(value) === "reversed";
}

/** `POST /finance/payables/:id/reaccrue` 与 `POST /finance/receivables/:id/reaccrue` 的响应体。 */
export type AccrualReaccrueResult = {
  id: string;
  voucherNo: string;
  status: string;
  /** true = 已有有效挂账凭证被复用，这次没有新生成（界面要如实说「未重复生成」）。 */
  replayed?: boolean;
};
