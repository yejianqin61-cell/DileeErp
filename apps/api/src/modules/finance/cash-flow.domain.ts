/**
 * 收支流水的纯口径（不碰数据库）。
 *
 * 需求来源：`example/财务/收支明细表.xls`（列：日期 / 对方名称 / 币种 / 收入 / 支出 / 结算方式）。
 */
import { Prisma } from "@prisma/client";

export const CASH_FLOW_DIRECTIONS = ["income", "expense"] as const;
export type CashFlowDirection = (typeof CASH_FLOW_DIRECTIONS)[number];

/** 方向校验：只认 income / expense（库层也有同名 CHECK 约束兜底）。 */
export function cashFlowDirection(value: string | null | undefined): CashFlowDirection {
  if (value !== "income" && value !== "expense") throw new Error("invalid cash flow direction");
  return value;
}

/**
 * 「结算方式」列的文字。
 *
 * 老表把**方式 + 银行账户**写在同一格，形如 `转账--农业银行5706`（`收支明细表.xls` 第 2 行），
 * 因此这里同样合成一格；两部分都空时留空（不写空字符串）。
 */
export function settlementText(
  method: string | null | undefined,
  accountLabel: string | null | undefined,
): string | null {
  const parts = [method?.trim(), accountLabel?.trim()].filter((part): part is string => Boolean(part && part.length));
  return parts.length ? parts.join("--") : null;
}

/**
 * 「收支类目」的取值（2026-10-13）：本次核销的**单据**里，金额最大的那一条所填的科目。
 *
 * 为什么是"金额最大的那一条"而不是"第一条"或"都不填"：一条流水 = 一笔付款（一个金额），
 * 而一笔付款可能同时核销备用金（库存现金（备用金））与房租（房租费）。台账/付款单能逐条显示，
 * 流水只有一格，所以取**占钱最多**的那条 —— 与主科目"按金额最大的来源类型"同一条思路，
 * 结果确定且事后解释得清（设计文档 `cash-flow-category-and-payable-batch-delete-2026-10-13.md` §1.2）。
 *
 * 全部单据都没填科目时返回 `null`：由调用方交给候选链兜底（"猜的只当兼底"），不在这里猜。
 */
export function dominantDocumentSubject(
  rows: ReadonlyArray<{ amount: Prisma.Decimal | string | number; subjectId?: string | null }>,
): string | null {
  let best: { amount: Prisma.Decimal; subjectId: string } | null = null;
  for (const row of rows) {
    if (!row.subjectId) continue;
    const amount = new Prisma.Decimal(row.amount ?? 0);
    if (!best || amount.gt(best.amount)) best = { amount, subjectId: row.subjectId };
  }
  return best?.subjectId ?? null;
}
