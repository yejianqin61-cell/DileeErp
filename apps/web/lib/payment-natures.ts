// 款项性质（定金 / 货款 / 尾款 / 其他）——纯数据模块，**不能**放进 "use client" 文件。
//
// 与后端 `apps/api/src/modules/finance/payment-nature.ts` 是同一份口径的两份副本：
// 后端那份能改库、前端这份只能渲染选项，两边不可能互相 import（两个 workspace 不共享源码），
// 所以 key 必须逐字一致。改这里时后端那份要一起改（`settlement_account`、收支项目这些
// 字典 key 早就用了同一套「两处各一份」的处理，见 finance-sections.ts）。
//
// 为什么单独成模块而不是写在 cash-flow-workspace 里：确认应收的三个弹窗（逐条 / 勾选批量 /
// 按对账单一键）与收支流水表单都要用同一份选项，写在任何一个组件里都会让另外几个要么复制一份、
// 要么跨 RSC/client 边界 import。

export const PAYMENT_NATURES = [
  { key: "deposit", label: "定金" },
  { key: "balance", label: "货款" },
  { key: "final", label: "尾款" },
  { key: "other", label: "其他" },
] as const;

export type PaymentNatureKey = (typeof PAYMENT_NATURES)[number]["key"];

/** Radix Select 不接受空串 value：用哨兵值表示「不标注」，提交时再翻译成空。 */
export const PAYMENT_NATURE_EMPTY = "__no_payment_nature__";

export function paymentNatureOptions() {
  return PAYMENT_NATURES.map((item) => ({ value: item.key, label: item.label }));
}

/** 性质 → 中文标签。未知/为空时返回 `null`（页面显示 `-`，不编一个「其他」出来）。 */
export function paymentNatureLabel(value: string | null | undefined): string | null {
  if (!value) return null;
  return PAYMENT_NATURES.find((item) => item.key === value)?.label ?? null;
}
