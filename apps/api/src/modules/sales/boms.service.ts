import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { AuditService } from "../../platform/audit/audit.service";
import type { CurrentUser } from "../../platform/auth/auth.service";
import { PrismaService } from "../../platform/database/prisma.service";
import { bomBlockedReason, bomFacts, bomHasDownstream, type BomFacts } from "./bom-facts";

@Injectable()
export class BomsService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  async list(orderNo?: string) {
    // `orphaned` = 所属销售单已被软删（2026-11-03：删销售单不删下游单，只显示成孤立）。
    const rows = await this.prisma.bom.findMany({ where: { deletedAt: null, ...(orderNo ? { orderNo } : {}) }, orderBy: [{ orderNo: "asc" }, { version: "desc" }], include: { salesOrder: { select: { id: true, orderNo: true, status: true, currentVersion: true, deletedAt: true } }, salesOrderVersion: { select: { id: true, version: true, createdAt: true } } } });
    return rows.map((row) => ({ ...row, orphaned: Boolean(row.salesOrder?.deletedAt) }));
  }

  async get(id: string) {
    // 明细带上供应商摘要：BOM 表要显示「这一行默认找哪家做」，而供应商可能被改名/停用，
    // 所以既给关系（当前值）也给 `supplierSnapshot`（当时记的那一家）——两者由前端择优显示。
    const bom = await this.prisma.bom.findFirst({ where: { id, deletedAt: null }, include: { salesOrder: true, salesOrderVersion: true, items: { where: { deletedAt: null }, orderBy: [{ sequence: "asc" }, { createdAt: "asc" }], include: { supplier: { select: { id: true, supplierCode: true, name: true, isActive: true } } } } } });
    if (!bom) throw new NotFoundException({ code: "BOM_NOT_FOUND", message: "BOM 不存在", details: [] });
    return bom;
  }

  /**
   * 删除前的预览（2026-11-05）：先告诉用户「这张 BOM 有什么、为什么不能删 / 为什么要填原因」，
   * 前端据此决定确认框里要不要出现原因输入框。
   *
   * 只读、**不加锁**是有意的：预览允许略陈旧 —— 真正的判定在 `delete()` 里、行锁之后**重算一次**。
   * 所以「预览说可删、删除时被并发补建的采购单挡住」是正确行为：宁可删不掉，也不能凭旧快照穿透。
   */
  async deletePreview(id: string) {
    const facts = await bomFacts(this.prisma, id);
    if (!facts) throw new NotFoundException({ code: "BOM_NOT_FOUND", message: "BOM 不存在", details: [] });
    return {
      bom_id: facts.id,
      order_no: facts.order_no,
      version: facts.version,
      status: facts.status,
      item_count: facts.item_count,
      purchase_plan: facts.purchase_plan,
      purchase_order_count: facts.purchase_order_count,
      production_order_count: facts.production_order_count,
      // 已被采购/投产引用的 BOM 不可删：与销售单核心字段锁同一口径（先回退下游），见 bom-facts 模块头注释。
      deletable: !bomHasDownstream(facts),
      blocked_reason: bomBlockedReason(facts),
      reason_required: this.deleteReasonRequired(facts),
    };
  }

  /**
   * 软删一张 BOM：表头与明细行一起软删，**不物理删任何行**。
   *
   * 为什么只能软删：38 类下游表对 `boms` 的外键全是 RESTRICT，BOM 还被采购单/生产单/采购计划按 `bom_id` 引用，
   * 物理删永远会被数据库拒绝；软删让既有引用不断、历史仍可追溯（与采购计划删除同一口径）。
   *
   * 为什么事务里先 `FOR UPDATE` 再重算：可删性取决于「有没有未取消的采购单 / 未删除的生产单」。
   * 若只在事务外读一次，采购/生产建单路径可能在这期间补建单据 —— 那样「判定时没人用」的 BOM 会被删掉，
   * 而新单据的 `bom_id` 指向一张已删表，下游入口凭空消失。
   * 锁机制正好能挡住它：采购单/生产单插入时按外键要对 `boms` 行取 KEY SHARE 锁，与这里的 FOR UPDATE 冲突，
   * 于是建单只能排在本事务之后；反过来，若它先提交了，本事务的锁后重读就一定看得见那张单据。
   * 所以重算必须在锁**之后**，重算到的才是提交时刻的真实事实。
   */
  async delete(id: string, reason: string | undefined, user: CurrentUser) {
    const note = (reason ?? "").trim();
    const facts = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM boms WHERE id = ${id}::uuid FOR UPDATE`;
      const current = await bomFacts(tx, id);
      // 锁之后再读一遍：不存在或已被他人软删，统一按 404 处理（重复删除不该报 500）。
      if (!current) throw new NotFoundException({ code: "BOM_NOT_FOUND", message: "BOM 不存在", details: [] });
      const blocked = bomBlockedReason(current);
      if (blocked) {
        throw new UnprocessableEntityException({
          code: "BOM_HAS_DOWNSTREAM",
          message: blocked,
          details: [{ bom_id: current.id, order_no: current.order_no, purchase_order_count: current.purchase_order_count, production_order_count: current.production_order_count }],
        });
      }
      if (this.deleteReasonRequired(current) && !note) {
        throw new UnprocessableEntityException({
          code: "BOM_DELETE_REASON_REQUIRED",
          message: "这张 BOM 已经录过内容（有明细或已有采购计划），删除必须填写原因：删掉的是一份有人维护过的资料，审计里要说得清为什么删",
          details: [{ bom_id: current.id, order_no: current.order_no, item_count: current.item_count, has_purchase_plan: current.purchase_plan !== null }],
        });
      }
      // 明细与表头一起软删：只删表头会让 bom_items 变成指向已删表头的孤儿行，将来排查/恢复都对不上。
      await tx.bomItem.updateMany({ where: { bomId: id, deletedAt: null }, data: this.audit.softDelete(user) });
      await tx.bom.update({ where: { id }, data: this.audit.softDelete(user) });
      return current;
    });
    // 审计写在事务外（既有口径）：业务已经提交，就不该因为附加记录失败而回滚删除。
    // `reason` 没填时记 `null` 而不是丢掉这个键 —— 审计要能区分「没填」与「这条老记录没有该字段」。
    await this.audit.record("bom.delete", "bom", user.id, id, {
      order_no: facts.order_no,
      version: facts.version,
      item_count: facts.item_count,
      reason: note || null,
      purchase_plan_id: facts.purchase_plan?.id ?? null,
      purchase_order_count: facts.purchase_order_count,
      production_order_count: facts.production_order_count,
    });
    return { id, order_no: facts.order_no, version: facts.version, deleted: true, item_count: facts.item_count };
  }

  /**
   * 要不要填删除原因：明细或采购计划存在 = 这张 BOM「被用过」（计划存在时即使 0 行也算，
   * 见设计文档 §4.1）—— 删它要在审计里说得清为什么。0 明细、无计划、无下游的**空壳**不要求原因，
   * 它不含任何业务事实，一键删即可（D2）。
   */
  private deleteReasonRequired(facts: Pick<BomFacts, "item_count" | "purchase_plan">) {
    return facts.item_count > 0 || facts.purchase_plan !== null;
  }

  async createFromSalesOrder(salesOrderId: string, input: { extension_data?: Record<string, unknown>; form_definition_id?: string }, user: CurrentUser) {
    const order = await this.prisma.salesOrder.findFirst({ where: { id: salesOrderId, deletedAt: null }, include: { versions: { orderBy: { version: "desc" }, take: 1 }, boms: { where: { deletedAt: null }, orderBy: { version: "desc" }, take: 1 } } });
    if (!order) throw new NotFoundException({ code: "SALES_ORDER_NOT_FOUND", message: "销售单不存在", details: [] });
    if (order.status !== "confirmed") throw new UnprocessableEntityException({ code: "SALES_ORDER_NOT_CONFIRMED", message: "只有已确认销售单可以创建 BOM", details: [{ status: order.status }] });
    const sourceVersion = order.versions[0];
    if (!sourceVersion) throw new UnprocessableEntityException({ code: "SALES_ORDER_VERSION_MISSING", message: "销售单版本不存在", details: [] });
    if (order.boms[0]) throw new ConflictException({ code: "BOM_ALREADY_EXISTS", message: "该销售单已经存在 BOM 表", details: [{ bom_id: order.boms[0].id }] });
    const version = 1;
    try {
      if (input.form_definition_id) {
        const form = await this.prisma.formDefinition.findFirst({ where: { id: input.form_definition_id, status: "published", deletedAt: null } });
        if (!form) throw new UnprocessableEntityException({ code: "FORM_DEFINITION_NOT_AVAILABLE", message: "表单定义不存在或未发布", details: [] });
      }
      const bom = await this.prisma.bom.create({ data: { orderNo: order.orderNo, salesOrderId: order.id, salesOrderVersionId: sourceVersion.id, formDefinitionId: input.form_definition_id, version, status: "draft", extensionData: (input.extension_data ?? {}) as Prisma.InputJsonValue, ...this.audit.create(user) } });
      await this.audit.record("bom.create", "bom", user.id, bom.id, { order_no: order.orderNo, sales_order_version: sourceVersion.version, bom_version: version });
      return this.get(bom.id);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "P2002") throw new ConflictException({ code: "BOM_ALREADY_EXISTS", message: "该销售单已经存在 BOM 表", details: [] });
      throw error;
    }
  }

  async update(id: string, extensionData: Record<string, unknown>, user: CurrentUser, expectedUpdatedAt?: string) {
    const bom = await this.get(id);
    const expected = expectedUpdatedAt?.trim();
    const updated = expected
      ? await this.prisma.$transaction(async (tx) => {
          await this.assertNotStale(tx, id, expected);
          return tx.bom.update({ where: { id }, data: { extensionData: extensionData as Prisma.InputJsonValue, ...this.audit.update(user) } });
        })
      : await this.prisma.bom.update({ where: { id }, data: { extensionData: extensionData as Prisma.InputJsonValue, ...this.audit.update(user) } });
    await this.audit.record("bom.update", "bom", user.id, id, { order_no: bom.orderNo, version: bom.version });
    return updated;
  }

  /**
   * 乐观锁：BOM 现在被采购与生产两个模块共同编辑，必须防止「后保存的静默覆盖先保存的」。
   *
   * 做法：客户端回传打开时的 `updatedAt`，服务端在事务里先取行锁（FOR UPDATE）再读最新值比对。
   * 行锁保证两个并发保存在数据库里排成先后：先到者写完后 updatedAt 变化，后到者读到的就是新值，
   * 于是必然冲突并被拒绝 —— 而不是把对方的修改覆盖掉。
   * 冲突使用 422 BOM_UPDATE_CONFLICT，前端提示「已被他人修改，请重新加载」。
   * 不传令牌时跳过比对（兼容旧调用方与既有单测桩）。
   */
  private async assertNotStale(tx: Prisma.TransactionClient, id: string, expectedUpdatedAt: string) {
    await tx.$queryRaw`SELECT id FROM boms WHERE id = ${id}::uuid FOR UPDATE`;
    const fresh = await tx.bom.findFirst({ where: { id, deletedAt: null }, select: { updatedAt: true } });
    if (!fresh) throw new NotFoundException({ code: "BOM_NOT_FOUND", message: "BOM 不存在", details: [] });
    const expectedTime = new Date(expectedUpdatedAt).getTime();
    if (Number.isNaN(expectedTime) || fresh.updatedAt.getTime() !== expectedTime) {
      throw new UnprocessableEntityException({
        code: "BOM_UPDATE_CONFLICT",
        message: "BOM 已被他人（采购或生产）修改，本次保存没有写入；请重新加载最新版本后再改一次",
        details: [{ expected_updated_at: expectedUpdatedAt, actual_updated_at: fresh.updatedAt.toISOString() }],
      });
    }
  }

  async replaceItems(id: string, items: Array<{ material_id: string; material_name?: string; model?: string; specification_model?: string; color?: string; material_snapshot: Record<string, unknown>; required_quantity: string; production_batch_base?: string; base_usage?: string; unit: string; unit_id?: string; supplier_id?: string; reference_unit_price?: string; reference_currency?: string; loss_quantity?: string; loss_rate?: string; extension_data?: Record<string, unknown> }>, user: CurrentUser, expectedUpdatedAt?: string) {
    const bom = await this.get(id);
    // Material master data stays authoritative for raw-material checks only.
    // Quantity and unit are user-maintained BOM fields: required_quantity is
    // persisted verbatim (no silent recompute), and unit_id (unit pool) wins
    // over the material default when provided.
    const unitIds = items.map((item) => item.unit_id).filter((value): value is string => Boolean(value));
    const unitRows = unitIds.length && this.prisma.unit?.findMany ? await this.prisma.unit.findMany({ where: { id: { in: [...new Set(unitIds)] }, isActive: true, deletedAt: null }, select: { id: true } }) : [];
    const unitIdSet = new Set(unitRows.map((row) => row.id));
    if (unitIds.some((unitId) => !unitIdSet.has(unitId))) throw new UnprocessableEntityException({ code: "BOM_UNIT_NOT_FOUND", message: "BOM 明细单位不存在或已停用", details: [] });
    /**
     * 默认供应商：与单位同一套校验（存在 + 启用）。
     *
     * 只在**真的填了供应商**时才查库：老调用方与轻量单测桩没有这张表也能跑（同 `unit`/`material` 的写法）。
     * 软删的供应商不能选（`deletedAt: null`）—— 否则 BOM 上会挂一个列表里再也找不到的供应商。
     */
    const supplierIds = items.map((item) => item.supplier_id).filter((value): value is string => Boolean(value));
    const supplierRows = supplierIds.length && this.prisma.supplier?.findMany ? await this.prisma.supplier.findMany({ where: { id: { in: [...new Set(supplierIds)] }, isActive: true, deletedAt: null }, select: { id: true, supplierCode: true, name: true } }) : [];
    const supplierMap = new Map(supplierRows.map((row) => [row.id, row]));
    if (supplierIds.some((supplierId) => !supplierMap.has(supplierId))) throw new UnprocessableEntityException({ code: "BOM_SUPPLIER_NOT_FOUND", message: "BOM 明细的默认供应商不存在或已停用", details: [] });
    const order = this.prisma.salesOrder?.findUnique ? await this.prisma.salesOrder.findUnique({ where: { id: bom.salesOrderId }, select: { quantity: true } }) : { quantity: new Prisma.Decimal(1) };
    /**
     * 参考单价（2026-10-08）：可空。空串按「没填」处理（`null`），填了就必须是 ≥ 0 的四位小数——
     * 与 `loss_quantity` 同一套数字校验，不新造一种写法。
     * 它**不参与任何金额计算**（成本/毛利/应付都取采购单上的实际单价），所以这里只校验"是不是个数"。
     */
    const referencePrices = items.map((item) => (item.reference_unit_price ?? "").trim());
    if (referencePrices.some((value) => value !== "" && !this.isNonNegativeDecimal(value))) {
      throw new UnprocessableEntityException({ code: "INVALID_BOM_ITEM", message: "BOM 明细的物料、数量、单位或参考单价不合法", details: [] });
    }
    if (!order || items.some((item) => !item.material_id || !item.unit || !(item.material_name ?? String(item.material_snapshot.name ?? "")).trim() || !this.isPositiveDecimal(item.required_quantity) || (item.production_batch_base !== undefined && !this.isPositiveDecimal(item.production_batch_base)) || (item.base_usage !== undefined && !this.isPositiveDecimal(item.base_usage)) || (item.loss_quantity !== undefined && !this.isNonNegativeDecimal(item.loss_quantity)) || (item.loss_rate !== undefined && !this.isNonNegativeDecimal(item.loss_rate)))) {
      throw new UnprocessableEntityException({ code: "INVALID_BOM_ITEM", message: "BOM 明细的物料、数量、单位或参考单价不合法", details: [] });
    }
    const expected = expectedUpdatedAt?.trim();
    await this.prisma.$transaction(async (tx) => {
      // 先做并发比对再做任何写入：冲突时连软删旧行都不会发生。
      if (expected) await this.assertNotStale(tx, id, expected);
      await tx.bomItem.updateMany({ where: { bomId: id, deletedAt: null }, data: { deletedAt: new Date(), deletedBy: user.id, updatedBy: user.id } });
      if (items.length) {
        // ponytail: lightweight unit tests may provide only the BOM write seam; production Prisma always has material.findMany.
        const materials = tx.material?.findMany ? await tx.material.findMany({ where: { id: { in: items.map((item) => item.material_id) }, isActive: true, deletedAt: null }, select: { id: true, materialType: true, defaultUnitId: true } }) : items.map((item) => ({ id: item.material_id, materialType: "raw_material", defaultUnitId: undefined }));
        const materialMap = new Map(materials.map((material) => [material.id, material]));
        if (items.some((item) => materialMap.get(item.material_id)?.materialType !== "raw_material")) throw new UnprocessableEntityException({ code: "BOM_RAW_MATERIAL_REQUIRED", message: "BOM 只能使用启用的原料物料", details: [] });
        // Auto-fill of specification_model/color happens in the web client only
        // at material-selection or BOM-import time. On save we persist the
        // submitted values verbatim: manual edits must never be replaced by
        // material_snapshot (or a legacy model fallback) here. Required
        // quantity is likewise verbatim — the historical batch-usage recompute
        // silently discarded user edits and must not come back.
        await tx.bomItem.createMany({ data: items.map((item, index) => { const required = new Prisma.Decimal(item.required_quantity); const supplier = item.supplier_id ? supplierMap.get(item.supplier_id) : undefined; return { bomId: id, materialId: item.material_id, materialName: item.material_name ?? String(item.material_snapshot.name ?? ""), model: item.model, specificationModel: item.specification_model, color: item.color, unitId: item.unit_id ?? materialMap.get(item.material_id)?.defaultUnitId, materialSnapshot: item.material_snapshot as Prisma.InputJsonValue, requiredQuantity: required, productionBatchBase: item.production_batch_base ?? "1", baseUsage: item.base_usage ?? required, approvedUsage: required, sequence: index + 1, unit: item.unit, supplierId: item.supplier_id ?? null, // 快照存当时那家的编码与名称：供应商改名/停用后，BOM 上仍看得见记录。
          // 没选供应商时写 **DbNull（SQL NULL）** 而不是 `Prisma.JsonNull`：后者存的是 JSON 的
          // `null` 字面量，`WHERE supplier_snapshot IS NULL` 找不到它 —— 将来想查"哪些行没有快照"会漏。
          supplierSnapshot: supplier ? ({ id: supplier.id, supplierCode: supplier.supplierCode, name: supplier.name } as Prisma.InputJsonValue) : Prisma.DbNull, // 参考单价：空串 = 没填（存 NULL，不是 0）。币种没填时也存 NULL —— 预填到计划时按人民币兜底。
          referenceUnitPrice: (item.reference_unit_price ?? "").trim() === "" ? null : new Prisma.Decimal(item.reference_unit_price!.trim()), referenceCurrency: (item.reference_currency ?? "").trim() || null, lossQuantity: item.loss_quantity, lossRate: item.loss_rate, extensionData: (item.extension_data ?? {}) as Prisma.InputJsonValue, ...this.audit.create(user) }; }) });
      }
    });
    await this.audit.record("bom.items.replace", "bom", user.id, id, { order_no: bom.orderNo, version: bom.version, item_count: items.length });
    return this.get(id);
  }

  private isPositiveDecimal(value: string) { return /^(?:0|[1-9]\d*)(?:\.\d{1,4})?$/.test(value) && Number(value) > 0; }
  private isNonNegativeDecimal(value: string) { return /^(?:0|[1-9]\d*)(?:\.\d{1,4})?$/.test(value) && Number(value) >= 0; }
}
