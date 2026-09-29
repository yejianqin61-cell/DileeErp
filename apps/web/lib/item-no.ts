/**
 * 货号（item no）的归一与匹配键 —— **与 `apps/api/src/modules/sales/item-no.ts` 逐字同义**。
 *
 * 两个 workspace 之间没有共享包（本仓库既有约定，例如 `currency-catalogue` / `china-region`
 * 都是各存一份），所以这里是一份镜像实现。两份用**同一组测试向量**钉住：
 * `apps/web/lib/item-no.test.mjs` 与 `apps/api/test/unit/item-no.test.cjs` 里的向量表逐条相同。
 * 改这里就要同时改那一份，否则「页面上归到一起的货号」与「服务端归到一起的货号」会不一致 ——
 * 而这种不一致只在跨大小写/空格的货号上才显形，最难被发现。
 *
 * 前端只需要「匹配键」（建议去重、筛选），不需要归一后的入库值（那是服务端的事）。
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
