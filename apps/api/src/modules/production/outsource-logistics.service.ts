import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { AuditService } from "../../platform/audit/audit.service";
import type { CurrentUser } from "../../platform/auth/auth.service";
import { PrismaService } from "../../platform/database/prisma.service";

type CreateInput = { production_order_id: string; purchase_order_item_id: string; planned_quantity: string; remark?: string };

@Injectable()
export class OutsourceLogisticsService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  async list(orderNo?: string) {
    return this.prisma.outsourceLogisticsBatch.findMany({
      where: { deletedAt: null, ...(orderNo ? { orderNo } : {}) },
      include: { productionOrder: { select: { productionOrderNo: true, executionMode: true, status: true } }, outsourceLocation: true, purchaseOrder: { select: { purchaseOrderNo: true, status: true } }, purchaseOrderItem: true, material: true, unit: true, receipts: { where: { deletedAt: null }, orderBy: { receiptDate: "asc" } } },
      orderBy: { updatedAt: "desc" }
    });
  }

  async get(id: string) {
    const item = await this.prisma.outsourceLogisticsBatch.findFirst({ where: { id, deletedAt: null }, include: { productionOrder: true, outsourceLocation: true, purchaseOrder: true, purchaseOrderItem: { include: { material: true, unit: true } }, material: true, unit: true, receipts: { where: { deletedAt: null }, orderBy: { receiptDate: "asc" } } } });
    if (!item) throw new NotFoundException({ code: "OUTSOURCE_BATCH_NOT_FOUND", message: "外加工物流批次不存在", details: [] });
    return item;
  }

  async create(input: CreateInput, user: CurrentUser) {
    const refs = await this.refs(input);
    const planned = this.decimal(input.planned_quantity, "INVALID_OUTSOURCE_BATCH_QUANTITY");
    const existing = await this.prisma.outsourceLogisticsBatch.aggregate({ where: { purchaseOrderItemId: refs.item.id, deletedAt: null, status: { not: "cancelled" } }, _sum: { plannedQuantity: true } });
    if (planned + Number(existing._sum.plannedQuantity ?? 0) > Number(refs.item.quantity)) throw new UnprocessableEntityException({ code: "OUTSOURCE_BATCH_QUANTITY_EXCEEDED", message: "外加工直发计划数量超过采购明细数量", details: [{ available: (Number(refs.item.quantity) - Number(existing._sum.plannedQuantity ?? 0)).toFixed(4) }] });
    const batchNo = `OB-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomUUID().slice(0, 8).toUpperCase()}`;
    const created = await this.prisma.outsourceLogisticsBatch.create({ data: { batchNo, orderNo: refs.production.orderNo, productionOrderId: refs.production.id, outsourceLocationId: refs.location.id, purchaseOrderId: refs.po.id, purchaseOrderItemId: refs.item.id, materialId: refs.item.materialId, unitId: refs.item.unitId, plannedQuantity: input.planned_quantity, remark: input.remark, ...this.audit.create(user) } });
    await this.audit.record("outsource_logistics_batch.create", "outsource_logistics_batch", user.id, created.id, { order_no: created.orderNo, batch_no: batchNo });
    return this.get(created.id);
  }

  async update(id: string, input: { planned_quantity?: string; remark?: string }, user: CurrentUser) {
    const current = await this.get(id);
    if (current.status !== "draft") throw new UnprocessableEntityException({ code: "OUTSOURCE_BATCH_NOT_EDITABLE", message: "只有草稿外加工批次可以编辑", details: [] });
    if (input.planned_quantity !== undefined) {
      const planned = this.decimal(input.planned_quantity, "INVALID_OUTSOURCE_BATCH_QUANTITY");
      const existing = await this.prisma.outsourceLogisticsBatch.aggregate({ where: { purchaseOrderItemId: current.purchaseOrderItemId, id: { not: id }, deletedAt: null, status: { not: "cancelled" } }, _sum: { plannedQuantity: true } });
      if (planned + Number(existing._sum.plannedQuantity ?? 0) > Number(current.purchaseOrderItem.quantity)) throw new UnprocessableEntityException({ code: "OUTSOURCE_BATCH_QUANTITY_EXCEEDED", message: "外加工直发计划数量超过采购明细数量", details: [] });
    }
    const result = await this.prisma.outsourceLogisticsBatch.update({ where: { id }, data: { ...(input.planned_quantity === undefined ? {} : { plannedQuantity: input.planned_quantity }), ...(input.remark === undefined ? {} : { remark: input.remark }), ...this.audit.update(user) } });
    await this.audit.record("outsource_logistics_batch.update", "outsource_logistics_batch", user.id, id, { order_no: current.orderNo, before: { planned_quantity: current.plannedQuantity.toString(), remark: current.remark }, after: input });
    return result;
  }

  async dispatch(id: string, input: { quantity: string; dispatch_date: string; proof_remark?: string }, user: CurrentUser) {
    const current = await this.get(id);
    if (current.status !== "draft") throw new UnprocessableEntityException({ code: "OUTSOURCE_BATCH_NOT_DISPATCHABLE", message: "只有草稿批次可以直发", details: [] });
    const quantity = this.decimal(input.quantity, "INVALID_DISPATCH_QUANTITY");
    if (quantity > Number(current.plannedQuantity)) throw new UnprocessableEntityException({ code: "DISPATCH_QUANTITY_EXCEEDED", message: "直发数量不能超过批次计划数量", details: [] });
    if (!input.proof_remark?.trim()) throw new UnprocessableEntityException({ code: "DISPATCH_PROOF_REQUIRED", message: "直发凭据或交接说明不能为空", details: [] });
    const result = await this.prisma.outsourceLogisticsBatch.update({ where: { id }, data: { dispatchedQuantity: input.quantity, dispatchDate: new Date(input.dispatch_date), dispatchProofRemark: input.proof_remark, status: "dispatched", ...this.audit.update(user) } });
    await this.audit.record("outsource_logistics_batch.dispatch", "outsource_logistics_batch", user.id, id, { order_no: current.orderNo, quantity: input.quantity });
    return result;
  }

  async receipt(id: string, input: { quantity: string; receipt_date: string; receiver_name?: string; proof_remark?: string }, user: CurrentUser) {
    const current = await this.get(id);
    if (!["dispatched", "partially_received"].includes(current.status)) throw new UnprocessableEntityException({ code: "OUTSOURCE_BATCH_NOT_RECEIVABLE", message: "当前批次不允许签收", details: [] });
    const quantity = this.decimal(input.quantity, "INVALID_RECEIPT_QUANTITY");
    const received = current.receipts.reduce((sum, row) => sum + Number(row.quantity) - Number(row.reversalQuantity), 0);
    const remaining = Number(current.dispatchedQuantity) - received;
    if (quantity > remaining) throw new UnprocessableEntityException({ code: "OUTSOURCE_RECEIPT_QUANTITY_EXCEEDED", message: "签收数量超过未签收直发数量", details: [{ remaining: remaining.toFixed(4) }] });
    if (!input.proof_remark?.trim()) throw new UnprocessableEntityException({ code: "RECEIPT_PROOF_REQUIRED", message: "签收凭据或签收说明不能为空", details: [] });
    const status = quantity === remaining ? "received" : "partially_received";
    const result = await this.prisma.$transaction(async (tx) => {
      const receipt = await tx.outsourceReceipt.create({ data: { logisticsBatchId: id, orderNo: current.orderNo, receiptDate: new Date(input.receipt_date), quantity: input.quantity, receiverName: input.receiver_name, proofRemark: input.proof_remark, ...this.audit.create(user) } });
      await tx.outsourceLogisticsBatch.update({ where: { id }, data: { status, ...this.audit.update(user) } });
      const item = current.purchaseOrderItem;
      await tx.outsourcePayableSource.create({ data: { outsourceReceiptId: receipt.id, logisticsBatchId: id, orderNo: current.orderNo, purchaseOrderId: current.purchaseOrderId, purchaseOrderItemId: current.purchaseOrderItemId, supplierId: current.purchaseOrder.supplierId, quantity: input.quantity, unitPrice: item.unitPrice, currency: current.purchaseOrder.currency, taxRate: item.taxRate, amount: (quantity * Number(item.unitPrice)).toFixed(4), ...this.audit.create(user) } });
      return receipt;
    });
    await this.audit.record("outsource_receipt.create", "outsource_receipt", user.id, result.id, { order_no: current.orderNo, logistics_batch_id: id, quantity: input.quantity, payable_source: true });
    return this.get(id);
  }

  async payableSources(orderNo?: string) {
    return this.prisma.outsourcePayableSource.findMany({ where: orderNo ? { orderNo, deletedAt: null } : { deletedAt: null }, include: { outsourceReceipt: true, logisticsBatch: true }, orderBy: { createdAt: "desc" } });
  }

  async remove(id: string, user: CurrentUser) {
    const current = await this.get(id);
    if (current.status !== "draft") throw new UnprocessableEntityException({ code: "OUTSOURCE_BATCH_NOT_DELETABLE", message: "只有草稿外加工批次可以删除", details: [] });
    const result = await this.prisma.outsourceLogisticsBatch.update({ where: { id }, data: this.audit.softDelete(user) });
    await this.audit.record("outsource_logistics_batch.delete", "outsource_logistics_batch", user.id, id, { order_no: current.orderNo });
    return result;
  }

  private async refs(input: CreateInput) {
    const [production, item] = await Promise.all([
      this.prisma.productionOrder.findFirst({ where: { id: input.production_order_id, deletedAt: null }, include: { executionLocation: true } }),
      this.prisma.purchaseOrderItem.findFirst({ where: { id: input.purchase_order_item_id, deletedAt: null }, include: { purchaseOrder: true, material: true, unit: true } })
    ]);
    if (!production) throw new NotFoundException({ code: "PRODUCTION_ORDER_NOT_FOUND", message: "生产单不存在", details: [] });
    if (production.executionMode !== "outsourced") throw new UnprocessableEntityException({ code: "OUTSOURCE_PRODUCTION_REQUIRED", message: "只有外加工生产单可以直发", details: [] });
    if (["closed", "cancelled"].includes(production.status)) throw new UnprocessableEntityException({ code: "PRODUCTION_ORDER_NOT_WRITABLE", message: "当前生产单不允许新增外加工批次", details: [] });
    if (production.executionLocation.locationType !== "outsource_site" || !production.executionLocation.isActive) throw new UnprocessableEntityException({ code: "OUTSOURCE_LOCATION_INVALID", message: "外加工生产地点不存在或已停用", details: [] });
    if (!item) throw new NotFoundException({ code: "PURCHASE_ORDER_ITEM_NOT_FOUND", message: "采购明细不存在", details: [] });
    if (item.purchaseOrder.orderNo !== production.orderNo) throw new UnprocessableEntityException({ code: "ORDER_NO_MISMATCH", message: "采购明细与生产单订单号不一致", details: [] });
    if (["cancelled", "closed"].includes(item.purchaseOrder.status)) throw new UnprocessableEntityException({ code: "PURCHASE_ORDER_NOT_WRITABLE", message: "当前采购单不允许外加工直发", details: [] });
    return { production, location: production.executionLocation, item, po: item.purchaseOrder };
  }

  private decimal(value: string, code: string) { const number = Number(value); if (!Number.isFinite(number) || number <= 0) throw new UnprocessableEntityException({ code, message: "数量必须是大于零的有效数字", details: [] }); return number; }
}
