// 销售单列表的排序选项（前端这一侧，2026-11-13）。
//
// 用户原话：「针对销售模块，用户需要给销售单排序，支持按照销售单号字典序排序，创建时间排序。」
//
// ⚠️ **口径的真源在 API 那一侧**：`apps/api/src/modules/sales/sales-order-list-sort.ts`
// 定义了合法键、方向、默认值，以及每个组合的中文文案。前端这里必须与它逐字一致，
// 否则会出现"下拉里选得到、后端 400"或者"文案对不上"。
//
// 为什么不在前端 import 后端模块：`apps/web` 与 `apps/api` 是两个独立 workspace，
// 没有配跨 workspace 的路径别名（也没有构建期共享包）。所以这里**照抄一份常量**，
// 并用一条**静态守卫用例**（`apps/web/test/sales-order-sort.test.tsx` 的最后一条）
// 直接读后端那个文件、逐项比对键与文案 —— 抄一份可以让下拉能用，
// 而守卫让"两边漂移"变成一条会红的用例，而不是一个用户报的 bug。

/** 选项值用 `${sort}:${direction}`：一个下拉一个值，不必再维护两个 state 的联动。 */
export type SalesOrderSortValue = string;

export const DEFAULT_SALES_ORDER_SORT_VALUE: SalesOrderSortValue = "updated_at:desc";

/**
 * 六种排法（与后端 `SALES_ORDER_LIST_SORT_LABELS` 逐字一致）。
 *
 * 顺序：默认项排最前（用户进来看到的就是它），其余按「订单号 → 创建时间」，
 * 与用户提需求时说的顺序一致。
 */
export const SALES_ORDER_SORT_OPTIONS: ReadonlyArray<{ value: SalesOrderSortValue; label: string }> = [
  { value: "updated_at:desc", label: "最后修改（新→旧）" },
  { value: "order_no:asc", label: "订单号（字典序 A→Z）" },
  { value: "order_no:desc", label: "订单号（字典序 Z→A）" },
  { value: "created_at:desc", label: "创建时间（新→旧）" },
  { value: "created_at:asc", label: "创建时间（旧→新）" },
  { value: "updated_at:asc", label: "最后修改（旧→新）" },
];

/**
 * 把选项值折成查询参数。
 *
 * **默认值不传**：`updated_at:desc` 是服务端的默认行为，传与不传结果一样，
 * 但传了会让请求 URL 与改造前不同 —— 而"老行为一字不改"是这次改造的硬要求
 * （有接口日志/缓存按 URL 归类的场合，URL 变了就是变了）。所以默认项返回空对象。
 */
export function salesOrderSortParams(value: SalesOrderSortValue): { sort?: string; direction?: string } {
  if (!value || value === DEFAULT_SALES_ORDER_SORT_VALUE) return {};
  const [sort, direction] = value.split(":");
  if (!sort || !direction) return {};
  return { sort, direction };
}

/** 把 `{sort, direction}` 拼进已有的查询串（`page_size=200` 那一段）。 */
export function salesOrderListPath(value: SalesOrderSortValue): string {
  const params = new URLSearchParams({ page_size: "200" });
  const extra = salesOrderSortParams(value);
  if (extra.sort) params.set("sort", extra.sort);
  if (extra.direction) params.set("direction", extra.direction);
  return `/sales-orders?${params.toString()}`;
}
