import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";

/**
 * 采购计划的状态、编号与**金额**口径 —— 只此一处实现。
 *
 * 设计依据 `docs/design/purchase-plan-and-supplier-collapse-2026-09-27.md`（状态与编号）
 * 与 `docs/design/purchase-plan-pricing-2026-09-30.md`（金额）。
 */

/** 计划行的默认币种（用户 2026-09-30：「添加价格字段，单价，总价」）。 */
export const DEFAULT_PLAN_CURRENCY = "CNY";

/**
 * 一行计划的金额 = 数量 × 单价。
 *
 * **派生量，不落列**：落列就会有第二个真源，改数量忘了改金额时两个数都"看起来对"。
 * 与采购明细`amount = 数量 × 单价 + extra_fee`故意不同 —— 计划里没有额外费用这一项。
 */
export function planLineAmount(quantity: Prisma.Decimal | string | number, unitPrice: Prisma.Decimal | string | number): Prisma.Decimal {
  return new Prisma.Decimal(quantity).mul(unitPrice);
}

/** 一行计划在合计里的归属形状（只要求用到的三列，避免耦合 Prisma 生成类型）。 */
export type PlanAmountLine = {
  quantity: Prisma.Decimal | string | number;
  unitPrice: Prisma.Decimal | string | number;
  currency?: string | null;
};

/**
 * 计划合计：**按币种分组**（仓库约定「金额不跨币种合计」）。
 *
 * 为什么不返回一个数加一个币种：一张计划里同时有多个供应商（口径 1），
 * 而"一个币种"是**一张采购单**的属性 —— 拿第一行的币种去标一个跨币种的总和，
 * 得到的是一个没有会计意义的数，而它看起来是对的。这与 `reorder.domain.ts` 的
 * `sumByCurrency` 同一口径（那一个是返单追溯用的现成实现）。
 *
 * 币种按字母序输出：调用方（列表/明细）直接拼字符串展示，不该各自排一遍。
 */
export function sumPlanAmounts(lines: readonly PlanAmountLine[]): Array<{ currency: string; amount: string }> {
  const totals = new Map<string, Prisma.Decimal>();
  for (const line of lines) {
    const currency = line.currency?.trim() || DEFAULT_PLAN_CURRENCY;
    totals.set(currency, (totals.get(currency) ?? new Prisma.Decimal(0)).plus(planLineAmount(line.quantity, line.unitPrice)));
  }
  return [...totals.entries()]
    .map(([currency, amount]) => ({ currency, amount: amount.toFixed(4) }))
    .sort((left, right) => left.currency.localeCompare(right.currency));
}

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

/** 计划列表按 BOM 汇总时说「这张 BOM 比计划多几个物料」——按**物料**比，不按 BOM 行 ID。 */
export function countBomMaterialsMissingFromPlan(bomMaterialIds: readonly string[], planMaterialIds: readonly string[]): number {
  const planned = new Set(planMaterialIds);
  // 同一物料在 BOM 里出现多行时只算一次（提示是给采购员看的"少了哪个东西"，不是行数）。
  const missing = new Set(bomMaterialIds.filter((id) => !planned.has(id)));
  return missing.size;
}

/**
 * 可以建采购计划的销售单状态（2026-11-12）。
 *
 * `closed` 一并放行，理由见 `docs/audit/procurement-audit-2026-11-12.md` §1.3：
 * 关闭是**销售侧**的动作（`sales-orders.service.ts` 里关单只要求当前是 confirmed），
 * 它不表示料已经买齐；客户加量、上批损耗补货都可能在关单之后才发生。
 * 而 BOM 本来就只可能建在**已确认**的销售单上（`boms.service.ts` 的 `createFromSalesOrder`），
 * 所以放开 closed 不会把"草稿期还没有 BOM"的噪音放进来。
 */
export const PLAN_ELIGIBLE_SALES_STATUSES: readonly string[] = ["confirmed", "closed"];

/** 候选被拦下的原因码（契约；中文文案可以改，码不能改）。 */
export type PlanCandidateBlockCode = "SALES_ORDER_DELETED" | "PLAN_ALREADY_EXISTS" | "SALES_ORDER_NOT_CONFIRMED";

export type PlanCandidateBlock = { code: PlanCandidateBlockCode; message: string };

/** 卖单状态的可读名（原因文案要给采购员看，不给他看枚举值）。 */
const SALES_ORDER_STATUS_LABELS: Record<string, string> = { draft: "草稿", confirmed: "已确认", closed: "已关闭" };

/**
 * 这张 BOM 为什么**不能**建采购计划？返回空数组 = 可以建。
 *
 * 纯函数、只吃已读好的行（不查库），因为它要在两个地方得到同一个答案：
 * 候选列表（告诉用户为什么选不到）与建计划的前置校验（真的拦住）。
 * 两处各写一遍条件，就等于给自己留一次"候选里有、保存时报 404"的事故。
 */
export function planCandidateReasons(input: {
  salesOrderDeleted: boolean;
  salesOrderStatus: string;
  existingPlan: { planNo: string; status?: PurchasePlanStatus } | null;
}): PlanCandidateBlock[] {
  // 销售单没了优先说：这时候"状态"已经不是采购员该关心的事了。
  if (input.salesOrderDeleted) {
    return [{ code: "SALES_ORDER_DELETED", message: "所属销售单已被删除（孤立单据）：要补购请先找管理员把销售单接回来" }];
  }
  if (input.existingPlan) {
    const status = input.existingPlan.status ? PURCHASE_PLAN_STATUS_LABELS[input.existingPlan.status] : "已有";
    return [{
      code: "PLAN_ALREADY_EXISTS",
      message: `该 BOM 已有采购计划 ${input.existingPlan.planNo}（${status}）：补料请打开这份计划、加一行，不要另建一份`,
    }];
  }
  if (!PLAN_ELIGIBLE_SALES_STATUSES.includes(input.salesOrderStatus)) {
    const label = SALES_ORDER_STATUS_LABELS[input.salesOrderStatus] ?? input.salesOrderStatus;
    return [{ code: "SALES_ORDER_NOT_CONFIRMED", message: `所属销售单还是${label}：请先在销售模块确认销售单，再回来建采购计划` }];
  }
  return [];
}

/**
 * 计划状态从**行链接**派生（口径 4.1：状态不落列，落列就一定和行状态漂移）。
 *
 * 抽出来是给候选列表用的：它要在一屏里说清"那份计划是还没下单、还是已经买完了"，
 * 而它手里只有行的 `purchaseOrderItemId`。
 */
export function planStatusFromItems(items: ReadonlyArray<{ purchaseOrderItemId: string | null }>): PurchasePlanStatus {
  return planStatusOf(items.length, items.filter((item) => !item.purchaseOrderItemId).length);
}
