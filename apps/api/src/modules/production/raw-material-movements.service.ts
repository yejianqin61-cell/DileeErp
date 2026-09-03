import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { AuditService } from "../../platform/audit/audit.service";
import type { CurrentUser } from "../../platform/auth/auth.service";
import { PrismaService } from "../../platform/database/prisma.service";
import { InventoryService } from "../../platform/inventory/inventory.service";

type IssueLineInput = { material_id: string; quantity: string; remark?: string };
type IssueInput = { production_order_id: string; business_date?: string; reason?: string; remark?: string; lines: IssueLineInput[] };
type DerivedLineInput = { source_issue_line_id: string; quantity: string; remark?: string };
type DerivedInput = { production_order_id: string; business_date?: string; reason?: string; remark?: string; lines: DerivedLineInput[] };

@Injectable()
export class RawMaterialMovementsService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly inventory: InventoryService) {}

  async list(orderNo?: string) {
    return this.prisma.rawMaterialMovement.findMany({
      where: { deletedAt: null, ...(orderNo ? { orderNo } : {}) },
      include: { productionOrder: true, lines: { include: { material: true, unit: true, risks: true } }, risks: true },
      orderBy: { createdAt: "desc" }
    });
  }

  async get(id: string) {
    const movement = await this.prisma.rawMaterialMovement.findFirst({
      where: { id, deletedAt: null },
      include: { productionOrder: { include: { executionLocation: true } }, lines: { where: { deletedAt: null }, include: { material: true, unit: true, risks: true } }, risks: true }
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

  async updateIssue(id: string, input: Partial<IssueInput>, user: CurrentUser) {
    const movement = await this.get(id);
    if (movement.status !== "draft") throw new UnprocessableEntityException({ code: "MATERIAL_MOVEMENT_NOT_EDITABLE", message: "只有草稿领料单可以编辑", details: [] });
    const order = await this.requireInHouseOrder(movement.productionOrderId);
    const preview = input.lines ? await this.previewLines(order, input.lines) : null;
    const updated = await this.prisma.$transaction(async (tx) => {
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
    const result = await this.prisma.rawMaterialMovement.update({ where: { id }, data: this.audit.softDelete(user) });
    await this.audit.record("raw_material_movement.delete", "raw_material_movement", user.id, id, { order_no: movement.orderNo });
    return result;
  }

  async impactPreview(id: string) {
    const movement = await this.get(id);
    const preview = await this.previewLines(movement.productionOrder, movement.lines.map((line) => ({ material_id: line.materialId, quantity: line.quantity.toString(), remark: line.remark ?? undefined })));
    return { movement_no: movement.movementNo, order_no: movement.orderNo, production_order_no: movement.productionOrder.productionOrderNo, status: movement.status, ...preview };
  }

  async postIssue(id: string, idempotencyKey: string, user: CurrentUser) {
    if (!idempotencyKey?.trim()) throw new UnprocessableEntityException({ code: "IDEMPOTENCY_KEY_REQUIRED", message: "领料过账必须提供幂等键", details: [] });
    const movement = await this.get(id);
    if (movement.documentType !== "issue") throw new UnprocessableEntityException({ code: "INVALID_MATERIAL_MOVEMENT_TYPE", message: "该单据不是领料单", details: [] });
    if (movement.status === "posted" && movement.idempotencyKey === idempotencyKey) return movement;
    if (movement.status !== "draft") throw new UnprocessableEntityException({ code: "INVALID_MATERIAL_MOVEMENT_STATE", message: "只有草稿领料单可以过账", details: [] });
    const order = await this.requireInHouseOrder(movement.productionOrderId);
    const preview = await this.previewLines(order, movement.lines.map((line) => ({ material_id: line.materialId, quantity: line.quantity.toString(), remark: line.remark ?? undefined })));
    const risks = preview.lines.flatMap((line) => line.risks.map((risk) => ({ line_id: line.id, risk_type: risk.type, context: risk.context })));
    if (risks.length && !movement.reason?.trim()) throw new UnprocessableEntityException({ code: "RISK_REASON_REQUIRED", message: "超领或非 BOM 物料必须填写原因", details: risks });
    if (preview.lines.some((line) => line.available_after.isNegative())) throw new UnprocessableEntityException({ code: "INSUFFICIENT_INVENTORY", message: "领料会造成原料库存不足", details: preview.lines.filter((line) => line.available_after.isNegative()).map((line) => ({ material_id: line.material_id, available_quantity: line.available_before.toString() })) });

    try {
      const posted = await this.prisma.$transaction(async (tx) => {
        const current = await tx.rawMaterialMovement.findFirst({ where: { id, deletedAt: null }, include: { lines: { where: { deletedAt: null } } } });
        if (!current || current.status !== "draft") throw new ConflictException({ code: "MATERIAL_MOVEMENT_ALREADY_POSTED", message: "领料单已被其他操作处理", details: [] });
        for (const line of current.lines) await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`${line.materialId}|${line.unitId}`}))`;
        const lockedPreview = await this.previewLines(order, current.lines.map((line) => ({ material_id: line.materialId, quantity: line.quantity.toString(), remark: line.remark ?? undefined })), tx);
        if (lockedPreview.lines.some((line) => line.available_after.isNegative())) throw new UnprocessableEntityException({ code: "INSUFFICIENT_INVENTORY", message: "领料会造成原料库存不足", details: [] });
        const lockedRisks = lockedPreview.lines.flatMap((line) => line.risks.map((risk) => ({ line_id: line.id, risk_type: risk.type, context: risk.context })));
        if (lockedRisks.length && !current.reason?.trim()) throw new UnprocessableEntityException({ code: "RISK_REASON_REQUIRED", message: "超领或非 BOM 物料必须填写原因", details: lockedRisks });
        const updated = await tx.rawMaterialMovement.update({ where: { id }, data: { status: "posted", idempotencyKey, ...this.audit.update(user) } });
        for (const line of current.lines) {
          await tx.inventoryFact.create({ data: { materialId: line.materialId, unitId: line.unitId, inventoryCategory: "raw_material", quantityDelta: `-${line.quantity}`, sourceType: "material_issue", sourceId: current.id, orderNo: current.orderNo, productionOrderId: current.productionOrderId, rawMaterialMovementLineId: line.id, createdBy: user.id } });
        }
        for (const risk of lockedRisks) {
          await tx.rawMaterialMovementRisk.create({ data: { movementId: current.id, lineId: risk.line_id, riskType: risk.risk_type, context: risk.context, reason: current.reason!, confirmedBy: user.id, ...this.audit.create(user) } });
        }
        return updated;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      await this.audit.record("raw_material_movement.post", "raw_material_movement", user.id, id, { order_no: movement.orderNo, production_order_id: movement.productionOrderId, idempotency_key: idempotencyKey });
      return posted;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "P2034") throw new ConflictException({ code: "VERSION_CONFLICT", message: "库存已被其他操作更新，请刷新后重试", details: [] });
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

  async reverse(id: string, reason: string, idempotencyKey: string, user: CurrentUser) {
    if (!reason?.trim()) throw new UnprocessableEntityException({ code: "REVERSAL_REASON_REQUIRED", message: "冲销必须填写原因", details: [] });
    if (!idempotencyKey?.trim()) throw new UnprocessableEntityException({ code: "IDEMPOTENCY_KEY_REQUIRED", message: "冲销必须提供幂等键", details: [] });
    const movement = await this.get(id);
    if (movement.status !== "posted") throw new UnprocessableEntityException({ code: "INVALID_MATERIAL_MOVEMENT_STATE", message: "只有已过账单据可以冲销", details: [] });
    const preview = await this.reversalPreview(id);
    if (!preview.can_reverse) throw new UnprocessableEntityException({ code: "DOWNSTREAM_RECORD_EXISTS", message: "存在后续退料或报废记录，不能冲销来源领料", details: [{ count: preview.dependent_record_count }] });
    const reversal = await this.prisma.$transaction(async (tx) => {
      const current = await tx.rawMaterialMovement.findFirst({ where: { id, status: "posted", deletedAt: null }, include: { lines: { where: { deletedAt: null } } } });
      if (!current) throw new ConflictException({ code: "MATERIAL_MOVEMENT_ALREADY_REVERSED", message: "单据已被其他操作冲销", details: [] });
      if (current.documentType === "issue") {
        const derived = await tx.rawMaterialMovementLine.count({ where: { sourceIssueLineId: { in: current.lines.map((line) => line.id) }, deletedAt: null, movement: { is: { status: "posted", deletedAt: null } } } });
        if (derived) throw new UnprocessableEntityException({ code: "DOWNSTREAM_RECORD_EXISTS", message: "存在后续退料或报废记录，不能冲销来源领料", details: [{ count: derived }] });
      }
      const facts = await tx.inventoryFact.findMany({ where: { sourceId: current.id } });
      for (const fact of facts) {
        if (fact.inventoryCategory === "raw_material" && fact.quantityDelta.isPositive()) {
          if (!fact.materialId) throw new ConflictException({ code: "RAW_MATERIAL_FACT_MISSING_MATERIAL", message: "原料库存事实缺少物料", details: [] });
          const balance = await this.inventory.rawMaterialBalance(tx, fact.materialId, fact.unitId);
          if (balance.minus(fact.quantityDelta).isNegative()) throw new UnprocessableEntityException({ code: "INSUFFICIENT_INVENTORY", message: "冲销会造成原料库存不足", details: [{ material_id: fact.materialId }] });
        }
      }
      const created = await tx.rawMaterialMovement.create({ data: { movementNo: `RV-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomUUID().slice(0, 8).toUpperCase()}`, documentType: "reversal", status: "posted", productionOrderId: current.productionOrderId, orderNo: current.orderNo, businessDate: new Date(), reason, remark: `冲销 ${current.movementNo}`, idempotencyKey, lines: { create: current.lines.map((line) => ({ materialId: line.materialId, unitId: line.unitId, quantity: line.quantity, bomReferenceQuantity: line.bomReferenceQuantity, sourceIssueLineId: line.id, remark: `冲销 ${current.movementNo}`, ...this.audit.create(user) })) }, ...this.audit.create(user) }, include: { lines: true } });
      for (let index = 0; index < facts.length; index += 1) {
        const fact = facts[index];
        await tx.inventoryFact.create({ data: { materialId: fact.materialId, unitId: fact.unitId, inventoryCategory: fact.inventoryCategory, quantityDelta: fact.quantityDelta.negated(), sourceType: "material_movement_reversal", sourceId: created.id, orderNo: current.orderNo, productionOrderId: current.productionOrderId, rawMaterialMovementLineId: created.lines[index]?.id, createdBy: user.id } });
      }
      await tx.rawMaterialMovement.update({ where: { id }, data: { status: "reversed", remark: `${current.remark ?? ""}\n冲销：${reason}`, ...this.audit.update(user) } });
      return created;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    await this.audit.record("raw_material_movement.reverse", "raw_material_movement", user.id, id, { order_no: movement.orderNo, production_order_id: movement.productionOrderId, reversal_movement_id: reversal.id, reason });
    return reversal;
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
        await this.derivedLines(current.productionOrderId, current.lines.map((line) => ({ source_issue_line_id: line.sourceIssueLineId!, quantity: line.quantity.toString(), remark: line.remark ?? undefined })), tx);
        const updated = await tx.rawMaterialMovement.update({ where: { id }, data: { status: "posted", idempotencyKey, ...this.audit.update(user) } });
        for (const line of current.lines) {
          await tx.inventoryFact.create({ data: { materialId: line.materialId, unitId: line.unitId, inventoryCategory: documentType === "return" ? "raw_material" : "scrap", quantityDelta: line.quantity, sourceType: documentType === "return" ? "material_return" : "material_scrap", sourceId: current.id, orderNo: current.orderNo, productionOrderId: current.productionOrderId, rawMaterialMovementLineId: line.id, createdBy: user.id } });
        }
        return updated;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      await this.audit.record("raw_material_movement.post", "raw_material_movement", user.id, id, { order_no: movement.orderNo, production_order_id: movement.productionOrderId, document_type: documentType, idempotency_key: idempotencyKey });
      return posted;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "P2034") throw new ConflictException({ code: "VERSION_CONFLICT", message: "物料流转已被其他操作更新，请刷新后重试", details: [] });
      throw error;
    }
  }

  private async derivedLines(productionOrderId: string, lines: DerivedLineInput[], client: PrismaService | Prisma.TransactionClient = this.prisma) {
    if (!Array.isArray(lines) || lines.length === 0) throw new UnprocessableEntityException({ code: "MATERIAL_MOVEMENT_LINES_REQUIRED", message: "单据至少需要一条物料明细", details: [] });
    const seen = new Set<string>();
    const result = [];
    for (const line of lines) {
      if (!line?.source_issue_line_id || seen.has(line.source_issue_line_id) || !Number.isFinite(Number(line.quantity)) || Number(line.quantity) <= 0) throw new UnprocessableEntityException({ code: "INVALID_MATERIAL_MOVEMENT_LINE", message: "来源领料明细和数量必须有效且不可重复", details: [] });
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

  private async requireInHouseOrder(id: string) {
    const order = await this.prisma.productionOrder.findFirst({ where: { id, deletedAt: null }, include: { bom: true, executionLocation: true } });
    if (!order) throw new NotFoundException({ code: "PRODUCTION_ORDER_NOT_FOUND", message: "生产单不存在", details: [] });
    if (order.executionMode !== "in_house" || order.status !== "in_progress") throw new UnprocessableEntityException({ code: "PRODUCTION_ORDER_NOT_ISSUABLE", message: "只有生产中的厂内生产单可以领料", details: [] });
    return order;
  }

  private async previewLines(order: { id: string; orderNo: string; bomId: string | null }, lines: IssueLineInput[], client: PrismaService | Prisma.TransactionClient = this.prisma) {
    if (!Array.isArray(lines) || lines.length === 0) throw new UnprocessableEntityException({ code: "MATERIAL_MOVEMENT_LINES_REQUIRED", message: "领料单至少需要一条物料明细", details: [] });
    const seen = new Set<string>();
    const previewLines = [];
    for (const line of lines) {
      if (!line?.material_id || seen.has(line.material_id) || !Number.isFinite(Number(line.quantity)) || Number(line.quantity) <= 0) throw new UnprocessableEntityException({ code: "INVALID_MATERIAL_MOVEMENT_LINE", message: "领料物料和数量必须有效且不可重复", details: [] });
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
