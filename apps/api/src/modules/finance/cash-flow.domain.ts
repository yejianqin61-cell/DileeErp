/**
 * 收支流水的纯口径（不碰数据库）。
 *
 * 需求来源：`example/财务/收支明细表.xls`（列：日期 / 对方名称 / 币种 / 收入 / 支出 / 结算方式）。
 */

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
