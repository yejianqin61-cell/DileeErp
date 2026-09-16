// 「确认应收 / 确认应付」台账的筛选口径（前端）。与后端 `apps/api/src/modules/finance/ledger-filter.ts`
// 是**同一套口径的两份实现**：界面上的筛选、计数与导出参数必须一致，否则会出现
// 「界面显示 3 条、导出的文件里 8 条」。两边都改的时候要一起改（各有一份单测钉住）。
//
// ## 「已付 / 未付」到底是什么
//
// 第十三/十五轮把「确认」改成**确认即记账**：确认应付时金额从所选银行账户转出，确认应收时记进所选账户。
// 所以：
//   - 未付 / 未收 = 草稿（还没确认，钱还没动）；
//   - 已付 / 已收 = 已确认（钱已经进出账户）；
//   - 部分付款 / 已付清 / 部分收款 / 已收清 = 有收付款核销金额的（历史数据或接口写入）；
//   - 已冲销 / 已作废 / 已取消既不算未付也不算已付，只在「全部」里出现。
// 界面上没有第二步付款，把「已付」定义成「有付款单核销」的话，这个筛选项永远是空的。

export type LedgerPaymentFilter = "unpaid" | "paid" | "all";
export type LedgerPaymentBucket = "unpaid" | "paid" | "void";

/** 已付/已收的状态集合（`confirmed` 起都算钱已经动过）。 */
export const PAID_LEDGER_STATUSES = ["confirmed", "partially_paid", "paid"] as const;

export function paymentBucket(status: string): LedgerPaymentBucket {
  if (status === "draft") return "unpaid";
  return (PAID_LEDGER_STATUSES as readonly string[]).includes(status) ? "paid" : "void";
}

/** 各桶条数（筛选器上的「未付（3）/ 已付（5）」）。`all` 含作废/冲销，所以不等于 unpaid + paid。 */
export function paymentCounts<T extends { status: string }>(rows: T[]): { unpaid: number; paid: number; void: number; all: number } {
  const counts = { unpaid: 0, paid: 0, void: 0, all: rows.length };
  for (const row of rows) counts[paymentBucket(row.status)] += 1;
  return counts;
}

/**
 * 日期区间（含两端，YYYY-MM-DD）。
 *
 * 没有日期的行在设了区间时**不算命中** —— 与后端同一口径：无法证明它落在区间内时宁可少列，
 * 也不要列一条日期不明的进去。
 */
export function withinDateRange(value: string | null | undefined, from?: string, to?: string): boolean {
  if (!from && !to) return true;
  const date = value ? String(value).slice(0, 10) : "";
  if (!date) return false;
  if (from && date < from) return false;
  if (to && date > to) return false;
  return true;
}

/** 导出查询串：与界面筛选一一对应（导出的就是所见）。 */
export function ledgerExportQuery(filter: { payment: LedgerPaymentFilter; from?: string; to?: string; q?: string }): string {
  const query = new URLSearchParams({ payment: filter.payment });
  if (filter.from) query.set("from", filter.from);
  if (filter.to) query.set("to", filter.to);
  const text = filter.q?.trim();
  if (text) query.set("q", text);
  return query.toString();
}
