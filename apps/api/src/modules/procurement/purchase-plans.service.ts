import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { AuditService } from "../../platform/audit/audit.service";
import type { CurrentUser } from "../../platform/auth/auth.service";
import { PrismaService } from "../../platform/database/prisma.service";
import { itemNoKey } from "../sales/item-no";
import { PurchaseOrdersService, type PurchaseOrderItemInput, type SplitGroup, type SplitInput } from "./purchase-orders.service";
import { countBomMaterialsMissingFromPlan, planStatusOf, purchasePlanNo, PURCHASE_PLAN_STATUS_LABELS, type PurchasePlanStatus } from "./purchase-plans.domain";

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
export type PlanOrderInput = { purchase_date?: string; remark?: string; extension_data?: Record<string, unknown>; groups: PlanOrderGroup[] };

/** 保存时要比对的最小行形状（只取已下单行保护用得上的列）。 */
type WritablePlanItem = {
  id: string;
  materialId: string;
  unitId: string;
  supplierId: string | null;
  quantity: Prisma.Decimal;
  unitPrice: Prisma.Decimal;
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
  items: Array<{ id: string; purchaseOrderItemId: string | null }>;
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

@Injectable()
export class PurchasePlansService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly orders: PurchaseOrdersService) {}

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
        items: { where: { deletedAt: null }, select: { id: true, purchaseOrderItemId: true } },
        salesOrder: { select: { orderNo: true, itemNo: true, customerSnapshot: true } },
      },
      orderBy: { updatedAt: "desc" },
    });
    const summaries = rows.map((row) => this.summaryOf(row as PlanSummarySource));
    const status = query.status?.trim();
    const key = itemNoKey(query.item_no);
    const text = query.q?.trim().toLowerCase();
    return summaries.filter((row) => {
      if (status && status !== "all" && row.status !== status) return false;
      if (key && itemNoKey(row.itemNo) !== key) return false;
      if (text && !`${row.planNo} ${row.orderNo} ${row.itemNo ?? ""} ${row.customerName ?? ""}`.toLowerCase().includes(text)) return false;
      return true;
    });
  }

  /**
   * 可以建计划的 BOM：已确认销售单 + 未删 BOM + **还没有未删计划**。
   *
   * 这张清单就是"该建计划还没建"的待办，所以不返回已经有计划的 BOM ——
   * 否则下拉里一堆点了会 409 的选项。
   */
  async candidates() {
    const boms = await this.prisma.bom.findMany({
      where: { deletedAt: null, salesOrder: { status: "confirmed", deletedAt: null }, purchasePlans: { none: { deletedAt: null } } },
      include: {
        salesOrder: { select: { orderNo: true, itemNo: true, customerSnapshot: true, deliveryDate: true } },
        items: { where: { deletedAt: null }, select: { id: true } },
      },
      orderBy: [{ orderNo: "asc" }, { version: "desc" }],
    });
    return boms.map((bom) => ({
      bomId: bom.id,
      orderNo: bom.orderNo,
      bomVersion: bom.version,
      itemNo: bom.salesOrder?.itemNo ?? null,
      customerName: snapshotName(bom.salesOrder?.customerSnapshot),
      deliveryDate: bom.salesOrder?.deliveryDate ?? null,
      itemCount: bom.items.length,
    }));
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
      return this.get(created.id);
    } catch (error) {
      // 部分唯一索引（`bom_id WHERE deleted_at IS NULL`）挡住并发重复建：两个人同时点"新建"时，
      // 先到的赢，后到的拿到的是同一句人话，而不是一个 500。
      if (error && typeof error === "object" && "code" in error && error.code === "P2002") throw new ConflictException({ code: "PURCHASE_PLAN_ALREADY_EXISTS", message: "该 BOM 已经有一份采购计划", details: [] });
      throw error;
    }
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
        salesOrder: { select: { orderNo: true, itemNo: true, customerSnapshot: true, deliveryDate: true, status: true } },
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
    const bomItems = plan.bom && !plan.bom.deletedAt ? await this.prisma.bomItem.findMany({ where: { bomId: plan.bomId, deletedAt: null }, select: { materialId: true } }) : [];
    return {
      ...this.summaryOf(plan as unknown as PlanSummarySource),
      deliveryDate: plan.salesOrder?.deliveryDate ?? null,
      bomDeleted: Boolean(plan.bom?.deletedAt),
      bomExtraMaterialCount: countBomMaterialsMissingFromPlan(bomItems.map((row) => row.materialId), plan.items.map((row) => row.materialId)),
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
    ordered.forEach((item, index) => {
      const next = incomingById.get(item.id);
      if (!next) {
        throw new UnprocessableEntityException({
          code: "PURCHASE_PLAN_ORDERED_LINE_REMOVED",
          message: `第 ${index + 1} 行已经下过单，不能从计划里移除；要改先「退回采购计划」`,
          details: [{ plan_item_id: item.id, purchase_order_item_id: item.purchaseOrderItemId }],
        });
      }
      const changed = this.orderedLineChanged(item, next);
      if (changed) {
        throw new UnprocessableEntityException({
          code: "PURCHASE_PLAN_ORDERED_LINE_LOCKED",
          message: `第 ${index + 1} 行的${changed}已经下过单，不能在计划里改；要改先「退回采购计划」`,
          details: [{ plan_item_id: item.id, field: changed, purchase_order_item_id: item.purchaseOrderItemId }],
        });
      }
    });
    // 未下单的行随便改：它们还只是"打算买什么"。
    const replacement = incoming.filter((item) => !(item.id && orderedIds.has(item.id)));
    const prepared = await this.prepareItems({ id: current.bomId }, replacement, user);
    const orderedById = new Map(ordered.map((item) => [item.id, item]));
    let syncedArrivalDates = 0;
    await this.prisma.$transaction(async (tx) => {
      await this.assertNotStale(tx, id, input.expected_updated_at);
      await tx.purchasePlanItem.updateMany({ where: { planId: id, deletedAt: null, purchaseOrderItemId: null }, data: { ...this.audit.softDelete(user) } });
      let preparedCursor = 0;
      for (const [index, item] of incoming.entries()) {
        const existing = item.id ? orderedById.get(item.id) : undefined;
        if (existing) {
          const nextDate = this.parseDate(item.expected_date);
          const dateChanged = !this.sameDate(existing.expectedDate, nextDate);
          await tx.purchasePlanItem.update({ where: { id: existing.id }, data: { sequence: index + 1, ...(dateChanged ? { expectedDate: nextDate } : {}), ...this.audit.update(user) } });
          // 预计到货改了就同步进那张已下单的采购明细：否则同一行会有两个"预计到货"，
          // 而采购员拿去跟供应商对的是采购单上那一份。
          if (dateChanged && existing.purchaseOrderItemId) {
            await tx.purchaseOrderItem.update({ where: { id: existing.purchaseOrderItemId }, data: { expectedDate: nextDate, ...this.audit.update(user) } });
            syncedArrivalDates += 1;
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
      reason: input.reason?.trim() || undefined,
    });
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
          select: { id: true, materialId: true, unitId: true, supplierId: true, quantity: true, unitPrice: true, model: true, expectedDate: true, purchaseOrderItemId: true, bomItemId: true, extensionData: true },
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
   */
  private orderedLineChanged(item: WritablePlanItem, next: PlanItemInput): string | null {
    if (next.material_id !== item.materialId) return "物料";
    if (next.unit_id !== item.unitId) return "单位";
    if ((item.supplierId ?? null) !== (next.supplier_id ?? null)) return "供应商";
    if ((item.model ?? null) !== (next.model ?? null)) return "型号";
    if (!this.decimalEquals(item.quantity, next.quantity)) return "数量";
    if (!this.decimalEquals(item.unitPrice, next.unit_price)) return "单价";
    return null;
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
   * 收束下单（口径 6 + 口径 10）。
   *
   * 勾选的行按**供应商**分组 → 一组一张采购单（复用采购单既有的 `collectGroups()`：
   * 一个供应商一张单的不变式、下单前校验、金额与快照全部沿用，不另写一套建单逻辑）；
   * **没勾的行留在计划里**，下次再下。
   *
   * 三件事必须**在同一个事务里**：建采购单、回写计划行的 1:1 链接、计划头的时间戳。
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
    const created = await this.prisma.$transaction(async (tx) => {
      const rows = await this.orders.createOrdersFromGroups(tx, merged, "ordered", user);
      const createdItems = await tx.purchaseOrderItem.findMany({
        where: { purchaseOrderId: { in: rows.map((row) => row.id) }, deletedAt: null },
        select: { id: true, extensionData: true },
      });
      for (const item of createdItems) {
        const planItemId = (item.extensionData as { purchase_plan_item_id?: string } | null)?.purchase_plan_item_id;
        if (!planItemId) continue;
        await tx.purchasePlanItem.update({ where: { id: planItemId }, data: { purchaseOrderItemId: item.id, ...this.audit.update(user) } });
      }
      return rows;
    });
    await this.audit.record("purchase_plan.order", "purchase_plan", user.id, id, {
      plan_no: current.planNo,
      order_no: current.orderNo,
      ordered_line_count: claimed.size,
      remaining_line_count: current.items.length - claimed.size,
      group_count: created.length,
      purchase_order_nos: created.map((row) => row.purchaseOrderNo),
    });
    const plan = await this.get(id);
    return {
      plan,
      orders: created.map((row) => ({ id: row.id, purchaseOrderNo: row.purchaseOrderNo, currency: row.currency, totalAmount: row.totalAmount.toFixed(4) })),
    };
  }

  /** 列表/详情共用的摘要：行数、未下单行数、派生状态。 */
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
        unitPrice: "0",
        expectedDate: null,
        extensionData: {},
      });
    }
    if (unresolved.length) throw new UnprocessableEntityException({ code: "PURCHASE_PLAN_UNIT_UNRESOLVED", message: `有 ${unresolved.length} 个 BOM 行找不到可用单位：${unresolved.slice(0, 5).join("、")}。请先在 BOM 表里补齐单位`, details: [{ materials: unresolved.slice(0, 20) }] });
    return items;
  }

  /** 前端传进来的行。校验口径与采购明细**完全一致**（否则会出现"计划里能存、下单时被拒"）。 */
  private async prepareItems(bom: { id: string }, items: PlanItemInput[], _user: CurrentUser): Promise<PreparedPlanItem[]> {
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
