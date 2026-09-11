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
    const existingDraft = inspection.rawMaterialInbounds.find((row) => row.status === "draft");
    if (existingDraft) return existingDraft;
    const item = inspection.purchaseReceipt.purchaseOrderItem;
    if (item.material.materialType !== "raw_material") throw new UnprocessableEntityException({ code: "INBOUND_FINISHED_PRODUCT_FORBIDDEN", message: "原料入库只能接收原料物料", details: [] });
    const quantity = new Prisma.Decimal(inspection.acceptedQuantity).plus(inspection.conditionalQuantity).minus(inspection.rawMaterialInbounds.reduce((sum, row) => sum.plus(row.quantity), new Prisma.Decimal(0)));
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
    // 结算口径属于采购：仓库登记只负责实际入库数量，不再强制填写结算三字段。
    // 采购若填写了人工结算值，则仍必须是正数并说明差异原因（下方 assertSettlementInput 校验）。
    this.assertSettlementInput(input);

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
        // 结算口径缺省取采购明细单价：仓库只登记实际入库数量，金额由采购口径决定。
        const isPartialInbound = inbound.incomingInspection.qcResult === "partial_inbound" || inbound.incomingInspection.status === "partially_accepted";
          const settlementUnitPrice = isPartialInbound ? (inbound.settlementUnitPrice ?? item.unitPrice) : item.unitPrice;
          const settlementAmount = isPartialInbound ? (inbound.settlementTotalAmount ?? inbound.quantity.mul(settlementUnitPrice)) : inbound.quantity.mul(item.unitPrice);
          const receiptSource = await tx.payableSource.findFirst({ where: { rawMaterialInboundId: inbound.id } });
        if (receiptSource && receiptSource.status === "voided") await tx.payableSource.update({ where: { id: receiptSource.id }, data: { orderNo: inbound.orderNo, purchaseOrderId: inbound.purchaseOrderId, purchaseOrderItemId: inbound.purchaseOrderItemId, materialId: inbound.materialId, supplierId: inbound.supplierId, quantity: inbound.quantity, unitPrice: settlementUnitPrice, settlementUnitPrice: isPartialInbound ? settlementUnitPrice : null, settlementTotalAmount: isPartialInbound ? settlementAmount : null, settlementAmountReason: isPartialInbound ? inbound.settlementAmountReason : null, currency: purchaseOrder.currency, taxRate: item.taxRate, amount: settlementAmount.toFixed(4), qcResult: inbound.incomingInspection.qcResult, acceptedQuantity: inbound.incomingInspection.acceptedQuantity, conditionalQuantity: inbound.incomingInspection.conditionalQuantity, rejectedQuantity: inbound.incomingInspection.rejectedQuantity, actualInboundQuantity: inbound.quantity, status: "pending_finance", ...this.audit.update(user) } });
          else if (!receiptSource) await tx.payableSource.create({
          data: {
            rawMaterialInboundId: inbound.id,
            orderNo: inbound.orderNo,
            purchaseOrderId: inbound.purchaseOrderId,
            purchaseOrderItemId: inbound.purchaseOrderItemId,
            materialId: inbound.materialId,
              supplierId: inbound.supplierId,
            quantity: inbound.quantity,
            unitPrice: settlementUnitPrice,
              settlementUnitPrice: isPartialInbound ? settlementUnitPrice : null,
              settlementTotalAmount: isPartialInbound ? settlementAmount : null,
              settlementAmountReason: isPartialInbound ? inbound.settlementAmountReason : null,
            currency: purchaseOrder.currency,
            taxRate: item.taxRate,
            amount: settlementAmount.toFixed(4),
              qcResult: inbound.incomingInspection.qcResult,
              acceptedQuantity: inbound.incomingInspection.acceptedQuantity,
              conditionalQuantity: inbound.incomingInspection.conditionalQuantity,
              rejectedQuantity: inbound.incomingInspection.rejectedQuantity,
              actualInboundQuantity: inbound.quantity,
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
    this.assertSettlementInput(input);
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
      // 结算字段校验已在进入事务前由 assertSettlementInput 完成（含“填总价必须说明原因”），此处不再重复。
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
      const current = await tx.rawMaterialInbound.findFirst({ where: { id, deletedAt: null }, include: { payableSources: { include: { supplierPayableEntry: { include: { allocations: { where: { deletedAt: null, status: "active" }, include: { payment: true } } } } } } } });
      if (!current || current.status !== "posted") throw new ConflictException({ code: "INBOUND_ALREADY_REVERSED", message: "入库已被其他操作冲销", details: [] });
       const payableEntries = current.payableSources.flatMap((source) => source.supplierPayableEntry ? [source.supplierPayableEntry] : []);
        const hasPostedPayment = payableEntries.some((entry) => entry.allocations.some((allocation) => allocation.payment.status === "posted"));
        if (hasPostedPayment) throw new UnprocessableEntityException({ code: "INBOUND_PAYABLE_HAS_PAYMENT", message: "应付已有有效付款核销，必须先冲销付款后再冲销入库", details: [] });
        const nonDraftEntries = payableEntries.filter((entry) => entry.status !== "draft");
        if (nonDraftEntries.length) throw new UnprocessableEntityException({ code: "INBOUND_PAYABLE_ALREADY_CONFIRMED", message: "应付已确认或付款，不能直接冲销入库", details: nonDraftEntries.map((entry) => ({ payable_id: entry.id, status: entry.status })) });
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
      await tx.payableSource.updateMany({ where: { OR: [{ rawMaterialInboundId: inbound.id }, { purchaseReceiptId: current.purchaseReceiptId, rawMaterialInboundId: null }], status: { not: "voided" } }, data: { status: "voided", ...this.audit.update(user) } });
        const draftEntryIds = payableEntries.filter((entry) => entry.status === "draft").map((entry) => entry.id);
        if (draftEntryIds.length) await tx.supplierPayableEntry.updateMany({ where: { id: { in: draftEntryIds } }, data: { status: "voided", ...this.audit.update(user) } });
      return updated;
    });
    await this.audit.record("raw_material_inbound.reverse", "raw_material_inbound", user.id, id, { order_no: inbound.orderNo, reason: input.reason });
    return result;
  }

  async impactPreview(id: string) {
    const inbound = await this.prisma.rawMaterialInbound.findFirst({ where: { id, deletedAt: null }, include: { payableSources: { include: { supplierPayableEntry: { include: { allocations: { where: { deletedAt: null, status: "active" }, include: { payment: true } } } } } }, incomingInspection: true } });
    if (!inbound) throw new NotFoundException({ code: "INBOUND_NOT_FOUND", message: "原料入库单不存在", details: [] });
    const balance = await this.inventory.rawMaterialBalance(this.prisma, inbound.materialId, inbound.unitId);
    return { inbound_id: id, order_no: inbound.orderNo, status: inbound.status, quantity: inbound.quantity.toString(), current_inventory: balance.toString(), after_reversal_inventory: balance.minus(inbound.quantity).toString(), payable_sources: inbound.payableSources.map((source) => ({ id: source.id, status: source.status, amount: source.amount.toString(), payable_entry_status: source.supplierPayableEntry?.status ?? null, payment_posted: source.supplierPayableEntry?.allocations.some((allocation) => allocation.payment.status === "posted") ?? false })), warning: "未确认应付将随入库冲销作废；已确认、部分支付或已有付款核销的应付必须先处理付款和应付，再冲销入库。" };
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

  /**
   * 人工结算口径校验：字段可留空（仓库不填、采购按采购单价自动结算），
   * 但一旦填写就必须是大于零的金额，且填写结算总价时必须说明差异原因。
   * 过账时会以采购明细单价作为缺省口径，因此不再强制要求这三个字段。
   */
  private assertSettlementInput(input: { settlement_unit_price?: string; settlement_total_amount?: string; settlement_amount_reason?: string }) {
    const amounts: Array<[string | undefined, string]> = [[input.settlement_unit_price, "结算单价必须是大于零的十进制数"], [input.settlement_total_amount, "结算总价必须是大于零的十进制数"]];
    for (const [value, message] of amounts) {
      if (value === undefined || value === null || String(value).trim() === "") continue;
      let parsed: Prisma.Decimal;
      try { parsed = new Prisma.Decimal(value); } catch { throw new UnprocessableEntityException({ code: "INVALID_SETTLEMENT_AMOUNT", message, details: [] }); }
      if (!parsed.gt(0)) throw new UnprocessableEntityException({ code: "INVALID_SETTLEMENT_AMOUNT", message, details: [] });
    }
    if (input.settlement_total_amount?.trim() && !input.settlement_amount_reason?.trim()) throw new UnprocessableEntityException({ code: "SETTLEMENT_REASON_REQUIRED", message: "人工填写结算总价时必须填写金额差异原因", details: [] });
  }
}
