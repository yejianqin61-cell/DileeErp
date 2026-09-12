import { Prisma } from "@prisma/client";

/**
 * 成品出库 → 应收来源 的计价口径（出库过账自动生成 与 财务手工补建 两条路径必须一致）。
 *
 * 优先级：
 *  1. 销售单填了「应收金额」→ 单价 = 应收金额 ÷ 订单数量（整单出库时应收总额与销售填写完全一致，
 *     部分出库时按比例），金额在整单出库时直接取应收金额本身，避免 4 位小数折算误差；
 *  2. 否则用「结算币价」；
 *  3. 否则用销售单价。
 */
export const SETTLEMENT_METHOD_LABELS: Record<string, string> = { tt: "T/T 电汇", letter_of_credit: "信用证 L/C", cash: "现金", monthly: "月结", other: "其他" };

export type SettlementSalesOrder = {
  quantity: Prisma.Decimal;
  unitPrice: Prisma.Decimal | null;
  settlementUnitPrice: Prisma.Decimal | null;
  receivableAmount: Prisma.Decimal | null;
  settlementMethod?: string | null;
  localCurrencyAmount?: Prisma.Decimal | null;
};

/** 兼容 Prisma Decimal 与字符串/数字（服务层不同路径传进来的形态可能不同）。 */
function toDecimal(value: Prisma.Decimal | string | number | null | undefined): Prisma.Decimal | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Prisma.Decimal) return value;
  try { return new Prisma.Decimal(value); } catch { return null; }
}

export function receivableUnitPrice(sales: SettlementSalesOrder | null): Prisma.Decimal | null {
  if (!sales) return null;
  const receivableAmount = toDecimal(sales.receivableAmount);
  const quantity = toDecimal(sales.quantity);
  if (receivableAmount && receivableAmount.gt(0) && quantity && quantity.gt(0)) return receivableAmount.div(quantity);
  return toDecimal(sales.settlementUnitPrice) ?? toDecimal(sales.unitPrice);
}

/**
 * 应收金额：整单出库且销售填了应收金额时直接等于应收金额（权威值），
 * 否则 单价 × 出库数量。注意 unitPrice 列是 DECIMAL(18,4)，非整除折算时
 * unitPrice × quantity 可能与 amount 差最后一位，以 amount 为准。
 */
export function receivableAmountFor(sales: SettlementSalesOrder | null, unitPrice: Prisma.Decimal | string, quantity: Prisma.Decimal | string): Prisma.Decimal {
  const price = toDecimal(unitPrice) ?? new Prisma.Decimal(0);
  const amount = toDecimal(quantity) ?? new Prisma.Decimal(0);
  const receivableAmount = toDecimal(sales?.receivableAmount);
  const orderQuantity = toDecimal(sales?.quantity);
  if (receivableAmount && receivableAmount.gt(0) && orderQuantity && amount.eq(orderQuantity)) return receivableAmount;
  return price.mul(amount);
}

/** 把结算口径写进应收来源备注，财务不必回到销售单才能看到结算方式与本币金额。 */
export function settlementRemark(sales: SettlementSalesOrder | null, unitPrice: Prisma.Decimal | string): string {
  const price = toDecimal(unitPrice) ?? new Prisma.Decimal(0);
  const parts = [`结算单价 ${price.toFixed(4)}`];
  if (sales?.settlementMethod) parts.push(`结算方式 ${SETTLEMENT_METHOD_LABELS[sales.settlementMethod] ?? sales.settlementMethod}`);
  const localAmount = toDecimal(sales?.localCurrencyAmount);
  if (localAmount) parts.push(`本币金额 ${localAmount.toString()}`);
  const receivableAmount = toDecimal(sales?.receivableAmount);
  if (receivableAmount) parts.push(`销售单应收 ${receivableAmount.toString()}`);
  return parts.join("；");
}
