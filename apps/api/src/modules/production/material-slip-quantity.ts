/**
 * 领料单明细的四个数量：**配料数量 / 已领数量 / 本次领料量 / 余下数量**。
 *
 * 为什么单独抽一个模块：这四个数在**打印件（Excel 领料单）**和**系统页面（新建/编辑领料单的预估列）**
 * 上必须是同一组数字。之前的页面显示的是「生产领用数量」（净领料，**含**本单）和
 * 「生产未领用数量」（配料 − 已领，**不含**本单），而打印件是「已领数量」（不含本单）与
 * 「余下数量」（配料 − 已领 − 本次）—— 同一格差一个「本次领料量」，车间拿纸核对系统就对不上。
 * 所以口径只在这里写一次：导出服务与预估接口都调这里，禁止各自再算一遍。
 */

/** 统一保留 4 位小数（与数据库 numeric(18,4) 对齐）：浮点减法会蹦出 0.30000000000000004。 */
const round4 = (value: number): number => Number(value.toFixed(4));

/**
 * 已领数量 = 净领料（领料 − 退料）里**属于本单之前**的那部分。
 *
 * 库存事实只有过账后才写，所以：
 * - 草稿 / 待仓库出库：事实里没有本单，净领料本身就是「本单之前」的量；
 * - 已过账：净领料已经含了本单自己的数量，必须扣掉，否则已领数量把本次算了两遍。
 *
 * @param netIssued 该生产单 + 物料 + 单位的净领料（库存事实 quantityDelta 求和后取反）
 * @param ownQuantity 本单该行数量
 * @param ownPosted 本单是否已过账（已过账才会在库存事实里留下自己的量）
 */
export function issuedBeforeQuantity(netIssued: number, ownQuantity: number, ownPosted: boolean): number {
  return round4(ownPosted ? netIssued - ownQuantity : netIssued);
}

/**
 * 领料基准数量：**实际入库数量优先，BOM 配料数量兜底**。
 *
 * 业务口径（2026-11 用户反馈）：领料要按实际到货入库的数量扣减，不能按采购/配料时预定的数量。
 * 例：BOM 配料 5950 码、实际入库 6470 码，生产领料就应以 6470 为基数扣已领，而不是 5950。
 *
 * 还没有入库记录时（非本订单采购、直接从库存领用等）才回落到 BOM 配料数量：
 * 否则这些物料会没有「余下」基准，页面反而比以前更不可用。
 * 两者都为空时返回 null（打印件与页面显示「-」）。
 */
export function issueReferenceQuantity(actualInboundQuantity: number | null | undefined, bomQuantity: number | null): number | null {
  if (actualInboundQuantity !== null && actualInboundQuantity !== undefined && Number.isFinite(actualInboundQuantity) && actualInboundQuantity > 0) {
    return round4(actualInboundQuantity);
  }
  return bomQuantity === null ? null : round4(bomQuantity);
}

/**
 * 余下数量 = 领料基准数量 − 已领数量 − 本次领料量。
 *
 * 领料基准数量由 `issueReferenceQuantity()` 统一给出（实际入库优先，BOM 兜底）。
 * 负数表示超领（本次领料超出实际入库可用量的余额）：打印件上原样打负数，页面也不要把它抹成 0。
 * 基准为空（既没有入库记录、也没有 BOM 配料/快照）时留空 —— 没有分母就没有「余下」，
 * 假装成 0 会让人以为「一点都不能领」。
 */
export function remainingQuantity(referenceQuantity: number | null, issuedBefore: number, currentQuantity: number): number | null {
  return referenceQuantity === null ? null : round4(referenceQuantity - issuedBefore - currentQuantity);
}
