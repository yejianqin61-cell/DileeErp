import { Prisma } from "@prisma/client";

/**
 * 销售单列表的排序口径 —— 只此一处实现。
 *
 * 用户 2026-11-13：「需要给销售单排序，支持按照销售单号字典序排序，创建时间排序。」
 * 用户 2026-11-19（T-0022）：「订单列表默认按订单号升序（从小到大）排序；纯数字订单号按数值比较
 * （9 排在 10 之前）；分页后整体顺序保持一致；空值排在最后。」
 *
 * 为什么是**服务端**排序而不是前端排：`GET /sales-orders` 是分页接口
 * （`page` / `page_size` / `meta.total`），前端手上只有当前这一页。
 * 在前端排只会把"这一页里的顺序"换一换，翻到第 2 页就前后矛盾 ——
 * 而那种错**看起来是对的**，正是最难查的一类。
 *
 * 三个键各自对应一句人话（界面上照这个显示）：
 *   · `order_no`   订单号（**默认**，从小到大；纯数字按数值比较）
 *   · `updated_at` 最后修改
 *   · `created_at` 创建时间
 */

export const SALES_ORDER_LIST_SORTS = ["updated_at", "order_no", "created_at"] as const;
export type SalesOrderListSort = (typeof SALES_ORDER_LIST_SORTS)[number];

export const SALES_ORDER_LIST_DIRECTIONS = ["asc", "desc"] as const;
export type SalesOrderListDirection = (typeof SALES_ORDER_LIST_DIRECTIONS)[number];

/** 不传 `sort` 时的默认：订单号升序（T-0022，用户 2026-11-19 拍板）。 */
export const DEFAULT_SALES_ORDER_LIST_SORT: SalesOrderListSort = "order_no";
export const DEFAULT_SALES_ORDER_LIST_DIRECTION: SalesOrderListDirection = "asc";

const SORT_COLUMNS: Record<SalesOrderListSort, keyof Prisma.SalesOrderOrderByWithRelationInput> = {
  updated_at: "updatedAt",
  order_no: "orderNo",
  created_at: "createdAt",
};

/** 合法键 → 排序键；认不出的值回落到默认（`order_no`）。 */
export function salesOrderListSortKey(sort?: string | null): SalesOrderListSort {
  return (SALES_ORDER_LIST_SORTS as readonly string[]).includes(sort ?? "")
    ? (sort as SalesOrderListSort)
    : DEFAULT_SALES_ORDER_LIST_SORT;
}

/** 合法方向 → 方向；认不出的值回落到默认（`asc`）。 */
export function salesOrderListDirection(direction?: string | null): SalesOrderListDirection {
  return (SALES_ORDER_LIST_DIRECTIONS as readonly string[]).includes(direction ?? "")
    ? (direction as SalesOrderListDirection)
    : DEFAULT_SALES_ORDER_LIST_DIRECTION;
}

/**
 * 把查询参数折成 Prisma 的 `orderBy`（**非订单号排序**的路径）。
 *
 * **两个刻意的设计**：
 *
 * 1. **永远追加 `{ id: "asc" }` 作为第二排序键。** 只按 `created_at` 排时，同一批导入
 *    （Excel 补录会一次建很多单，时间戳可能相同）的顺序在数据库里是**不确定**的：
 *    同一页翻两次可能给出不同的行，分页于是会**重复或漏掉**记录。
 *    `id` 是主键、恒定唯一，补上它之后排序是全序，分页才稳定。
 * 2. **认不出的值一律回落到默认**，不抛错。校准入参是 DTO 的职责（`@IsIn` 会给出 400），
 *    这里再抛一次只会让"某处拼错一个枚举"变成一个 500。回落到默认是**可见的**
 *    （界面上的下拉会显示它落到了哪一项），不是静默改口径。
 *
 * ⚠️ `order_no` 的数值比较（T-0022）无法用 Prisma 的 `orderBy` 表达：数据库的字符串序
 * 会把 `10` 排在 `9` 前面。service 对 `order_no` 走 `sortSalesOrderRowsByOrderNo` 做全序
 * 排序后再分页；这里保留 `orderNo` 映射，是为了让口径表本身完整、也让别的调用方不会
 * 误以为订单号排序必须依赖数据库字符串序。
 */
export function salesOrderListOrderBy(sort?: string | null, direction?: string | null): Prisma.SalesOrderOrderByWithRelationInput[] {
  const key = salesOrderListSortKey(sort);
  const dir = salesOrderListDirection(direction);
  return [{ [SORT_COLUMNS[key]]: dir } as Prisma.SalesOrderOrderByWithRelationInput, { id: "asc" }];
}

/** 纯数字（十进制、无符号、无小数点）：只有这一种订单号走数值比较。 */
const PURE_DIGITS = /^\d+$/;

/** 订单号的排序归一：null / undefined / 纯空白都视作"空值"（排最后）。 */
function normalizedOrderNo(value?: string | null): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * 非空订单号的比较：纯数字按数值，其余按字符串。
 *
 * 为什么把"纯数字"当作一个独立分组：数值序与字符串序是两种不同的全序，
 * 直接混用会**不满足传递性**（例如 `2 < 10` 按数值、`10 < 15 < 2` 按字符串，
 * 会出现 `2 < 10 < 15 < 2` 的环）。分组后：纯数字组在升序时在前、组内按数值；
 * 非纯数字组在后、组内按字符串。降序整体反转。
 *
 * 字符串比较用码点序（`<` / `>`）而不是 `localeCompare`：后者的结果依赖运行环境的
 * ICU/locale，同一个库在两台机器上可能给出不同顺序，分页就又不稳定了。
 */
function compareNonNullOrderNo(left: string, right: string): number {
  const leftNumeric = PURE_DIGITS.test(left);
  const rightNumeric = PURE_DIGITS.test(right);
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
  if (leftNumeric) {
    // 用 BigInt 而不是 Number：订单号列是 varchar(100)，`Number` 会在超过 2^53 时丢精度。
    // BigInt 同时把前导零视作同一个数值（`09` 与 `9` 数值相等），相等后再用字符串兜底。
    const leftValue = BigInt(left);
    const rightValue = BigInt(right);
    if (leftValue < rightValue) return -1;
    if (leftValue > rightValue) return 1;
  }
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * 订单号比较器（空值永远排最后，升降序都一样）。
 *
 * `direction` 只影响非空值之间的顺序；空值不参与方向反转 —— 用户明确要求
 * 「空值排在最后」，降序时把空值翻到最前面不是他要的。
 */
export function compareSalesOrderNo(left?: string | null, right?: string | null, direction?: string | null): number {
  const leftValue = normalizedOrderNo(left);
  const rightValue = normalizedOrderNo(right);
  if (leftValue === null || rightValue === null) {
    if (leftValue === null && rightValue === null) return 0;
    return leftValue === null ? 1 : -1;
  }
  const compared = compareNonNullOrderNo(leftValue, rightValue);
  return salesOrderListDirection(direction) === "desc" ? -compared : compared;
}

/**
 * 把一组销售单按订单号排成**全序**（service 的订单号分页路径用它）。
 *
 * 同订单号（理论上未删除行唯一，但空值与脏数据仍可能重复）用 `id` 升序兜底：
 * 没有这个兜底，`Array.prototype.sort` 对相等元素的顺序虽然稳定，但下一次查询
 * 返回的行序可能不同，翻页仍可能重复/漏行。`id` 是主键，补上后就是确定的全序。
 */
export function sortSalesOrderRowsByOrderNo<T extends { id: string; orderNo?: string | null }>(rows: readonly T[], direction?: string | null): T[] {
  const resolved = salesOrderListDirection(direction);
  return [...rows].sort((left, right) => {
    const compared = compareSalesOrderNo(left.orderNo, right.orderNo, resolved);
    if (compared !== 0) return compared;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
}

/** 排序选项的显示文案（列表页那一格下拉用它，避免前后端各写一份中文）。 */
export const SALES_ORDER_LIST_SORT_LABELS: Record<`${SalesOrderListSort}:${SalesOrderListDirection}`, string> = {
  "order_no:asc": "订单号（从小到大）",
  "order_no:desc": "订单号（从大到小）",
  "updated_at:desc": "最后修改（新→旧）",
  "updated_at:asc": "最后修改（旧→新）",
  "created_at:desc": "创建时间（新→旧）",
  "created_at:asc": "创建时间（旧→新）",
};
