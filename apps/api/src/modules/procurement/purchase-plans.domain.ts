import { randomUUID } from "node:crypto";

/**
 * 采购计划的状态与编号口径 —— 只此一处实现。
 *
 * 设计依据 `docs/design/purchase-plan-and-supplier-collapse-2026-09-27.md`。
 */

/** 计划状态：**派生**得出，不落列（落列就会有第二个真源，早晚与行状态漂移）。 */
export type PurchasePlanStatus = "unordered" | "partial" | "completed";

export const PURCHASE_PLAN_STATUSES: readonly PurchasePlanStatus[] = ["unordered", "partial", "completed"];

export const PURCHASE_PLAN_STATUS_LABELS: Record<PurchasePlanStatus, string> = {
  unordered: "未下单",
  partial: "部分下单",
  completed: "已完成",
};

/**
 * 由「总行数 + 未下单行数」推出计划状态。
 *
 * `lineCount === 0` 判成「未下单」而不是「已完成」：一份空计划什么都没做完，
 * 把它显示成"已完成"会让人以为这张 BOM 已经买齐了 —— 这正是这个状态存在的意义所要防的事。
 */
export function planStatusOf(lineCount: number, unorderedCount: number): PurchasePlanStatus {
  if (lineCount <= 0) return "unordered";
  if (unorderedCount <= 0) return "completed";
  return unorderedCount >= lineCount ? "unordered" : "partial";
}

/**
 * 计划编号：`PP-{YYYYMMDD}-{后缀}`，与采购单号 `PO-{YYYYMMDD}-{后缀}` 同格式
 * （`purchase-orders.service.ts` 就是 `PO-` + 日期 + `randomUUID().slice(0,8).toUpperCase()`）。
 *
 * 抽成纯函数（后缀可注入）是为了能在单测里断言格式，而不是去 mock `randomUUID`。
 */
export function purchasePlanNo(now: Date = new Date(), suffix: string = randomUUID().slice(0, 8)): string {
  return `PP-${now.toISOString().slice(0, 10).replaceAll("-", "")}-${suffix.toUpperCase()}`;
}

/**
 * 计划行的「下单状态」里那一档**计划中**的判定。
 *
 * 与采购明细的累计口径并列：`bomItemOrderStatus` 的 `draft` 档原来数的是草稿采购单
 * （草稿已经不存在了），现在改数**计划行**里还没下单的那些行。
 * 名字保留 `draft`（4 个前端文件与既有契约都按它取值），语义变成"计划中"。
 */
export function isPlannedNotOrdered(purchaseOrderItemId: string | null | undefined): boolean {
  return !purchaseOrderItemId;
}

/** 计划列表按 BOM 汇总时说「这张 BOM 比计划多几个物料」——按**物料**比，不按 BOM 行 ID。 */
export function countBomMaterialsMissingFromPlan(bomMaterialIds: readonly string[], planMaterialIds: readonly string[]): number {
  const planned = new Set(planMaterialIds);
  // 同一物料在 BOM 里出现多行时只算一次（提示是给采购员看的"少了哪个东西"，不是行数）。
  const missing = new Set(bomMaterialIds.filter((id) => !planned.has(id)));
  return missing.size;
}
