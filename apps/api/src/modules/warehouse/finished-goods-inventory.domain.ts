import { UnprocessableEntityException } from "@nestjs/common";
import { Prisma } from "@prisma/client";

// 成品/次品可用量的业务规则。
// 与 finished-goods-qc.domain.ts 同一口径：规则不满足时抛 422（可读提示），
// 不能抛普通 Error —— 那会变成 500「服务器内部错误」，用户看不到真正的原因。

function decimal(value: string, label: string) {
  if (typeof value !== "string" || value.trim() === "" || Number.isNaN(Number(value))) {
    throw new UnprocessableEntityException({ code: "INVALID_QUANTITY", message: `${label}必须是有效数字`, details: [] });
  }
  const result = new Prisma.Decimal(value.trim());
  if (result.lt(0)) throw new UnprocessableEntityException({ code: "INVALID_QUANTITY", message: `${label}不能为负数`, details: [] });
  return result;
}

export function availableFinishedGoodsQuantity(accepted: string, postedInbound: string) {
  const available = decimal(accepted, "QC 接收数量").minus(decimal(postedInbound, "已入库数量"));
  if (available.lt(0)) {
    throw new UnprocessableEntityException({ code: "FINISHED_GOODS_INBOUND_EXCEEDS_QC", message: "成品可入库数量为负：已入库数量超过了 QC 接收数量，请先核对入库记录", details: [] });
  }
  return available.toString();
}

export function availableDefectiveGoodsQuantity(rejected: string, postedDefective: string) {
  const available = decimal(rejected, "QC 不合格数量").minus(decimal(postedDefective, "已登记次品数量"));
  if (available.lt(0)) {
    throw new UnprocessableEntityException({ code: "DEFECTIVE_GOODS_EXCEEDS_QC", message: "次品可登记数量为负：已登记次品数量超过了 QC 不合格数量，请先核对次品记录", details: [] });
  }
  return available.toString();
}
