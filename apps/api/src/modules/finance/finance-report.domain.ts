import { Prisma } from "@prisma/client";
import { adjustmentNet, type AdjustmentAmountRow } from "./receivable-adjustment.domain";

/**
 * 财务对账导出报表的纯计算口径（不碰数据库，便于单测钉住）。
 *
 * 需求来源：`example/财务/` 下 6 份老系统（WPS 表格 / 管家）导出的报表；
 * 口径与逐列映射见 `docs/design/finance-example-forms-export-mapping-design-2026-09-14.md`（R1–R7）。
 *
 * 这里只放「算出来的列」：直取的列不经过本模块，缺字段的列在表格构造层写 `null`（留空）。
 */

/**
 * 本位币。
 *
 * 系统里没有单独的「本位币」配置项：`sales_orders.local_currency_amount` 在 schema 里的注释就是
 * 「本币金额=折算成人民币的金额」，因此本位币固定为 CNY。
 * 老表人民币行也印证了这一点（销售对账明细表第二行：汇率 1、本币列与原币列同值）。
 */
export const LOCAL_CURRENCY = "CNY";

/**
 * 数值格式：所有数值列共用一个。
 *
 * 为什么是 `0.####` 而不是「固定 2 位」：老表样本里同一张表的金额位数并不统一
 * （`1862.024` 三位、`12475.56` 两位、`99`/`384`/`42` 零位），
 * 这正是「最多 4 位小数、去掉多余的 0」渲染出来的样子。用 `0.####` 能逐格还原老表的显示，
 * 同时底层仍是**数值类型**（`SUM`/排序/筛选可用），而不是老表的文本型数字。
 * 不加千分位分隔符，也是为了与老表显示一致。
 */
export const NUMBER_FORMAT = "0.####";

/** 汇率保留位数：老表隐含 6.7，本位币 1；6 位足以表达常见报价且能吸收「本币金额」本身的四舍五入噪声。 */
const RATE_DECIMALS = 6;

/** Prisma Decimal / 字符串 / 数字 → Decimal；空值（含空字符串）返回 null。 */
export function toDecimal(value: Prisma.Decimal | string | number | null | undefined): Prisma.Decimal | null {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Prisma.Decimal) return value;
  try {
    return new Prisma.Decimal(value);
  } catch {
    return null;
  }
}

/**
 * 导出到 Excel 的数值。
 *
 * **必须落成 JS number**：老表里所有数据单元格都是文本型（BIFF 格式 `z="@"`），
 * 文本型数字在 Excel 里 `SUM` 得 0、筛选分不出数值区间、排序按字典序（`"100" < "20"`）。
 * 用户明确要求「数字一定要是数值型」，这是 R1 的硬约束。
 *
 * 空值返回 `null`（空单元格），**不是 0 也不是 `""`**：0 是「确实为零」的事实，
 * 空是「系统没有这个数据」，两者在财务上完全不同。
 */
export function toExportNumber(value: Prisma.Decimal | string | number | null | undefined): number | null {
  const decimal = toDecimal(value);
  if (!decimal) return null;
  const parsed = Number(decimal.toString());
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * 日期列写成 `YYYY-MM-DD` **文本**。
 *
 * 与 `docs/design/export-numeric-cells-and-progress-sheet-2026-09-14.md` 的既有决定一致：
 * ISO 日期按字典序排序与按时间排序一致，Excel 也能正确识别成日期参与筛选；
 * 写成真日期单元格会改变读取语义（`sheet_to_json` 会返回 `Date` 对象），收益不抵回归风险。
 */
export function toDateText(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) return null;
  return date.toISOString().slice(0, 10);
}

export type SalesOrderCurrencyFacts = {
  currency?: string | null;
  /** 销售单原币总额 */
  totalAmount?: Prisma.Decimal | string | number | null;
  /** 销售单应收金额（原币） */
  receivableAmount?: Prisma.Decimal | string | number | null;
  /** 销售单本币金额（人民币） */
  localCurrencyAmount?: Prisma.Decimal | string | number | null;
};

/**
 * 汇率 = 本币金额 ÷ 原币金额（保留 6 位）。
 *
 * 不需要新字段：可以从已有的「本币金额」推出来（R2）。用老表样本反解验证过：
 *   - 销售对账明细表第一行：12475.56 ÷ 1862.024 = 6.7
 *   - 销售利润报表：164317.5 ÷ 24525 = 6.7
 *
 * **必须收敛到 6 位**：`本币金额` 自己就是四舍五入过的（12475.56 而不是 12475.5608），
 * 直接相除会得到 6.6999995705… 这种噪声，显示成汇率很难看。
 *
 * 规则：
 * 1. 本币金额与原币金额都有 → 取比值（6 位）；
 * 2. 本位币（人民币）单据 → 1（老表人民币行就是 汇率=1、本币列=原币列）；
 * 3. 外币且没有本币金额 → `null`（留空）。
 *    **绝不回落成 1**：那会让本币列等于原币列，把美元金额当成人民币记账。
 */
export function salesExchangeRate(order: SalesOrderCurrencyFacts | null | undefined): Prisma.Decimal | null {
  if (!order) return null;
  const local = toDecimal(order.localCurrencyAmount);
  const base = toDecimal(order.totalAmount) ?? toDecimal(order.receivableAmount);
  if (local && local.gt(0) && base && base.gt(0)) return local.div(base).toDecimalPlaces(RATE_DECIMALS);
  if (order.currency === LOCAL_CURRENCY) return new Prisma.Decimal(1);
  return null;
}

/**
 * 本币金额。
 *
 * **按比例分摊，不是「原币金额 × 汇率」**：汇率是收敛到 6 位的展示值，
 * 乘回去会与销售单上权威的 `local_currency_amount` 产生尾差
 * （老表样本：1862.024 × 6.7 = 12475.5608，而销售单上的本币金额是 12475.56）。
 * 对账表里「本币金额合计 = 销售单本币金额」是硬要求，因此这里按
 * `本币金额 × (本行原币金额 ÷ 订单原币金额)` 分摊，整单出库时精确等于 `local_currency_amount`，
 * 分批出库时各行相加也回到整单金额。
 *
 * 本位币单据直接等于原币金额；外币且没有本币金额 → `null`（留空），不做任何兜底。
 */
export function localAmountFor(
  amount: Prisma.Decimal | string | number | null | undefined,
  order: SalesOrderCurrencyFacts | null | undefined,
): Prisma.Decimal | null {
  const value = toDecimal(amount);
  if (!value) return null;
  const local = toDecimal(order?.localCurrencyAmount);
  const base = toDecimal(order?.totalAmount) ?? toDecimal(order?.receivableAmount);
  if (local && base && base.gt(0)) return local.mul(value).div(base);
  if (order?.currency === LOCAL_CURRENCY) return value;
  return null;
}

/**
 * 本币单价 = 本币金额 ÷ 数量。
 *
 * 由本币金额反算（而不是用汇率乘原币单价），这样页面与导出上
 * `单价(本) × 数量 == 金额(本)` 恒成立 —— 这是对账的人第一件会去核的事。
 * 老表样本同样成立：12475.56 ÷ 41.67 = 299.389…（样本写 299.389）。
 */
export function localUnitPriceFor(
  localAmount: Prisma.Decimal | null | undefined,
  quantity: Prisma.Decimal | string | number | null | undefined,
): Prisma.Decimal | null {
  const amount = toDecimal(localAmount);
  const count = toDecimal(quantity);
  if (!amount || !count || count.eq(0)) return null;
  return amount.div(count);
}

/** 币种代码 → 中文标签。老表币种列写的是「美元」「人民币」，库里存的是 `USD`/`CNY`。 */
export function currencyLabel(code: string | null | undefined, labels: ReadonlyMap<string, string>): string | null {
  const value = code?.trim();
  if (!value) return null;
  return labels.get(value) ?? value;
}

/* ------------------------------------------------------------------ 销售对账汇总表口径 */

/**
 * 欠款（未收余额）= 应收合计 + 调整净额 − 已收合计。
 *
 * 调整净额直接复用 `receivable-adjustment.domain.ts` 的 `adjustmentNet`（`increase` 为正、其余为负），
 * 不在这里重写一遍式子 —— 两处口径一旦漂移，对账就会对不上。
 *
 * 与 `receivable-adjustment.service.ts` 的 `orderNetSummary.outstanding_amount` 同式：
 * 调用方必须只传**已过账**调整（草稿未生效、冲销后的不算），
 * 已收只算「有效核销（`status = active`）且付款已过账」。
 */
export function receivableOutstanding(
  receivableAmount: Prisma.Decimal | string | number | null | undefined,
  paidAmount: Prisma.Decimal | string | number | null | undefined,
  adjustments: readonly AdjustmentAmountRow[],
): Prisma.Decimal {
  const receivable = toDecimal(receivableAmount) ?? new Prisma.Decimal(0);
  const paid = toDecimal(paidAmount) ?? new Prisma.Decimal(0);
  return receivable.plus(adjustmentNet([...adjustments])).minus(paid);
}

/* ------------------------------------------------------------------ 销售利润报表口径 */

export type BomUsageItem = {
  approvedUsage?: Prisma.Decimal | string | number | null;
  baseUsage?: Prisma.Decimal | string | number | null;
  requiredQuantity?: Prisma.Decimal | string | number | null;
  productionBatchBase?: Prisma.Decimal | string | number | null;
};

/**
 * 单件用量 = 核定用量 ÷ 生产批量基数。
 *
 * 字段回落顺序：`approved_usage` → `base_usage` → `required_quantity`（建 BOM 时三者都写的是
 * 同一个 `required_quantity`，见 `sales/boms.service.ts`；批量基数缺失或为 0 时按 1）。
 */
export function unitUsagePerUnit(item: BomUsageItem): Prisma.Decimal | null {
  const usage = toDecimal(item.approvedUsage) ?? toDecimal(item.baseUsage) ?? toDecimal(item.requiredQuantity);
  if (!usage) return null;
  const base = toDecimal(item.productionBatchBase);
  if (!base || base.eq(0)) return usage;
  return usage.div(base);
}

/** 物料成本 = 单件用量 × 数量 × 单价。任一缺失返回 `null`（调用方据此把该物料记入「缺采购价」清单）。 */
export function materialCostOf(
  usagePerUnit: Prisma.Decimal | string | number | null | undefined,
  quantity: Prisma.Decimal | string | number | null | undefined,
  unitPrice: Prisma.Decimal | string | number | null | undefined,
): Prisma.Decimal | null {
  const usage = toDecimal(usagePerUnit);
  const count = toDecimal(quantity);
  const price = toDecimal(unitPrice);
  if (!usage || !count || !price) return null;
  return usage.mul(count).mul(price);
}

/**
 * 销售利润 = 销售金额 − 成本金额。
 *
 * 成本缺失时按 0 参与计算，而不是让整行利润留空：一个物料缺采购价不应让整单毛利消失
 * （R5 的取舍）。缺价必须在导出表尾显式列出（见 `footnoteLines`），否则毛利会被高估而看不出来。
 * 销售金额缺失时返回 `null`（没有销售额就算不出利润）。
 */
export function profitAmount(
  salesAmount: Prisma.Decimal | string | number | null | undefined,
  costAmount: Prisma.Decimal | string | number | null | undefined,
): Prisma.Decimal | null {
  const income = toDecimal(salesAmount);
  if (!income) return null;
  return income.minus(toDecimal(costAmount) ?? new Prisma.Decimal(0));
}

/** 销售金额：销售单原币总额，缺失时退到应收金额（老表样本是 24525，本币 164317.5 = ×6.7）。 */
export function salesAmountOf(order: {
  totalAmount?: Prisma.Decimal | string | number | null;
  receivableAmount?: Prisma.Decimal | string | number | null;
}): Prisma.Decimal | null {
  return toDecimal(order.totalAmount) ?? toDecimal(order.receivableAmount);
}
