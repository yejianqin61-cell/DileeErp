/**
 * 「确认应收 / 确认应付」台账的筛选口径（应收 / 应付共用一份，避免两侧漂移）。
 *
 * 用户三条要求合在一起看：
 *   ①「如果是已付或者已收款，那个条目就不要出现在那里了」→ 确认页默认只显示**未付/未收**（待办清单）；
 *   ②「支持按照已付未付、已收未收」→ 同一个筛选器可以切到已付/已收或全部；
 *   ③「还有按照时间范围筛选」→ 起止日期。
 *
 * ## 「已付 / 未付」在这个系统里到底是什么
 *
 * 2026-09-24 起「确认」是**两步挂账**的第一步：确认 = 挂账，那一刻钱还没动 —— 这一步既不写收支
 * 流水也不动银行账户（见 `supplier-payable.service.ts:200-227` 与
 * `docs/design/finance-accrual-two-step-2026-09-24.md`）。钱真正出去/进来由「登记付款 / 合并付款」
 * 决定，所以「已付」不能再等于「已确认」（原来那句「界面上没有第二步付款」的前提已经不成立）：
 *   - **未付 / 未收 = 草稿 + 已确认 + 部分付款**：草稿还没挂账、已确认只挂了账，钱都还没付；
 *     部分付款归未付是因为**还欠着钱** —— 核销只走了一部分，剩余仍挂在账上；
 *   - **已付 / 已收 = 已付清 / 已收清**（只有核销走完才算）；
 *   - 已冲销 / 已作废 / 已取消 = 不算未付也不算已付，只在「全部」里出现。
 */

export type LedgerPaymentFilter = "unpaid" | "paid" | "all";

export type LedgerFilter = {
  /** 起始日期（含），YYYY-MM-DD。 */
  from?: string;
  /** 结束日期（含），YYYY-MM-DD。 */
  to?: string;
  /** 关键字（与列表页搜索框同一口径：单号 / 订单号 / 对方名称 / 物料）。 */
  q?: string;
  payment?: LedgerPaymentFilter;
};

/** 行上参与筛选的字段（各侧自己映射）。 */
export type LedgerFilterRow = {
  status: string;
  /** 用于时间筛选的日期：应付=确认日期，应收=创建日期（出库过账生成的日期）。 */
  date: Date | string | null;
  search: Array<string | null | undefined>;
};

export type LedgerPaymentBucket = "unpaid" | "paid" | "void";

/** 未付/未收的状态集合（钱没有全部付出去：草稿还没挂账、已确认只挂了账、部分付款还欠着钱）。 */
export const UNPAID_LEDGER_STATUSES = ["draft", "confirmed", "partially_paid"] as const;

/** 已付/已收的状态集合（只有付清算已付：核销已经走完）。 */
export const PAID_LEDGER_STATUSES = ["paid"] as const;

/**
 * 分档：未付 / 已付 / 其余（冲销、作废…只在「全部」里）。
 *
 * 由上面两个集合推出（不另抄一份状态名），这样集合与函数不会各自漂移。
 */
export function paymentBucket(status: string): LedgerPaymentBucket {
  if ((UNPAID_LEDGER_STATUSES as readonly string[]).includes(status)) return "unpaid";
  return (PAID_LEDGER_STATUSES as readonly string[]).includes(status) ? "paid" : "void";
}

/** 日期→`YYYY-MM-DD`：与界面显示同一口径（按 UTC 取日期，DATE 列与 createdAt 都适用）。 */
export function ledgerDateText(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return (typeof value === "string" ? value : value.toISOString()).slice(0, 10);
}

/** 是否落在筛选条件内（`payment` 缺省 = 全部）。 */
export function matchesLedgerFilter(row: LedgerFilterRow, filter: LedgerFilter = {}): boolean {
  const payment = filter.payment ?? "all";
  if (payment !== "all" && paymentBucket(row.status) !== payment) return false;
  if (filter.from || filter.to) {
    const date = ledgerDateText(row.date);
    // 没有日期的行在「按时间筛选」时不算命中：它们无法证明落在区间内（宁可少列，也不要列错）。
    if (!date) return false;
    if (filter.from && date < filter.from) return false;
    if (filter.to && date > filter.to) return false;
  }
  const text = filter.q?.trim().toLowerCase();
  if (text && !row.search.some((value) => (value ?? "").toLowerCase().includes(text))) return false;
  return true;
}

/** 各桶的条数（给筛选器上的「未付（3）/ 已付（5）」用）。 */
export function paymentCounts<T extends { status: string }>(rows: T[]): { unpaid: number; paid: number; void: number; all: number } {
  const counts = { unpaid: 0, paid: 0, void: 0, all: rows.length };
  for (const row of rows) counts[paymentBucket(row.status)] += 1;
  return counts;
}
