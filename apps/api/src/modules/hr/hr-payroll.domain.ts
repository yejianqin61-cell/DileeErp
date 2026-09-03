import { Prisma } from "@prisma/client";

export type PayrollSource = { wage_mode: "piece" | "time"; quantity: string; duration_minutes: string; amount: string };

export function productionSourceAmount(sources: PayrollSource[]) {
  return sources.reduce((total, source) => total.plus(new Prisma.Decimal(source.amount)), new Prisma.Decimal(0)).toString();
}

export function payrollBaseAmount(input: { base_salary: string; production_source_amount: string; overtime_amount: string; attendance_deduction: string; performance_amount: string; allowance_amount: string; social_insurance: string; individual_tax: string; other_adjustment: string }) {
  return new Prisma.Decimal(input.base_salary).plus(input.production_source_amount).plus(input.overtime_amount).minus(input.attendance_deduction).plus(input.performance_amount).plus(input.allowance_amount).minus(input.social_insurance).minus(input.individual_tax).plus(input.other_adjustment).toString();
}

export function payrollPayableAmount(baseAmount: string, adjustments: Array<{ effect: "increase" | "decrease"; amount: string }>) {
  return adjustments.reduce((total, adjustment) => total.plus(adjustment.effect === "increase" ? adjustment.amount : new Prisma.Decimal(adjustment.amount).negated()), new Prisma.Decimal(baseAmount)).toString();
}

export function allocationRemaining(payableAmount: string, paidAmount: string, allocationAmount: string) {
  const remaining = new Prisma.Decimal(payableAmount).minus(paidAmount);
  const requested = new Prisma.Decimal(allocationAmount);
  if (requested.lte(0) || requested.gt(remaining)) throw new Error("salary allocation exceeds ledger balance");
  return remaining.minus(requested).toString();
}

export function paymentRemaining(paymentAmount: string, allocatedAmount: string, allocationAmount: string) {
  const remaining = new Prisma.Decimal(paymentAmount).minus(allocatedAmount);
  const requested = new Prisma.Decimal(allocationAmount);
  if (requested.lte(0) || requested.gt(remaining)) throw new Error("salary allocation exceeds payment balance");
  return remaining.minus(requested).toString();
}

export function payrollStatus(payableAmount: string, paidAmount: string) {
  const payable = new Prisma.Decimal(payableAmount);
  const paid = new Prisma.Decimal(paidAmount);
  return paid.eq(0) ? "confirmed" : paid.gte(payable) ? "paid" : "partially_paid";
}

export function canReopenPayroll(status: string) {
  return status === "confirmed" || status === "expired";
}
