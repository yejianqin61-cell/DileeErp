/**
 * 款项性质：这笔汇进来的钱是**定金 / 货款 / 尾款 / 其他**。
 *
 * 需求来源：用户 2026-09-17 要求把老表 `example/财务/外汇一览表.xlsx` 搬成系统导出。
 * 老表把每个订单的到账拆成「定金（日期 + 金额）/ 货款（日期 + 金额）」两组，系统里没有任何
 * 字段能回答「这笔钱是定金还是货款」，用户选定「加在【收支流水】上，并给收入流水加一个可选订单号」。
 *
 * 为什么是**四个**取值（而不是老表的两列）：
 *   老表的「货款」列实际混合了「出货后收的尾款」与「一次性付清的全款」。财务在录的时候分得清、
 *   事后却分不清。四个取值多花不了录入成本，却让报表能按真实性质归集；
 *   报表里「货款列」= 货款 + 尾款（老表口径），「其他到账」= 其他 + 未标注。
 *
 * 为什么 key 用英文、label 用中文：库里的值不该因为界面文案调整而变化（历史流水要能一直解释得通）；
 * 这也与全站其它枚举（direction、status）一致。
 *
 * 纯数据模块，不依赖 Prisma / Nest，前端另有一份同口径的副本
 * （`apps/web/lib/payment-natures.ts`，理由见 `finance-sections.ts` 顶部的 RSC 边界说明）。
 */

export const PAYMENT_NATURES = [
  { key: "deposit", label: "定金" },
  { key: "balance", label: "货款" },
  { key: "final", label: "尾款" },
  { key: "other", label: "其他" },
] as const;

export type PaymentNatureKey = (typeof PAYMENT_NATURES)[number]["key"];

/** 全部合法取值，供 DTO / 服务层做白名单校验。 */
export const PAYMENT_NATURE_KEYS: readonly string[] = PAYMENT_NATURES.map((item) => item.key);

/**
 * DTO 接受的取值：四个 key **加上空串**。
 *
 * 为什么放行空串：前端用 Radix Select，清空一个选择只能送空串或哨兵值；而全站既有约定是
 * 「空串 = 清空」（见 `settlement_account_id` / `bank_id` 的清除语义）。若不在这里放行，
 * 界面上一选「（不标注）」就会被 class-validator 判成非法值（400），
 * 而财务于是永远抹不掉一个标错的性质。服务层 `requirePaymentNature` 会把空串归一成「不标注」。
 */
export const PAYMENT_NATURE_FORM_KEYS: readonly string[] = [...PAYMENT_NATURE_KEYS, ""];

export function isPaymentNature(value: unknown): value is PaymentNatureKey {
  return typeof value === "string" && PAYMENT_NATURE_KEYS.includes(value);
}

/** 性质 → 中文标签。未知/为空时返回 `null`（页面显示 `-`，导出写空单元格，不编一个「其他」出来）。 */
export function paymentNatureLabel(value: string | null | undefined): string | null {
  if (!value) return null;
  return PAYMENT_NATURES.find((item) => item.key === value)?.label ?? null;
}
