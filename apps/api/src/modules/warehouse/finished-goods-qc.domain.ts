export const FINISHED_GOODS_SUBMISSION_STATUSES = ["draft", "submitted", "inspecting", "qc_completed", "cancelled", "corrected"] as const;
export type FinishedGoodsSubmissionStatus = (typeof FINISHED_GOODS_SUBMISSION_STATUSES)[number];

export const FINISHED_GOODS_QC_CONCLUSIONS = ["qualified", "conditional_accepted", "rejected", "mixed"] as const;
export type FinishedGoodsQcConclusion = (typeof FINISHED_GOODS_QC_CONCLUSIONS)[number];

export type QcQuantities = {
  inspected_quantity: string;
  qualified_quantity: string;
  conditional_accept_quantity: string;
  rejected_quantity: string;
};

export type QcQuantityResult = QcQuantities & {
  conclusion: FinishedGoodsQcConclusion;
};

const decimalPattern = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;

function decimal(value: string, field: string) {
  if (typeof value !== "string" || !decimalPattern.test(value)) throw new Error(`${field} must be a non-negative decimal string`);
  return new Prisma.Decimal(value);
}

export function deriveFinishedGoodsQcConclusion(input: QcQuantities): QcQuantityResult {
  const inspected = decimal(input.inspected_quantity, "inspected_quantity");
  const qualified = decimal(input.qualified_quantity, "qualified_quantity");
  const conditional = decimal(input.conditional_accept_quantity, "conditional_accept_quantity");
  const rejected = decimal(input.rejected_quantity, "rejected_quantity");
  if (inspected.lte(0)) throw new Error("inspected_quantity must be greater than zero");
  if (!inspected.eq(qualified.plus(conditional).plus(rejected))) throw new Error("QC quantities must balance");
  const conclusion = qualified.gt(0) && conditional.eq(0) && rejected.eq(0) ? "qualified" : qualified.eq(0) && conditional.gt(0) && rejected.eq(0) ? "conditional_accepted" : qualified.eq(0) && conditional.eq(0) && rejected.gt(0) ? "rejected" : "mixed";
  return { ...input, conclusion };
}

export function availableFinishedGoodsInboundQuantity(qualified: string, conditional: string, alreadyInbound: string) {
  const available = decimal(qualified, "qualified").plus(decimal(conditional, "conditional")).minus(decimal(alreadyInbound, "already_inbound"));
  if (available.lt(0)) throw new Error("inbound quantity cannot exceed QC-accepted quantity");
  return available.toString();
}
import { Prisma } from "@prisma/client";
