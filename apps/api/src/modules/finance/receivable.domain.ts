import { Prisma } from "@prisma/client";

export function allocationAvailable(receivableAmount: string, allocatedAmount: string, requestedAmount: string) {
  const available = new Prisma.Decimal(receivableAmount).minus(new Prisma.Decimal(allocatedAmount));
  const requested = new Prisma.Decimal(requestedAmount);
  if (requested.lte(0) || requested.gt(available)) throw new Error("allocation exceeds receivable balance");
  return available.minus(requested).toString();
}

export function paymentAllocationRemaining(paymentAmount: string, allocatedAmount: string, requestedAmount: string) {
  const remaining = new Prisma.Decimal(paymentAmount).minus(new Prisma.Decimal(allocatedAmount));
  const requested = new Prisma.Decimal(requestedAmount);
  if (requested.lte(0) || requested.gt(remaining)) throw new Error("allocation exceeds payment balance");
  return remaining.minus(requested).toString();
}

export function receivableStatus(amount: string, allocated: string) {
  const total = new Prisma.Decimal(amount);
  const used = new Prisma.Decimal(allocated);
  if (used.eq(0)) return "confirmed";
  if (used.gte(total)) return "paid";
  return "partially_paid";
}

/**
 * 一张应收对账的范围：**有订单号时收窄到该订单，否则按客户**，再加币种与期间。
 *
 * 与应付侧的 `payableInReconciliationScope` 对称，是「哪些应收属于这张对账单」的**唯一定义**：
 * 对账快照（`ReconciliationService.snapshot`）、纳入条目（`entries`）、批量确认、流转摘要
 * （`flow`）与台账的覆盖判断共用它，避免「前端说没对过账、后端说已覆盖」。
 *
 * 期间是**左闭右开**（`createdAt ∈ [periodStart, periodEnd + 1 天)`）：对账期间是「日期」，
 * 业务事实的时间戳带时分秒，右端必须含当天整天 —— 与服务的 `endExclusive` 完全一致。
 */
export type ReceivableReconciliationScope = {
  customerId: string;
  orderNo?: string | null;
  currency: string;
  periodStart: Date;
  periodEnd: Date;
};

export function receivableInReconciliationScope(
  entry: { customerId: string; orderNo: string | null; currency: string; createdAt: Date },
  scope: ReceivableReconciliationScope,
) {
  return (scope.orderNo ? entry.orderNo === scope.orderNo : entry.customerId === scope.customerId)
    && entry.currency === scope.currency
    && entry.createdAt >= scope.periodStart
    && entry.createdAt < new Date(scope.periodEnd.getTime() + 24 * 60 * 60 * 1000);
}

/** 某条应收是否已被某张对账单覆盖；覆盖它的第一张（按传入顺序）对账单。 */
export function coveringReceivableReconciliation<
  T extends ReceivableReconciliationScope,
  E extends { customerId: string; orderNo: string | null; currency: string; createdAt: Date },
>(entry: E, scopes: T[]): T | null {
  return scopes.find((scope) => receivableInReconciliationScope(entry, scope)) ?? null;
}
