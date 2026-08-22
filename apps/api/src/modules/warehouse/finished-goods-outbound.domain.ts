import { Prisma } from "@prisma/client";

export function outboundAvailableQuantity(balance: string, requested: string) {
  const available = new Prisma.Decimal(balance);
  const quantity = new Prisma.Decimal(requested);
  if (quantity.lte(0)) throw new Error("requested quantity must be positive");
  if (quantity.gt(available)) throw new Error("outbound quantity exceeds finished goods balance");
  return available.minus(quantity).toString();
}

export function validateSignatureTime(shipmentDate: string, signedAt: string) {
  const shipment = new Date(shipmentDate);
  const signed = new Date(signedAt);
  if (Number.isNaN(shipment.valueOf()) || Number.isNaN(signed.valueOf()) || signed < shipment) throw new Error("signature cannot precede shipment");
  return true;
}

export function customerReturnDestination(destination: string) {
  if (destination !== "finished_goods" && destination !== "defective_goods") throw new Error("invalid customer return destination");
  return destination;
}
