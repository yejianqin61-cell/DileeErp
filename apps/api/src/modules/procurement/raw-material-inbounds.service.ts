import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { AuditService } from "../../platform/audit/audit.service";
import type { CurrentUser } from "../../platform/auth/auth.service";
import { PrismaService } from "../../platform/database/prisma.service";
import { InventoryService } from "../../platform/inventory/inventory.service";

@Injectable()
export class RawMaterialInboundsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly inventory: InventoryService
  ) {}

  async list(orderNo?: string) {
    return this.prisma.rawMaterialInbound.findMany({
      where: { deletedAt: null, ...(orderNo ? { orderNo } : {}) },
      include: { inventoryFacts: true, payableSources: true },
      orderBy: { createdAt: "desc" }
    });
  }

  async create(input: { incoming_inspection_id: string; quantity: string; inventory_category?: string; remark?: string }, user: CurrentUser) {
    const inspection = await this.requireInspection(input.incoming_inspection_id);
    const allowed = Number(inspection.acceptedQuantity) + Number(inspection.conditionalQuantity);
    const used = inspection.rawMaterialInbounds.reduce((sum, row) => sum + Number(row.quantity), 0);
    if (!Number.isFinite(Number(input.quantity)) || Number(input.quantity) <= 0 || Number(input.quantity) + used > allowed) {
      throw new UnprocessableEntityException({ code: "INBOUND_QUANTITY_EXCEEDED", message: "入库数量超过 QC 允许数量", details: [{ allowed: allowed - used }] });
    }

    const item = inspection.purchaseReceipt.purchaseOrderItem;
    if (input.inventory_category && input.inventory_category !== "raw_material") throw new UnprocessableEntityException({ code: "INVALID_INVENTORY_CATEGORY", message: "原料入库库存分类必须是 raw_material", details: [] });
    if (item.material.materialType !== "raw_material") throw new UnprocessableEntityException({ code: "INBOUND_FINISHED_PRODUCT_FORBIDDEN", message: "原料入库只能接收原料物料", details: [] });
    const inbound = await this.prisma.rawMaterialInbound.create({
      data: {
        inboundNo: `RM-${randomUUID().slice(0, 12).toUpperCase()}`,
        orderNo: inspection.orderNo,
        purchaseOrderId: inspection.purchaseReceipt.purchaseOrderId,
        purchaseOrderItemId: inspection.purchaseReceipt.purchaseOrderItemId,
        purchaseReceiptId: inspection.purchaseReceiptId,
        incomingInspectionId: inspection.id,
        materialId: item.materialId,
        supplierId: inspection.purchaseReceipt.purchaseOrder.supplierId,
        unitId: item.unitId,
        quantity: input.quantity,
        inventoryCategory: "raw_material",
        idempotencyKey: `draft:${randomUUID()}`,
        remark: input.remark,
        ...this.audit.create(user)
      }
    });
    await this.audit.record("raw_material_inbound.create", "raw_material_inbound", user.id, inbound.id, { order_no: inbound.orderNo });
    return inbound;
  }

  async post(id: string, user: CurrentUser) {
    const inbound = await this.prisma.rawMaterialInbound.findFirst({
      where: { id, deletedAt: null },
      include: { incomingInspection: { include: { purchaseReceipt: { include: { purchaseOrder: { include: { items: true } }, purchaseOrderItem: true } } } } }
    });
    if (!inbound) throw new NotFoundException({ code: "INBOUND_NOT_FOUND", message: "原料入库单不存在", details: [] });
    if (inbound.status !== "draft") throw new UnprocessableEntityException({ code: "INVALID_INBOUND_STATE", message: "只有草稿入库单可以过账", details: [] });

    const item = inbound.incomingInspection.purchaseReceipt.purchaseOrderItem;
    const purchaseOrder = inbound.incomingInspection.purchaseReceipt.purchaseOrder;
    const key = `inbound:${inbound.id}`;
    try {
      const result = await this.prisma.$transaction(async (tx) => {
        const existing = await tx.inventoryFact.findFirst({ where: { rawMaterialInboundId: inbound.id } });
        if (existing) throw new ConflictException({ code: "INBOUND_ALREADY_POSTED", message: "入库已过账", details: [] });

        const posted = await tx.rawMaterialInbound.update({ where: { id }, data: { status: "posted", idempotencyKey: key, ...this.audit.update(user) } });
        await tx.inventoryFact.create({
          data: {
            rawMaterialInboundId: inbound.id,
            materialId: inbound.materialId,
            unitId: inbound.unitId,
            inventoryCategory: inbound.inventoryCategory,
            quantityDelta: inbound.quantity,
            sourceType: "raw_material_inbound",
            sourceId: inbound.id,
            orderNo: inbound.orderNo,
            createdBy: user.id
          }
        });
        const receiptSource = await tx.payableSource.findUnique({ where: { purchaseReceiptId: inbound.purchaseReceiptId } });
        if (!receiptSource) await tx.payableSource.create({
          data: {
            rawMaterialInboundId: inbound.id,
            orderNo: inbound.orderNo,
            purchaseOrderId: inbound.purchaseOrderId,
            purchaseOrderItemId: inbound.purchaseOrderItemId,
            supplierId: inbound.supplierId,
            quantity: inbound.quantity,
            unitPrice: item.unitPrice,
            currency: purchaseOrder.currency,
            taxRate: item.taxRate,
            amount: (Number(inbound.quantity) * Number(item.unitPrice)).toFixed(4),
            idempotencyKey: key,
            ...this.audit.create(user)
          }
        });
        return posted;
      });
      await this.audit.record("raw_material_inbound.post", "raw_material_inbound", user.id, id, { order_no: inbound.orderNo, idempotency_key: key });
      return result;
    } catch (error) {
      if (error instanceof ConflictException) throw error;
      if (error && typeof error === "object" && "code" in error && error.code === "P2002") {
        throw new ConflictException({ code: "PAYABLE_SOURCE_DUPLICATE", message: "入库或应付来源已存在", details: [] });
      }
      throw error;
    }
  }

  async update(id: string, input: { quantity: string; remark?: string }, user: CurrentUser) {
    const current = await this.prisma.rawMaterialInbound.findFirst({ where: { id, deletedAt: null }, include: { incomingInspection: { include: { rawMaterialInbounds: { where: { deletedAt: null } } } } } });
    if (!current) throw new NotFoundException({ code: "INBOUND_NOT_FOUND", message: "原料入库单不存在", details: [] });
    if (current.status !== "draft") throw new UnprocessableEntityException({ code: "INBOUND_NOT_EDITABLE", message: "只有草稿入库单可以编辑", details: [] });
    const allowed = Number(current.incomingInspection.acceptedQuantity) + Number(current.incomingInspection.conditionalQuantity);
    const used = current.incomingInspection.rawMaterialInbounds.filter((row) => row.id !== id).reduce((sum, row) => sum + Number(row.quantity), 0);
    if (!Number.isFinite(Number(input.quantity)) || Number(input.quantity) <= 0 || Number(input.quantity) + used > allowed) throw new UnprocessableEntityException({ code: "INBOUND_QUANTITY_EXCEEDED", message: "入库数量超过 QC 允许数量", details: [] });
    return this.prisma.rawMaterialInbound.update({ where: { id }, data: { quantity: input.quantity, remark: input.remark, ...this.audit.update(user) } });
  }

  async remove(id: string, user: CurrentUser) {
    const current = await this.prisma.rawMaterialInbound.findFirst({ where: { id, deletedAt: null } });
    if (!current) throw new NotFoundException({ code: "INBOUND_NOT_FOUND", message: "原料入库单不存在", details: [] });
    if (current.status !== "draft") throw new UnprocessableEntityException({ code: "INBOUND_NOT_DELETABLE", message: "只有草稿入库单可以删除", details: [] });
    return this.prisma.rawMaterialInbound.update({ where: { id }, data: this.audit.softDelete(user) });
  }

  async payableSources(orderNo?: string) {
    return this.prisma.payableSource.findMany({
      where: { ...(orderNo ? { orderNo } : {}), status: "pending_finance" },
      include: {
        rawMaterialInbound: { select: { inboundNo: true, purchaseReceiptId: true, status: true } },
        purchaseReceipt: { select: { receiptNo: true, extensionData: true } },
        purchaseOrder: { select: { purchaseOrderNo: true } },
        purchaseOrderItem: { select: { materialId: true, unitId: true } },
        supplier: { select: { id: true, name: true, supplierCode: true } }
      },
      orderBy: { createdAt: "desc" }
    });
  }

  async reverse(id: string, input: { reason: string }, user: CurrentUser) {
    const inbound = await this.prisma.rawMaterialInbound.findFirst({ where: { id, deletedAt: null }, include: { payableSources: true } });
    if (!inbound) throw new NotFoundException({ code: "INBOUND_NOT_FOUND", message: "原料入库单不存在", details: [] });
    if (inbound.status !== "posted") throw new UnprocessableEntityException({ code: "INVALID_INBOUND_STATE", message: "只有已过账入库可以冲销", details: [] });
    if (!input.reason?.trim()) throw new UnprocessableEntityException({ code: "REVERSAL_REASON_REQUIRED", message: "冲销必须填写原因", details: [] });

    const result = await this.prisma.$transaction(async (tx) => {
      const balance = await this.inventory.rawMaterialBalance(tx, inbound.materialId, inbound.unitId);
      if (balance.minus(inbound.quantity).isNegative()) {
        throw new UnprocessableEntityException({ code: "INVENTORY_INSUFFICIENT", message: "冲销会造成库存负数", details: [] });
      }

      const updated = await tx.rawMaterialInbound.update({
        where: { id },
        data: { status: "reversed", remark: `${inbound.remark ?? ""}\n冲销：${input.reason}`, ...this.audit.update(user) }
      });
      await tx.inventoryFact.create({
        data: {
          rawMaterialInboundId: inbound.id,
          materialId: inbound.materialId,
          unitId: inbound.unitId,
          inventoryCategory: inbound.inventoryCategory,
          quantityDelta: `-${inbound.quantity}`,
          sourceType: "raw_material_inbound_reversal",
          sourceId: inbound.id,
          orderNo: inbound.orderNo,
          createdBy: user.id
        }
      });
      await tx.payableSource.updateMany({ where: { rawMaterialInboundId: inbound.id, status: "pending_finance" }, data: { status: "voided", ...this.audit.update(user) } });
      return updated;
    });
    await this.audit.record("raw_material_inbound.reverse", "raw_material_inbound", user.id, id, { order_no: inbound.orderNo, reason: input.reason });
    return result;
  }

  async impactPreview(id: string) {
    const inbound = await this.prisma.rawMaterialInbound.findFirst({ where: { id, deletedAt: null }, include: { payableSources: true, incomingInspection: true } });
    if (!inbound) throw new NotFoundException({ code: "INBOUND_NOT_FOUND", message: "原料入库单不存在", details: [] });
    const balance = await this.inventory.rawMaterialBalance(this.prisma, inbound.materialId, inbound.unitId);
    return { inbound_id: id, order_no: inbound.orderNo, status: inbound.status, quantity: inbound.quantity.toString(), current_inventory: balance.toString(), after_reversal_inventory: balance.minus(inbound.quantity).toString(), payable_sources: inbound.payableSources.map((source) => ({ id: source.id, status: source.status, amount: source.amount.toString() })), warning: "冲销将创建反向库存事实，并将待财务应付来源置为作废" };
  }

  private async requireInspection(id: string) {
    const inspection = await this.prisma.incomingInspection.findFirst({
      where: { id, deletedAt: null, status: { in: ["accepted", "conditionally_accepted", "partially_accepted", "completed"] } },
      include: { rawMaterialInbounds: { where: { deletedAt: null } }, purchaseReceipt: { include: { purchaseOrder: true, purchaseOrderItem: { include: { material: true } } } } }
    });
    if (!inspection) throw new NotFoundException({ code: "INSPECTION_NOT_AVAILABLE", message: "QC 不存在或不允许入库", details: [] });
    return inspection;
  }
}
