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
  if (value !== "raw_material_inbound" && value !== "outsource_receipt") throw new Error("invalid payable source type");
  return value;
}
