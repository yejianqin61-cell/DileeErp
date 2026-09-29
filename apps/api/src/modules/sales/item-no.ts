/**
 * 货号（item no）的归一与匹配键 —— 全模块**只此一处**实现。
 *
 * 为什么需要这一步：货号是**手抄/OCR 进来**的外部编码（客户给的，或从上一张单上抄的），
 * 同一个货号在系统里会长成这些形状：
 *
 * ```
 * 27621     27621␠     27621　（全角空格）     27621␠流水花扇
 * ```
 *
 * 而货号的全部价值在于「返单时按它把历次批次归到一组」——不归一就会出现
 * 「同一个货号两个分组」，那正是老板要「调取该货号」时最怕的结果：
 * 他查 `27621` 只看到两批，另外三批躲在 `27621 ` 底下。
 *
 * 两条规则：
 *   1. **入库的值 = `normalizeItemNo`**：去掉首尾空白 + 把内部连续空白折叠成一个普通空格。
 *      不改大小写、不删内部空格 —— 库里存的是**人能读的原样**，页面上照原样显示。
 *   2. **匹配/分组的值 = `itemNoKey`**：在归一的基础上删掉全部空白并转大写。
 *      查询、分组、查重一律用它；库里**不存**这个值（存了就有两份真源，早晚不一致）。
 *
 * 归一**不做**的事：不做前缀/后缀补全、不改写大小写、不猜相近写法（`DL27621` 与 `27621` 是两个货号）。
 * 猜错会把两批不同的货合并成一批，比查不到糟糕得多。
 */

/** 与数据库列 `sales_orders.item_no VARCHAR(100)` 一致。 */
export const ITEM_NO_MAX_LENGTH = 100;

/** 展示/入库用的归一值。空串与纯空白一律变成 `null`（= 没有货号）。 */
export function normalizeItemNo(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  // `\s` 在 JS 里包含全角空格 U+3000 与不换行空格 U+00A0 —— 现场抄单最常见的就是这两种。
  const collapsed = value.replace(/\s+/gu, " ").trim();
  return collapsed === "" ? null : collapsed;
}

/** 匹配/分组用的键。没有货号时是空串（**不是** `null`，方便当 Map 的键用）。 */
export function itemNoKey(value: string | null | undefined): string {
  const normalized = normalizeItemNo(value);
  return normalized === null ? "" : normalized.replace(/\s+/gu, "").toUpperCase();
}

/** 需要「没有货号」与「有货号」分开处理时用它；否则直接用 `itemNoKey`。 */
export function itemNoKeyOrNull(value: string | null | undefined): string | null {
  const key = itemNoKey(value);
  return key === "" ? null : key;
}
