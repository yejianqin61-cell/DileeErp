import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { AuditService } from "../../platform/audit/audit.service";
import { AuditActorService } from "../../platform/audit/audit-actor.service";
import type { CurrentUser } from "../../platform/auth/auth.service";
import { PrismaService } from "../../platform/database/prisma.service";
import { itemNoKey } from "../sales/item-no";
import { PurchaseOrdersService, type PurchaseOrderItemInput, type SplitGroup, type SplitInput } from "./purchase-orders.service";
import { countBomMaterialsMissingFromPlan, DEFAULT_PLAN_CURRENCY, planCandidateReasons, planLineAmount, planStatusFromItems, planStatusOf, purchasePlanNo, PURCHASE_PLAN_STATUS_LABELS, sumPlanAmounts, type PurchasePlanStatus } from "./purchase-plans.domain";

/**
 * 采购计划：老板要求「采购模块多一个采购计划栏目，承接原来的采购单草稿」。
 *
 * 设计依据 `docs/design/purchase-plan-and-supplier-collapse-2026-09-27.md`，三条最要紧的：
 *
 *   1. **粒度是「一个销售单 / 一份 BOM」**，一张计划里同时有多个供应商的行。
 *      采购单的粒度是「一个供应商 × 一个币种」，所以计划不能拿采购单顶替。
 *   2. **数量/单价/供应商的唯一编辑点在这里**。采购单页只剩打印字段可填 ——
 *      两个模块都能改数量，等于把「下单状态没及时更新」那类 bug 制度化。
 *   3. **已下单的行留在计划里**（`purchaseOrderItemId` 非空即"已下单"），
 *      否则"这张 BOM 还差什么没买"就没人答得出来，而那正是计划存在的理由。
 */

/** 计划行入参（snake_case：与采购单的 `ItemDto` 同一形状，前端两边共用一套字段名）。 */
export type PlanItemInput = {
  /** 已有行的身份。已下单的行必须带着它回来 —— 见 `update()` 的已下单行保护。 */
  id?: string;
  material_id: string;
  unit_id: string;
  bom_item_id?: string;
  supplier_id?: string;
  model?: string;
  quantity: string;
  unit_price: string;
  expected_date?: string;
  extension_data?: Record<string, unknown>;
};
export type PlanInput = { bom_id?: string; items?: PlanItemInput[]; extension_data?: Record<string, unknown>; expected_updated_at?: string; reason?: string };

export type PlanListQuery = { order_no?: string; item_no?: string; status?: string; q?: string };

/**
 * 收束下单的入参：**按供应商分组**，每组一个币种（口径 10），`items` 是计划行 ID。
 *
 * 没收进任何一组的行**留在计划里**（口径 6 的多波次）—— 分批下单是采购现实
 * （这家先下、那家还在等图纸）。
 */
export type PlanOrderGroup = { supplier_id?: string; currency?: string; expected_date?: string; remark?: string; items: string[] };
/**
 * 收束下单的入参。
 *
 * 这里曾经有一个 `allow_pending_price`（2026-10-09 的「价格待定」放行开关）：
 * 辅料要等客户确认资料才有价，于是允许带着 0 单价下单先把供应商与交期占住。
 *
 * **2026-10-11 用户改了口径**：「确定单价的能下单，没确定单价的先不下单」——
 * 0 价的行现在**一律不下单**，留在计划里等补价之后再下一波（分批下单本来就是采购现实）。
 * 开关连同下游的放行逻辑一起删掉：留着它就是给 0 价采购单留一条后门，
 * 而那条后门通向一条**0 元应付**（财务收到一张没法付的单，全链路不报错）。
 */
export type PlanOrderInput = { purchase_date?: string; remark?: string; extension_data?: Record<string, unknown>; groups: PlanOrderGroup[] };

/** 保存时要比对的最小行形状（只取已下单行保护用得上的列）。 */
type WritablePlanItem = {
  id: string;
  materialId: string;
  unitId: string;
  supplierId: string | null;
  quantity: Prisma.Decimal;
  unitPrice: Prisma.Decimal;
  /** 币种只在**下单**时由服务端写回，客户端不参与比对（见 `orderedLineChanged` 的注释）。 */
  currency: string;
  model: string | null;
  expectedDate: Date | null;
  purchaseOrderItemId: string | null;
  bomItemId: string | null;
  extensionData: unknown;
};

/** 落库前的计划行（日期已解析、快照已备好）。 */
type PreparedPlanItem = {
  materialId: string;
  materialSnapshot: Prisma.InputJsonValue;
  unitId: string;
  unitSnapshot: Prisma.InputJsonValue;
  bomItemId: string | null;
  supplierId: string | null;
  supplierSnapshot: Prisma.InputJsonValue | typeof Prisma.DbNull;
  model: string | null;
  quantity: string;
  unitPrice: string;
  currency: string;
  expectedDate: Date | null;
  extensionData: Record<string, unknown>;
};

/** 列表/详情共用的计划摘要来源（只要求用到的字段，避免耦合 Prisma 生成类型）。 */
export type PlanSummarySource = {
  id: string;
  planNo: string;
  orderNo: string;
  bomId: string;
  bomVersion: number | null;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string;
  updatedBy: string;
  items: Array<{ id: string; purchaseOrderItemId: string | null; quantity: Prisma.Decimal; unitPrice: Prisma.Decimal; currency: string }>;
  salesOrder: { orderNo: string; itemNo: string | null; customerSnapshot: unknown } | null;
};

/** 从快照 JSON 里取一个字符串字段（供应商/客户被改名或停用后，页面上仍要看得见当时记的是什么）。 */
function snapshotField(snapshot: unknown, key: string): string | null {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return null;
  const value = (snapshot as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}
const snapshotName = (snapshot: unknown) => snapshotField(snapshot, "name");
/** 「张伟 / 13800000000」：联系人与电话合成一列（列已经 13 个，拆两列在 1366px 上没法用）。 */
function contactLine(supplier: { contactName?: string | null; phone?: string | null } | null | undefined): string | null {
  if (!supplier) return null;
  const parts = [supplier.contactName?.trim(), supplier.phone?.trim()].filter((part): part is string => Boolean(part));
  return parts.length ? parts.join(" / ") : null;
}

/** 列表页展平用的一行（`GET /purchase-plans` 的 `lines[]`，2026-10-13）。 */
type PlanListLineSource = {
  id: string;
  materialId: string;
  materialSnapshot: unknown;
  model: string | null;
  unitSnapshot: unknown;
  quantity: Prisma.Decimal;
  unitPrice: Prisma.Decimal;
  currency: string;
  purchaseOrderItemId: string | null;
  expectedDate: Date | null;
  supplierId: string | null;
  supplierSnapshot: unknown;
  material?: { id: string; materialCode: string; name: string } | null;
  unit?: { id: string; name: string } | null;
  supplier?: { id: string; name: string } | null;
  purchaseOrderItem?: { purchaseOrder: { purchaseOrderNo: string } | null } | null;
};

/**
 * 列表页那一张表的一行（用户 2026-10-13：「采购计划的那个页面，也要显示物料名称等等 column。都要显示」）。
 *
 * 名字刻意叫 `lines` 而**不是** `items`：详情接口的 `items` 是可编辑行（带快照、BOM 参考单价、
 * 已下单行锁），这里只是渲染那 13 列要用的投影。同名不同形是最容易被误用的那种"一致"。
 *
 * 「已下单」仍然只有一个表示：`purchaseOrderItemId` 非空（口径 5 / 2026-09-27 §3.2）。
 * 物料/单位/供应商名优先取主数据现值、取不到退回快照 —— 与 `get()` 同一口径，
 * 所以物料改名、供应商停用都不会让列表那一格变空。
 */
function planListLines(items: readonly PlanListLineSource[]) {
  return items.map((item) => ({
    id: item.id,
    materialId: item.materialId,
    materialCode: item.material?.materialCode ?? snapshotField(item.materialSnapshot, "materialCode"),
    materialName: item.material?.name ?? snapshotName(item.materialSnapshot) ?? "",
    model: item.model,
    unitName: item.unit?.name ?? snapshotName(item.unitSnapshot),
    quantity: item.quantity.toFixed(4),
    unitPrice: item.unitPrice.toFixed(4),
    /** 行总价 = 数量 × 单价（**派生**，与详情/合计同一个函数）—— 财务看的就是这个数。 */
    amount: planLineAmount(item.quantity, item.unitPrice).toFixed(4),
    currency: item.currency ?? DEFAULT_PLAN_CURRENCY,
    supplierId: item.supplierId,
    supplierName: item.supplier?.name ?? snapshotName(item.supplierSnapshot),
    expectedDate: item.expectedDate,
    ordered: Boolean(item.purchaseOrderItemId),
    purchaseOrderNo: item.purchaseOrderItem?.purchaseOrder?.purchaseOrderNo ?? null,
  }));
}

@Injectable()
export class PurchasePlansService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly orders: PurchaseOrdersService, private readonly actors: AuditActorService) {}

  /**
   * 计划列表。
   *
   * `order_no` 走数据库；**货号 / 状态 / 关键词在内存里筛**，两个理由：
   *   · 货号必须按 `itemNoKey` **归一**后比（`27621` 与 `27621␠` 是同一个货号，
   *     而库里存的是人能读的原样）—— SQL 里 `=` 恰好匹配不到这种"同一货号两种写法"，
   *     而那正是 2026-09-26 那批返单功能要解决的现场问题；
   *   · 计划的粒度是「一个已确认销售单一行」，量级与销售单同阶（几百），内存筛不构成负担。
   */
  async list(query: PlanListQuery = {}) {
    const orderNo = query.order_no?.trim();
    const rows = await this.prisma.purchasePlan.findMany({
      where: { deletedAt: null, ...(orderNo ? { orderNo } : {}) },
      include: {
        // 金额要在这里算出来：列表的「计划金额」列与明细表下方那一行合计同一口径
        // （`sumPlanAmounts` 只此一处实现），所以数量/单价/币种都要取回来。
        //
        // 2026-10-13（用户：「采购计划的那个页面，也要显示物料名称等等 column。都要显示」）：
        // 列表页**展平成一行 = 一条明细**，所以这里把渲染那 13 列要用的字段一并取回来 ——
        // 一次查询解决，不新增接口（`lib/page-data-alignment.test.mjs` 盯着这一页的请求绑定表）。
        items: {
          where: { deletedAt: null },
          orderBy: [{ sequence: "asc" }, { createdAt: "asc" }],
          select: {
            id: true, materialId: true, materialSnapshot: true, model: true,
            unitSnapshot: true, quantity: true, unitPrice: true, currency: true,
            purchaseOrderItemId: true, expectedDate: true,
            supplierId: true, supplierSnapshot: true,
            // 物料/单位/供应商名优先取**主数据的现值**，取不到再退回快照（与 `get()` 同一口径）：
            // 物料改名之后列表要显示新名字，而快照是"建计划那一刻"的旧名字。
            material: { select: { id: true, materialCode: true, name: true } },
            unit: { select: { id: true, name: true } },
            supplier: { select: { id: true, name: true } },
            purchaseOrderItem: { select: { purchaseOrder: { select: { purchaseOrderNo: true } } } },
          },
        },
        salesOrder: { select: { orderNo: true, itemNo: true, customerSnapshot: true, deletedAt: true } },
      },
      orderBy: { updatedAt: "desc" },
    });
    const summaries = rows.map((row) => this.summaryOf(row as PlanSummarySource));
    // 列表要显示"最后更新（人 + 北京时间）"，所以把操作人姓名一并解析出来。
    // 只输出**姓名**、绝不输出 UUID —— 全站治理要消灭的正是「制单：6f3a1c8e-…」那种显示。
    const names = rows.length ? await this.actors.namesOf(rows.flatMap((row) => [row.updatedBy, row.createdBy])) : new Map<string, string>();
    // `orphaned` = 所属销售单已被软删（2026-11-03）：采购计划不删，显示为孤立单据。
    const withNames = summaries.map((row, index) => ({ ...row, updatedByName: names.get(rows[index].updatedBy) ?? null, createdByName: names.get(rows[index].createdBy) ?? null, lines: planListLines(rows[index].items), orphaned: Boolean(rows[index].salesOrder?.deletedAt) }));
    const status = query.status?.trim();
    const key = itemNoKey(query.item_no);
    const text = query.q?.trim().toLowerCase();
    return withNames.filter((row) => {
      if (status && status !== "all" && row.status !== status) return false;
      if (key && itemNoKey(row.itemNo) !== key) return false;
      if (text && !`${row.planNo} ${row.orderNo} ${row.itemNo ?? ""} ${row.customerName ?? ""}`.toLowerCase().includes(text)) return false;
      return true;
    });
  }

  /**
   * 可以建计划的 BOM：**只返回能建的那一半**（老调用方的形状，一行都不用改）。
   *
   * 分类规则本身在 `candidateReport()` 里；这里只是取它的 `eligible` 半边，
   * 免得"哪些能建"出现第二份实现。
   */
  async candidates() {
    return (await this.candidateReport()).eligible;
  }

  /**
   * 候选清单的**两半**：能建的与被拦下的（2026-11-12）。
   *
   * 为什么要把被拦下的也返回：这张清单既是"该建计划还没建"的待办，也是新建弹窗的**选择器**，
   * 而选择器必须回答"为什么没有我要的那张 BOM"。原来三层条件全写在 `where` 里，
   * 不可建的 BOM 直接从结果里消失 —— 界面上只剩一个空下拉（用户原话：
   * 「采购计划有时候无法选中需要建立采购计划的BOM表」）。审计见
   * `docs/audit/procurement-audit-2026-11-12.md` §1。
   *
   * 过滤口径**不再写在 `where` 里**，而是取回该看的 BOM 后在内存里分类：
   * 这样"为什么不行"才有地方放（`reasons`），而不是被 SQL 吃掉。
   * 量级与销售单同阶（几百），且 `orderNo` 上有索引。
   *
   * 被拦下的上限 50 条：这是给下拉旁边的一句解释，不是报表。
   */
  async candidateReport() {
    const boms = await this.prisma.bom.findMany({
      where: { deletedAt: null },
      include: {
        salesOrder: { select: { orderNo: true, itemNo: true, customerSnapshot: true, deliveryDate: true, status: true, deletedAt: true } },
        items: { where: { deletedAt: null }, select: { id: true } },
        // 一份 BOM 最多一份未删计划（部分唯一索引），所以这里取 `[0]` 是安全的；
        // 行链接要读回来算派生状态（口径 4.1：状态不落列）。
        purchasePlans: { where: { deletedAt: null }, select: { id: true, planNo: true, items: { where: { deletedAt: null }, select: { purchaseOrderItemId: true } } } },
      },
      orderBy: [{ orderNo: "asc" }, { version: "desc" }],
    });
    const eligible: Array<{ bomId: string; orderNo: string; bomVersion: number; itemNo: string | null; customerName: string | null; deliveryDate: Date | null; itemCount: number }> = [];
    const blocked: Array<{
      bomId: string; orderNo: string; bomVersion: number; itemNo: string | null; customerName: string | null; itemCount: number;
      reasons: ReturnType<typeof planCandidateReasons>;
      existingPlan: { id: string; planNo: string; status: PurchasePlanStatus; statusLabel: string } | null;
    }> = [];
    for (const bom of boms) {
      const plan = bom.purchasePlans?.[0] ?? null;
      const existingPlan = plan
        ? { id: plan.id, planNo: plan.planNo, status: planStatusFromItems(plan.items ?? []), statusLabel: PURCHASE_PLAN_STATUS_LABELS[planStatusFromItems(plan.items ?? [])] }
        : null;
      const reasons = planCandidateReasons({
        salesOrderDeleted: Boolean(bom.salesOrder?.deletedAt),
        salesOrderStatus: bom.salesOrder?.status ?? "",
        existingPlan,
      });
      const shape = {
        bomId: bom.id,
        orderNo: bom.orderNo,
        bomVersion: bom.version,
        itemNo: bom.salesOrder?.itemNo ?? null,
        customerName: snapshotName(bom.salesOrder?.customerSnapshot),
        itemCount: bom.items?.length ?? 0,
      };
      if (!reasons.length) {
        eligible.push({ ...shape, deliveryDate: bom.salesOrder?.deliveryDate ?? null });
        continue;
      }
      if (blocked.length < 50) blocked.push({ ...shape, reasons, existingPlan });
    }
    return { eligible, blocked };
  }

  /**
   * 新建计划（口径 2）：选一张还没有计划的 BOM，**自动带出该 BOM 全部明细行**。
   *
   * 为什么不是空计划 + 手动"导入 BOM 明细"：计划的身份是"这张 BOM 的采购工作面"，
   * 那它诞生时就该已经包含全部需求 —— 这是"漏买部件"唯一的防法。
   * 带出来的行可以删、也可以加（BOM 外的补料/替代料走 `outside_bom_reason`）。
   */
  async create(input: PlanInput, user: CurrentUser) {
    const bom = await this.loadBom(input.bom_id);
    const existing = await this.prisma.purchasePlan.findFirst({ where: { bomId: bom.id, deletedAt: null }, select: { id: true, planNo: true } });
    if (existing) throw new ConflictException({ code: "PURCHASE_PLAN_ALREADY_EXISTS", message: `该 BOM 已经有一份采购计划（${existing.planNo}）`, details: [{ plan_id: existing.id, plan_no: existing.planNo }] });
    const created = await this.createPlanRecord(bom, input, user);
    return this.get(created.id);
  }

  /**
   * 建一条计划记录（头 + 行）并写审计。**不做"已存在"检查** —— 语义由调用方决定：
   * 新建接口看到已存在要报 409；退回采购计划时看到已存在要**复用它**。
   */
  private async createPlanRecord(bom: Awaited<ReturnType<PurchasePlansService["loadBom"]>>, input: PlanInput, user: CurrentUser) {
    const items = input.items?.length ? await this.prepareItems(bom, input.items, user) : await this.itemsFromBom(bom);
    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const plan = await tx.purchasePlan.create({
          data: {
            planNo: purchasePlanNo(),
            orderNo: bom.orderNo,
            salesOrderId: bom.salesOrderId,
            bomId: bom.id,
            bomVersion: bom.version,
            bomSnapshot: bom as unknown as Prisma.InputJsonValue,
            extensionData: (input.extension_data ?? {}) as Prisma.InputJsonValue,
            ...this.audit.create(user),
          },
        });
        if (items.length) await tx.purchasePlanItem.createMany({ data: items.map((item, index) => this.itemData(plan.id, item, index + 1, user)) });
        return plan;
      });
      await this.audit.record("purchase_plan.create", "purchase_plan", user.id, created.id, { plan_no: created.planNo, order_no: created.orderNo, bom_id: bom.id, item_count: items.length, prefilled_suppliers: items.filter((item) => item.supplierId).length });
      return created;
    } catch (error) {
      // 部分唯一索引（`bom_id WHERE deleted_at IS NULL`）挡住并发重复建：两个人同时点"新建"时，
      // 先到的赢，后到的拿到的是同一句人话，而不是一个 500。
      if (error && typeof error === "object" && "code" in error && error.code === "P2002") throw new ConflictException({ code: "PURCHASE_PLAN_ALREADY_EXISTS", message: "该 BOM 已经有一份采购计划", details: [] });
      throw error;
    }
  }

  /**
   * 取该 BOM 的未删计划；**没有就补建一份**（口径 15 ③）。
   *
   * 什么时候会没有：这张已下单的采购单是 2026-09-27 之前建的（那时没有计划），
   * 或者它的 BOM 后来才补上计划。退回时不能因为"计划不存在"就把用户挡回去 ——
   * 补建出来的计划带的是**这张 BOM 的全部需求行**，正好就是"这些还要买"的工作面。
   */
  private async ensurePlanForBom(bomId: string, user: CurrentUser) {
    const existing = await this.prisma.purchasePlan.findFirst({ where: { bomId, deletedAt: null }, select: { id: true, planNo: true } });
    if (existing) return existing;
    try {
      const created = await this.createPlanRecord(await this.loadBomForRevert(bomId), {}, user);
      return { id: created.id, planNo: created.planNo };
    } catch (error) {
      // 并发下别人刚补建出来：复用它，别把用户的退回动作顶掉。
      if (error instanceof ConflictException) {
        const raced = await this.prisma.purchasePlan.findFirst({ where: { bomId, deletedAt: null }, select: { id: true, planNo: true } });
        if (raced) return raced;
      }
      throw error;
    }
  }

  /**
   * 退回时用的 BOM 读取：**不看软删、不看销售单状态**。
   *
   * 与 `loadBom`（新建计划用）的差别是有理由的：那张采购单已经存在，它的 `bom_id` 一定指向
   * 一行真实存在的 BOM（外键保证），而那张 BOM 可能后来被软删、销售单也可能已经关闭。
   * 这些都**不该**把"退回"这条唯一的出路堵死 —— 计划表的外键只需要那行还在，软删的行也在。
   * BOM 行已经全被软删时，补建出来的计划是空的，退回的明细会以镜像行的形式落进去，正好。
   */
  private async loadBomForRevert(bomId: string) {
    const bom = await this.prisma.bom.findFirst({ where: { id: bomId } });
    if (!bom) throw new NotFoundException({ code: "BOM_NOT_FOUND", message: "BOM 不存在（采购单引用的 BOM 已不在库里）", details: [] });
    return bom;
  }

  /**
   * 退回采购计划（口径 15 ③，替换已删除的 `revertToDraft`）。
   *
   * 什么时候用：供应商说做不了、价格谈崩了、下错了 —— 这张单还没发出有效到货事实。
   *
   * 为什么是"可逆"的：**不删任何数据**。计划行保留原来的数量、单价、供应商，
   * 只是把「已下单」这个链接断开，行回到未下单，采购员改完可以重新收束。
   * 那张采购单记 `cancelled` 且不进列表，审计里留痕（谁、何时、什么原因）。
   *
   * 历史单（2026-09-27 之前建的、没有计划行链接）也不丢：把它的明细**镜像成新的计划行**，
   * 数量/单价/供应商/预计到货/BOM 外原因全部照搬。
   */
  async revertPurchaseOrder(purchaseOrderId: string, reason: string, user: CurrentUser) {
    if (!reason?.trim()) throw new UnprocessableEntityException({ code: "CORRECTION_REASON_REQUIRED", message: "退回采购计划必须填写原因", details: [] });
    const order = await this.prisma.purchaseOrder.findFirst({
      where: { id: purchaseOrderId, deletedAt: null },
      include: { items: { where: { deletedAt: null }, include: { receipts: { where: { deletedAt: null }, select: { id: true } } } } },
    });
    if (!order) throw new NotFoundException({ code: "PURCHASE_ORDER_NOT_FOUND", message: "采购单不存在", details: [] });
    // 与既有 `revertToDraft` 完全同一条不变式（错误码也沿用）：只有"已下单且没有任何到货事实"能退。
    // 已有到货的单要改，走质检/退货那条线 —— 到货是既成事实，退回计划会与它打架。
    if (order.status !== "ordered" || order.items.some((item) => item.receipts.length)) {
      throw new UnprocessableEntityException({ code: "PURCHASE_ORDER_NOT_REVERTIBLE", message: "仅无到货事实的已下单采购单可以退回采购计划", details: [{ status: order.status }] });
    }
    if (!order.bomId) throw new UnprocessableEntityException({ code: "PURCHASE_ORDER_WITHOUT_BOM_NOT_REVERTIBLE", message: "这张采购单没有 BOM 表，没有可退回的采购计划", details: [] });
    const plan = await this.ensurePlanForBom(order.bomId, user);
    const itemIds = order.items.map((item) => item.id);
    const linked = itemIds.length ? await this.prisma.purchasePlanItem.findMany({ where: { purchaseOrderItemId: { in: itemIds }, deletedAt: null }, select: { id: true, purchaseOrderItemId: true } }) : [];
    const linkedIds = new Set(linked.map((row) => row.purchaseOrderItemId));
    const orphanItems = order.items.filter((item) => !linkedIds.has(item.id));
    await this.prisma.$transaction(async (tx) => {
      if (linked.length) await tx.purchasePlanItem.updateMany({ where: { id: { in: linked.map((row) => row.id) } }, data: { purchaseOrderItemId: null, ...this.audit.update(user) } });
      if (orphanItems.length) {
        // 历史单：没有计划行认领这些明细，按原值补成计划行（数量/单价/供应商照搬，不重录）。
        await tx.purchasePlanItem.createMany({
          data: orphanItems.map((item, index) => ({
            planId: plan.id,
            materialId: item.materialId,
            materialSnapshot: item.materialSnapshot as Prisma.InputJsonValue,
            unitId: item.unitId,
            unitSnapshot: item.unitSnapshot as Prisma.InputJsonValue,
            bomItemId: item.bomItemId,
            supplierId: item.supplierId,
            supplierSnapshot: (item.supplierSnapshot ?? Prisma.DbNull) as Prisma.InputJsonValue | typeof Prisma.DbNull,
            model: item.model,
            quantity: item.quantity.toFixed(4),
            unitPrice: item.unitPrice.toFixed(4),
            // 镜像回来的行沿用**那张单**的币种：钱是那张单谈的，数量/单价都照搬了，币种也一样。
            currency: order.currency,
            expectedDate: item.expectedDate,
            sequence: linked.length + index + 1,
            extensionData: { ...((item.extensionData ?? {}) as Record<string, unknown>), restored_from_reverted_order: order.purchaseOrderNo },
            ...this.audit.create(user),
          })),
        });
      }
      await tx.purchaseOrderItem.updateMany({ where: { purchaseOrderId: order.id, deletedAt: null }, data: { ...this.audit.softDelete(user) } });
      await tx.purchaseOrder.update({ where: { id: order.id }, data: { status: "cancelled", ...this.audit.update(user) } });
    });
    await this.audit.record("purchase_order.revert_to_plan", "purchase_order", user.id, order.id, {
      order_no: order.orderNo,
      purchase_order_no: order.purchaseOrderNo,
      plan_id: plan.id,
      plan_no: plan.planNo,
      reason: reason.trim(),
      returned_line_count: linked.length,
      restored_line_count: orphanItems.length,
    });
    return { purchaseOrderId: order.id, purchaseOrderNo: order.purchaseOrderNo, planId: plan.id, planNo: plan.planNo, returnedLineCount: linked.length, restoredLineCount: orphanItems.length };
  }

  /**
   * 计划详情。
   *
   * 供应商的**地址与联系人实时联查主数据**（口径 4）：它们是主数据的事实、不是采购员的决策，
   * 计划里只读。要冻结的那一份在下单时写进采购单的 `supplier_snapshot`。
   */
  async get(id: string) {
    const plan = await this.prisma.purchasePlan.findFirst({
      where: { id, deletedAt: null },
      include: {
        salesOrder: { select: { orderNo: true, itemNo: true, customerSnapshot: true, deliveryDate: true, status: true, deletedAt: true } },
        bom: { select: { id: true, version: true, status: true, deletedAt: true } },
        items: {
          where: { deletedAt: null },
          orderBy: [{ sequence: "asc" }, { createdAt: "asc" }],
          include: {
            material: { select: { id: true, materialCode: true, name: true, specificationModel: true, color: true } },
            unit: { select: { id: true, name: true } },
            supplier: { select: { id: true, supplierCode: true, name: true, contactName: true, phone: true, address: true, isActive: true } },
            purchaseOrderItem: { select: { id: true, purchaseOrderId: true, purchaseOrder: { select: { purchaseOrderNo: true, status: true } } } },
          },
        },
      },
    });
    if (!plan) throw new NotFoundException({ code: "PURCHASE_PLAN_NOT_FOUND", message: "采购计划不存在", details: [] });
    // 口径 12 的提示：BOM 后来新增了物料就标出来，但**不自动插行**（计划可能已经部分下单，
    // 系统自动把"已下单"的行改成别的物料 = 数据损坏）。按**物料**比，不按 BOM 行 ID ——
    // `BomsService.replaceItems` 存一次 BOM 就会把全部行 ID 换掉。
    //
    // 同一次查询顺带把 BOM 行的**参考单价**读回来（2026-10-08 第二轮，用户：「为什么BOM表保存了单价之后，
    // 采购计划显示不了单价，下单不了」）：计划是**建立时的快照**，BOM 之后填的价不会回头进已有计划，
    // 于是"先有计划、后填价"的人永远卡在 0 价不能下单。这里把**当前 BOM 的参考单价**随行下发（只读），
    // 由前端对「未下单 + 单价还是 0」的行做预填 —— 计划行单价仍是唯一真源，落库只在用户保存计划时发生。
    // 已下单的行不下发预填意图（前端也会跳过：那些行在服务端被硬锁）。
    const bomItems = plan.bom && !plan.bom.deletedAt
      ? await this.prisma.bomItem.findMany({ where: { bomId: plan.bomId, deletedAt: null }, select: { materialId: true, referenceUnitPrice: true, referenceCurrency: true } })
      : [];
    // 同一物料在 BOM 上出现多次时取**第一个有参考价**的那一行（BOM 允许同一物料多行，价通常一致）。
    const referenceByMaterial = new Map<string, { unitPrice: string; currency: string }>();
    for (const row of bomItems) {
      if (!row.referenceUnitPrice || !row.referenceUnitPrice.gt(0) || referenceByMaterial.has(row.materialId)) continue;
      referenceByMaterial.set(row.materialId, { unitPrice: row.referenceUnitPrice.toFixed(4), currency: row.referenceCurrency || DEFAULT_PLAN_CURRENCY });
    }
    /**
     * 这份计划下**还能并入**的采购单（2026-10-13 口径 6）—— 前端收束预览按它把
     * 「这一组会并到哪张单 / 会新建一张」写出来。
     *
     * 与下单时的 `findMergeTarget()` **共用同一段查询**（`queryLinkedOpenOrders`），
     * 所以"预览说能并、下单却被拒"这种漂移在结构上不可能发生。
     */
    const linkedOrderItemIds = plan.items.flatMap((item) => (item.purchaseOrderItemId ? [item.purchaseOrderItemId] : []));
    const openPurchaseOrders = linkedOrderItemIds.length ? await this.orders.openOrdersForPlan({ orderNo: plan.orderNo, bomId: plan.bomId, linkedOrderItemIds }) : [];
    return {
      ...this.summaryOf(plan as unknown as PlanSummarySource),
      deliveryDate: plan.salesOrder?.deliveryDate ?? null,
      orphaned: Boolean(plan.salesOrder?.deletedAt),
      bomDeleted: Boolean(plan.bom?.deletedAt),
      bomExtraMaterialCount: countBomMaterialsMissingFromPlan(bomItems.map((row) => row.materialId), plan.items.map((row) => row.materialId)),
      /** 可并入的采购单一览（口径 6）：`{id, purchaseOrderNo, supplierId, currency, itemCount, totalAmount}`。 */
      openPurchaseOrders,
      items: plan.items.map((item) => ({
        id: item.id,
        materialId: item.materialId,
        materialSnapshot: item.materialSnapshot,
        materialCode: item.material?.materialCode ?? snapshotField(item.materialSnapshot, "materialCode"),
        materialName: item.material?.name ?? snapshotName(item.materialSnapshot) ?? "",
        model: item.model ?? item.material?.specificationModel ?? null,
        unitId: item.unitId,
        unitName: item.unit?.name ?? snapshotName(item.unitSnapshot),
        quantity: item.quantity.toFixed(4),
        unitPrice: item.unitPrice.toFixed(4),
        /** 行总价 = 数量 × 单价（**派生**，与列表的合计同一个函数）—— 财务看的就是这个数。 */
        amount: planLineAmount(item.quantity, item.unitPrice).toFixed(4),
        /** 币种在下单时按供应商组写回，见模型注释；未下单的行是默认人民币。 */
        currency: item.currency ?? DEFAULT_PLAN_CURRENCY,
        /** BOM 表上这个物料的参考单价（只读；单价为 0 的未下单行用它预填，见上面注释）。 */
        bomReferenceUnitPrice: referenceByMaterial.get(item.materialId)?.unitPrice ?? null,
        bomReferenceCurrency: referenceByMaterial.get(item.materialId)?.currency ?? null,
        bomItemId: item.bomItemId,
        supplierId: item.supplierId,
        // 供应商停用/软删之后仍要用快照显示"当时记的是哪一家"：否则这一格看起来是空的，
        // 一保存就把记录抹掉了（BOM 明细行上已经踩过同一个坑）。
        supplierName: item.supplier?.name ?? snapshotName(item.supplierSnapshot),
        supplierCode: item.supplier?.supplierCode ?? snapshotField(item.supplierSnapshot, "supplierCode"),
        supplierAddress: item.supplier?.address ?? null,
        supplierContact: contactLine(item.supplier),
        supplierActive: item.supplier ? item.supplier.isActive : null,
        expectedDate: item.expectedDate,
        purchaseOrderItemId: item.purchaseOrderItemId,
        purchaseOrderNo: item.purchaseOrderItem?.purchaseOrder?.purchaseOrderNo ?? null,
        purchaseOrderStatus: item.purchaseOrderItem?.purchaseOrder?.status ?? null,
        extensionData: item.extensionData,
      })),
    };
  }

  /**
   * 保存计划：**整体替换行**（未下单的老行软删 + 重建），但**已下单的行原样不动**。
   *
   * 为什么已下单的行不能跟着替换：它对应的采购单已经发给供应商了。计划里把它删掉或改成别的物料，
   * 系统里就出现了"这张单的明细在计划里查不到"的状态，而「这张 BOM 还差什么没买」立刻失真 ——
   * 那正是计划存在的意义。要改就**先「退回采购计划」**（退回会把链接断开、行回到未下单，
   * 数量/单价/供应商都还在，不用重录）。
   *
   * `sequence`（序号）是展示，不是业务内容，所以已下单行允许被重排。
   *
   * 并发用乐观锁：`expected_updated_at` 与库里的 `updatedAt` 不一致就 422 拒绝，
   * 而不是把对方刚保存的东西覆盖掉（口径与 `BomsService` 一致，错误码同名风格）。
   */
  async update(id: string, input: PlanInput, user: CurrentUser) {
    const current = await this.loadForWrite(id);
    const incoming = input.items ?? [];
    const ordered = current.items.filter((item) => item.purchaseOrderItemId);
    const orderedIds = new Set(ordered.map((item) => item.id));
    const incomingById = new Map(incoming.flatMap((item) => (item.id ? [[item.id, item] as const] : [])));
    /** 这一次要补价的行（已下单 + 库里单价 0 + 这次填了正数）：见 `pendingPriceOf`。 */
    const priceRefills = new Map<string, Prisma.Decimal>();
    ordered.forEach((item, index) => {
      const next = incomingById.get(item.id);
      if (!next) {
        throw new UnprocessableEntityException({
          code: "PURCHASE_PLAN_ORDERED_LINE_REMOVED",
          message: `第 ${index + 1} 行已经下过单，不能从计划里移除；要改先「退回采购计划」`,
          details: [{ plan_item_id: item.id, purchase_order_item_id: item.purchaseOrderItemId }],
        });
      }
      const refillPrice = this.pendingPriceOf(item, next);
      if (refillPrice) priceRefills.set(item.id, refillPrice);
      const changed = this.orderedLineChanged(item, next, { allowPrice: refillPrice !== null });
      if (changed) {
        throw new UnprocessableEntityException({
          code: "PURCHASE_PLAN_ORDERED_LINE_LOCKED",
          message: `第 ${index + 1} 行的${changed}已经下过单，不能在计划里改；要改先「退回采购计划」`,
          details: [{ plan_item_id: item.id, field: changed, purchase_order_item_id: item.purchaseOrderItemId }],
        });
      }
    });
    // 未下单的行随便改：它们还只是"打算买什么"。
    // 币种由**库里那一行**带过来（客户端根本不传这个字段：`PlanItemDto` 里没有它）——
    // 行是整体替换的（软删 + 重建），不带过来，"保存一次计划"就会把一行退回计划后
    // 留下的美元静默重置成人民币，而这行人的钱本来是谈好的。
    const currencyById = new Map(current.items.map((item) => [item.id, item.currency]));
    const replacement = incoming.filter((item) => !(item.id && orderedIds.has(item.id)));
    const prepared = await this.prepareItems({ id: current.bomId }, replacement, user, currencyById);
    const orderedById = new Map(ordered.map((item) => [item.id, item]));
    let syncedArrivalDates = 0;
    /** 补价写进采购明细的行（事务后写审计；顺带把"补的是哪张单的哪一行"留下来）。 */
    const refilledPrices: Array<{ plan_item_id: string; purchase_order_item_id: string; purchase_order_no: string | null; unit_price: string; amount: string }> = [];
    await this.prisma.$transaction(async (tx) => {
      await this.assertNotStale(tx, id, input.expected_updated_at);
      await tx.purchasePlanItem.updateMany({ where: { planId: id, deletedAt: null, purchaseOrderItemId: null }, data: { ...this.audit.softDelete(user) } });
      let preparedCursor = 0;
      for (const [index, item] of incoming.entries()) {
        const existing = item.id ? orderedById.get(item.id) : undefined;
        if (existing) {
          const nextDate = this.parseDate(item.expected_date);
          const dateChanged = !this.sameDate(existing.expectedDate, nextDate);
          const refillPrice = priceRefills.get(existing.id);
          // 补价先校验、后写入：「校验在写之前」是仓库里反复强调的一条（假 Prisma 的事务不回滚，
          // 顺序错了连测试都会给出错误的安全感）。两道校验：
          //   ① 明细还在（采购单被退回过又会重建，ID 可能已经过期）；
          //   ② 这一行**没有到货事实** —— 有到货就说明钱已经按当时的单价走过账了。
          let poItem: { id: string; quantity: Prisma.Decimal; extraFee: Prisma.Decimal | null; purchaseOrderId: string; purchaseOrder: { purchaseOrderNo: string } | null } | null = null;
          if (refillPrice && existing.purchaseOrderItemId) {
            poItem = await tx.purchaseOrderItem.findUnique({ where: { id: existing.purchaseOrderItemId }, select: { id: true, quantity: true, extraFee: true, purchaseOrderId: true, purchaseOrder: { select: { purchaseOrderNo: true } } } });
            if (!poItem) throw new UnprocessableEntityException({ code: "PURCHASE_ORDER_ITEM_NOT_FOUND", message: `第 ${index + 1} 行对应的采购明细已经不存在了，不能补价`, details: [{ plan_item_id: existing.id, purchase_order_item_id: existing.purchaseOrderItemId }] });
            // 已经有到货事实的行不许补价：那条链上的钱（应付 = 入库量 × 单价）早就按 0 记过账了，
            // 事后改单价只会让"账实不符"，正确动作是走财务侧的应付调整。
            const receipts = await tx.purchaseReceipt.count({ where: { purchaseOrderItemId: poItem.id, deletedAt: null } });
            if (receipts > 0) throw new UnprocessableEntityException({ code: "PURCHASE_ORDER_ITEM_PRICE_LOCKED", message: `第 ${index + 1} 行已经有到货记录，不能再从计划里补单价；请走财务的应付调整`, details: [{ plan_item_id: existing.id, purchase_order_item_id: poItem.id }] });
          }
          await tx.purchasePlanItem.update({ where: { id: existing.id }, data: { sequence: index + 1, ...(dateChanged ? { expectedDate: nextDate } : {}), ...(refillPrice ? { unitPrice: refillPrice.toFixed(4) } : {}), ...this.audit.update(user) } });
          // 预计到货改了就同步进那张已下单的采购明细：否则同一行会有两个"预计到货"，
          // 而采购员拿去跟供应商对的是采购单上那一份。
          if (dateChanged && existing.purchaseOrderItemId) {
            await tx.purchaseOrderItem.update({ where: { id: existing.purchaseOrderItemId }, data: { expectedDate: nextDate, ...this.audit.update(user) } });
            syncedArrivalDates += 1;
          }
          // 补价（价格待定 → 有价）：计划行、采购明细、单头合计三处一起改，一次事务里要么全成要么全不成。
          if (refillPrice && poItem) {
            const amount = new Prisma.Decimal(poItem.quantity).mul(refillPrice).plus(new Prisma.Decimal(poItem.extraFee ?? 0));
            await tx.purchaseOrderItem.update({ where: { id: poItem.id }, data: { unitPrice: refillPrice.toFixed(4), amount: amount.toFixed(4), ...this.audit.update(user) } });
            // 单头合计 = Σ 未删明细的 amount（与建单时同一个口径：`prepare()` 的 total）。
            const siblings = await tx.purchaseOrderItem.findMany({ where: { purchaseOrderId: poItem.purchaseOrderId, deletedAt: null }, select: { amount: true } });
            const total = siblings.reduce((sum, row) => sum.plus(new Prisma.Decimal(row.amount ?? 0)), new Prisma.Decimal(0));
            await tx.purchaseOrder.update({ where: { id: poItem.purchaseOrderId }, data: { totalAmount: total.toFixed(4), ...this.audit.update(user) } });
            refilledPrices.push({ plan_item_id: existing.id, purchase_order_item_id: poItem.id, purchase_order_no: poItem.purchaseOrder?.purchaseOrderNo ?? null, unit_price: refillPrice.toFixed(4), amount: amount.toFixed(4) });
          }
          continue;
        }
        preparedCursor += 1;
        await tx.purchasePlanItem.create({ data: this.itemData(id, prepared[preparedCursor - 1], index + 1, user) });
      }
      await tx.purchasePlan.update({
        where: { id },
        data: { extensionData: (input.extension_data ?? current.extensionData ?? {}) as Prisma.InputJsonValue, ...this.audit.update(user) },
      });
    });
    await this.audit.record("purchase_plan.update", "purchase_plan", user.id, id, {
      plan_no: current.planNo,
      order_no: current.orderNo,
      item_count: incoming.length,
      ordered_line_count: ordered.length,
      synced_arrival_dates: syncedArrivalDates || undefined,
      // 补价要单独留一条：它改的是**已经发给供应商**的那张单上的钱，事后查"这张单的价是谁、什么时候补的"。
      refilled_prices: refilledPrices.length || undefined,
      reason: input.reason?.trim() || undefined,
    });
    for (const row of refilledPrices) {
      await this.audit.record("purchase_order_item.price_refilled", "purchase_order_item", user.id, row.purchase_order_item_id, {
        plan_id: id,
        plan_no: current.planNo,
        plan_item_id: row.plan_item_id,
        purchase_order_no: row.purchase_order_no,
        unit_price: row.unit_price,
        amount: row.amount,
      });
    }
    return this.get(id);
  }

  /**
   * 删除计划（软删）。
   *
   * 只要**有任何一行下过单**就不许删：那意味着这张 BOM 上已经有发给供应商的采购单，
   * 删掉计划等于把那条线的入口抹掉。要先「退回采购计划」把行收回来再删。
   *
   * BOM 被软删之后计划仍然独立存活（它是历史记录），所以这里不跟着 BOM 走。
   */
  async remove(id: string, user: CurrentUser) {
    const current = await this.loadForWrite(id);
    const ordered = current.items.filter((item) => item.purchaseOrderItemId);
    if (ordered.length) {
      throw new UnprocessableEntityException({
        code: "PURCHASE_PLAN_HAS_ORDERED_LINES",
        message: `这份计划有 ${ordered.length} 行已经下过单，不能删除；请先「退回采购计划」`,
        details: ordered.map((item) => ({ plan_item_id: item.id, purchase_order_item_id: item.purchaseOrderItemId })),
      });
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.purchasePlanItem.updateMany({ where: { planId: id, deletedAt: null }, data: { ...this.audit.softDelete(user) } });
      await tx.purchasePlan.update({ where: { id }, data: { ...this.audit.softDelete(user) } });
    });
    await this.audit.record("purchase_plan.delete", "purchase_plan", user.id, id, { plan_no: current.planNo, order_no: current.orderNo, item_count: current.items.length });
    return { id, planNo: current.planNo, deleted: true };
  }

  /**
   * 保存前读一遍计划现状（只取写路径用得上的列）。
   *
   * 与 `get()` 分开：写路径不需要供应商地址/联系人这些联查，而它要的是**可以比对的行形状**
   * （数量/单价是 Decimal，不是格式化过的字符串）。
   */
  private async loadForWrite(id: string) {
    const plan = await this.prisma.purchasePlan.findFirst({
      where: { id, deletedAt: null },
      select: {
        id: true,
        planNo: true,
        orderNo: true,
        bomId: true,
        extensionData: true,
        items: {
          where: { deletedAt: null },
          select: { id: true, materialId: true, unitId: true, supplierId: true, quantity: true, unitPrice: true, currency: true, model: true, expectedDate: true, purchaseOrderItemId: true, bomItemId: true, extensionData: true },
        },
      },
    });
    if (!plan) throw new NotFoundException({ code: "PURCHASE_PLAN_NOT_FOUND", message: "采购计划不存在", details: [] });
    return plan;
  }

  /**
   * 乐观锁：行锁保证两个并发保存在数据库里排成先后，后到者读到的必然是对方写完之后的值，
   * 于是必然冲突并被拒绝 —— 而不是把对方的修改覆盖掉。不传令牌时跳过比对。
   */
  private async assertNotStale(tx: Prisma.TransactionClient, id: string, expectedUpdatedAt: string | undefined) {
    const expected = expectedUpdatedAt?.trim();
    if (!expected) return;
    await tx.$queryRaw`SELECT id FROM purchase_plans WHERE id = ${id}::uuid FOR UPDATE`;
    const fresh = await tx.purchasePlan.findFirst({ where: { id, deletedAt: null }, select: { updatedAt: true } });
    if (!fresh) throw new NotFoundException({ code: "PURCHASE_PLAN_NOT_FOUND", message: "采购计划不存在", details: [] });
    if (new Date(expected).getTime() !== fresh.updatedAt.getTime()) {
      throw new UnprocessableEntityException({
        code: "PURCHASE_PLAN_UPDATE_CONFLICT",
        message: "这份采购计划已被他人修改，本次保存没有写入；请重新加载最新版本后再改一次",
        details: [{ expected_updated_at: expected, actual_updated_at: fresh.updatedAt.toISOString() }],
      });
    }
  }

  /**
   * 已下单的行能不能被这次提交改动？返回被改的字段名（没改则返回 null）。
   *
   * `expectedDate` **不在这里**：预计到货是「预期」而不是「既成事实」，供应商说这周到不了、
   * 下周到，采购员必须能记下来。锁死它等于系统里再没有任何地方能改这个日期
   * （口径 7 已经把采购单页的明细编辑关掉了）。改它时**同步进采购明细**，保证只有一份值。
   *
   * `options.allowPrice`（2026-10-09）：**这一行是"价格待定"下的单**（已下单时单价是 0），
   * 这时允许填上一次价 —— 辅料要等客户确认资料才有价，采购员先把单占下来、价出来再补。
   * 补价之外的一切改动照旧锁死；补过价之后 `item.unitPrice` 已经 > 0，这条路自然关闭。
   */
  private orderedLineChanged(item: WritablePlanItem, next: PlanItemInput, options: { allowPrice?: boolean } = {}): string | null {
    if (next.material_id !== item.materialId) return "物料";
    if (next.unit_id !== item.unitId) return "单位";
    if ((item.supplierId ?? null) !== (next.supplier_id ?? null)) return "供应商";
    if ((item.model ?? null) !== (next.model ?? null)) return "型号";
    if (!this.decimalEquals(item.quantity, next.quantity)) return "数量";
    if (!options.allowPrice && !this.decimalEquals(item.unitPrice, next.unit_price)) return "单价";
    return null;
  }

  /**
   * 「补价」判定：这一行**已下单**、库里单价还是 0（= 价格待定下单）、这次填了 > 0 的价。
   *
   * 返回要补的那个价；不是补价就返回 null（那就按"已下单行锁死"处理）。
   * 只认"0 → 正数"：0 → 0 算没改（`orderedLineChanged` 自己会放过），
   * 0 → 负数、有价 → 任何值都不放行（要改先「退回采购计划」）。
   */
  private pendingPriceOf(item: WritablePlanItem, next: PlanItemInput): Prisma.Decimal | null {
    if (item.unitPrice.gt(0)) return null;
    try {
      const price = new Prisma.Decimal(next.unit_price);
      return price.gt(0) ? price : null;
    } catch {
      return null;
    }
  }

  /**
   * 把一个 `bom_item_id` 归到**当前** BOM 的行 ID 上。
   *
   * `BomsService.replaceItems` 存一次 BOM 就会换掉**全部**行 ID，而计划（与草稿不同）是长期存在的，
   * 所以它必然持有"当前 BOM 里已经不存在"的 ID。规则：给定的 ID 还在就用它（物料对不上由调用方判错），
   * 不在就**按物料找回**当前 BOM 的对应行；找不回（物料已不在 BOM 里）返回 null，当作 BOM 外的行处理。
   */
  private resolveBomItemId(bomItemId: string | null, materialId: string, bomItems: Array<{ id: string; materialId: string }>): string | null {
    if (bomItemId && bomItems.some((row) => row.id === bomItemId)) return bomItemId;
    return bomItems.find((row) => row.materialId === materialId)?.id ?? null;
  }

  /** 两个日期是不是同一时刻（都为 null 也算相同）。 */  private sameDate(current: Date | null, next: Date | null) {
    if (current === null && next === null) return true;
    if (current === null || next === null) return false;
    return current.getTime() === next.getTime();
  }

  /** Decimal 比较：非法输入一律判成"改了"（宁可让用户重新加载，也不能静默放过一次改动）。 */
  private decimalEquals(current: Prisma.Decimal, value: string) {
    try {
      return new Prisma.Decimal(value).equals(current);
    } catch {
      return false;
    }
  }

  /**
   * 收束下单（口径 6 + 口径 10 + 2026-10-13 的自动收束）。
   *
   * 勾选的行按**供应商**分组（复用采购单既有的 `collectGroups()`：一个供应商一张单的不变式、
   * 下单前校验、金额与快照全部沿用，不另写一套建单逻辑）；**没勾的行留在计划里**，下次再下。
   *
   * 每一组的落点有两种（2026-10-13，用户：「如果相同的供应商的不同物料没有同时下单，
   * 下单之后也要自动收束在一个采购单里」）：
   *   · 这家在同一份计划下**已经有**一张「已下单 + 无任何到货 + 同币种」的单 → **追加**进去
   *     （`orders.findMergeTarget()` / `orders.appendItems()`，单号不变、已有行不动）；
   *   · 否则**新建**一张（判据见设计文档 §2.1、§2.2）。
   * 于是"辅料等客户资料才有价 → 后面再下一波"不会再给同一家生出第二张单，
   * 而 2026-09-17 那条「一个采购单内，一个供应商下一个单」在跨波次时也成立。
   *
   * 三件事必须**在同一个事务里**：建单/追单、回写计划行的 1:1 链接、计划头的时间戳。
   * 分成两次事务的话，中途失败会留下「采购单已经建好、计划还显示未下单」的中间态 ——
   * 那正是重复采购的入口。
   *
   * 认领关系**不靠 Prisma 嵌套 create 的返回顺序**：下单时把计划行 ID 写进采购明细的
   * `extension_data.purchase_plan_item_id`，落库后按这个标记回写（顺带留下了
   * "这条采购明细来自哪一行计划"的可追溯性）。
   */
  async order(id: string, input: PlanOrderInput, user: CurrentUser) {
    const current = await this.loadForWrite(id);
    const groups = input.groups ?? [];
    if (!groups.length) throw new UnprocessableEntityException({ code: "PURCHASE_PLAN_ORDER_GROUPS_REQUIRED", message: "请至少勾选一行并按供应商分组后再下单", details: [] });
    const bomItems = await this.prisma.bomItem.findMany({ where: { bomId: current.bomId, deletedAt: null }, select: { id: true, materialId: true } });
    const lineById = new Map(current.items.map((item) => [item.id, item]));
    /** 报错要说"第几行"：这是给采购员看的，不是给调用方解析的。 */
    const rowNoOf = (lineId: string) => current.items.findIndex((item) => item.id === lineId) + 1;
    const claimed = new Set<string>();
    const splitGroups: SplitGroup[] = [];
    for (const [index, group] of groups.entries()) {
      if (!group.supplier_id) throw new UnprocessableEntityException({ code: "PURCHASE_PLAN_ORDER_SUPPLIER_REQUIRED", message: `第 ${index + 1} 组还没选供应商，不能下单`, details: [] });
      const ids = group.items ?? [];
      if (!ids.length) throw new UnprocessableEntityException({ code: "PURCHASE_PLAN_ORDER_ITEMS_REQUIRED", message: `第 ${index + 1} 组没有计划行`, details: [] });
      const items: PurchaseOrderItemInput[] = [];
      for (const lineId of ids) {
        const line = lineById.get(lineId);
        if (!line) throw new UnprocessableEntityException({ code: "PURCHASE_PLAN_ORDER_LINE_INVALID", message: "有采购行不属于这份计划", details: [{ plan_item_id: lineId }] });
        if (line.purchaseOrderItemId) throw new UnprocessableEntityException({ code: "PURCHASE_PLAN_ORDER_LINE_ALREADY_ORDERED", message: "有采购行已经下过单了，刷新后再试", details: [{ plan_item_id: lineId, purchase_order_item_id: line.purchaseOrderItemId }] });
        if (claimed.has(lineId)) throw new UnprocessableEntityException({ code: "PURCHASE_PLAN_ORDER_LINE_DUPLICATE", message: "同一行被分到了多个供应商组", details: [{ plan_item_id: lineId }] });
        claimed.add(lineId);
        // 单价必须大于 0（用户 2026-09-30：「添加价格字段…不然财务没法付钱」）。
        //
        // 这条门禁掐的是一条真的能走通的链：从 BOM 新建的计划行单价固定是 0，而原来只校验
        // 「不为负」，于是 0 单价可以一路下单成 0 元采购单、到货入库后变成一条 **0 元应付** ——
        // 财务确实没法付钱，而系统里没有任何一处会报错。钱的根就在这一格（应付金额 =
        // 入库数量 × 这里的单价，见 raw-material-inbounds.service.ts）。
        // 草稿不受影响：计划里单价可以先留 0（还没谈价），不能做的是**带着 0 单价下单**。
        //
        // 2026-10-11 用户重新拍板：「确定单价的能下单，没确定单价的先不下单」——
        // 所以这里**没有例外分支**了（2026-10-09 曾有过一个 `allow_pending_price` 放行开关，
        // 已删）。0 价的行由前端排除在本次下单之外、留在计划里；万一有请求硬把 0 价行塞进来，
        // 就在这一格被拦住而不是变成一张 0 元采购单。
        if (!line.unitPrice.gt(0)) {
          throw new UnprocessableEntityException({
            code: "PURCHASE_PLAN_PRICE_REQUIRED",
            message: `第 ${rowNoOf(lineId)} 行还没填单价，不能下单：应付金额就是按这一行的「数量 × 单价」算出来的。这一行会留在计划里，补上单价后再下一波。`,
            details: [{ plan_item_id: lineId, row_no: rowNoOf(lineId) }],
          });
        }
        const bomItemId = this.resolveBomItemId(line.bomItemId, line.materialId, bomItems);
        const reason = (line.extensionData as { outside_bom_reason?: unknown } | null)?.outside_bom_reason;
        if (!bomItemId && !(typeof reason === "string" && reason.trim())) {
          throw new UnprocessableEntityException({ code: "PURCHASE_OUTSIDE_BOM_REASON_REQUIRED", message: "这行的物料已经不在 BOM 表里了，请先在计划里填写「BOM 外新增原因」再下单", details: [{ plan_item_id: lineId }] });
        }
        items.push({
          material_id: line.materialId,
          unit_id: line.unitId,
          bom_item_id: bomItemId ?? undefined,
          supplier_id: group.supplier_id,
          expected_date: line.expectedDate ? line.expectedDate.toISOString() : undefined,
          model: line.model ?? undefined,
          quantity: line.quantity.toFixed(4),
          unit_price: line.unitPrice.toFixed(4),
          extension_data: { ...((line.extensionData ?? {}) as Record<string, unknown>), purchase_plan_item_id: line.id, purchase_plan_no: current.planNo },
        });
      }
      splitGroups.push({ supplier_id: group.supplier_id, currency: group.currency, expected_date: group.expected_date, remark: group.remark, items });
    }
    const splitInput: SplitInput = {
      order_no: current.orderNo,
      bom_id: current.bomId,
      purchase_date: input.purchase_date,
      remark: input.remark,
      place_order: true,
      extension_data: { ...(input.extension_data ?? {}), purchase_plan: { plan_id: id, plan_no: current.planNo } },
      groups: splitGroups,
    };
    // 校验与收束在用事务之前完成：失败时一个字都没写。
    const merged = await this.orders.collectGroups(splitInput, true);
    /**
     * 这份计划**已经下过单**的行指向的采购明细 id —— 「并入哪张单」的认据（口径 1 ①）。
     *
     * 按链接认、**不按供应商猜**：按供应商猜会把别人手工建的同供应商单吞进来，
     * 而那类错误不会当场报错，只会让两张不相干的采购单悄悄长在一起。
     */
    const linkedOrderItemIds = current.items.flatMap((item) => (item.purchaseOrderItemId ? [item.purchaseOrderItemId] : []));
    const written = await this.prisma.$transaction(async (tx) => {
      const rows: Array<{
        order: { id: string; purchaseOrderNo: string; currency: string; totalAmount: Prisma.Decimal };
        /** 这一波在这一组上新建的采购明细（并入的那张单上**原有**的明细不在里面）。 */
        items: Array<{ id: string; extensionData: unknown; currency: string }>;
        merged: boolean;
      }> = [];
      for (const entry of merged) {
        const supplierId = entry.input.supplier_id;
        const currency = entry.input.currency ?? DEFAULT_PLAN_CURRENCY;
        const target = supplierId
          ? await this.orders.findMergeTarget(tx, { orderNo: current.orderNo, bomId: current.bomId, supplierId, currency, linkedOrderItemIds })
          : null;
        if (target) {
          const appended = await this.orders.appendItems(tx, target.id, entry, user);
          rows.push({
            order: appended.order,
            items: appended.items.map((item) => ({ id: item.id, extensionData: item.extensionData, currency: appended.order.currency })),
            merged: true,
          });
          continue;
        }
        const [createdOrder] = await this.orders.createOrdersFromGroups(tx, [entry], "ordered", user);
        const items = await tx.purchaseOrderItem.findMany({ where: { purchaseOrderId: createdOrder.id, deletedAt: null }, select: { id: true, extensionData: true } });
        rows.push({ order: createdOrder, items: items.map((item) => ({ id: item.id, extensionData: item.extensionData, currency: createdOrder.currency })), merged: false });
      }
      /**
       * 回写链接**只认这一波新建的明细**。
       *
       * 并入的那张单上**原有**的明细带着上一波写进去的同一个认领标记；不过滤就会把那些计划行的
       * `updatedBy/updatedAt` 再刷一遍 —— 不算错，但会让列表的「最后更新（人 + 北京时间）」
       * 说成这次下单的人，而那个人根本没碰那些行。
       */
      for (const row of rows) {
        for (const item of row.items) {
          const planItemId = (item.extensionData as { purchase_plan_item_id?: string } | null)?.purchase_plan_item_id;
          if (!planItemId) continue;
          // 币种**写回**这一行：不是两次输入，是把"这张单谈的是什么钱"记到计划行上。
          // 写回之后，已下单行的币种永远等于那张采购单的币种，计划合计（按币种分列）才不会说谎。
          await tx.purchasePlanItem.update({ where: { id: planItemId }, data: { purchaseOrderItemId: item.id, currency: item.currency, ...this.audit.update(user) } });
        }
      }
      return rows;
    });
    const mergedRows = written.filter((row) => row.merged);
    await this.audit.record("purchase_plan.order", "purchase_plan", user.id, id, {
      plan_no: current.planNo,
      order_no: current.orderNo,
      ordered_line_count: claimed.size,
      remaining_line_count: current.items.length - claimed.size,
      group_count: written.length,
      purchase_order_nos: written.map((row) => row.order.purchaseOrderNo),
      /**
       * 口径 4：并进了哪几张单、各追加了几行要留在审计里。采购单号没换，事后要解释
       * "这张单为什么比上周多了两行"只能靠这条记录。
       */
      merged_purchase_order_nos: mergedRows.map((row) => row.order.purchaseOrderNo),
      merged_line_count: mergedRows.reduce((sum, row) => sum + row.items.length, 0),
      // 没有「价格待定的行」这一档了（2026-10-11 起 0 价一律不下单）：留在计划里的行就是
      // `remaining_line_count`，它们没进任何采购单，所以也不需要额外的待补价清单。
    });
    for (const row of mergedRows) {
      await this.audit.record("purchase_order.append_plan_items", "purchase_order", user.id, row.order.id, {
        purchase_order_no: row.order.purchaseOrderNo,
        plan_id: id,
        plan_no: current.planNo,
        appended_line_count: row.items.length,
      });
    }
    const plan = await this.get(id);
    return {
      plan,
      orders: written.map((row) => ({
        id: row.order.id,
        purchaseOrderNo: row.order.purchaseOrderNo,
        currency: row.order.currency,
        totalAmount: row.order.totalAmount.toFixed(4),
        /** `true` = 这一组**并进了**已有采购单（不是新建）。前端按它把提示分成两半说。 */
        merged: row.merged,
        lineCount: row.items.length,
      })),
      mergedOrderCount: mergedRows.length,
    };
  }

  /**
   * 列表/详情共用的摘要：行数、未下单行数、派生状态、**金额合计**。
   *
   * 金额**按币种分列**返回（`金额不跨币种合计`）：计划里既有人民币行又有美元行时，
   * 调用方拼成 `CNY 12,345.60 · USD 2,000.00`，绝不加成一个数。
   * 「未下单金额」不是装饰：列表的「未下单 N」回答还有几行没买，金额那一栏回答还剩多少钱没买 ——
   * 采购员与财务问的是后一个问题（用户 2026-09-30：「不然财务没法付钱」）。
   *
   * `updatedByName` 由调用方补（列表要显示"最后更新（人 + 北京时间）"，而姓名要另查 `users`）。
   */
  private summaryOf(row: PlanSummarySource) {
    const lineCount = row.items.length;
    const unorderedCount = row.items.filter((item) => !item.purchaseOrderItemId).length;
    const status: PurchasePlanStatus = planStatusOf(lineCount, unorderedCount);
    return {
      id: row.id,
      planNo: row.planNo,
      orderNo: row.orderNo,
      itemNo: row.salesOrder?.itemNo ?? null,
      customerName: snapshotName(row.salesOrder?.customerSnapshot),
      bomId: row.bomId,
      bomVersion: row.bomVersion,
      lineCount,
      unorderedCount,
      orderedCount: lineCount - unorderedCount,
      status,
      statusLabel: PURCHASE_PLAN_STATUS_LABELS[status],
      /** 全部行的金额（含已下过单的）：这张 BOM 一共要花多少。 */
      amounts: sumPlanAmounts(row.items),
      /** 未下单行的金额：还要花多少。 */
      unorderedAmounts: sumPlanAmounts(row.items.filter((item) => !item.purchaseOrderItemId)),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      createdBy: row.createdBy,
      updatedBy: row.updatedBy,
    };
  }

  /** 计划只能建在**已确认销售单**的**未删 BOM** 上（与采购单建单的前置条件一致）。 */
  private async loadBom(bomId: string | undefined) {
    if (!bomId?.trim()) throw new UnprocessableEntityException({ code: "PURCHASE_PLAN_BOM_REQUIRED", message: "请选择 BOM 表", details: [] });
    const bom = await this.prisma.bom.findFirst({ where: { id: bomId, deletedAt: null, salesOrder: { status: "confirmed", deletedAt: null } } });
    if (!bom) throw new NotFoundException({ code: "BOM_NOT_FOUND", message: "BOM 不存在或所属销售单未确认", details: [] });
    return bom;
  }

  /**
   * 从 BOM 明细生成计划行（口径 2 + 口径 3 的预填供应商）。
   *
   * 单位解析沿用采购页的老口径：先按 `unit_id`，取不到再按单位名。**解析不到就整体拒绝**，
   * 不静默跳过那一行 —— 静默跳过的表现是"计划少了一个部件"，等发现时采购单已经发出去了。
   */
  private async itemsFromBom(bom: { id: string }): Promise<PreparedPlanItem[]> {
    const [rows, units] = await Promise.all([
      this.prisma.bomItem.findMany({
        where: { bomId: bom.id, deletedAt: null },
        orderBy: [{ sequence: "asc" }, { createdAt: "asc" }],
        include: { supplier: { select: { id: true, supplierCode: true, name: true, isActive: true, deletedAt: true } } },
      }),
      this.prisma.unit.findMany({ where: { isActive: true }, select: { id: true, name: true } }),
    ]);
    const unitById = new Map(units.map((unit) => [unit.id, unit]));
    const unitByName = new Map(units.map((unit) => [unit.name, unit]));
    const unresolved: string[] = [];
    const items: PreparedPlanItem[] = [];
    for (const row of rows) {
      const unit = (row.unitId ? unitById.get(row.unitId) : undefined) ?? unitByName.get(row.unit);
      if (!unit) {
        unresolved.push(row.materialName);
        continue;
      }
      // 只有**启用中**的供应商才预填：停用的供应商在下单时会被 `refs()` 拒掉，
      // 预填一格注定报错的值比留空更糟（用户会以为已经选好了）。
      const supplier = row.supplier && row.supplier.isActive && !row.supplier.deletedAt ? row.supplier : undefined;
      /**
       * 参考单价（2026-10-08，用户：「采购计划要下单需要填写单价，但是BOM表没办法填写单价」）。
       *
       * BOM 行上填过的价**预填**到计划行，采购员按实际报价改；没填（或填 0）时仍写 `"0"`
       * —— 0 价不能下单（口径 1.4），所以 0 与"没填"在这里等价，区别只在库里的 BOM 行上。
       * 币种跟着这一行的价一起带过来：不带的话，"计划合计按币种分列"会把美元价当成人民币。
       * 预填**不改变**任何既有校验与账务链路：计划行仍是唯一真源，成本/应付一律取采购单上的价。
       */
      const referencePrice = row.referenceUnitPrice && row.referenceUnitPrice.gt(0) ? row.referenceUnitPrice.toFixed(4) : "0";
      items.push({
        materialId: row.materialId,
        materialSnapshot: row.materialSnapshot as Prisma.InputJsonValue,
        unitId: unit.id,
        unitSnapshot: { id: unit.id, name: unit.name } as Prisma.InputJsonValue,
        bomItemId: row.id,
        supplierId: supplier?.id ?? null,
        supplierSnapshot: supplier ? ({ id: supplier.id, supplierCode: supplier.supplierCode, name: supplier.name } as Prisma.InputJsonValue) : Prisma.DbNull,
        model: row.model ?? row.specificationModel ?? null,
        quantity: row.requiredQuantity.toFixed(4),
        unitPrice: referencePrice,
        // 币种来自 BOM 行上那笔参考价；没有参考价时就是默认值（人民币）。
        currency: referencePrice === "0" ? DEFAULT_PLAN_CURRENCY : row.referenceCurrency || DEFAULT_PLAN_CURRENCY,
        expectedDate: null,
        extensionData: {},
      });
    }
    if (unresolved.length) throw new UnprocessableEntityException({ code: "PURCHASE_PLAN_UNIT_UNRESOLVED", message: `有 ${unresolved.length} 个 BOM 行找不到可用单位：${unresolved.slice(0, 5).join("、")}。请先在 BOM 表里补齐单位`, details: [{ materials: unresolved.slice(0, 20) }] });
    return items;
  }

  /** 前端传进来的行。校验口径与采购明细**完全一致**（否则会出现"计划里能存、下单时被拒"）。 */
  private async prepareItems(bom: { id: string }, items: PlanItemInput[], _user: CurrentUser, currencyById?: Map<string, string>): Promise<PreparedPlanItem[]> {
    const [materials, units, suppliers, bomItems] = await Promise.all([
      this.prisma.material.findMany({ where: { id: { in: items.map((item) => item.material_id) }, materialType: "raw_material", isActive: true, deletedAt: null }, select: { id: true, materialCode: true, name: true, specificationModel: true, color: true } }),
      this.prisma.unit.findMany({ where: { id: { in: items.map((item) => item.unit_id) }, isActive: true, deletedAt: null }, select: { id: true, name: true } }),
      this.prisma.supplier.findMany({ where: { id: { in: items.flatMap((item) => (item.supplier_id ? [item.supplier_id] : [])) }, isActive: true, deletedAt: null }, select: { id: true, supplierCode: true, name: true } }),
      this.prisma.bomItem.findMany({ where: { bomId: bom.id, deletedAt: null }, select: { id: true, materialId: true } }),
    ]);
    const materialMap = new Map(materials.map((row) => [row.id, row]));
    const unitMap = new Map(units.map((row) => [row.id, row]));
    const supplierMap = new Map(suppliers.map((row) => [row.id, row]));
    const bomItemMap = new Map(bomItems.map((row) => [row.id, row]));
    return items.map((item) => {
      const material = materialMap.get(item.material_id);
      const unit = unitMap.get(item.unit_id);
      if (!material || !unit) throw new NotFoundException({ code: "PURCHASE_PLAN_REFERENCE_NOT_FOUND", message: "物料或单位不存在或已停用", details: [] });
      if (!this.isPositive(item.quantity) || !this.isNonNegative(item.unit_price)) throw new UnprocessableEntityException({ code: "PURCHASE_PLAN_ITEM_INVALID", message: "计划行数量必须大于零、单价不能为负", details: [] });
      const supplier = item.supplier_id ? supplierMap.get(item.supplier_id) : undefined;
      if (item.supplier_id && !supplier) throw new NotFoundException({ code: "SUPPLIER_NOT_FOUND", message: "供应商不存在或已停用", details: [] });
      // BOM 行 ID 已经被替换过（`BomsService.replaceItems` 存一次 BOM 就软删全部旧行 + 建新行，
      // **所有行 ID 都会换掉**）：按**物料**找回当前 BOM 里的对应行。
      // 不做这一步的后果很重：BOM 改过一次之后，这份计划里所有行都带着"当前 BOM 里不存在"的行 ID，
      // 于是**计划再也保存不了**（`PURCHASE_BOM_ITEM_MISMATCH`），而计划是长期存在的，
      // 窗口比一次性的草稿大得多。按物料找回与 `bomItemOrderStatus` 的"换行 ID 就按物料摊回"同一口径。
      const bomItemId = this.resolveBomItemId(item.bom_item_id ?? null, item.material_id, bomItems);
      if (bomItemId && bomItemMap.get(bomItemId)?.materialId !== item.material_id) throw new UnprocessableEntityException({ code: "PURCHASE_BOM_ITEM_MISMATCH", message: "计划行必须引用当前 BOM 表中的对应物料", details: [] });
      // BOM 外的补料/替代料必须写原因 —— 与采购单 `refs()` 的同一条规则。
      // 放在计划这一侧校验，是为了让用户在**保存计划**时就看见，而不是等下单时才 422。
      const outsideReason = item.extension_data?.outside_bom_reason;
      if (!bomItemId && (typeof outsideReason !== "string" || !outsideReason.trim())) throw new UnprocessableEntityException({ code: "PURCHASE_OUTSIDE_BOM_REASON_REQUIRED", message: "计划行不在 BOM 表中（补料/替代料），必须填写新增原因", details: [] });
      return {
        materialId: material.id,
        materialSnapshot: material as unknown as Prisma.InputJsonValue,
        unitId: unit.id,
        unitSnapshot: { id: unit.id, name: unit.name } as Prisma.InputJsonValue,
        bomItemId,
        supplierId: supplier?.id ?? null,
        supplierSnapshot: supplier ? ({ id: supplier.id, supplierCode: supplier.supplierCode, name: supplier.name } as Prisma.InputJsonValue) : Prisma.DbNull,
        model: item.model ?? material.specificationModel ?? null,
        quantity: new Prisma.Decimal(item.quantity).toFixed(4),
        unitPrice: new Prisma.Decimal(item.unit_price).toFixed(4),
        // 币种**不来自请求体**：新行一律默认人民币；已有的未下单行由调用方从库里带过来
        // （`currencyById`）。真正的决策点是「收束下单」里按供应商组选的那一格 —— 那一组
        // 下完单会把币种写回这里，所以计划合计按币种分列时才不会说谎。
        currency: currencyById?.get(item.id ?? "") ?? DEFAULT_PLAN_CURRENCY,
        expectedDate: this.parseDate(item.expected_date),
        extensionData: item.extension_data ?? {},
      };
    });
  }

  /** 计划行的落库形状。`supplierSnapshot` 的"没有值"必须是 `Prisma.DbNull`（SQL NULL），
   *  不是 `Prisma.JsonNull`（JSON 的 `null` 字面量）—— 后者会让 `WHERE x IS NULL` 查不到。 */
  private itemData(planId: string, item: PreparedPlanItem, sequence: number, user: CurrentUser) {
    return {
      planId,
      materialId: item.materialId,
      materialSnapshot: item.materialSnapshot,
      unitId: item.unitId,
      unitSnapshot: item.unitSnapshot,
      bomItemId: item.bomItemId,
      supplierId: item.supplierId,
      supplierSnapshot: item.supplierSnapshot,
      model: item.model,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      currency: item.currency,
      expectedDate: item.expectedDate,
      sequence,
      extensionData: item.extensionData as Prisma.InputJsonValue,
      ...this.audit.create(user),
    };
  }

  private parseDate(value: string | undefined) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  private isPositive(value: string) {
    try {
      return new Prisma.Decimal(value).gt(0);
    } catch {
      return false;
    }
  }
  private isNonNegative(value: string) {
    try {
      return new Prisma.Decimal(value).gte(0);
    } catch {
      return false;
    }
  }
}
