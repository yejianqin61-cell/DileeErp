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
