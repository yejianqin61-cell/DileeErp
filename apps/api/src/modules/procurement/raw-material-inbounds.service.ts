import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
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

  async create(input: { incoming_inspection_id: string; quantity: string; inventory_category?: string; idempotency_key?: string; remark?: string }, user: CurrentUser) {
    if (input.idempotency_key) {
      const previous = await this.prisma.rawMaterialInbound.findFirst({ where: { idempotencyKey: input.idempotency_key, deletedAt: null } });
      if (previous) return previous;
    }
    const quantity = this.positive(input.quantity, "入库数量必须是大于零的十进制数");
    if (input.inventory_category && input.inventory_category !== "raw_material") throw new UnprocessableEntityException({ code: "INVALID_INVENTORY_CATEGORY", message: "原料入库库存分类必须是 raw_material", details: [] });
    const preview = await this.requireInspection(input.incoming_inspection_id);
    const previewAllowed = new Prisma.Decimal(preview.acceptedQuantity).plus(preview.conditionalQuantity);
    const previewUsed = preview.rawMaterialInbounds.reduce((sum, row) => sum.plus(row.quantity), new Prisma.Decimal(0));
    if (quantity.plus(previewUsed).gt(previewAllowed)) throw new UnprocessableEntityException({ code: "INBOUND_QUANTITY_EXCEEDED", message: "入库数量超过 QC 允许数量", details: [{ allowed: previewAllowed.minus(previewUsed).toString() }] });
    const inbound = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM incoming_inspections WHERE id = ${input.incoming_inspection_id}::uuid FOR UPDATE`;
      const inspection = await this.requireInspection(input.incoming_inspection_id, tx);
      const allowed = new Prisma.Decimal(inspection.acceptedQuantity).plus(inspection.conditionalQuantity);
      const used = inspection.rawMaterialInbounds.reduce((sum, row) => sum.plus(row.quantity), new Prisma.Decimal(0));
      if (quantity.plus(used).gt(allowed)) throw new UnprocessableEntityException({ code: "INBOUND_QUANTITY_EXCEEDED", message: "入库数量超过 QC 允许数量", details: [{ allowed: allowed.minus(used).toString() }] });
      const item = inspection.purchaseReceipt.purchaseOrderItem;
      if (item.material.materialType !== "raw_material") throw new UnprocessableEntityException({ code: "INBOUND_FINISHED_PRODUCT_FORBIDDEN", message: "原料入库只能接收原料物料", details: [] });
      return tx.rawMaterialInbound.create({
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
          idempotencyKey: input.idempotency_key ?? `draft:${randomUUID()}`,
          remark: input.remark,
          ...this.audit.create(user)
        }
      });
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
            amount: inbound.quantity.mul(item.unitPrice).toFixed(4),
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
    const quantity = this.positive(input.quantity, "入库数量必须是大于零的十进制数");
    const allowed = new Prisma.Decimal(current.incomingInspection.acceptedQuantity).plus(current.incomingInspection.conditionalQuantity);
    const used = current.incomingInspection.rawMaterialInbounds.filter((row) => row.id !== id).reduce((sum, row) => sum.plus(row.quantity), new Prisma.Decimal(0));
    if (quantity.plus(used).gt(allowed)) throw new UnprocessableEntityException({ code: "INBOUND_QUANTITY_EXCEEDED", message: "入库数量超过 QC 允许数量", details: [{ allowed: allowed.minus(used).toString() }] });
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

  private async requireInspection(id: string, client: PrismaService | Prisma.TransactionClient = this.prisma) {
    const inspection = await client.incomingInspection.findFirst({
      where: { id, deletedAt: null, status: { in: ["accepted", "conditionally_accepted", "partially_accepted", "completed"] } },
      include: { rawMaterialInbounds: { where: { deletedAt: null } }, purchaseReceipt: { include: { purchaseOrder: true, purchaseOrderItem: { include: { material: true } } } } }
    });
    if (!inspection) throw new NotFoundException({ code: "INSPECTION_NOT_AVAILABLE", message: "QC 不存在或不允许入库", details: [] });
    return inspection;
  }

  private positive(value: string, message: string) { try { const quantity = new Prisma.Decimal(value); if (!quantity.gt(0)) throw new Error(); return quantity; } catch { throw new UnprocessableEntityException({ code: "INVALID_INBOUND_QUANTITY", message, details: [] }); } }
}
