import { Prisma } from "@prisma/client";

/**
 * 销售单列表的排序口径 —— 只此一处实现。
 *
 * 用户 2026-11-13：「需要给销售单排序，支持按照销售单号字典序排序，创建时间排序。」
 *
 * 为什么是**服务端**排序而不是前端排：`GET /sales-orders` 是分页接口
 * （`page` / `page_size` / `meta.total`），前端手上只有当前这一页。
 * 在前端排只会把"这一页里的顺序"换一换，翻到第 2 页就前后矛盾 ——
 * 而那种错**看起来是对的**，正是最难查的一类。
 *
 * 三个键各自对应一句人话（界面上照这个显示）：
 *   · `updated_at` 最后修改（**默认**，与本次改造前的行为一致）
 *   · `order_no`   订单号，**字典序**（纯字符串序）
 *   · `created_at` 创建时间
 */

export const SALES_ORDER_LIST_SORTS = ["updated_at", "order_no", "created_at"] as const;
export type SalesOrderListSort = (typeof SALES_ORDER_LIST_SORTS)[number];

export const SALES_ORDER_LIST_DIRECTIONS = ["asc", "desc"] as const;
export type SalesOrderListDirection = (typeof SALES_ORDER_LIST_DIRECTIONS)[number];

/** 不传 `sort` 时的默认：保持 2026-11-13 之前的行为（最后修改倒序），老调用方零变化。 */
export const DEFAULT_SALES_ORDER_LIST_SORT: SalesOrderListSort = "updated_at";
export const DEFAULT_SALES_ORDER_LIST_DIRECTION: SalesOrderListDirection = "desc";

const SORT_COLUMNS: Record<SalesOrderListSort, keyof Prisma.SalesOrderOrderByWithRelationInput> = {
  updated_at: "updatedAt",
  order_no: "orderNo",
  created_at: "createdAt",
};

/**
 * 把查询参数折成 Prisma 的 `orderBy`。
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
 * ⚠️ `order_no` 是**纯字符串序**（字典序），这是用户要的口径。它的一个必然后果是
 * 编号不带前导零时 `DL260001-10` 排在 `DL260001-2` **前面**。
 * 要按结尾数字排（自然序）是另一件事，需要先确认单号的编号规则，不在本次口径内。
 */
export function salesOrderListOrderBy(sort?: string | null, direction?: string | null): Prisma.SalesOrderOrderByWithRelationInput[] {
  const key = (SALES_ORDER_LIST_SORTS as readonly string[]).includes(sort ?? "")
    ? (sort as SalesOrderListSort)
    : DEFAULT_SALES_ORDER_LIST_SORT;
  const dir = (SALES_ORDER_LIST_DIRECTIONS as readonly string[]).includes(direction ?? "")
    ? (direction as SalesOrderListDirection)
    : DEFAULT_SALES_ORDER_LIST_DIRECTION;
  return [{ [SORT_COLUMNS[key]]: dir } as Prisma.SalesOrderOrderByWithRelationInput, { id: "asc" }];
}

/** 排序选项的显示文案（列表页那一格下拉用它，避免前后端各写一份中文）。 */
export const SALES_ORDER_LIST_SORT_LABELS: Record<`${SalesOrderListSort}:${SalesOrderListDirection}`, string> = {
  "updated_at:desc": "最后修改（新→旧）",
  "updated_at:asc": "最后修改（旧→新）",
  "order_no:asc": "订单号（字典序 A→Z）",
  "order_no:desc": "订单号（字典序 Z→A）",
  "created_at:desc": "创建时间（新→旧）",
  "created_at:asc": "创建时间（旧→新）",
};
