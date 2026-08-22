import { Prisma } from "@prisma/client";

export type AdjustmentAmountRow = { effect: string; amount: string | Prisma.Decimal };

export function adjustmentNet(rows: AdjustmentAmountRow[]) {
  return rows.reduce((sum, row) => sum.plus(row.effect === "increase" ? row.amount : new Prisma.Decimal(row.amount).negated()), new Prisma.Decimal(0));
}

export function adjustmentOutstanding(sourceAmount: string, paidAmount: string, rows: AdjustmentAmountRow[]) {
  return new Prisma.Decimal(sourceAmount).plus(adjustmentNet(rows)).minus(paidAmount);
}

export function assertAdjustmentWithinBalance(amount: string, available: string) {
  const requested = new Prisma.Decimal(amount);
  const balance = new Prisma.Decimal(available);
  if (requested.lte(0) || requested.gt(balance)) throw new Error("adjustment exceeds receivable balance");
  return balance.minus(requested).toString();
}

export function reconciliationStatus(systemBalance: string, externalBalance: string) {
  return new Prisma.Decimal(systemBalance).eq(new Prisma.Decimal(externalBalance)) ? "matched" : "difference";
}

export type ClosePreviewInput = { productionComplete: boolean; outboundComplete: boolean; outstandingAmount: string; unresolvedReconciliations: number; unreversedAdjustments: number };

export function closeBlockers(input: ClosePreviewInput) {
  const blockers: string[] = [];
  if (!input.productionComplete) blockers.push("PRODUCTION_NOT_COMPLETE");
  if (!input.outboundComplete) blockers.push("OUTBOUND_NOT_COMPLETE");
  if (new Prisma.Decimal(input.outstandingAmount).gt(0)) blockers.push("RECEIVABLE_OUTSTANDING");
  if (input.unresolvedReconciliations > 0) blockers.push("UNRESOLVED_RECONCILIATION");
  if (input.unreversedAdjustments > 0) blockers.push("UNREVERSED_ADJUSTMENT");
  return blockers;
}
