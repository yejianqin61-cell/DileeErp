import { Prisma } from "@prisma/client";

export function payableOutstanding(amount: string, allocated: string) {
  const total = new Prisma.Decimal(amount);
  const used = new Prisma.Decimal(allocated);
  if (total.lt(0) || used.lt(0) || used.gt(total)) throw new Error("invalid payable allocation balance");
  return total.minus(used).toString();
}

export function paymentAllocationRemaining(paymentAmount: string, allocated: string, requested: string) {
  const remaining = new Prisma.Decimal(paymentAmount).minus(new Prisma.Decimal(allocated));
  const value = new Prisma.Decimal(requested);
  if (value.lte(0) || value.gt(remaining)) throw new Error("payment allocation exceeds balance");
  return remaining.minus(value).toString();
}

export function payableAllocationRemaining(payableAmount: string, allocated: string, requested: string) {
  const remaining = new Prisma.Decimal(payableAmount).minus(new Prisma.Decimal(allocated));
  const value = new Prisma.Decimal(requested);
  if (value.lte(0) || value.gt(remaining)) throw new Error("payable allocation exceeds balance");
  return remaining.minus(value).toString();
}

export function payableStatus(amount: string, allocated: string) {
  const total = new Prisma.Decimal(amount);
  const used = new Prisma.Decimal(allocated);
  if (used.eq(0)) return "confirmed";
  if (used.gte(total)) return "paid";
  return "partially_paid";
}

export function sourceType(value: string) {
  if (value !== "raw_material_inbound" && value !== "purchase_receipt" && value !== "outsource_receipt") throw new Error("invalid payable source type");
  return value;
}

/**
 * 一张应付对账的范围：供应商 + 币种 + 期间，可选收窄到订单 / 采购单。
 *
 * 这是「哪些应付属于这张对账单」的**唯一定义**：对账服务用它算快照、批量确认与流转摘要，
 * 应付台账用它判断某条草稿是否已经纳入过对账（否则用户会为同一条草稿重复建单）。
 * 三处口径必须一致，所以放在纯函数里而不是各写一遍 where。
 */
export type PayableReconciliationScope = {
  supplierId: string;
  currency: string;
  orderNo?: string | null;
  purchaseOrderId?: string | null;
  periodStart: Date;
  periodEnd: Date;
};

export function payableInReconciliationScope(
  entry: { supplierId: string; currency: string; orderNo: string | null; purchaseOrderId: string | null; confirmationDate: Date },
  scope: PayableReconciliationScope,
) {
  return entry.supplierId === scope.supplierId
    && entry.currency === scope.currency
    && (!scope.orderNo || entry.orderNo === scope.orderNo)
    && (!scope.purchaseOrderId || entry.purchaseOrderId === scope.purchaseOrderId)
    && entry.confirmationDate >= scope.periodStart
    && entry.confirmationDate <= scope.periodEnd;
}

/** 某条应付是否已被某张对账单覆盖；覆盖它的第一张（按传入顺序）对账单。 */
export function coveringPayableReconciliation<
  T extends PayableReconciliationScope,
  E extends { supplierId: string; currency: string; orderNo: string | null; purchaseOrderId: string | null; confirmationDate: Date },
>(entry: E, scopes: T[]): T | null {
  return scopes.find((scope) => payableInReconciliationScope(entry, scope)) ?? null;
}
