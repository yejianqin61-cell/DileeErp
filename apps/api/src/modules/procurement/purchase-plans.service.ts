import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { AuditService } from "../../platform/audit/audit.service";
import type { CurrentUser } from "../../platform/auth/auth.service";
import { PrismaService } from "../../platform/database/prisma.service";
import { itemNoKey } from "../sales/item-no";
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
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

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

  /** 前端传进来的行（用于"新建时就带行"这种少见路径）。校验口径与采购明细一致。 */
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
      if (item.bom_item_id && bomItemMap.get(item.bom_item_id)?.materialId !== item.material_id) throw new UnprocessableEntityException({ code: "PURCHASE_BOM_ITEM_MISMATCH", message: "计划行必须引用当前 BOM 表中的对应物料", details: [] });
      return {
        materialId: material.id,
        materialSnapshot: material as unknown as Prisma.InputJsonValue,
        unitId: unit.id,
        unitSnapshot: { id: unit.id, name: unit.name } as Prisma.InputJsonValue,
        bomItemId: item.bom_item_id ?? null,
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
