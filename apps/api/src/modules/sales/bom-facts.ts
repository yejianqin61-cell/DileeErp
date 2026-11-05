import type { Prisma } from "@prisma/client";

/**
 * BOM 的「下游事实」判定（2026-11-05）。
 *
 * 为什么单独一个模块：同一句「这张 BOM 到底被谁用过」现在有**两条**路径要用 ——
 *   1. `BomsService.delete` / `deletePreview`：删 BOM 之前判断可不可删、要不要填原因；
 *   2. `SalesOrdersService.update` / `revertToDraft`：销售单核心字段能不能改，
 *      以及哪些 BOM 属于「谁都没用过、也没录过内容」的空壳、可以自动清理。
 * 两处如果各写一遍查询，迟早出现「销售单说没用过、删 BOM 却说被引用」这种自相矛盾。
 *
 * 口径（与 docs/design/bom-delete-and-empty-shell-release-2026-11-05.md 一致）：
 *   - 明细行只数未删除的 `bom_items`；
 *   - 采购单只数未删除、且 `status != "cancelled"` 的（已取消的采购单不是事实）；
 *   - 生产单数未删除的**任何状态**（生产单只有草稿能删，非草稿引用即视为在用）；
 *   - 采购计划不阻止删除 BOM（既有设计：BOM 软删后计划独立存活），但它会让删除必须填原因；
 *   - 「空壳」= 0 明细 + 无采购计划 + 无采购单 + 无生产单。它不含任何业务事实，
 *     所以销售单改核心字段时可以直接清理掉（审计留痕，不静默）。
 */
export type BomFactsClient = Prisma.TransactionClient;

export type BomPlanFacts = {
  id: string;
  plan_no: string;
  /** 计划里已经下过单的行数。只作为诊断信息，不改变「BOM 能不能删」。 */
  ordered_line_count: number;
};

export type BomFacts = {
  id: string;
  order_no: string;
  version: number;
  status: string;
  item_count: number;
  /** 该 BOM 的采购计划（一张 BOM 至多一份未删计划，见部分唯一索引）。 */
  purchase_plan: BomPlanFacts | null;
  purchase_order_count: number;
  production_order_count: number;
};

/** 自动清理空壳 BOM 时写进审计的固定理由（销售单保存/回退草稿两条路径共用）。 */
export const AUTO_RELEASE_EMPTY_BOM_REASON = "销售单核心字段修改时自动清理未填内容的空 BOM";

/**
 * 读一张 BOM 的全部下游事实；BOM 不存在或已软删返回 `null`。
 *
 * 调用方若要「判断完就写」，必须放在同一个事务里、并先对 `boms` 行取行锁，
 * 否则两次读之间可能有人补建采购单/生产单（`BomsService.delete` 就是这么做的）。
 */
export async function bomFacts(client: BomFactsClient, bomId: string): Promise<BomFacts | null> {
  const bom = await client.bom.findFirst({ where: { id: bomId, deletedAt: null }, select: { id: true, orderNo: true, version: true, status: true } });
  if (!bom) return null;
  const [itemCount, plan, purchaseOrderCount, productionOrderCount] = await Promise.all([
    client.bomItem.count({ where: { bomId, deletedAt: null } }),
    client.purchasePlan.findFirst({ where: { bomId, deletedAt: null }, select: { id: true, planNo: true } }),
    client.purchaseOrder.count({ where: { bomId, deletedAt: null, status: { not: "cancelled" } } }),
    client.productionOrder.count({ where: { bomId, deletedAt: null } }),
  ]);
  let purchasePlan: BomPlanFacts | null = null;
  if (plan) {
    const orderedLineCount = await client.purchasePlanItem.count({ where: { planId: plan.id, deletedAt: null, purchaseOrderItemId: { not: null } } });
    purchasePlan = { id: plan.id, plan_no: plan.planNo, ordered_line_count: orderedLineCount };
  }
  return { id: bom.id, order_no: bom.orderNo, version: bom.version, status: bom.status, item_count: itemCount, purchase_plan: purchasePlan, purchase_order_count: purchaseOrderCount, production_order_count: productionOrderCount };
}

/** 一张销售单名下**未删除**的全部 BOM 的下游事实（部分唯一索引决定通常只有一张）。 */
export async function salesOrderBomFacts(client: BomFactsClient, salesOrderId: string): Promise<BomFacts[]> {
  const rows = await client.bom.findMany({ where: { salesOrderId, deletedAt: null }, select: { id: true }, orderBy: { version: "desc" } });
  const facts: BomFacts[] = [];
  for (const row of rows) {
    const item = await bomFacts(client, row.id);
    if (item) facts.push(item);
  }
  return facts;
}

/** 空壳 = 谁都没用过、也没录过内容：0 明细、无采购计划、无采购单、无生产单。 */
export function isEmptyShellBom(facts: Pick<BomFacts, "item_count" | "purchase_plan" | "purchase_order_count" | "production_order_count">): boolean {
  return facts.item_count === 0 && facts.purchase_plan === null && facts.purchase_order_count === 0 && facts.production_order_count === 0;
}

/** 已经采购/投产的 BOM 不可删：与销售单核心字段锁同一口径（先回退下游）。 */
export function bomHasDownstream(facts: Pick<BomFacts, "purchase_order_count" | "production_order_count">): boolean {
  return facts.purchase_order_count > 0 || facts.production_order_count > 0;
}

/**
 * 「这张 BOM 为什么不能删/为什么在挡销售单」的一句人话。
 * 返回 `null` = 没有下游单据挡着（采购计划是允许存在的，见模块头注释）。
 */
export function bomBlockedReason(facts: Pick<BomFacts, "purchase_order_count" | "production_order_count">): string | null {
  const purchase = facts.purchase_order_count;
  const production = facts.production_order_count;
  if (!purchase && !production) return null;
  const parts: string[] = [];
  if (purchase) parts.push(`${purchase} 张采购单（可在采购计划里「退回采购计划」或取消后重来）`);
  if (production) parts.push(`${production} 张生产单（草稿可直接删除；已开工/已完工的生产单不能回退，BOM 需保留）`);
  return `这张 BOM 已被 ${parts.join("、")}引用，不能删除。请先回退下游单据，再删 BOM。`;
}
