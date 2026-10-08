// 「确认应收 / 确认应付」台账的筛选口径（前端）。与后端 `apps/api/src/modules/finance/ledger-filter.ts`
// 是**同一套口径的两份实现**：界面上的筛选、计数与导出参数必须一致，否则会出现
// 「界面显示 3 条、导出的文件里 8 条」。两边都改的时候要一起改（各有一份单测钉住）。
//
// ## 「已付 / 未付」到底是什么
//
// 2026-09-24 起「确认」是**两步挂账**的第一步：确认 = 挂账，钱没动（确认这一步不写收支流水、
// 不动银行账户，见 `apps/api/src/modules/finance/supplier-payable.service.ts:200-227` 与
// `docs/design/finance-accrual-two-step-2026-09-24.md`）。钱真正出去/进来由付款/收款那一步决定，
// 所以「已付」不再等于「已确认」（「界面上没有第二步付款」的旧前提已经不存在）：
//   - 未付 / 未收 = 草稿 + 已确认 + 部分付款（都还没付清；部分付款归未付是因为还欠着钱）；
//   - 已付 / 已收 = 已付清 / 已收清；
//   - 已冲销 / 已作废 / 已取消既不算未付也不算已付，只在「全部」里出现。

export type LedgerPaymentFilter = "unpaid" | "paid" | "all";
export type LedgerPaymentBucket = "unpaid" | "paid" | "void";

/** 未付/未收的状态集合（钱没有全部付出去）。 */
export const UNPAID_LEDGER_STATUSES = ["draft", "confirmed", "partially_paid"] as const;

/** 已付/已收的状态集合（只有付清算已付）。 */
export const PAID_LEDGER_STATUSES = ["paid"] as const;

/** 分档：未付 / 已付 / 其余（冲销、作废…只在「全部」里）。由上面两个集合推出，不另抄一份状态名。 */
export function paymentBucket(status: string): LedgerPaymentBucket {
  if ((UNPAID_LEDGER_STATUSES as readonly string[]).includes(status)) return "unpaid";
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
