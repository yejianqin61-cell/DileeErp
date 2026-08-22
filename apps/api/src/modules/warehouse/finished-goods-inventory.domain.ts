import { Prisma } from "@prisma/client";

function decimal(value: string) {
  const result = new Prisma.Decimal(value);
  if (result.lt(0)) throw new Error("quantity must be non-negative");
  return result;
}

export function availableFinishedGoodsQuantity(accepted: string, postedInbound: string) {
  const available = decimal(accepted).minus(decimal(postedInbound));
  if (available.lt(0)) throw new Error("finished goods inbound exceeds QC accepted quantity");
  return available.toString();
}

export function availableDefectiveGoodsQuantity(rejected: string, postedDefective: string) {
  const available = decimal(rejected).minus(decimal(postedDefective));
  if (available.lt(0)) throw new Error("defective goods record exceeds QC rejected quantity");
  return available.toString();
}
