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
      include: {
        inventoryFacts: true,
        payableSources: true,
        purchaseOrder: { select: { purchaseOrderNo: true } },
        purchaseReceipt: { select: { receiptNo: true, extensionData: true } },
        incomingInspection: { select: { extensionData: true, status: true } },
      },
      orderBy: { createdAt: "desc" }
    }).then((rows) => rows.map((row) => ({
      ...row,
      purchase_order_no: row.purchaseOrder.purchaseOrderNo,
      receipt_no: row.purchaseReceipt.receiptNo,
      batch_sequence: Number((row.purchaseReceipt.extensionData as { batch_sequence?: number } | null)?.batch_sequence ?? (row.incomingInspection.extensionData as { batch_sequence?: number } | null)?.batch_sequence ?? 1),
      inspection_status: row.incomingInspection.status,
    })));
  }

  /** Create the draft receiving task for a passed inspection inside its caller transaction. */
  async createDraftForInspection(tx: Prisma.TransactionClient, inspectionId: string, user: CurrentUser) {
    const existing = await tx.rawMaterialInbound.findFirst({ where: { incomingInspectionId: inspectionId, deletedAt: null, status: "draft" } });
    if (existing) return existing;
    const inspection = await tx.incomingInspection.findFirst({
      where: { id: inspectionId, deletedAt: null, status: { in: ["accepted", "conditionally_accepted", "partially_accepted", "completed"] } },
      include: {
        rawMaterialInbounds: { where: { deletedAt: null, status: { not: "reversed" } } },
        purchaseReceipt: { include: { purchaseOrder: true, purchaseOrderItem: { include: { material: true } } } }
      }
    });
    if (!inspection) return null;
    if (inspection.rawMaterialInbounds.length) return inspection.rawMaterialInbounds[0];
    const item = inspection.purchaseReceipt.purchaseOrderItem;
    if (item.material.materialType !== "raw_material") throw new UnprocessableEntityException({ code: "INBOUND_FINISHED_PRODUCT_FORBIDDEN", message: "原料入库只能接收原料物料", details: [] });
    const quantity = new Prisma.Decimal(inspection.acceptedQuantity).plus(inspection.conditionalQuantity);
    if (quantity.isZero()) return null;
    return tx.rawMaterialInbound.create({
      data: {
        inboundNo: `RM-${randomUUID().slice(0, 12).toUpperCase()}`,
        orderNo: inspection.orderNo,
        purchaseOrderId: inspection.purchaseReceipt.purchaseOrderId,
        purchaseOrderItemId: inspection.purchaseReceipt.purchaseOrderItemId,
        purchaseReceiptId: inspection.purchaseReceiptId,
        incomingInspectionId: inspection.id,
        materialId: item.materialId,
        supplierId: inspection.purchaseReceipt.purchaseOrderItem.supplierId,
        unitId: item.unitId,
        quantity,
        inventoryCategory: "raw_material",
        idempotencyKey: `inspection:${inspection.id}:${randomUUID()}`,
        remark: "质检通过自动生成入库草稿",
        ...this.audit.create(user)
      }
    });
  }

  async create(input: { incoming_inspection_id: string; quantity: string; settlement_unit_price?: string; settlement_total_amount?: string; settlement_amount_reason?: string; inventory_category?: string; idempotency_key?: string; remark?: string }, user: CurrentUser) {
    if (input.idempotency_key) {
      const previous = await this.prisma.rawMaterialInbound.findFirst({ where: { idempotencyKey: input.idempotency_key, deletedAt: null } });
      if (previous) return previous;
    }
    const quantity = this.positive(input.quantity, "入库数量必须是大于零的十进制数");
    if (input.inventory_category && input.inventory_category !== "raw_material") throw new UnprocessableEntityException({ code: "INVALID_INVENTORY_CATEGORY", message: "原料入库库存分类必须是 raw_material", details: [] });
    const preview = await this.requireInspection(input.incoming_inspection_id);
    const notice = await this.prisma.rawMaterialInboundNotice.findFirst({ where: { incomingInspectionId: input.incoming_inspection_id, deletedAt: null }, select: { id: true, status: true } });
    if (!notice || notice.status !== "acknowledged" && notice.status !== "processing") throw new UnprocessableEntityException({ code: "INBOUND_NOTICE_NOT_ACKNOWLEDGED", message: "仓库接收入库通知后才能登记入库", details: [] });
    const previewAllowed = preview.qcResult === "rejected" ? new Prisma.Decimal(0) : new Prisma.Decimal(preview.acceptedQuantity).plus(preview.conditionalQuantity);
    const previewUsed = preview.rawMaterialInbounds.filter((row) => row.status !== "reversed").reduce((sum, row) => sum.plus(row.quantity), new Prisma.Decimal(0));
    if (quantity.plus(previewUsed).gt(previewAllowed)) throw new UnprocessableEntityException({ code: "INBOUND_QUANTITY_EXCEEDED", message: "入库数量超过 QC 允许数量", details: [{ allowed: previewAllowed.minus(previewUsed).toString() }] });
    // 与 update() 对齐：人工填写结算总价必须说明差异原因；部分入库批次必须携带完整结算口径。
    if (preview.qcResult === "partial_inbound" && (!input.settlement_unit_price?.trim() || !input.settlement_total_amount?.trim() || !input.settlement_amount_reason?.trim())) throw new UnprocessableEntityException({ code: "PARTIAL_INBOUND_SETTLEMENT_REQUIRED", message: "部分入库必须填写结算单价、结算总价和金额差异原因", details: [] });
       if (input.settlement_total_amount && !input.settlement_amount_reason?.trim()) throw new UnprocessableEntityException({ code: "SETTLEMENT_REASON_REQUIRED", message: "人工填写结算总价时必须填写金额差异原因", details: [] });
    if (preview.qcResult === "partial_inbound" && (!input.settlement_unit_price?.trim() || !input.settlement_total_amount?.trim() || !input.settlement_amount_reason?.trim())) throw new UnprocessableEntityException({ code: "PARTIAL_INBOUND_SETTLEMENT_REQUIRED", message: "部分入库必须填写结算单价、结算总价和金额差异原因", details: [] });
    const inbound = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM incoming_inspections WHERE id = ${input.incoming_inspection_id}::uuid FOR UPDATE`;
      const inspection = await this.requireInspection(input.incoming_inspection_id, tx);
      if (inspection.qcResult === "rejected") throw new UnprocessableEntityException({ code: "REJECTED_INSPECTION_NOT_INBOUNDABLE", message: "拒收质检批次不得建立原料入库", details: [] });
      const allowed = new Prisma.Decimal(inspection.acceptedQuantity).plus(inspection.conditionalQuantity);
      const notice = await tx.rawMaterialInboundNotice.findFirst({ where: { incomingInspectionId: input.incoming_inspection_id, deletedAt: null }, select: { id: true, status: true } });
       if (!notice || (notice.status !== "acknowledged" && notice.status !== "processing")) throw new UnprocessableEntityException({ code: "INBOUND_NOTICE_NOT_ACKNOWLEDGED", message: "仓库接收入库通知后才能登记入库", details: [] });
       const used = inspection.rawMaterialInbounds.filter((row) => row.status !== "reversed").reduce((sum, row) => sum.plus(row.quantity), new Prisma.Decimal(0));
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
          supplierId: inspection.purchaseReceipt.purchaseOrderItem.supplierId,
          unitId: item.unitId,
          quantity: input.quantity,
          settlementUnitPrice: input.settlement_unit_price,
          settlementTotalAmount: input.settlement_total_amount,
          settlementAmountReason: input.settlement_amount_reason,
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
    const existing = await this.prisma.rawMaterialInbound.findFirst({ where: { id, deletedAt: null }, select: { id: true, status: true } });
    if (!existing) throw new NotFoundException({ code: "INBOUND_NOT_FOUND", message: "原料入库单不存在", details: [] });
    if (existing.status !== "draft") throw new UnprocessableEntityException({ code: "INVALID_INBOUND_STATE", message: "只有草稿入库单可以过账", details: [] });
    const key = `inbound:${id}`;
    try {
      const result = await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM raw_material_inbounds WHERE id = ${id}::uuid FOR UPDATE`;
        const inbound = await tx.rawMaterialInbound.findFirst({ where: { id, deletedAt: null }, include: { inboundNotice: { select: { status: true } }, incomingInspection: { include: { rawMaterialInbounds: { where: { deletedAt: null }, select: { id: true, quantity: true, status: true } }, purchaseReceipt: { include: { purchaseOrder: { include: { items: true } }, purchaseOrderItem: true } } } } } });
        if (!inbound) throw new NotFoundException({ code: "INBOUND_NOT_FOUND", message: "原料入库单不存在", details: [] });
        if (inbound.status !== "draft") throw new ConflictException({ code: "INBOUND_ALREADY_POSTED", message: "入库已被其他操作处理", details: [] });
        if (!inbound.inboundNotice || !["acknowledged", "processing"].includes(inbound.inboundNotice.status)) throw new UnprocessableEntityException({ code: "INBOUND_NOTICE_NOT_ACKNOWLEDGED", message: "仓库接收入库通知后才能过账", details: [] });
         if (inbound.incomingInspection.qcResult === "partial_inbound" && (!inbound.settlementUnitPrice || !inbound.settlementTotalAmount || !inbound.settlementAmountReason?.trim())) throw new UnprocessableEntityException({ code: "PARTIAL_INBOUND_SETTLEMENT_REQUIRED", message: "部分入库必须填写结算单价、结算总价和金额差异原因", details: [] });
        await tx.$queryRaw`SELECT id FROM incoming_inspections WHERE id = ${inbound.incomingInspectionId}::uuid FOR UPDATE`;
        if (!["accepted", "conditionally_accepted", "partially_accepted", "completed"].includes(inbound.incomingInspection.status)) throw new UnprocessableEntityException({ code: "INSPECTION_NOT_AVAILABLE", message: "质检尚未完成，不能入库", details: [{ status: inbound.incomingInspection.status }] });
        const allowed = new Prisma.Decimal(inbound.incomingInspection.acceptedQuantity).plus(inbound.incomingInspection.conditionalQuantity);
        const used = inbound.incomingInspection.rawMaterialInbounds.filter((row) => row.id !== id && row.status !== "reversed").reduce((sum, row) => sum.plus(row.quantity), new Prisma.Decimal(0));
        if (used.plus(inbound.quantity).gt(allowed)) throw new UnprocessableEntityException({ code: "INBOUND_QUANTITY_EXCEEDED", message: "入库数量超过 QC 允许数量", details: [{ allowed: allowed.minus(used).toString() }] });
        const item = inbound.incomingInspection.purchaseReceipt.purchaseOrderItem;
        const purchaseOrder = inbound.incomingInspection.purchaseReceipt.purchaseOrder;

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
        const receiptSource = await tx.payableSource.findFirst({ where: { rawMaterialInboundId: inbound.id } });
        if (!receiptSource) await tx.payableSource.create({
          data: {
            rawMaterialInboundId: inbound.id,
            orderNo: inbound.orderNo,
            purchaseOrderId: inbound.purchaseOrderId,
            purchaseOrderItemId: inbound.purchaseOrderItemId,
            supplierId: inbound.supplierId,
            quantity: inbound.quantity,
            unitPrice: inbound.settlementUnitPrice ?? item.unitPrice,
            currency: purchaseOrder.currency,
            taxRate: item.taxRate,
            amount: (inbound.settlementTotalAmount ?? inbound.quantity.mul(inbound.settlementUnitPrice ?? item.unitPrice)).toFixed(4),
            idempotencyKey: key,
            ...this.audit.create(user)
          }
        });
        return posted;
      });
      await this.audit.record("raw_material_inbound.post", "raw_material_inbound", user.id, id, { order_no: result.orderNo, idempotency_key: key });
      return result;
    } catch (error) {
      if (error instanceof ConflictException) throw error;
      if (error && typeof error === "object" && "code" in error && error.code === "P2002") {
        throw new ConflictException({ code: "PAYABLE_SOURCE_DUPLICATE", message: "入库或应付来源已存在", details: [] });
      }
      throw error;
    }
  }

  async update(id: string, input: { quantity: string; settlement_unit_price?: string; settlement_total_amount?: string; settlement_amount_reason?: string; remark?: string }, user: CurrentUser) {
    const quantity = this.positive(input.quantity, "入库数量必须是大于零的十进制数");
    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT incoming_inspection_id FROM raw_material_inbounds WHERE id = ${id}::uuid FOR UPDATE`;
      const current = await tx.rawMaterialInbound.findFirst({ where: { id, deletedAt: null }, include: { incomingInspection: { include: { rawMaterialInbounds: { where: { deletedAt: null } } } } } });
      if (!current) throw new NotFoundException({ code: "INBOUND_NOT_FOUND", message: "原料入库单不存在", details: [] });
      if (current.status !== "draft") throw new UnprocessableEntityException({ code: "INBOUND_NOT_EDITABLE", message: "只有草稿入库单可以编辑", details: [] });
       const notice = await tx.rawMaterialInboundNotice.findFirst({ where: { incomingInspectionId: current.incomingInspectionId, deletedAt: null }, select: { status: true } });
       if (!notice || !["acknowledged", "processing"].includes(notice.status)) throw new UnprocessableEntityException({ code: "INBOUND_NOTICE_NOT_ACKNOWLEDGED", message: "仓库接收入库通知后才能编辑入库", details: [] });
      await tx.$queryRaw`SELECT id FROM incoming_inspections WHERE id = ${current.incomingInspectionId}::uuid FOR UPDATE`;
      const inspection = await tx.incomingInspection.findFirst({ where: { id: current.incomingInspectionId, deletedAt: null }, include: { rawMaterialInbounds: { where: { deletedAt: null } } } });
      if (!inspection) throw new NotFoundException({ code: "INSPECTION_NOT_AVAILABLE", message: "QC 不存在或不允许入库", details: [] });
      if (inspection.qcResult === "rejected") throw new UnprocessableEntityException({ code: "REJECTED_INSPECTION_NOT_INBOUNDABLE", message: "拒收质检批次不得建立原料入库", details: [] });
      const allowed = new Prisma.Decimal(inspection.acceptedQuantity).plus(inspection.conditionalQuantity);
      if (inspection.qcResult === "partial_inbound" && (!input.settlement_unit_price?.trim() || !input.settlement_total_amount?.trim() || !input.settlement_amount_reason?.trim())) throw new UnprocessableEntityException({ code: "PARTIAL_INBOUND_SETTLEMENT_REQUIRED", message: "部分入库必须填写结算单价、结算总价和金额差异原因", details: [] });
       if (input.settlement_total_amount && !input.settlement_amount_reason?.trim()) throw new UnprocessableEntityException({ code: "SETTLEMENT_REASON_REQUIRED", message: "人工填写结算总价时必须填写金额差异原因", details: [] });
      const used = inspection.rawMaterialInbounds.filter((row) => row.id !== id && row.status !== "reversed").reduce((sum, row) => sum.plus(row.quantity), new Prisma.Decimal(0));
      if (quantity.plus(used).gt(allowed)) throw new UnprocessableEntityException({ code: "INBOUND_QUANTITY_EXCEEDED", message: "入库数量超过 QC 允许数量", details: [{ allowed: allowed.minus(used).toString() }] });
      return tx.rawMaterialInbound.update({ where: { id }, data: { quantity: input.quantity, settlementUnitPrice: input.settlement_unit_price, settlementTotalAmount: input.settlement_total_amount, settlementAmountReason: input.settlement_amount_reason, remark: input.remark, ...this.audit.update(user) } });
    });
    await this.audit.record("raw_material_inbound.update", "raw_material_inbound", user.id, id, { order_no: updated.orderNo });
    return updated;
  }

  async remove(id: string, user: CurrentUser) {
    const current = await this.prisma.rawMaterialInbound.findFirst({ where: { id, deletedAt: null } });
    if (!current) throw new NotFoundException({ code: "INBOUND_NOT_FOUND", message: "原料入库单不存在", details: [] });
    if (current.status !== "draft") throw new UnprocessableEntityException({ code: "INBOUND_NOT_DELETABLE", message: "只有草稿入库单可以删除", details: [] });
    return this.prisma.rawMaterialInbound.update({ where: { id }, data: this.audit.softDelete(user) });
  }

  async payableSources(orderNo?: string) {
    const rows = await this.prisma.payableSource.findMany({
      where: { ...(orderNo ? { orderNo } : {}), status: { not: "voided" } },
      include: {
        rawMaterialInbound: { select: { inboundNo: true, purchaseReceiptId: true, status: true } },
        purchaseReceipt: { select: { receiptNo: true, extensionData: true } },
        purchaseOrder: { select: { purchaseOrderNo: true } },
        purchaseOrderItem: { select: { materialId: true, unitId: true } },
        supplier: { select: { id: true, name: true, supplierCode: true } }
      },
      orderBy: { createdAt: "desc" }
    });
    return rows.map((row) => ({
      ...row,
      purchase_order_no: row.purchaseOrder?.purchaseOrderNo ?? null,
      batch_sequence: Number((row.purchaseReceipt?.extensionData as { batch_sequence?: number } | null)?.batch_sequence ?? 1),
    }));
  }

  async reverse(id: string, input: { reason: string }, user: CurrentUser) {
    const inbound = await this.prisma.rawMaterialInbound.findFirst({ where: { id, deletedAt: null }, include: { payableSources: true } });
    if (!inbound) throw new NotFoundException({ code: "INBOUND_NOT_FOUND", message: "原料入库单不存在", details: [] });
    if (inbound.status !== "posted") throw new UnprocessableEntityException({ code: "INVALID_INBOUND_STATE", message: "只有已过账入库可以冲销", details: [] });
    if (!input.reason?.trim()) throw new UnprocessableEntityException({ code: "REVERSAL_REASON_REQUIRED", message: "冲销必须填写原因", details: [] });

    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM raw_material_inbounds WHERE id = ${id}::uuid FOR UPDATE`;
      const current = await tx.rawMaterialInbound.findFirst({ where: { id, deletedAt: null }, include: { payableSources: { include: { supplierPayableEntry: { include: { allocations: { where: { deletedAt: null, status: "active" } } } } } } } });
      if (!current || current.status !== "posted") throw new ConflictException({ code: "INBOUND_ALREADY_REVERSED", message: "入库已被其他操作冲销", details: [] });
       if (current.payableSources.some((source) => source.supplierPayableEntry && ["confirmed", "partially_paid", "paid"].includes(source.supplierPayableEntry.status))) throw new UnprocessableEntityException({ code: "INBOUND_PAYABLE_ALREADY_CONFIRMED", message: "应付已确认或付款，不能直接冲销入库", details: [] });
      const balance = await this.inventory.rawMaterialBalance(tx, current.materialId, current.unitId);
      if (balance.minus(current.quantity).isNegative()) {
        throw new UnprocessableEntityException({ code: "INVENTORY_INSUFFICIENT", message: "冲销会造成库存负数", details: [] });
      }

      const updated = await tx.rawMaterialInbound.update({
        where: { id },
        data: { status: "reversed", remark: `${current.remark ?? ""}\n冲销：${input.reason}`, ...this.audit.update(user) }
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
