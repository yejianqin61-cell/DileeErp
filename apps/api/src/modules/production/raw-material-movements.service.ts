import { ConflictException, ForbiddenException, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { AuditService } from "../../platform/audit/audit.service";
import type { CurrentUser } from "../../platform/auth/auth.service";
import { PrismaService } from "../../platform/database/prisma.service";
import { InventoryService } from "../../platform/inventory/inventory.service";
// 预估列要与领取单打印件同名同值，口径与导出服务共用一份实现（material-slip-quantity.ts）。
import { issueReferenceQuantity as issueReferenceQuantityOf, issuedBeforeQuantity, remainingQuantity as remainingQuantityOf } from "./material-slip-quantity";

// unit_id / source_production_order_id 只在「跨订单调料」时出现：
// 单位按来源库存单位锁定；来源生产单写进风险上下文留痕（不新增表/迁移）。
type IssueLineInput = { material_id: string; quantity: string; supplier_id?: string | null; unit_id?: string | null; source_production_order_id?: string | null; remark?: string };
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
/** 跨订单领料的来源留痕类型：context 里保存来源生产单 / 来源订单号，便于审计与导出追溯。 */
const CROSS_ORDER_SOURCE = "CROSS_ORDER_SOURCE";
const CROSS_ORDER_REASON = "跨订单领料来源留痕";

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
    const events = await this.prisma.auditEvent.findMany({ where: { entityType: "raw_material_movement", entityId: id }, orderBy: { createdAt: "desc" } });
    // 审计行只有 actorId（不是 createdBy），全站的姓名拦截器认不到它：这里补姓名，界面不显示 UUID。
    const actorIds = [...new Set(events.flatMap((event) => (event.actorId ? [event.actorId] : [])))];
    const actors = actorIds.length ? await this.prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, displayName: true } }) : [];
    const names = new Map(actors.map((actor) => [actor.id, actor.displayName]));
    return events.map((event) => ({ ...event, actor_name: (event.actorId ? names.get(event.actorId) : null) ?? null }));
  }

  async preview(input: IssueInput, user?: CurrentUser) {
    const order = await this.requireInHouseOrder(input.production_order_id);
    if (this.hasCrossOrderLines(input.lines)) await this.assertCrossOrderPermission(user);
    return this.previewLines(order, input.lines);
  }

  async createIssue(input: IssueInput, user: CurrentUser) {
    const order = await this.requireInHouseOrder(input.production_order_id);
    if (this.hasCrossOrderLines(input.lines)) await this.assertCrossOrderPermission(user);
    // 领料单只绑定生产单，不再绑定工序；同一个生产单可以开多张领料单（按需分批领料）。
    const preview = await this.previewLines(order, input.lines);
    const crossOrderRisks = this.crossOrderSourceRisks(preview.lines, user);
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
        lines: { create: preview.lines.map((line) => ({ materialId: line.material_id, unitId: line.unit_id, supplierId: line.supplier_id ?? null, quantity: line.quantity, bomReferenceQuantity: line.bom_reference_quantity, remark: line.remark, ...this.audit.create(user) })) },
        ...(crossOrderRisks.length ? { risks: { create: crossOrderRisks } } : {}),
        ...this.audit.create(user)
      },
      include: { lines: true, risks: true }
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
    // 跨订单调料只属于领料：补料是坏片/失误的补领，不应把来源订单借用混进来。
    if (this.hasCrossOrderLines(input.lines)) throw new UnprocessableEntityException({ code: "CROSS_ORDER_SOURCE_NOT_ALLOWED", message: "补料单不支持跨订单调料，请用领料单", details: [] });
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
        lines: { create: preview.lines.map((line) => ({ materialId: line.material_id, unitId: line.unit_id, supplierId: line.supplier_id ?? null, quantity: line.quantity, bomReferenceQuantity: line.bom_reference_quantity, remark: line.remark, ...this.audit.create(user) })) },
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
    if (this.hasCrossOrderLines(input.lines)) await this.assertCrossOrderPermission(user);
    const preview = input.lines ? await this.previewLines(order, input.lines) : null;
    const crossOrderRisks = preview ? this.crossOrderSourceRisks(preview.lines, user) : [];
    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM raw_material_movements WHERE id = ${id}::uuid FOR UPDATE`;
      const current = await tx.rawMaterialMovement.findFirst({ where: { id, deletedAt: null }, select: { status: true } });
      if (!current || current.status !== "draft") throw new ConflictException({ code: "MATERIAL_MOVEMENT_NOT_EDITABLE", message: "领料单已被其他操作处理，请刷新后重试", details: [] });
      if (preview) {
        await tx.rawMaterialMovementLine.updateMany({ where: { movementId: id, deletedAt: null }, data: this.audit.softDelete(user) });
        // 明细整批替换时，跨订单来源留痕也必须跟着换；否则改了来源订单，风险上下文还指着旧订单。
        await tx.rawMaterialMovementRisk.updateMany({ where: { movementId: id, riskType: CROSS_ORDER_SOURCE, deletedAt: null }, data: this.audit.softDelete(user) });
      }
      return tx.rawMaterialMovement.update({
        where: { id },
        data: {
          ...(input.business_date === undefined ? {} : { businessDate: new Date(input.business_date) }),
          ...(input.reason === undefined ? {} : { reason: input.reason }),
          ...(input.remark === undefined ? {} : { remark: input.remark }),
          ...(preview ? { lines: { create: preview.lines.map((line) => ({ materialId: line.material_id, unitId: line.unit_id, supplierId: line.supplier_id ?? null, quantity: line.quantity, bomReferenceQuantity: line.bom_reference_quantity, remark: line.remark, ...this.audit.create(user) })) } } : {}),
          ...(crossOrderRisks.length ? { risks: { create: crossOrderRisks } } : {}),
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
    const preview = await this.previewLines(movement.productionOrder, this.linesWithCrossOrderSource(movement), this.prisma, movement.id);
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
    if (this.hasCrossOrderMovement(movement)) await this.assertCrossOrderPermission(user);
    if (!["issue", "replenishment"].includes(movement.documentType)) throw new UnprocessableEntityException({ code: "INVALID_MATERIAL_MOVEMENT_TYPE", message: "只有领料单或补料单需要仓库确认出库", details: [] });
    if (movement.status !== "draft") throw new UnprocessableEntityException({ code: "INVALID_MATERIAL_MOVEMENT_STATE", message: `只有草稿单据可以提交仓库（当前：${movement.status}）`, details: [] });
    const order = await this.requireInHouseOrder(movement.productionOrderId);
    const preview = await this.previewLines(order, this.linesWithCrossOrderSource(movement), this.prisma, id);
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
    if (this.hasCrossOrderMovement(movement)) await this.assertCrossOrderPermission(user);
    if (movement.documentType !== kind) throw new UnprocessableEntityException({ code: "INVALID_MATERIAL_MOVEMENT_TYPE", message: kind === "issue" ? "该单据不是领料单" : "该单据不是补料单", details: [] });
    if (movement.status === "posted" && movement.idempotencyKey === idempotencyKey) return movement;
    if (movement.status !== "pending_outbound") throw new UnprocessableEntityException({ code: "INVALID_MATERIAL_MOVEMENT_STATE", message: `只有已确认待出库的${label}单可以出库；草稿请先由生产「确认提交」，当前状态：${movement.status}`, details: [] });
    const order = await this.requireInHouseOrder(movement.productionOrderId);
    const preview = await this.previewLines(order, this.linesWithCrossOrderSource(movement), this.prisma, id);
    // 超领/非 BOM 物料不再阻塞过账（业务确认该门禁没有必要）；风险仍在事务内照常记录，仅作审计留痕。
    if (preview.lines.some((line) => line.available_after.isNegative())) throw new UnprocessableEntityException({ code: "INSUFFICIENT_INVENTORY", message: `${label}会造成原料库存不足`, details: preview.lines.filter((line) => line.available_after.isNegative()).map((line) => ({ material_id: line.material_id, available_quantity: line.available_before.toString() })) });

    try {
      const posted = await this.prisma.$transaction(async (tx) => {
        // 必须带 risks：跨订单领料的来源不存明细列，只存风险上下文；
        // 事务内复核若丢掉来源，就会按本单 BOM/默认单位而不是来源库存单位校验。
        const current = await tx.rawMaterialMovement.findFirst({ where: { id, deletedAt: null }, include: { lines: { where: { deletedAt: null } }, risks: { where: { deletedAt: null } } } });
        if (!current || current.status !== "pending_outbound") throw new ConflictException({ code: "MATERIAL_MOVEMENT_ALREADY_POSTED", message: `${label}单已被其他操作处理`, details: [] });
        const lockedOrder = await this.requireInHouseOrder(current.productionOrderId, tx);
        // 先收集全部物料 advisory lock key 并排序后再加锁，避免并发多物料单据以相反顺序加锁造成死锁
        // lock key 带上 supplier_id，使同一物料不同供应商的两张单据不互相阻塞。
        const materialKeys = current.lines.map((line) => `${line.materialId}|${line.unitId}|${line.supplierId ?? "__none__"}`).sort();
        // pg_advisory_xact_lock 返回 void：必须用 $executeRaw（不反序列化结果列）。
        // 用 $queryRaw 会抛 "Failed to deserialize column of type 'void'"，导致过账必然 500。
        for (const key of materialKeys) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
        // 用 linesWithCrossOrderSource 还原 unit_id / 来源生产单：跨订单行按来源库存单位记账，
        // 不能用默认单位复核余额，否则张/个混账时会误判库存不足。
        const lockedPreview = await this.previewLines(lockedOrder, this.linesWithCrossOrderSource(current), tx, id);
        if (lockedPreview.lines.some((line) => line.available_after.isNegative())) throw new UnprocessableEntityException({ code: "INSUFFICIENT_INVENTORY", message: `${label}会造成原料库存不足`, details: [] });
        // 风险 line_id 必须指向数据库真实明细行（preview 行 id 为 undefined）。
        // 优先按 material_id + unit_id + supplier_id 精确关联；预览行没带 unit_id 的旧路径
        // 回退到 material_id + supplier_id，避免风险行变成“无归属”。
        const dbLineByMaterialUnit = new Map(current.lines.map((dbLine) => [`${dbLine.materialId}|${dbLine.unitId}|${dbLine.supplierId ?? "__none__"}`, dbLine]));
        const dbLineByMaterial = new Map(current.lines.map((dbLine) => [`${dbLine.materialId}|${dbLine.supplierId ?? "__none__"}`, dbLine]));
        const lockedRisks = lockedPreview.lines.flatMap((line) => line.risks.map((risk) => {
          const dbLine = dbLineByMaterialUnit.get(`${line.material_id}|${line.unit_id}|${line.supplier_id ?? "__none__"}`)
            ?? dbLineByMaterial.get(`${line.material_id}|${line.supplier_id ?? "__none__"}`);
          return { line_id: dbLine?.id ?? null, risk_type: risk.type, context: risk.context };
        }));
        const updated = await tx.rawMaterialMovement.update({ where: { id }, data: { status: "posted", idempotencyKey, ...this.audit.update(user) } });
        for (const line of current.lines) {
          await tx.inventoryFact.create({ data: { materialId: line.materialId, unitId: line.unitId, supplierId: line.supplierId ?? null, inventoryCategory: "raw_material", quantityDelta: `-${line.quantity}`, sourceType, sourceId: current.id, orderNo: current.orderNo, productionOrderId: current.productionOrderId, rawMaterialMovementLineId: line.id, createdBy: user.id } });
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
        await tx.inventoryFact.create({ data: { materialId: fact.materialId, unitId: fact.unitId, supplierId: fact.supplierId ?? null, inventoryCategory: fact.inventoryCategory, quantityDelta: fact.quantityDelta.negated(), sourceType: "material_movement_reopen", sourceId: current.id, orderNo: current.orderNo, productionOrderId: current.productionOrderId, rawMaterialMovementLineId: fact.rawMaterialMovementLineId, createdBy: user.id } });
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
      const netByKey = new Map<string, { materialId: string; unitId: string; inventoryCategory: string; supplierId: string | null; delta: Prisma.Decimal }>();
      for (const fact of facts) {
        if (!fact.materialId) continue;
        const key = `${fact.materialId}|${fact.unitId}|${fact.inventoryCategory}|${fact.supplierId ?? "__none__"}`;
        const current_ = netByKey.get(key);
        if (current_) current_.delta = current_.delta.plus(fact.quantityDelta);
        else netByKey.set(key, { materialId: fact.materialId, unitId: fact.unitId, inventoryCategory: fact.inventoryCategory, supplierId: fact.supplierId ?? null, delta: fact.quantityDelta });
      }
      const netGroups = [...netByKey.values()].filter((group) => !group.delta.isZero());
      for (const group of netGroups) {
        // 净额为正（如退料回补）时冲销会扣减库存，必须先确认库存足够。
        if (group.inventoryCategory === "raw_material" && group.delta.isPositive()) {
          const balance = await this.inventory.rawMaterialBalanceBySupplier(tx, group.materialId, group.unitId, group.supplierId);
          if (balance.minus(group.delta).isNegative()) throw new UnprocessableEntityException({ code: "INSUFFICIENT_INVENTORY", message: "冲销会造成原料库存不足", details: [{ material_id: group.materialId }] });
        }
      }
      const created = await tx.rawMaterialMovement.create({ data: { movementNo: `RV-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomUUID().slice(0, 8).toUpperCase()}`, documentType: "reversal", status: "posted", productionOrderId: current.productionOrderId, productionOrderOperationId: current.productionOrderOperationId, orderNo: current.orderNo, businessDate: new Date(), reason, remark: `冲销 ${current.movementNo}`, idempotencyKey, lines: { create: current.lines.map((line) => ({ materialId: line.materialId, unitId: line.unitId, supplierId: line.supplierId ?? null, quantity: line.quantity, bomReferenceQuantity: line.bomReferenceQuantity, sourceIssueLineId: line.id, remark: `冲销 ${current.movementNo}`, ...this.audit.create(user) })) }, ...this.audit.create(user) }, include: { lines: true } });
      const reversalLineByMaterial = new Map(created.lines.map((line) => [`${line.materialId}|${line.supplierId ?? "__none__"}`, line.id]));
      for (const group of netGroups) {
        await tx.inventoryFact.create({ data: { materialId: group.materialId, unitId: group.unitId, supplierId: group.supplierId, inventoryCategory: group.inventoryCategory, quantityDelta: group.delta.negated(), sourceType: "material_movement_reversal", sourceId: created.id, orderNo: current.orderNo, productionOrderId: current.productionOrderId, rawMaterialMovementLineId: reversalLineByMaterial.get(`${group.materialId}|${group.supplierId ?? "__none__"}`), createdBy: user.id } });
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
      result.push({ materialId: source.materialId, unitId: source.unitId, supplierId: source.supplierId ?? null, quantity: line.quantity, bomReferenceQuantity: source.bomReferenceQuantity, sourceIssueLineId: source.id, remark: line.remark });
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

  /** 是否包含跨订单调料行（只有领料单允许；补料单直接拒绝）。 */
  private hasCrossOrderLines(lines?: IssueLineInput[]) {
    return Boolean(lines?.some((line) => line?.source_production_order_id));
  }

  /** 单据是否已留存跨订单来源（风险上下文）：提交/过账时据此再校验一次权限。 */
  private hasCrossOrderMovement(movement: { risks?: Array<{ riskType: string }> }) {
    return Boolean(movement.risks?.some((risk) => risk.riskType === CROSS_ORDER_SOURCE));
  }

  /**
   * 跨订单调料的权限：除生产外必须拥有仓库模块（或管理员级角色）。
   *
   * 为什么不只靠前端隐藏入口：`role_permissions` 才是实际权限的唯一真相（与 ModulePermissionGuard 同口径）。
   * 前端 `useSessionProfile().module_keys` 只决定显不显示入口，这里拒绝伪造请求。
   */
  private async assertCrossOrderPermission(user?: CurrentUser) {
    if (!user) throw new ForbiddenException("跨订单调料需要仓库模块权限");
    const roles = await this.prisma.userRole.findMany({ where: { userId: user.id, role: { deletedAt: null } }, include: { role: { include: { permissions: true } } } });
    const allowed = roles.some(({ role }) => role.key === "administrator" || role.permissions.some((permission) => permission.moduleKey === "warehouse"));
    if (!allowed) throw new ForbiddenException("跨订单调料需要仓库模块权限：请让管理员在角色里授予仓库模块");
  }

  /** 来源生产单必须存在、厂内、非本单/同订单；否则「来源订单」只是一个可以随便填的字符串。 */
  private async requireCrossOrderSource(client: PrismaService | Prisma.TransactionClient, order: { id: string; orderNo: string }, sourceProductionOrderId: string) {
    const source = await client.productionOrder.findFirst({
      where: { id: sourceProductionOrderId, deletedAt: null },
      select: { id: true, productionOrderNo: true, orderNo: true, status: true, executionMode: true, bomId: true },
    });
    if (!source) throw new NotFoundException({ code: "CROSS_ORDER_SOURCE_NOT_FOUND", message: "来源生产单不存在", details: [{ source_production_order_id: sourceProductionOrderId }] });
    if (source.id === order.id || source.orderNo === order.orderNo) throw new UnprocessableEntityException({ code: "CROSS_ORDER_SOURCE_SAME_ORDER", message: "来源生产单不能是本单或本单所属订单：跨订单调料只能调其他订单的库存", details: [] });
    if (source.executionMode !== "in_house") throw new UnprocessableEntityException({ code: "CROSS_ORDER_SOURCE_NOT_IN_HOUSE", message: "来源生产单不是厂内生产单，没有本厂原料库存", details: [] });
    if (["draft", "cancelled"].includes(source.status)) throw new UnprocessableEntityException({ code: "CROSS_ORDER_SOURCE_NOT_AVAILABLE", message: "来源生产单尚未开始或已取消，没有可领用的库存", details: [] });
    return source;
  }

  /**
   * 来源订单已经被**其他生产单跨订单预占/借走**的数量。
   *
   * 计入 `pending_outbound`：生产「保存并提交仓库」后，来源可用量应立即扣减，
   * 否则提交完再查来源订单仍显示原数量，和用户看到的「已提交」不一致。
   * 复核本单自身时传 excludeMovementId 排除自己（本单的预占不能把自己拦下）。
   *
   * 库存仍是物料级结存（不新增订单库存表）：跨订单领料写出的库存事实仍归领用方订单，
   * 所以来源订单的可用量必须在这里按风险留痕扣一次，否则「借走之后来源单还能无限再借」。
   * 领料单回退草稿/冲销后状态不再是 posted/pending_outbound，这里自然不再扣，来源可用量随之恢复。
   */
  private async crossOrderBorrowed(
    client: PrismaService | Prisma.TransactionClient,
    sourceProductionOrderId: string,
    materialId: string,
    unitId: string,
    supplierId: string | null,
    excludeMovementId?: string,
  ) {
    const risks = await client.rawMaterialMovementRisk.findMany({
      where: {
        riskType: CROSS_ORDER_SOURCE,
        deletedAt: null,
        movement: {
          is: {
            documentType: "issue",
            status: { in: ["posted", "pending_outbound"] },
            deletedAt: null,
            ...(excludeMovementId ? { id: { not: excludeMovementId } } : {}),
          },
        },
        context: { path: ["source_production_order_id"], equals: sourceProductionOrderId },
      },
      select: { context: true },
    });
    let borrowed = new Prisma.Decimal(0);
    for (const risk of risks) {
      const context = (risk.context && typeof risk.context === "object" ? risk.context : {}) as Record<string, unknown>;
      if (context.material_id !== materialId) continue;
      if (String(context.unit_id ?? "") !== unitId) continue;
      if ((typeof context.supplier_id === "string" ? context.supplier_id : null) !== supplierId) continue;
      const quantity = new Prisma.Decimal(String(context.quantity ?? "0"));
      if (quantity.isPositive()) borrowed = borrowed.plus(quantity);
    }
    return borrowed;
  }

  /** 来源订单该物料「已入库 − 来源单已领用 − 已被其他订单预占/借走」的剩余量。库存本身仍是物料级结存。 */
  private async crossOrderAvailable(
    client: PrismaService | Prisma.TransactionClient,
    source: { id: string; orderNo: string },
    materialId: string,
    unitId: string,
    supplierId: string | null,
    excludeMovementId?: string,
  ) {
    // 原料入库行的 supplierId 是非空列：来源可用量只在明确到具体供应商时才有意义。
    if (!supplierId) return new Prisma.Decimal(0);
    const [inbound, facts, borrowed] = await Promise.all([
      client.rawMaterialInbound.aggregate({ where: { materialId, orderNo: source.orderNo, unitId, supplierId, status: "posted", deletedAt: null }, _sum: { quantity: true } }),
      client.inventoryFact.aggregate({ where: { productionOrderId: source.id, materialId, unitId, supplierId, inventoryCategory: { in: ["raw_material", "scrap"] } }, _sum: { quantityDelta: true } }),
      this.crossOrderBorrowed(client, source.id, materialId, unitId, supplierId, excludeMovementId),
    ]);
    return new Prisma.Decimal(inbound._sum?.quantity ?? 0).plus(facts._sum?.quantityDelta ?? 0).minus(borrowed);
  }

  /** 把预览行上的跨订单来源写成单据级风险（context 即追溯字段，不新增表/迁移）。 */
  private crossOrderSourceRisks(lines: Array<{ material_id: string; unit_id: string; supplier_id?: string | null; quantity: string; source_production_order_id?: string | null; source_production_order_no?: string | null; source_order_no?: string | null }>, user: CurrentUser) {
    return lines
      .filter((line) => line.source_production_order_id)
      .map((line) => ({
        riskType: CROSS_ORDER_SOURCE,
        context: {
          material_id: line.material_id,
          unit_id: line.unit_id,
          supplier_id: line.supplier_id ?? null,
          source_production_order_id: line.source_production_order_id,
          source_production_order_no: line.source_production_order_no ?? null,
          source_order_no: line.source_order_no ?? null,
          quantity: line.quantity,
        } as Prisma.InputJsonValue,
        reason: CROSS_ORDER_REASON,
        confirmedBy: user.id,
        ...this.audit.create(user),
      }));
  }

  /** 已保存的单据明细本身不存来源字段（不新增列），提交/过账时从风险上下文还原，再走同一套校验。 */
  private linesWithCrossOrderSource(movement: { lines: Array<{ materialId: string; unitId: string; supplierId: string | null; quantity: Prisma.Decimal; remark: string | null }>; risks?: Array<{ riskType: string; context: Prisma.JsonValue }> }) {
    const sourceByKey = new Map<string, Record<string, unknown>>();
    for (const risk of movement.risks ?? []) {
      if (risk.riskType !== CROSS_ORDER_SOURCE) continue;
      const context = (risk.context && typeof risk.context === "object" ? risk.context : {}) as Record<string, unknown>;
      if (typeof context.material_id === "string") sourceByKey.set(`${context.material_id}|${String(context.unit_id ?? "")}|${String(context.supplier_id ?? "__none__")}`, context);
    }
    return movement.lines.map((line) => {
      const source = sourceByKey.get(`${line.materialId}|${line.unitId}|${line.supplierId ?? "__none__"}`);
      return {
        material_id: line.materialId,
        unit_id: line.unitId,
        supplier_id: line.supplierId,
        quantity: line.quantity.toString(),
        remark: line.remark ?? undefined,
        ...(source ? { source_production_order_id: String(source.source_production_order_id) } : {}),
      };
    });
  }

  /**
   * 跨订单库存检索：按物料名称，在**其他生产订单**「已入库未领用」的库存里找可领物料。
   *
   * 口径说明（与仓库现有物料级结存一致，不做订单专属账）：
   *   来源可用量 = 该来源订单号下已过账入库 − 该来源生产单已领用（含报废，退料回补）− 已被其他订单借走。
   *   同时要求物料级结存 > 0，避免把已领空的料再挂到别的单上；领用数量超过来源可用量会被 422 拒绝。
   * 查询按物料逐个聚合（命中物料最多 20 个），数据量有上界；搜索由用户显式触发，不进列表页热路径。
   */
  async searchCrossOrderStock(productionOrderId: string, keyword: string) {
    const order = await this.requireInHouseOrder(productionOrderId);
    const query = (keyword ?? "").trim();
    if (query.length > 100) throw new UnprocessableEntityException({ code: "CROSS_ORDER_KEYWORD_TOO_LONG", message: "物料名称关键词不能超过 100 个字符", details: [] });
    if (!query) return { items: [] };
    const materials = await this.prisma.material.findMany({
      where: { deletedAt: null, isActive: true, materialType: "raw_material", name: { contains: query, mode: "insensitive" } },
      select: { id: true, materialCode: true, name: true, specificationModel: true, color: true, defaultUnitId: true },
      orderBy: { name: "asc" },
      take: 20,
    });
    const candidates: Array<{
      material_id: string; material_code: string; material_name: string; specification_model: string | null; color: string | null;
      unit_id: string; unit_name: string; supplier_id: string | null; supplier_name: string | null;
      source_production_order_id: string; source_production_order_no: string; source_order_no: string;
      source_available_quantity: string; inventory_quantity: string;
    }> = [];
    for (const material of materials) {
      const [bomItems, inbounds, facts] = await Promise.all([
        this.prisma.bomItem.findMany({ where: { materialId: material.id, deletedAt: null }, select: { bomId: true, unitId: true }, orderBy: { bomId: "asc" } }),
        this.prisma.rawMaterialInbound.findMany({
          where: { materialId: material.id, status: "posted", deletedAt: null },
          select: { orderNo: true, unitId: true, supplierId: true, quantity: true, unit: { select: { name: true } }, supplier: { select: { name: true } } },
        }),
        this.prisma.inventoryFact.findMany({
          where: { materialId: material.id, inventoryCategory: { in: ["raw_material", "scrap"] } },
          select: { productionOrderId: true, unitId: true, supplierId: true, quantityDelta: true },
        }),
      ]);
      const bomIds = [...new Set(bomItems.map((item) => item.bomId))];
      if (!bomIds.length) continue;
      const sourceOrders = await this.prisma.productionOrder.findMany({
        where: { id: { not: order.id }, orderNo: { not: order.orderNo }, bomId: { in: bomIds }, deletedAt: null, executionMode: "in_house", status: { in: ["in_progress", "paused", "completed", "closed"] } },
        select: { id: true, productionOrderNo: true, orderNo: true, bomId: true },
        orderBy: { productionOrderNo: "asc" },
      });
      for (const source of sourceOrders) {
        const sourceInbounds = inbounds.filter((inbound) => inbound.orderNo === source.orderNo);
        if (!sourceInbounds.length) continue;
        const buckets = new Map<string, { unitId: string; unitName: string; supplierId: string | null; supplierName: string | null; received: Prisma.Decimal }>();
        for (const inbound of sourceInbounds) {
          const key = `${inbound.unitId}|${inbound.supplierId ?? "__none__"}`;
          const current = buckets.get(key);
          if (current) current.received = current.received.plus(inbound.quantity);
          else buckets.set(key, { unitId: inbound.unitId, unitName: inbound.unit?.name ?? "", supplierId: inbound.supplierId ?? null, supplierName: inbound.supplier?.name ?? null, received: new Prisma.Decimal(inbound.quantity) });
        }
        for (const bucket of buckets.values()) {
          const issued = facts
            .filter((fact) => fact.productionOrderId === source.id && fact.unitId === bucket.unitId && (fact.supplierId ?? null) === bucket.supplierId)
            .reduce((sum, fact) => sum.plus(fact.quantityDelta), new Prisma.Decimal(0));
          // 已被其他生产单借走的部分也要从来源可用量里扣掉；否则来源单的料会被反复列出、反复借。
          const borrowed = await this.crossOrderBorrowed(this.prisma, source.id, material.id, bucket.unitId, bucket.supplierId);
          const available = bucket.received.plus(issued).minus(borrowed);
          const global = facts
            .filter((fact) => fact.unitId === bucket.unitId && (fact.supplierId ?? null) === bucket.supplierId)
            .reduce((sum, fact) => sum.plus(fact.quantityDelta), new Prisma.Decimal(0));
          if (available.lte(0) || global.lte(0)) continue;
          if (candidates.some((item) => item.material_id === material.id && item.unit_id === bucket.unitId && (item.supplier_id ?? null) === bucket.supplierId && item.source_production_order_id === source.id)) continue;
          candidates.push({
            material_id: material.id,
            material_code: material.materialCode,
            material_name: material.name,
            specification_model: material.specificationModel ?? null,
            color: material.color ?? null,
            unit_id: bucket.unitId,
            unit_name: bucket.unitName,
            supplier_id: bucket.supplierId,
            supplier_name: bucket.supplierName,
            source_production_order_id: source.id,
            source_production_order_no: source.productionOrderNo,
            source_order_no: source.orderNo,
            source_available_quantity: available.toString(),
            inventory_quantity: global.toString(),
          });
        }
      }
    }
    return { items: candidates.slice(0, 50) };
  }

  private async previewLines(order: { id: string; orderNo: string; bomId: string | null }, lines: IssueLineInput[], client: PrismaService | Prisma.TransactionClient = this.prisma, excludeMovementId?: string) {
    if (!Array.isArray(lines) || lines.length === 0) throw new UnprocessableEntityException({ code: "MATERIAL_MOVEMENT_LINES_REQUIRED", message: "领料单至少需要一条物料明细", details: [] });
    const seen = new Set<string>();
    const previewLines = [];
    // 同一物料 + 同一单位下，按供应商拆分的结存，供前端 hover title / 下拉里显示各档位结存。
    const bucketsByKey = new Map<string, Promise<Array<{ supplier_id: string | null; supplier_name: string | null; quantity: Prisma.Decimal }>>>();
    const getBuckets = async (materialId: string, unitId: string) => {
      const key = `${materialId}|${unitId}`;
      if (!bucketsByKey.has(key)) bucketsByKey.set(key, this.inventory.rawMaterialSupplierBuckets(client, materialId, unitId));
      return bucketsByKey.get(key)!;
    };
    for (const line of lines) {
      if (!line?.material_id || !this.isPositiveDecimal(line.quantity)) throw new UnprocessableEntityException({ code: "INVALID_MATERIAL_MOVEMENT_LINE", message: "领料物料和数量必须有效且不可重复", details: [] });
      const material = await client.material.findFirst({ where: { id: line.material_id, isActive: true, deletedAt: null } });
      if (!material) throw new NotFoundException({ code: "MATERIAL_NOT_FOUND", message: "物料不存在或已停用", details: [] });
      if (material.materialType !== "raw_material") throw new UnprocessableEntityException({ code: "MATERIAL_NOT_RAW", message: "生产领料只能使用原料物料", details: [{ material_id: material.id }] });
      // 跨订单调料：来源生产单必须是**其他订单**的真实生产单；权限在入口处已校验，
      // 这里只做归属校验，避免把本单自己的料伪装成「其他订单的库存」。
      const crossOrder = line.source_production_order_id ? await this.requireCrossOrderSource(client, order, line.source_production_order_id) : null;
      // 单位优先取显式 unit_id（跨订单库存按来源单位记账），其次 BOM 行单位（贴纸的坑：
      // defaultUnit=个、BOM 行=张、库存记在张；按 defaultUnit 取余额会恒为 0），最后物料默认单位。
      const unitOverride = line.unit_id ? await client.unit.findFirst({ where: { id: line.unit_id, deletedAt: null }, select: { id: true, name: true } }) : null;
      if (line.unit_id && !unitOverride) throw new UnprocessableEntityException({ code: "UNIT_NOT_FOUND", message: "领料单位不存在", details: [{ unit_id: line.unit_id }] });
      const bomItem = order.bomId ? await client.bomItem.findFirst({ where: { bomId: order.bomId, materialId: material.id, deletedAt: null } }) : null;
      // 没有显式单位时，跨订单行优先取来源生产单 BOM 上的单位，避免同一物料「张/个」混账。
      const sourceBomItem = crossOrder?.bomId ? await client.bomItem.findFirst({ where: { bomId: crossOrder.bomId, materialId: material.id, deletedAt: null } }) : null;
      const resolvedUnitId = unitOverride?.id ?? (crossOrder ? sourceBomItem?.unitId : bomItem?.unitId) ?? material.defaultUnitId;
      const resolvedUnitName = unitOverride?.name ?? (crossOrder ? sourceBomItem?.unit : bomItem?.unit) ?? null;
      const sourceAvailable = crossOrder ? await this.crossOrderAvailable(client, crossOrder, material.id, resolvedUnitId, line.supplier_id ?? null, excludeMovementId) : null;
      // 跨订单领料硬门禁：不允许超过来源订单当前可用库存。
      // 放在其他余额/采购查询之前，超量时直接 422，不把「其实领不出来」的明细算出一堆数字再让用户保存失败。
      const requestedQuantity = new Prisma.Decimal(line.quantity);
      if (crossOrder && sourceAvailable && requestedQuantity.greaterThan(sourceAvailable)) {
        throw new UnprocessableEntityException({
          code: "CROSS_ORDER_SOURCE_INSUFFICIENT",
          message: `来源生产单 ${crossOrder.productionOrderNo}（订单 ${crossOrder.orderNo}）该物料可用 ${sourceAvailable.toString()}${resolvedUnitName ?? ""}，本次领用 ${requestedQuantity.toString()}${resolvedUnitName ?? ""} 超出可用量`,
          details: [{
            source_production_order_id: crossOrder.id,
            source_production_order_no: crossOrder.productionOrderNo,
            source_order_no: crossOrder.orderNo,
            material_id: material.id,
            unit_id: resolvedUnitId,
            supplier_id: line.supplier_id ?? null,
            available_quantity: sourceAvailable.toString(),
            requested_quantity: requestedQuantity.toString(),
          }],
        });
      }
      // 唯一性从 material_id 改为 material_id + unit_id + supplier_id + 来源生产单：
      // 同一物料、不同供应商必须能并行存在；跨订单调料时不同来源订单也可各留一行，便于追溯。
      const dedupKey = `${material.id}|${resolvedUnitId}|${line.supplier_id ?? "__none__"}|${crossOrder?.id ?? "__self__"}`;
      if (seen.has(dedupKey)) throw new UnprocessableEntityException({ code: "INVALID_MATERIAL_MOVEMENT_LINE", message: "同一物料 + 同一单位 + 同一供应商 + 同一来源订单只能有一行：请合并数量后再保存", details: [] });
      seen.add(dedupKey);
      // 只看该档位的余额：传了 supplier_id 只算该供应商自己的量（含 NULL 档位独立计算），
      // 未传 supplier_id 时按 material + unit 全档位合计（历史宽松口径，避免误伤旧草稿）。
      const availableBefore = line.supplier_id
        ? await this.inventory.rawMaterialBalanceBySupplier(client, material.id, resolvedUnitId, line.supplier_id)
        : await this.inventory.rawMaterialBalance(client, material.id, resolvedUnitId);
      const issued = await client.inventoryFact.aggregate({ where: { productionOrderId: order.id, materialId: material.id, unitId: resolvedUnitId, inventoryCategory: "raw_material" }, _sum: { quantityDelta: true } });
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
      // 领料基数按**实际已过账入库量**：用户反馈 260136 卡其伞布 BOM 配料 5950 码、实际入库 6470 码，
      // 生产领料必须按 6470 扣已领，不能按采购/配料时预定的 5950。没有入库记录时才回落到 BOM。
      const bomQuantity = approvedQuantity === null ? null : approvedQuantity.toNumber();
      const actualInboundQuantity = purchaseReceived.toNumber();
      const issueReferenceQuantity = issueReferenceQuantityOf(actualInboundQuantity, bomQuantity);
      const issueReferenceDecimal = issueReferenceQuantity === null ? null : new Prisma.Decimal(issueReferenceQuantity);
      const productionOutstanding = issueReferenceDecimal ? issueReferenceDecimal.minus(cumulativeIssued) : null;
      // —— 与领取单打印件同名的数量（页面预估列直接显示，前端不再自己换算）——
      // 预估只针对**草稿**：草稿不写库存事实，所以净领料就是「本单之前」的已领数量，
      // 因此这里按「本单自身未过账」换算。已过账单据请以导出件为准（过账校验/退料影响预览
      // 也走本函数，但它们只读库存与风险字段，不读这几个）。
      const issuedQuantity = issuedBeforeQuantity(cumulativeIssued.toNumber(), 0, false);
      const currentQuantity = quantity.toNumber();
      const remainingQuantity = remainingQuantityOf(issueReferenceQuantity, issuedQuantity, currentQuantity);
      const risks = [] as { type: string; context: Prisma.InputJsonValue }[];
      if (!bomItem) risks.push({ type: "MATERIAL_NOT_IN_BOM_WARNING", context: { material_id: material.id, quantity: line.quantity } });
      // 超领按「领料基准数量」判断（实际入库优先、BOM 兜底）：实际到货 6470 时领 6470 不应再误报「超出 BOM 用量」。
      // context 同时保留 BOM 参考量与实际入库量，前端/日志都能看出是按哪个基准判的。
      if (bomItem && issueReferenceDecimal && cumulativeAfter.greaterThan(issueReferenceDecimal)) risks.push({ type: "OVER_ISSUE_WARNING", context: { material_id: material.id, bom_reference_quantity: bomItem.requiredQuantity.toString(), actual_inbound_quantity: purchaseReceived.toString(), issue_reference_quantity: issueReferenceDecimal.toString(), cumulative_issue_quantity: cumulativeAfter.toString() } });
      // 跨订单来源可用量在循环前已做硬门禁；这里不再写「超来源量」告警，因为根本走不到。
      // 供应商分档结存：同一物料可能来自多个供应商，前端「当前库存量」hover 要展示各档。
      const buckets = await getBuckets(material.id, resolvedUnitId);
      previewLines.push({
        id: undefined as string | undefined,
        material_id: material.id,
        material_name: material.name,
        material_code: material.materialCode,
        model: bomItem?.specificationModel ?? bomItem?.model ?? null,
        color: bomItem?.color ?? null,
        unit_id: resolvedUnitId,
        unit: resolvedUnitName,
        supplier_id: line.supplier_id ?? null,
        supplier_name: buckets.find((b) => b.supplier_id === line.supplier_id)?.supplier_name ?? (line.supplier_id ? null : null),
        // 跨订单来源（仅跨订单行有值）：前端显示「来源订单」列，导出/详情据此追溯。
        source_production_order_id: crossOrder?.id ?? null,
        source_production_order_no: crossOrder?.productionOrderNo ?? null,
        source_order_no: crossOrder?.orderNo ?? null,
        source_available_quantity: sourceAvailable?.toString() ?? null,
        quantity: line.quantity,
        remark: line.remark,
        bom_reference_quantity: bomItem?.requiredQuantity?.toString() ?? null,
        approved_usage: approvedQuantity?.toString() ?? null,
        available_before: availableBefore,
        available_after: availableBefore.minus(quantity),
        inventory_quantity: availableBefore.toString(),
        purchase_received_quantity: purchaseReceived.toString(),
        // 实际入库数量 = 该订单该物料已过账的原料入库合计；领料基数优先用它。
        actual_inbound_quantity: purchaseReceived.toString(),
        issue_reference_quantity: issueReferenceQuantity,
        purchase_outstanding_quantity: purchaseOutstanding.toString(),
        cumulative_issued_before: cumulativeIssued,
        cumulative_issued_after: cumulativeAfter,
        production_outstanding_quantity: productionOutstanding?.toString() ?? null,
        available_by_supplier: buckets.map((b) => ({ supplier_id: b.supplier_id, supplier_name: b.supplier_name ?? null, quantity: b.quantity.toString() })),
        // 打印件上的数量列：配料数量 / 实际入库数量 / 已领数量 / 本次领料量 / 余下数量
        //（同名同值，前端照抄即可；余下按实际入库算，不再按配料算）。
        material_quantity: bomQuantity,
        issued_quantity: issuedQuantity,
        current_quantity: currentQuantity,
        remaining_quantity: remainingQuantity,
        requested_replenishment_quantity: "0",
        risks
      });
    }
    return { lines: previewLines };
  }
}
