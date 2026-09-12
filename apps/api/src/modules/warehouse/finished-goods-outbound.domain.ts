import { UnprocessableEntityException } from "@nestjs/common";
import { Prisma } from "@prisma/client";

// 成品出库/客户退货的业务规则。
// 与 finished-goods-qc.domain.ts 同一口径：规则不满足时抛 422（可读提示），
// 不能抛普通 Error —— 那会变成 500「服务器内部错误」，用户看不到真正的原因。

export function outboundAvailableQuantity(balance: string, requested: string) {
  const available = new Prisma.Decimal(balance);
  const raw = typeof requested === "string" ? requested.trim() : String(requested ?? "");
  if (raw === "" || Number.isNaN(Number(raw))) throw new UnprocessableEntityException({ code: "INVALID_OUTBOUND_QUANTITY", message: "出库数量必须是有效数字", details: [] });
  const quantity = new Prisma.Decimal(raw);
  if (quantity.lte(0)) throw new UnprocessableEntityException({ code: "INVALID_OUTBOUND_QUANTITY", message: "出库数量必须大于 0", details: [] });
  if (quantity.gt(available)) {
    throw new UnprocessableEntityException({ code: "OUTBOUND_QUANTITY_EXCEEDED", message: "成品库存不足：出库数量不能大于当前成品可用量", details: [{ available_quantity: available.toString() }] });
  }
  return available.minus(quantity).toString();
}

export function validateSignatureTime(shipmentDate: string, signedAt: string) {
  const shipment = new Date(shipmentDate);
  const signed = new Date(signedAt);
  if (Number.isNaN(shipment.valueOf()) || Number.isNaN(signed.valueOf()) || signed < shipment) {
    throw new UnprocessableEntityException({ code: "INVALID_SIGNATURE_TIME", message: "签收时间无效：不能早于发货日期", details: [] });
  }
  return true;
}

export function customerReturnDestination(destination: string) {
  if (destination !== "finished_goods" && destination !== "defective_goods") {
    throw new UnprocessableEntityException({ code: "INVALID_RETURN_DESTINATION", message: "退货去向只能是成品或次品", details: [] });
  }
  return destination;
}
