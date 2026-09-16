import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { AuditService } from "../../platform/audit/audit.service";
import type { CurrentUser } from "../../platform/auth/auth.service";
import { PrismaService } from "../../platform/database/prisma.service";
import { InventoryService } from "../../platform/inventory/inventory.service";

type IssueLineInput = { material_id: string; quantity: string; remark?: string };
// 领料单与补料单都只绑定生产单，不再绑定工序。
// 领料单：一个生产单可有多张（按需分批领料）。
// 补料单：坏片/生产失误等的补充领料，同样参与原料出库。
type IssueInput = { production_order_id: string; business_date?: string; reason?: string; remark?: string; lines: IssueLineInput[] };
type ReplenishmentInput = { production_order_id: string; business_date?: string; reason?: string; remark?: string; lines: IssueLineInput[] };
type DerivedLineInput = { source_issue_line_id: string; quantity: string; remark?: string };
type DerivedInput = { production_order_id: string; business_date?: string; reason?: string; remark?: string; lines: DerivedLineInput[] };

// RawMaterialMovementRisk.reason 是非空列；超领/非 BOM 已不再要求填写原因，
// 未填写时写入该占位串，保证风险仍被留痕且不因缺字段而报错。
const RISK_REASON_NOT_REQUIRED = "未填写（超领/非BOM原因门禁已取消）";

@Injectable()
export class RawMaterialMovementsService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly inventory: InventoryService) {}

  async list(orderNo?: string, filter?: { productionOrderId?: string; productionOrderOperationId?: string }) {
    return this.prisma.rawMaterialMovement.findMany({
      where: {
        deletedAt: null,
        ...(orderNo ? { orderNo } : {}),
        ...(filter?.productionOrderId ? { productionOrderId: filter.productionOrderId } : {}),
        ...(filter?.productionOrderOperationId ? { productionOrderOperationId: filter.productionOrderOperationId } : {})
      },
      include: { productionOrder: { include: { executionLocation: true } }, productionOrderOperation: true, lines: { where: { deletedAt: null }, include: { material: true, unit: true, risks: { where: { deletedAt: null } } } }, risks: { where: { deletedAt: null } } },
      orderBy: { createdAt: "desc" }
    });
  }

  async get(id: string) {
    const movement = await this.prisma.rawMaterialMovement.findFirst({
      where: { id, deletedAt: null },
      include: { productionOrder: { include: { executionLocation: true, salesOrder: true } }, productionOrderOperation: true, lines: { where: { deletedAt: null }, include: { material: true, unit: true, risks: { where: { deletedAt: null } } } }, risks: { where: { deletedAt: null } } }
    });
    if (!movement) throw new NotFoundException({ code: "MATERIAL_MOVEMENT_NOT_FOUND", message: "原料领料单不存在", details: [] });
    return movement;
  }

  async auditEvents(id: string) {
    await this.get(id);
    return this.prisma.auditEvent.findMany({ where: { entityType: "raw_material_movement", entityId: id }, orderBy: { createdAt: "desc" } });
  }

  async preview(input: IssueInput) {
    const order = await this.requireInHouseOrder(input.production_order_id);
    return this.previewLines(order, input.lines);
  }

  async createIssue(input: IssueInput, user: CurrentUser) {
    const order = await this.requireInHouseOrder(input.production_order_id);
    // 领料单只绑定生产单，不再绑定工序；同一个生产单可以开多张领料单（按需分批领料）。
    const preview = await this.previewLines(order, input.lines);
    const movement = await this.prisma.rawMaterialMovement.create({
      data: {
        movementNo: `MI-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomUUID().slice(0, 8).toUpperCase()}`,
        documentType: "issue",
        productionOrderId: order.id,
        orderNo: order.orderNo,
        businessDate: input.business_date ? new Date(input.business_date) : new Date(),
        reason: input.reason,
        remark: input.remark,
        idempotencyKey: `draft:${randomUUID()}`,
        lines: { create: preview.lines.map((line) => ({ materialId: line.material_id, unitId: line.unit_id, quantity: line.quantity, bomReferenceQuantity: line.bom_reference_quantity, remark: line.remark, ...this.audit.create(user) })) },
        ...this.audit.create(user)
      },
      include: { lines: true }
    });
    await this.audit.record("raw_material_movement.create", "raw_material_movement", user.id, movement.id, { order_no: order.orderNo, production_order_id: order.id, document_type: "issue" });
    return movement;
  }

  async createReturn(input: DerivedInput, user: CurrentUser) { return this.createDerived("return", input, user); }
  async createScrap(input: DerivedInput, user: CurrentUser) { return this.createDerived("scrap", input, user); }

  /**
   * 补料单：坏片/生产失误导致的补充领料。
   * 与领料单一样只绑定生产单，同样写入原料出库库存事实（sourceType=material_replenishment）。
   */
  async createReplenishment(input: ReplenishmentInput, user: CurrentUser) {
    const order = await this.requireInHouseOrder(input.production_order_id);
    if (!input.reason?.trim()) throw new UnprocessableEntityException({ code: "REPLENISHMENT_REASON_REQUIRED", message: "补料必须填写补料原因", details: [] });
    const preview = await this.previewLines(order, input.lines);
    const movement = await this.prisma.rawMaterialMovement.create({
      data: {
        movementNo: `MC-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomUUID().slice(0, 8).toUpperCase()}`,
        documentType: "replenishment",
        productionOrderId: order.id,
        orderNo: order.orderNo,
        businessDate: input.business_date ? new Date(input.business_date) : new Date(),
        reason: input.reason.trim(),
        remark: input.remark,
        idempotencyKey: `draft:${randomUUID()}`,
        lines: { create: preview.lines.map((line) => ({ materialId: line.material_id, unitId: line.unit_id, quantity: line.quantity, bomReferenceQuantity: line.bom_reference_quantity, remark: line.remark, ...this.audit.create(user) })) },
        ...this.audit.create(user)
      },
      include: { lines: true }
    });
    await this.audit.record("raw_material_movement.create", "raw_material_movement", user.id, movement.id, { order_no: order.orderNo, production_order_id: order.id, document_type: "replenishment", reason: input.reason.trim() });
    return movement;
  }

  async updateIssue(id: string, input: Partial<IssueInput>, user: CurrentUser) {
    const movement = await this.get(id);
    if (movement.status !== "draft") throw new UnprocessableEntityException({ code: "MATERIAL_MOVEMENT_NOT_EDITABLE", message: "只有草稿领料单可以编辑", details: [] });
    const order = await this.requireInHouseOrder(movement.productionOrderId);
    const preview = input.lines ? await this.previewLines(order, input.lines) : null;
    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM raw_material_movements WHERE id = ${id}::uuid FOR UPDATE`;
      const current = await tx.rawMaterialMovement.findFirst({ where: { id, deletedAt: null }, select: { status: true } });
      if (!current || current.status !== "draft") throw new ConflictException({ code: "MATERIAL_MOVEMENT_NOT_EDITABLE", message: "领料单已被其他操作处理，请刷新后重试", details: [] });
      if (preview) {
        await tx.rawMaterialMovementLine.updateMany({ where: { movementId: id, deletedAt: null }, data: this.audit.softDelete(user) });
      }
      return tx.rawMaterialMovement.update({
        where: { id },
        data: {
          ...(input.business_date === undefined ? {} : { businessDate: new Date(input.business_date) }),
          ...(input.reason === undefined ? {} : { reason: input.reason }),
          ...(input.remark === undefined ? {} : { remark: input.remark }),
          ...(preview ? { lines: { create: preview.lines.map((line) => ({ materialId: line.material_id, unitId: line.unit_id, quantity: line.quantity, bomReferenceQuantity: line.bom_reference_quantity, remark: line.remark, ...this.audit.create(user) })) } } : {}),
          ...this.audit.update(user)
        }
      });
    });
    await this.audit.record("raw_material_movement.update", "raw_material_movement", user.id, id, { order_no: movement.orderNo });
    return updated;
  }

  async removeIssue(id: string, user: CurrentUser) {
    const movement = await this.get(id);
    if (movement.status !== "draft") throw new UnprocessableEntityException({ code: "MATERIAL_MOVEMENT_NOT_DELETABLE", message: "只有草稿领料单可以删除", details: [] });
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM raw_material_movements WHERE id = ${id}::uuid FOR UPDATE`;
      const current = await tx.rawMaterialMovement.findFirst({ where: { id, deletedAt: null }, select: { status: true } });
      if (!current || current.status !== "draft") throw new ConflictException({ code: "MATERIAL_MOVEMENT_NOT_DELETABLE", message: "领料单已被其他操作处理，请刷新后重试", details: [] });
      return tx.rawMaterialMovement.update({ where: { id }, data: this.audit.softDelete(user) });
    });
    await this.audit.record("raw_material_movement.delete", "raw_material_movement", user.id, id, { order_no: movement.orderNo });
    return result;
  }

  async impactPreview(id: string) {
    const movement = await this.get(id);
    const preview = await this.previewLines(movement.productionOrder, movement.lines.map((line) => ({ material_id: line.materialId, quantity: line.quantity.toString(), remark: line.remark ?? undefined })));
    return { movement_no: movement.movementNo, order_no: movement.orderNo, production_order_no: movement.productionOrder.productionOrderNo, status: movement.status, ...preview };
  }

  /**
   * 仓库的「待出库通知」清单：已被生产确认提交、还没实际出库的单据。
   *
   * 为什么不另建一张「出库通知」表：这张单本身就是通知 —— 单据号、生产单、订单号、物料明细、
   * 数量全都在里面。另建影子表只会让两张表的状态互相漂移（通知说待出库、单据说已出库）。
   *
   * 排序按提交时间**正序**：仓库按先来后到处理，而不是每次都先看到最新那张。
   */
  async pendingOutbound() {
    return this.prisma.rawMaterialMovement.findMany({
      where: { deletedAt: null, status: "pending_outbound", documentType: { in: ["issue", "replenishment"] } },
      include: {
        productionOrder: { select: { productionOrderNo: true, orderNo: true } },
        lines: { where: { deletedAt: null }, include: { material: { select: { materialCode: true, name: true, specificationModel: true } }, unit: { select: { name: true } } } },
      },
      orderBy: [{ submittedAt: "asc" }, { createdAt: "asc" }],
    });
  }

  /**
   * 生产「确认提交」：草稿 → 待仓库出库。**不写任何库存事实**。
   *
   * 为什么提交时就要校验库存：让生产当场知道这批料领不出来（而不是等仓库点确认时才失败）。
   * 真正扣减库存仍然只看仓库那一步 —— 提交与出库之间库存可能被别的单据改变，
   * `postOutbound` 会在事务里用同一套 preview 再校验一次。
   */
  async submitOutbound(id: string, user: CurrentUser) {
    const movement = await this.get(id);
    if (!["issue", "replenishment"].includes(movement.documentType)) throw new UnprocessableEntityException({ code: "INVALID_MATERIAL_MOVEMENT_TYPE", message: "只有领料单或补料单需要仓库确认出库", details: [] });
    if (movement.status !== "draft") throw new UnprocessableEntityException({ code: "INVALID_MATERIAL_MOVEMENT_STATE", message: `只有草稿单据可以提交仓库（当前：${movement.status}）`, details: [] });
    const order = await this.requireInHouseOrder(movement.productionOrderId);
    const preview = await this.previewLines(order, movement.lines.map((line) => ({ material_id: line.materialId, quantity: line.quantity.toString(), remark: line.remark ?? undefined })));
    if (preview.lines.some((line) => line.available_after.isNegative())) throw new UnprocessableEntityException({ code: "INSUFFICIENT_INVENTORY", message: "提交后原料库存不足，请先补货或减少领用数量", details: preview.lines.filter((line) => line.available_after.isNegative()).map((line) => ({ material_id: line.material_id, available_quantity: line.available_before.toString() })) });
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM raw_material_movements WHERE id = ${id}::uuid FOR UPDATE`;
      const current = await tx.rawMaterialMovement.findFirst({ where: { id, deletedAt: null }, select: { status: true } });
      if (!current || current.status !== "draft") throw new ConflictException({ code: "MATERIAL_MOVEMENT_NOT_SUBMITTABLE", message: "单据已被其他操作处理，请刷新后重试", details: [] });
      return tx.rawMaterialMovement.update({ where: { id }, data: { status: "pending_outbound", submittedAt: new Date(), ...this.audit.update(user) } });
    });
    await this.audit.record("raw_material_movement.submit", "raw_material_movement", user.id, id, { order_no: movement.orderNo, production_order_id: movement.productionOrderId, movement_no: movement.movementNo });
    return result;
  }

  async postIssue(id: string, idempotencyKey: string, user: CurrentUser) { return this.postOutbound("issue", id, idempotencyKey, user); }
  async postReplenishment(id: string, idempotencyKey: string, user: CurrentUser) { return this.postOutbound("replenishment", id, idempotencyKey, user); }

  /**
   * 原料出库过账（**仓库确认出库**这一步）：领料单与补料单共用同一条实现
   * （库存不足拦截、风险留痕、库存事实、幂等）。二者只有单据类型与文案不同，
   * 库存事实的 sourceType 用于区分来源。
   *
   * 2026-09-16 起：只有**已由生产确认提交**（`pending_outbound`）的单据可以出库 ——
   * 草稿直接过账会让生产单方面扣掉仓库的库存，仓库连一张单都没看到。
   */
  private async postOutbound(kind: "issue" | "replenishment", id: string, idempotencyKey: string, user: CurrentUser) {
    const label = kind === "issue" ? "领料" : "补料";
    const sourceType = kind === "issue" ? "material_issue" : "material_replenishment";
    if (!idempotencyKey?.trim()) throw new UnprocessableEntityException({ code: "IDEMPOTENCY_KEY_REQUIRED", message: `${label}过账必须提供幂等键`, details: [] });
    const movement = await this.get(id);
    if (movement.documentType !== kind) throw new UnprocessableEntityException({ code: "INVALID_MATERIAL_MOVEMENT_TYPE", message: kind === "issue" ? "该单据不是领料单" : "该单据不是补料单", details: [] });
    if (movement.status === "posted" && movement.idempotencyKey === idempotencyKey) return movement;
    if (movement.status !== "pending_outbound") throw new UnprocessableEntityException({ code: "INVALID_MATERIAL_MOVEMENT_STATE", message: `只有已确认待出库的${label}单可以出库；草稿请先由生产「确认提交」，当前状态：${movement.status}`, details: [] });
    const order = await this.requireInHouseOrder(movement.productionOrderId);
    const preview = await this.previewLines(order, movement.lines.map((line) => ({ material_id: line.materialId, quantity: line.quantity.toString(), remark: line.remark ?? undefined })));
    // 超领/非 BOM 物料不再阻塞过账（业务确认该门禁没有必要）；风险仍在事务内照常记录，仅作审计留痕。
    if (preview.lines.some((line) => line.available_after.isNegative())) throw new UnprocessableEntityException({ code: "INSUFFICIENT_INVENTORY", message: `${label}会造成原料库存不足`, details: preview.lines.filter((line) => line.available_after.isNegative()).map((line) => ({ material_id: line.material_id, available_quantity: line.available_before.toString() })) });

    try {
      const posted = await this.prisma.$transaction(async (tx) => {
        const current = await tx.rawMaterialMovement.findFirst({ where: { id, deletedAt: null }, include: { lines: { where: { deletedAt: null } } } });
        if (!current || current.status !== "pending_outbound") throw new ConflictException({ code: "MATERIAL_MOVEMENT_ALREADY_POSTED", message: `${label}单已被其他操作处理`, details: [] });
        const lockedOrder = await this.requireInHouseOrder(current.productionOrderId, tx);
        // 先收集全部物料 advisory lock key 并排序后再加锁，避免并发多物料单据以相反顺序加锁造成死锁
        const materialKeys = current.lines.map((line) => `${line.materialId}|${line.unitId}`).sort();
        // pg_advisory_xact_lock 返回 void：必须用 $executeRaw（不反序列化结果列）。
        // 用 $queryRaw 会抛 "Failed to deserialize column of type 'void'"，导致过账必然 500。
        for (const key of materialKeys) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
        const lockedPreview = await this.previewLines(lockedOrder, current.lines.map((line) => ({ material_id: line.materialId, quantity: line.quantity.toString(), remark: line.remark ?? undefined })), tx);
        if (lockedPreview.lines.some((line) => line.available_after.isNegative())) throw new UnprocessableEntityException({ code: "INSUFFICIENT_INVENTORY", message: `${label}会造成原料库存不足`, details: [] });
        // 风险 line_id 必须指向数据库真实明细行（preview 行 id 为 undefined），按 material_id 关联 current.lines
        const dbLineByMaterial = new Map(current.lines.map((dbLine) => [dbLine.materialId, dbLine]));
        const lockedRisks = lockedPreview.lines.flatMap((line) => line.risks.map((risk) => {
          const dbLine = dbLineByMaterial.get(line.material_id);
          return { line_id: dbLine?.id ?? null, risk_type: risk.type, context: risk.context };
        }));
        const updated = await tx.rawMaterialMovement.update({ where: { id }, data: { status: "posted", idempotencyKey, ...this.audit.update(user) } });
        for (const line of current.lines) {
          await tx.inventoryFact.create({ data: { materialId: line.materialId, unitId: line.unitId, inventoryCategory: "raw_material", quantityDelta: `-${line.quantity}`, sourceType, sourceId: current.id, orderNo: current.orderNo, productionOrderId: current.productionOrderId, rawMaterialMovementLineId: line.id, createdBy: user.id } });
        }
        for (const risk of lockedRisks) {
          await tx.rawMaterialMovementRisk.create({ data: { movementId: current.id, lineId: risk.line_id, riskType: risk.risk_type, context: risk.context, reason: current.reason?.trim() || RISK_REASON_NOT_REQUIRED, confirmedBy: user.id, ...this.audit.create(user) } });
        }
        return updated;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      await this.audit.record("raw_material_movement.post", "raw_material_movement", user.id, id, { order_no: movement.orderNo, production_order_id: movement.productionOrderId, idempotency_key: idempotencyKey });
      return posted;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "P2034") throw new ConflictException({ code: "VERSION_CONFLICT", message: "库存已被其他操作更新，请刷新后重试", details: [] });
      if (error && typeof error === "object" && "code" in error && error.code === "P2002") throw new ConflictException({ code: "UNIQUE_VALUE_CONFLICT", message: "领料单号或幂等键冲突，请检查后重试", details: [] });
      throw error;
    }
  }

  async postReturn(id: string, idempotencyKey: string, user: CurrentUser) { return this.postDerived("return", id, idempotencyKey, user); }
  async postScrap(id: string, idempotencyKey: string, user: CurrentUser) { return this.postDerived("scrap", id, idempotencyKey, user); }

  async reversalPreview(id: string) {
    const movement = await this.get(id);
    if (movement.status !== "posted") throw new UnprocessableEntityException({ code: "INVALID_MATERIAL_MOVEMENT_STATE", message: "只有已过账单据可以冲销", details: [] });
    const dependentCount = movement.documentType === "issue" ? await this.prisma.rawMaterialMovementLine.count({ where: { sourceIssueLineId: { in: movement.lines.map((line) => line.id) }, deletedAt: null, movement: { is: { status: "posted", deletedAt: null } } } }) : 0;
    const facts = await this.prisma.inventoryFact.findMany({ where: { sourceId: movement.id } });
    return { movement_no: movement.movementNo, order_no: movement.orderNo, document_type: movement.documentType, can_reverse: dependentCount === 0, dependent_record_count: dependentCount, inventory_facts: facts.map((fact) => ({ material_id: fact.materialId, inventory_category: fact.inventoryCategory, quantity_delta: fact.quantityDelta.negated().toString() })) };
  }

  /**
   * 回退草稿：把单据退回草稿以便继续编辑。两种来源：
   *   - `posted`（过账撤销）：库存侧的处理见下 —— InventoryFact 没有软删除列，库存余额是按事实
   *     聚合出来的，所以不能删除已写的事实，而是写入等额冲抵事实（sourceType=material_movement_reopen）。
   *     之后重新过账会再写一张出库事实；再冲销时按净额取反，因此“过账→回退→再过账→冲销”最终净额为 0。
   *     已存在下游退料/报废的单据不允许回退（否则下游引用会失真）。
   *   - `pending_outbound`（撤回提交）：还没有任何库存事实，改状态即可，不需要写冲抵事实。
   *     没有这一步的话，生产填错数量提交之后就再也改不了，只能等仓库照错单出库。
   */
  async reopen(id: string, reason: string, user: CurrentUser) {
    if (!reason?.trim()) throw new UnprocessableEntityException({ code: "REOPEN_REASON_REQUIRED", message: "回退草稿必须填写原因", details: [] });
    const movement = await this.get(id);
    if (!["issue", "replenishment"].includes(movement.documentType)) throw new UnprocessableEntityException({ code: "INVALID_MATERIAL_MOVEMENT_TYPE", message: "只有领料单或补料单可以回退草稿", details: [] });
    if (movement.status === "pending_outbound") {
      const withdrawn = await this.prisma.$transaction(async (tx) => {
        const current = await tx.rawMaterialMovement.findFirst({ where: { id, status: "pending_outbound", deletedAt: null } });
        if (!current) throw new ConflictException({ code: "MATERIAL_MOVEMENT_NOT_PENDING", message: "单据已被其他操作处理（可能已被仓库出库），请刷新后重试", details: [] });
        return tx.rawMaterialMovement.update({ where: { id }, data: { status: "draft", submittedAt: null, remark: `${current.remark ?? ""}\n撤回提交：${reason.trim()}`, ...this.audit.update(user) } });
      });
      await this.audit.record("raw_material_movement.withdraw", "raw_material_movement", user.id, id, { order_no: movement.orderNo, production_order_id: movement.productionOrderId, reason: reason.trim(), from_movement_no: movement.movementNo });
      return withdrawn;
    }
    if (movement.status !== "posted") throw new UnprocessableEntityException({ code: "INVALID_MATERIAL_MOVEMENT_STATE", message: "只有已过账或已提交待出库的单据可以回退草稿", details: [] });
    const preview = await this.reversalPreview(id);
    if (!preview.can_reverse) throw new UnprocessableEntityException({ code: "DOWNSTREAM_RECORD_EXISTS", message: "存在后续退料或报废记录，不能回退草稿", details: [{ count: preview.dependent_record_count }] });
    const result = await this.prisma.$transaction(async (tx) => {
      const current = await tx.rawMaterialMovement.findFirst({ where: { id, status: "posted", deletedAt: null }, include: { lines: { where: { deletedAt: null } } } });
      if (!current) throw new ConflictException({ code: "MATERIAL_MOVEMENT_NOT_POSTED", message: "单据已被其他操作处理，请刷新后重试", details: [] });
      if (current.documentType === "issue") {
        const derived = await tx.rawMaterialMovementLine.count({ where: { sourceIssueLineId: { in: current.lines.map((line) => line.id) }, deletedAt: null, movement: { is: { status: "posted", deletedAt: null } } } });
        if (derived) throw new UnprocessableEntityException({ code: "DOWNSTREAM_RECORD_EXISTS", message: "存在后续退料或报废记录，不能回退草稿", details: [{ count: derived }] });
      }
      const facts = await tx.inventoryFact.findMany({ where: { sourceId: current.id } });
      for (const fact of facts) {
        if (!fact.materialId) continue;
        await tx.inventoryFact.create({ data: { materialId: fact.materialId, unitId: fact.unitId, inventoryCategory: fact.inventoryCategory, quantityDelta: fact.quantityDelta.negated(), sourceType: "material_movement_reopen", sourceId: current.id, orderNo: current.orderNo, productionOrderId: current.productionOrderId, rawMaterialMovementLineId: fact.rawMaterialMovementLineId, createdBy: user.id } });
      }
      return tx.rawMaterialMovement.update({ where: { id }, data: { status: "draft", idempotencyKey: `draft:${randomUUID()}`, remark: `${current.remark ?? ""}\n回退过账：${reason}`, ...this.audit.update(user) } });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    await this.audit.record("raw_material_movement.reopen", "raw_material_movement", user.id, id, { order_no: movement.orderNo, production_order_id: movement.productionOrderId, reason, from_movement_no: movement.movementNo });
    return result;
  }

  async reverse(id: string, reason: string, idempotencyKey: string, user: CurrentUser) {
    if (!reason?.trim()) throw new UnprocessableEntityException({ code: "REVERSAL_REASON_REQUIRED", message: "冲销必须填写原因", details: [] });
    if (!idempotencyKey?.trim()) throw new UnprocessableEntityException({ code: "IDEMPOTENCY_KEY_REQUIRED", message: "冲销必须提供幂等键", details: [] });
    const movement = await this.get(id);
    if (movement.status !== "posted") throw new UnprocessableEntityException({ code: "INVALID_MATERIAL_MOVEMENT_STATE", message: "只有已过账单据可以冲销", details: [] });
    const preview = await this.reversalPreview(id);
    if (!preview.can_reverse) throw new UnprocessableEntityException({ code: "DOWNSTREAM_RECORD_EXISTS", message: "存在后续退料或报废记录，不能冲销来源领料", details: [{ count: preview.dependent_record_count }] });
    try {
    const reversal = await this.prisma.$transaction(async (tx) => {
      const current = await tx.rawMaterialMovement.findFirst({ where: { id, status: "posted", deletedAt: null }, include: { lines: { where: { deletedAt: null } } } });
      if (!current) throw new ConflictException({ code: "MATERIAL_MOVEMENT_ALREADY_REVERSED", message: "单据已被其他操作冲销", details: [] });
      if (current.documentType === "issue") {
        const derived = await tx.rawMaterialMovementLine.count({ where: { sourceIssueLineId: { in: current.lines.map((line) => line.id) }, deletedAt: null, movement: { is: { status: "posted", deletedAt: null } } } });
        if (derived) throw new UnprocessableEntityException({ code: "DOWNSTREAM_RECORD_EXISTS", message: "存在后续退料或报废记录，不能冲销来源领料", details: [{ count: derived }] });
      }
      const facts = await tx.inventoryFact.findMany({ where: { sourceId: current.id } });
      // 按「物料+单位+库存类别」取净额再取反：单据可能经历“过账 → 回退草稿 → 再过账”，
      // 逐行取反会把回退时写入的冲抵事实也算一遍，导致库存多加/多减。
      const netByKey = new Map<string, { materialId: string; unitId: string; inventoryCategory: string; delta: Prisma.Decimal }>();
      for (const fact of facts) {
        if (!fact.materialId) continue;
        const key = `${fact.materialId}|${fact.unitId}|${fact.inventoryCategory}`;
        const current_ = netByKey.get(key);
        if (current_) current_.delta = current_.delta.plus(fact.quantityDelta);
        else netByKey.set(key, { materialId: fact.materialId, unitId: fact.unitId, inventoryCategory: fact.inventoryCategory, delta: fact.quantityDelta });
      }
      const netGroups = [...netByKey.values()].filter((group) => !group.delta.isZero());
      for (const group of netGroups) {
        // 净额为正（如退料回补）时冲销会扣减库存，必须先确认库存足够。
        if (group.inventoryCategory === "raw_material" && group.delta.isPositive()) {
          const balance = await this.inventory.rawMaterialBalance(tx, group.materialId, group.unitId);
          if (balance.minus(group.delta).isNegative()) throw new UnprocessableEntityException({ code: "INSUFFICIENT_INVENTORY", message: "冲销会造成原料库存不足", details: [{ material_id: group.materialId }] });
        }
      }
      const created = await tx.rawMaterialMovement.create({ data: { movementNo: `RV-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomUUID().slice(0, 8).toUpperCase()}`, documentType: "reversal", status: "posted", productionOrderId: current.productionOrderId, productionOrderOperationId: current.productionOrderOperationId, orderNo: current.orderNo, businessDate: new Date(), reason, remark: `冲销 ${current.movementNo}`, idempotencyKey, lines: { create: current.lines.map((line) => ({ materialId: line.materialId, unitId: line.unitId, quantity: line.quantity, bomReferenceQuantity: line.bomReferenceQuantity, sourceIssueLineId: line.id, remark: `冲销 ${current.movementNo}`, ...this.audit.create(user) })) }, ...this.audit.create(user) }, include: { lines: true } });
      const reversalLineByMaterial = new Map(created.lines.map((line) => [line.materialId, line.id]));
      for (const group of netGroups) {
        await tx.inventoryFact.create({ data: { materialId: group.materialId, unitId: group.unitId, inventoryCategory: group.inventoryCategory, quantityDelta: group.delta.negated(), sourceType: "material_movement_reversal", sourceId: created.id, orderNo: current.orderNo, productionOrderId: current.productionOrderId, rawMaterialMovementLineId: reversalLineByMaterial.get(group.materialId), createdBy: user.id } });
      }
      await tx.rawMaterialMovement.update({ where: { id }, data: { status: "reversed", remark: `${current.remark ?? ""}\n冲销：${reason}`, ...this.audit.update(user) } });
      return created;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      await this.audit.record("raw_material_movement.reverse", "raw_material_movement", user.id, id, { order_no: movement.orderNo, production_order_id: movement.productionOrderId, reversal_movement_id: reversal.id, reason });
      return reversal;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "P2034") throw new ConflictException({ code: "VERSION_CONFLICT", message: "库存已被其他操作更新，请刷新后重试", details: [] });
      if (error && typeof error === "object" && "code" in error && error.code === "P2002") throw new ConflictException({ code: "UNIQUE_VALUE_CONFLICT", message: "冲销单号或幂等键冲突，请检查后重试", details: [] });
      throw error;
    }
  }

  private async createDerived(documentType: "return" | "scrap", input: DerivedInput, user: CurrentUser) {
    const order = await this.requireInHouseOrder(input.production_order_id);
    const lines = await this.derivedLines(order.id, input.lines);
    const prefix = documentType === "return" ? "MR" : "MS";
    const movement = await this.prisma.rawMaterialMovement.create({
      data: {
        movementNo: `${prefix}-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomUUID().slice(0, 8).toUpperCase()}`,
        documentType,
        productionOrderId: order.id,
        orderNo: order.orderNo,
        businessDate: input.business_date ? new Date(input.business_date) : new Date(),
        reason: input.reason,
        remark: input.remark,
        idempotencyKey: `draft:${randomUUID()}`,
        lines: { create: lines.map((line) => ({ materialId: line.materialId, unitId: line.unitId, quantity: line.quantity, bomReferenceQuantity: line.bomReferenceQuantity, sourceIssueLineId: line.sourceIssueLineId, remark: line.remark, ...this.audit.create(user) })) },
        ...this.audit.create(user)
      },
      include: { lines: true }
    });
    await this.audit.record("raw_material_movement.create", "raw_material_movement", user.id, movement.id, { order_no: order.orderNo, production_order_id: order.id, document_type: documentType });
    return movement;
  }

  private async postDerived(documentType: "return" | "scrap", id: string, idempotencyKey: string, user: CurrentUser) {
    if (!idempotencyKey?.trim()) throw new UnprocessableEntityException({ code: "IDEMPOTENCY_KEY_REQUIRED", message: "过账必须提供幂等键", details: [] });
    const movement = await this.get(id);
    if (movement.documentType !== documentType) throw new UnprocessableEntityException({ code: "INVALID_MATERIAL_MOVEMENT_TYPE", message: "单据类型不匹配", details: [] });
    if (movement.status === "posted" && movement.idempotencyKey === idempotencyKey) return movement;
    if (movement.status !== "draft") throw new UnprocessableEntityException({ code: "INVALID_MATERIAL_MOVEMENT_STATE", message: "只有草稿单据可以过账", details: [] });
    await this.requireInHouseOrder(movement.productionOrderId);
    try {
      const posted = await this.prisma.$transaction(async (tx) => {
        const current = await tx.rawMaterialMovement.findFirst({ where: { id, deletedAt: null, status: "draft", documentType }, include: { lines: { where: { deletedAt: null } } } });
        if (!current) throw new ConflictException({ code: "MATERIAL_MOVEMENT_ALREADY_POSTED", message: "单据已被其他操作处理", details: [] });
        await this.requireInHouseOrder(current.productionOrderId, tx);
        // 同样先收集全部来源明细锁 key 排序后再加锁，避免相反顺序加锁死锁
        const derivedKeys = current.lines.map((line) => `derived:${line.sourceIssueLineId}`).sort();
        // 同上：advisory lock 返回 void，只能用 $executeRaw。
        for (const key of derivedKeys) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
        await this.derivedLines(current.productionOrderId, current.lines.map((line) => ({ source_issue_line_id: line.sourceIssueLineId!, quantity: line.quantity.toString(), remark: line.remark ?? undefined })), tx);
        const updated = await tx.rawMaterialMovement.update({ where: { id }, data: { status: "posted", idempotencyKey, ...this.audit.update(user) } });
        for (const line of current.lines) {
          await tx.inventoryFact.create({ data: { materialId: line.materialId, unitId: line.unitId, inventoryCategory: documentType === "return" ? "raw_material" : "scrap", quantityDelta: documentType === "return" ? line.quantity : line.quantity.negated(), sourceType: documentType === "return" ? "material_return" : "material_scrap", sourceId: current.id, orderNo: current.orderNo, productionOrderId: current.productionOrderId, rawMaterialMovementLineId: line.id, createdBy: user.id } });
        }
        return updated;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      await this.audit.record("raw_material_movement.post", "raw_material_movement", user.id, id, { order_no: movement.orderNo, production_order_id: movement.productionOrderId, document_type: documentType, idempotency_key: idempotencyKey });
      return posted;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "P2034") throw new ConflictException({ code: "VERSION_CONFLICT", message: "物料流转已被其他操作更新，请刷新后重试", details: [] });
      if (error && typeof error === "object" && "code" in error && error.code === "P2002") throw new ConflictException({ code: "UNIQUE_VALUE_CONFLICT", message: "单据号或幂等键冲突，请检查后重试", details: [] });
      throw error;
    }
  }

  private async derivedLines(productionOrderId: string, lines: DerivedLineInput[], client: PrismaService | Prisma.TransactionClient = this.prisma) {
    if (!Array.isArray(lines) || lines.length === 0) throw new UnprocessableEntityException({ code: "MATERIAL_MOVEMENT_LINES_REQUIRED", message: "单据至少需要一条物料明细", details: [] });
    const seen = new Set<string>();
    const result = [];
    for (const line of lines) {
      if (!line?.source_issue_line_id || seen.has(line.source_issue_line_id) || !this.isPositiveDecimal(line.quantity)) throw new UnprocessableEntityException({ code: "INVALID_MATERIAL_MOVEMENT_LINE", message: "来源领料明细和数量必须有效且不可重复", details: [] });
      seen.add(line.source_issue_line_id);
      const source = await client.rawMaterialMovementLine.findFirst({ where: { id: line.source_issue_line_id, deletedAt: null, movement: { productionOrderId, documentType: "issue", status: "posted", deletedAt: null } } });
      if (!source) throw new UnprocessableEntityException({ code: "SOURCE_ISSUE_LINE_INVALID", message: "来源领料明细不存在、未过账或不属于该生产单", details: [] });
      const derived = await client.rawMaterialMovementLine.findMany({ where: { sourceIssueLineId: source.id, deletedAt: null }, include: { movement: true } });
      const consumed = derived.filter((item) => item.movement.deletedAt === null && item.movement.status === "posted" && ["return", "scrap"].includes(item.movement.documentType)).reduce((sum, item) => sum.plus(item.quantity), new Prisma.Decimal(0));
      const available = new Prisma.Decimal(source.quantity).minus(consumed);
      if (available.lessThan(line.quantity)) {
        throw new UnprocessableEntityException({ code: "DERIVED_QUANTITY_EXCEEDED", message: "退料或报废数量超过来源领料可处分数量", details: [{ source_issue_line_id: source.id, available_quantity: available.toString() }] });
      }
      result.push({ materialId: source.materialId, unitId: source.unitId, quantity: line.quantity, bomReferenceQuantity: source.bomReferenceQuantity, sourceIssueLineId: source.id, remark: line.remark });
    }
    return result;
  }

  private async requireInHouseOrder(id: string, client: PrismaService | Prisma.TransactionClient = this.prisma) {
    const order = await client.productionOrder.findFirst({ where: { id, deletedAt: null }, include: { bom: true, executionLocation: true } });
    if (!order) throw new NotFoundException({ code: "PRODUCTION_ORDER_NOT_FOUND", message: "生产单不存在", details: [] });
    if (order.executionMode !== "in_house" || order.status !== "in_progress") throw new UnprocessableEntityException({ code: "PRODUCTION_ORDER_NOT_ISSUABLE", message: "只有生产中的厂内生产单可以领料", details: [] });
    return order;
  }

  private isPositiveDecimal(value: string) {
    return this.parseQuantity(value) !== null;
  }

  /** 统一数量解析护栏：正十进制、拒绝指数/符号/十六进制、小数位 ≤4、不超出 numeric(18,4)（整数 ≤14 位）。 */
  private parseQuantity(value: string) {
    if (typeof value !== "string" || value.length === 0 || !/^\d+(?:\.\d+)?$/.test(value)) return null;
    const [integerPart, fractionPart = ""] = value.split(".");
    if (fractionPart.length > 4 || (integerPart.replace(/^0+/, "").length || 1) > 14) return null;
    try {
      const parsed = new Prisma.Decimal(value);
      return parsed.gt(0) ? parsed : null;
    } catch {
      return null;
    }
  }

  private async previewLines(order: { id: string; orderNo: string; bomId: string | null }, lines: IssueLineInput[], client: PrismaService | Prisma.TransactionClient = this.prisma) {
    if (!Array.isArray(lines) || lines.length === 0) throw new UnprocessableEntityException({ code: "MATERIAL_MOVEMENT_LINES_REQUIRED", message: "领料单至少需要一条物料明细", details: [] });
    const seen = new Set<string>();
    const previewLines = [];
    for (const line of lines) {
      if (!line?.material_id || seen.has(line.material_id) || !this.isPositiveDecimal(line.quantity)) throw new UnprocessableEntityException({ code: "INVALID_MATERIAL_MOVEMENT_LINE", message: "领料物料和数量必须有效且不可重复", details: [] });
      seen.add(line.material_id);
      const material = await client.material.findFirst({ where: { id: line.material_id, isActive: true, deletedAt: null } });
      if (!material) throw new NotFoundException({ code: "MATERIAL_NOT_FOUND", message: "物料不存在或已停用", details: [] });
      if (material.materialType !== "raw_material") throw new UnprocessableEntityException({ code: "MATERIAL_NOT_RAW", message: "生产领料只能使用原料物料", details: [{ material_id: material.id }] });
      const bomItem = order.bomId ? await client.bomItem.findFirst({ where: { bomId: order.bomId, materialId: material.id, deletedAt: null } }) : null;
      const availableBefore = await this.inventory.rawMaterialBalance(client, material.id, material.defaultUnitId);
      const issued = await client.inventoryFact.aggregate({ where: { productionOrderId: order.id, materialId: material.id, unitId: material.defaultUnitId, inventoryCategory: "raw_material" }, _sum: { quantityDelta: true } });
      const cumulativeIssued = (issued._sum.quantityDelta ?? new Prisma.Decimal(0)).negated();
      const quantity = new Prisma.Decimal(line.quantity);
      const cumulativeAfter = cumulativeIssued.plus(quantity);
      const [purchased, received] = await Promise.all([
        client.purchaseOrderItem.aggregate({ where: { materialId: material.id, deletedAt: null, purchaseOrder: { orderNo: order.orderNo, deletedAt: null } }, _sum: { quantity: true } }),
        client.rawMaterialInbound.aggregate({ where: { materialId: material.id, orderNo: order.orderNo, deletedAt: null, status: "posted" }, _sum: { quantity: true } })
      ]);
      const purchaseOrdered = new Prisma.Decimal(purchased._sum.quantity ?? 0);
      const purchaseReceived = new Prisma.Decimal(received._sum.quantity ?? 0);
      const approvedQuantity = bomItem?.approvedUsage ?? bomItem?.requiredQuantity ?? null;
      const purchaseOutstanding = purchaseOrdered.minus(purchaseReceived);
      const productionOutstanding = approvedQuantity ? approvedQuantity.minus(cumulativeIssued) : null;
      const risks = [] as { type: string; context: Prisma.InputJsonValue }[];
      if (!bomItem) risks.push({ type: "MATERIAL_NOT_IN_BOM_WARNING", context: { material_id: material.id, quantity: line.quantity } });
      if (bomItem && cumulativeAfter.greaterThan(bomItem.requiredQuantity)) risks.push({ type: "OVER_ISSUE_WARNING", context: { material_id: material.id, bom_reference_quantity: bomItem.requiredQuantity.toString(), cumulative_issue_quantity: cumulativeAfter.toString() } });
      previewLines.push({
        id: undefined as string | undefined,
        material_id: material.id,
        material_name: material.name,
        material_code: material.materialCode,
        model: bomItem?.specificationModel ?? bomItem?.model ?? null,
        color: bomItem?.color ?? null,
        unit_id: material.defaultUnitId,
        unit: bomItem?.unit ?? null,
        quantity: line.quantity,
        remark: line.remark,
        bom_reference_quantity: bomItem?.requiredQuantity?.toString() ?? null,
        approved_usage: approvedQuantity?.toString() ?? null,
        available_before: availableBefore,
        available_after: availableBefore.minus(quantity),
        inventory_quantity: availableBefore.toString(),
        purchase_received_quantity: purchaseReceived.toString(),
        purchase_outstanding_quantity: purchaseOutstanding.toString(),
        cumulative_issued_before: cumulativeIssued,
        cumulative_issued_after: cumulativeAfter,
        production_outstanding_quantity: productionOutstanding?.toString() ?? null,
        requested_replenishment_quantity: "0",
        risks
      });
    }
    return { lines: previewLines };
  }
}
