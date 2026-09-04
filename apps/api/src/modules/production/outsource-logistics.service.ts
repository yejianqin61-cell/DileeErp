import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { AuditService } from "../../platform/audit/audit.service";
import type { CurrentUser } from "../../platform/auth/auth.service";
import { PrismaService } from "../../platform/database/prisma.service";
import { ProductionProgressService } from "./production-progress.service";

type CreateInput = { production_order_id: string; purchase_order_item_id: string; planned_quantity: string; remark?: string };

@Injectable()
export class OutsourceLogisticsService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly progress: ProductionProgressService) {}

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

  async receipt(id: string, input: { quantity: string; receipt_date: string; receiver_name?: string; proof_remark?: string; difference_reason?: string; idempotency_key: string }, user: CurrentUser) {
    const current = await this.get(id);
    if (!["dispatched", "partially_received"].includes(current.status)) throw new UnprocessableEntityException({ code: "OUTSOURCE_BATCH_NOT_RECEIVABLE", message: "当前批次不允许签收", details: [] });
    const quantity = this.decimal(input.quantity, "INVALID_RECEIPT_QUANTITY");
    const received = current.receipts.reduce((sum, row) => sum + Number(row.quantity) - Number(row.reversalQuantity), 0);
    const remaining = Number(current.dispatchedQuantity) - received;
    if (quantity > remaining) throw new UnprocessableEntityException({ code: "OUTSOURCE_RECEIPT_QUANTITY_EXCEEDED", message: "签收数量超过未签收直发数量", details: [{ remaining: remaining.toFixed(4) }] });
    if (!input.proof_remark?.trim()) throw new UnprocessableEntityException({ code: "RECEIPT_PROOF_REQUIRED", message: "签收凭据或签收说明不能为空", details: [] });
    if (quantity < remaining && !input.difference_reason?.trim()) throw new UnprocessableEntityException({ code: "RECEIPT_DIFFERENCE_REASON_REQUIRED", message: "短收必须填写差异原因", details: [] });
    const duplicate = await this.prisma.outsourceReceipt.findFirst({ where: { idempotencyKey: input.idempotency_key, deletedAt: null } });
    if (duplicate) return this.get(id);
    const status = quantity === remaining ? "received" : "partially_received";
    const result = await this.prisma.$transaction(async (tx) => {
      const receipt = await tx.outsourceReceipt.create({ data: { logisticsBatchId: id, orderNo: current.orderNo, receiptDate: new Date(input.receipt_date), quantity: input.quantity, receiverName: input.receiver_name, proofRemark: input.proof_remark, differenceReason: input.difference_reason, idempotencyKey: input.idempotency_key, ...this.audit.create(user) } });
      await tx.outsourceLogisticsBatch.update({ where: { id }, data: { status, ...this.audit.update(user) } });
      const item = current.purchaseOrderItem;
      await tx.outsourcePayableSource.create({ data: { outsourceReceiptId: receipt.id, logisticsBatchId: id, orderNo: current.orderNo, purchaseOrderId: current.purchaseOrderId, purchaseOrderItemId: current.purchaseOrderItemId, supplierId: current.purchaseOrder.supplierId, quantity: input.quantity, unitPrice: item.unitPrice, currency: current.purchaseOrder.currency, taxRate: item.taxRate, amount: (quantity * Number(item.unitPrice)).toFixed(4), ...this.audit.create(user) } });
      return receipt;
    });
    await this.audit.record("outsource_receipt.create", "outsource_receipt", user.id, result.id, { order_no: current.orderNo, logistics_batch_id: id, quantity: input.quantity, payable_source: true });
    return { batch: await this.get(id), warning: quantity < remaining ? "OUTSOURCE_RECEIPT_SHORT" : null };
  }

  async payableSources(orderNo?: string) {
    return this.prisma.outsourcePayableSource.findMany({ where: orderNo ? { orderNo, deletedAt: null, status: { not: "voided" } } : { deletedAt: null, status: { not: "voided" } }, include: { outsourceReceipt: true, logisticsBatch: true, purchaseOrder: { select: { purchaseOrderNo: true } }, supplier: { select: { id: true, name: true, supplierCode: true } } }, orderBy: { createdAt: "desc" } });
  }

  async impactPreview(id: string) {
    const current = await this.get(id);
    const received = current.receipts.reduce((sum, row) => sum + Number(row.quantity) - Number(row.reversalQuantity), 0);
    const payable = await this.prisma.outsourcePayableSource.count({ where: { logisticsBatchId: id, deletedAt: null, status: { not: "voided" } } });
    return { order_no: current.orderNo, batch_no: current.batchNo, status: current.status, planned_quantity: current.plannedQuantity.toString(), dispatched_quantity: current.dispatchedQuantity.toString(), received_quantity: received.toFixed(4), payable_source_count: payable, inventory_effect: "none", warnings: current.status === "received" ? [] : ["该批次尚未全部签收"] };
  }

  async auditEvents(id: string) {
    const batch = await this.get(id);
    const receiptIds = batch.receipts.map((receipt) => receipt.id);
    return this.prisma.auditEvent.findMany({ where: { OR: [{ entityType: "outsource_logistics_batch", entityId: id }, { entityType: "outsource_receipt", entityId: { in: receiptIds } }] }, orderBy: { createdAt: "desc" } });
  }

  async reverseReceipt(receiptId: string, reason: string, user: CurrentUser) {
    if (!reason?.trim()) throw new UnprocessableEntityException({ code: "REVERSAL_REASON_REQUIRED", message: "冲销必须填写原因", details: [] });
    const receipt = await this.prisma.outsourceReceipt.findFirst({ where: { id: receiptId, deletedAt: null }, include: { logisticsBatch: { include: { receipts: { where: { deletedAt: null } } } }, payableSource: true } });
    if (!receipt) throw new NotFoundException({ code: "OUTSOURCE_RECEIPT_NOT_FOUND", message: "外加工签收记录不存在", details: [] });
    if (receipt.status === "reversed") throw new ConflictException({ code: "OUTSOURCE_RECEIPT_ALREADY_REVERSED", message: "外加工签收已冲销", details: [] });
    const result = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.outsourceReceipt.update({ where: { id: receiptId }, data: { status: "reversed", reversalQuantity: receipt.quantity, reversalReason: reason, ...this.audit.update(user) } });
      if (receipt.payableSource) await tx.outsourcePayableSource.update({ where: { id: receipt.payableSource.id }, data: { status: "voided", ...this.audit.update(user) } });
      const active = receipt.logisticsBatch.receipts.filter((row) => row.id !== receiptId && row.status !== "reversed").reduce((sum, row) => sum + Number(row.quantity) - Number(row.reversalQuantity), 0);
      const target = active === 0 ? "dispatched" : active >= Number(receipt.logisticsBatch.dispatchedQuantity) ? "received" : "partially_received";
      await tx.outsourceLogisticsBatch.update({ where: { id: receipt.logisticsBatchId }, data: { status: target, ...this.audit.update(user) } });
      return updated;
    });
    await this.audit.record("outsource_receipt.reverse", "outsource_receipt", user.id, receiptId, { order_no: receipt.orderNo, reason, before_quantity: receipt.quantity.toString() });
    return result;
  }

  async cancelDispatch(id: string, reason: string, user: CurrentUser) {
    if (!reason?.trim()) throw new UnprocessableEntityException({ code: "CANCELLATION_REASON_REQUIRED", message: "取消直发必须填写原因", details: [] });
    const current = await this.get(id);
    if (!["dispatched", "partially_received"].includes(current.status) || current.receipts.some((receipt) => receipt.status !== "reversed")) throw new UnprocessableEntityException({ code: "OUTSOURCE_DISPATCH_NOT_REVERSIBLE", message: "已存在有效签收的直发不能直接取消", details: [] });
    const result = await this.prisma.outsourceLogisticsBatch.update({ where: { id }, data: { status: "cancelled", remark: `${current.remark ?? ""}\n直发取消：${reason}`, ...this.audit.update(user) } });
    await this.audit.record("outsource_logistics_batch.cancel_dispatch", "outsource_logistics_batch", user.id, id, { order_no: current.orderNo, reason });
    return result;
  }

  async listReturns(orderNo?: string, transferType?: string) {
    return this.prisma.outsourceReturnTransfer.findMany({ where: { deletedAt: null, ...(transferType ? { transferType } : {}), ...(orderNo ? { orderNo } : {}) }, include: { productionOrder: { select: { productionOrderNo: true, executionMode: true } }, logisticsBatch: true, material: true, unit: true }, orderBy: { updatedAt: "desc" } });
  }

  async createMaterialReturn(input: { production_order_id: string; logistics_batch_id: string; material_id: string; unit_id: string; quantity: string; transfer_date: string; remark?: string }, user: CurrentUser) {
    const refs = await this.returnRefs(input);
    const quantity = this.decimal(input.quantity, "INVALID_RETURN_QUANTITY");
    if (refs.batch.materialId !== input.material_id || refs.batch.unitId !== input.unit_id) throw new UnprocessableEntityException({ code: "RETURN_REFERENCE_MISMATCH", message: "余料回厂物料或单位与直发批次不一致", details: [] });
    const transferNo = `RT-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomUUID().slice(0, 8).toUpperCase()}`;
    const created = await this.prisma.outsourceReturnTransfer.create({ data: { transferNo, transferType: "material_return", orderNo: refs.production.orderNo, productionOrderId: refs.production.id, logisticsBatchId: refs.batch.id, materialId: input.material_id, unitId: input.unit_id, quantity: input.quantity, transferDate: new Date(input.transfer_date), remark: input.remark, ...this.audit.create(user) } });
    await this.audit.record("outsource_material_return.create", "outsource_return_transfer", user.id, created.id, { order_no: created.orderNo, transfer_no: transferNo, quantity });
    return created;
  }

  async submitReturnForQc(id: string, user: CurrentUser) {
    const current = await this.prisma.outsourceReturnTransfer.findFirst({ where: { id, deletedAt: null } });
    if (!current) throw new NotFoundException({ code: "OUTSOURCE_RETURN_NOT_FOUND", message: "外加工回厂记录不存在", details: [] });
    if (current.transferType !== "material_return" || current.status !== "draft") throw new UnprocessableEntityException({ code: "OUTSOURCE_RETURN_NOT_SUBMITTABLE", message: "当前回厂记录不可提交 QC", details: [] });
    const result = await this.prisma.outsourceReturnTransfer.update({ where: { id }, data: { status: "pending_qc", ...this.audit.update(user) } });
    await this.audit.record("outsource_material_return.submit_qc", "outsource_return_transfer", user.id, id, { order_no: current.orderNo });
    return result;
  }

  async createFinishedReturn(input: { production_order_id: string; unit_id: string; product_description: string; quantity: string; transfer_date: string; remark?: string }, user: CurrentUser) {
    const production = await this.prisma.productionOrder.findFirst({ where: { id: input.production_order_id, deletedAt: null }, include: { unit: true } });
    if (!production || production.executionMode !== "outsourced") throw new NotFoundException({ code: "OUTSOURCE_PRODUCTION_NOT_FOUND", message: "外加工生产单不存在", details: [] });
    if (["closed", "cancelled"].includes(production.status)) throw new UnprocessableEntityException({ code: "PRODUCTION_ORDER_NOT_WRITABLE", message: "当前生产单不允许登记余料回厂", details: [] });
    if (["closed", "cancelled"].includes(production.status)) throw new UnprocessableEntityException({ code: "PRODUCTION_ORDER_NOT_WRITABLE", message: "当前生产单不允许登记成品回厂", details: [] });
    await this.requireActiveUnit(input.unit_id);
    this.decimal(input.quantity, "INVALID_RETURN_QUANTITY");
    if (!input.product_description?.trim()) throw new UnprocessableEntityException({ code: "PRODUCT_DESCRIPTION_REQUIRED", message: "成品描述不能为空", details: [] });
    const transferNo = `FG-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomUUID().slice(0, 8).toUpperCase()}`;
    const created = await this.prisma.$transaction(async (tx) => {
      const row = await tx.outsourceReturnTransfer.create({ data: { transferNo, transferType: "finished_goods_return", orderNo: production.orderNo, productionOrderId: production.id, unitId: input.unit_id, productDescription: input.product_description, quantity: input.quantity, transferDate: new Date(input.transfer_date), remark: input.remark, ...this.audit.create(user) } });
      await this.progress.recalculateInTransaction(tx, production.id, "outsource_finished_goods_return", row.id, user);
      return row;
    });
    await this.audit.record("outsource_finished_return.create", "outsource_return_transfer", user.id, created.id, { order_no: created.orderNo, transfer_no: transferNo, quantity: input.quantity });
    return created;
  }

  async submitFinishedReturnForQc(id: string, user: CurrentUser) {
    const current = await this.prisma.outsourceReturnTransfer.findFirst({ where: { id, deletedAt: null } });
    if (!current || current.transferType !== "finished_goods_return") throw new NotFoundException({ code: "OUTSOURCE_FINISHED_RETURN_NOT_FOUND", message: "外加工成品回厂记录不存在", details: [] });
    if (current.status !== "draft") throw new UnprocessableEntityException({ code: "OUTSOURCE_RETURN_NOT_SUBMITTABLE", message: "当前回厂记录不可提交 QC", details: [] });
    const result = await this.prisma.$transaction(async (tx) => {
      const row = await tx.outsourceReturnTransfer.update({ where: { id }, data: { status: "pending_qc", ...this.audit.update(user) } });
      await this.progress.recalculateInTransaction(tx, current.productionOrderId, "outsource_finished_goods_return", id, user);
      return row;
    });
    await this.audit.record("outsource_finished_return.submit_qc", "outsource_return_transfer", user.id, id, { order_no: current.orderNo });
    return result;
  }

  async updateReturn(id: string, input: { quantity?: string; remark?: string; product_description?: string }, user: CurrentUser) {
    const current = await this.prisma.outsourceReturnTransfer.findFirst({ where: { id, deletedAt: null } });
    if (!current) throw new NotFoundException({ code: "OUTSOURCE_RETURN_NOT_FOUND", message: "外加工回厂记录不存在", details: [] });
    if (current.status !== "draft") throw new UnprocessableEntityException({ code: "OUTSOURCE_RETURN_NOT_EDITABLE", message: "只有草稿回厂记录可以编辑", details: [] });
    if (input.quantity !== undefined) this.decimal(input.quantity, "INVALID_RETURN_QUANTITY");
    const result = await this.prisma.$transaction(async (tx) => {
      const row = await tx.outsourceReturnTransfer.update({ where: { id }, data: { ...(input.quantity === undefined ? {} : { quantity: input.quantity }), ...(input.remark === undefined ? {} : { remark: input.remark }), ...(input.product_description === undefined ? {} : { productDescription: input.product_description }), ...this.audit.update(user) } });
      if (current.transferType === "finished_goods_return") await this.progress.recalculateInTransaction(tx, current.productionOrderId, "outsource_finished_goods_return", id, user);
      return row;
    });
    return result;
  }

  async removeReturn(id: string, user: CurrentUser) {
    const current = await this.prisma.outsourceReturnTransfer.findFirst({ where: { id, deletedAt: null } });
    if (!current) throw new NotFoundException({ code: "OUTSOURCE_RETURN_NOT_FOUND", message: "外加工回厂记录不存在", details: [] });
    if (current.status !== "draft") throw new UnprocessableEntityException({ code: "OUTSOURCE_RETURN_NOT_DELETABLE", message: "只有草稿回厂记录可以删除", details: [] });
    const result = await this.prisma.$transaction(async (tx) => {
      const row = await tx.outsourceReturnTransfer.update({ where: { id }, data: this.audit.softDelete(user) });
      if (current.transferType === "finished_goods_return") await this.progress.recalculateInTransaction(tx, current.productionOrderId, "outsource_finished_goods_return", id, user);
      return row;
    });
    return result;
  }

  async updateDirectShipment(id: string, input: { quantity?: string; product_description?: string; logistics_reference?: string; remark?: string }, user: CurrentUser) {
    const current = await this.prisma.outsourceDirectShipment.findFirst({ where: { id, deletedAt: null } });
    if (!current) throw new NotFoundException({ code: "OUTSOURCE_DIRECT_SHIPMENT_NOT_FOUND", message: "外加工直装柜记录不存在", details: [] });
    if (current.status !== "draft") throw new UnprocessableEntityException({ code: "OUTSOURCE_DIRECT_SHIPMENT_NOT_EDITABLE", message: "只有草稿直装柜记录可以编辑", details: [] });
    if (input.quantity !== undefined) this.decimal(input.quantity, "INVALID_SHIPMENT_QUANTITY");
    return this.prisma.outsourceDirectShipment.update({ where: { id }, data: { ...(input.quantity === undefined ? {} : { quantity: input.quantity }), ...(input.product_description === undefined ? {} : { productDescription: input.product_description }), ...(input.logistics_reference === undefined ? {} : { logisticsReference: input.logistics_reference }), ...(input.remark === undefined ? {} : { remark: input.remark }), ...this.audit.update(user) } });
  }

  async removeDirectShipment(id: string, user: CurrentUser) {
    const current = await this.prisma.outsourceDirectShipment.findFirst({ where: { id, deletedAt: null } });
    if (!current) throw new NotFoundException({ code: "OUTSOURCE_DIRECT_SHIPMENT_NOT_FOUND", message: "外加工直装柜记录不存在", details: [] });
    if (current.status !== "draft") throw new UnprocessableEntityException({ code: "OUTSOURCE_DIRECT_SHIPMENT_NOT_DELETABLE", message: "只有草稿直装柜记录可以删除", details: [] });
    return this.prisma.outsourceDirectShipment.update({ where: { id }, data: this.audit.softDelete(user) });
  }

  async listDirectShipments(orderNo?: string) {
    return this.prisma.outsourceDirectShipment.findMany({ where: { deletedAt: null, ...(orderNo ? { orderNo } : {}) }, include: { productionOrder: { select: { productionOrderNo: true, executionMode: true } }, unit: true }, orderBy: { updatedAt: "desc" } });
  }

  async createDirectShipment(input: { production_order_id: string; unit_id: string; product_description: string; quantity: string; shipment_date: string; logistics_reference: string; remark?: string }, user: CurrentUser) {
    const production = await this.prisma.productionOrder.findFirst({ where: { id: input.production_order_id, deletedAt: null } });
    if (!production || production.executionMode !== "outsourced") throw new NotFoundException({ code: "OUTSOURCE_PRODUCTION_NOT_FOUND", message: "外加工生产单不存在", details: [] });
    if (["closed", "cancelled"].includes(production.status)) throw new UnprocessableEntityException({ code: "PRODUCTION_ORDER_NOT_WRITABLE", message: "当前生产单不允许直装柜", details: [] });
    await this.requireActiveUnit(input.unit_id);
    this.decimal(input.quantity, "INVALID_SHIPMENT_QUANTITY");
    if (!input.product_description?.trim() || !input.logistics_reference?.trim()) throw new UnprocessableEntityException({ code: "SHIPMENT_REFERENCE_REQUIRED", message: "成品描述和物流/装柜资料不能为空", details: [] });
    const shipmentNo = `OS-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomUUID().slice(0, 8).toUpperCase()}`;
    const created = await this.prisma.$transaction(async (tx) => {
      const row = await tx.outsourceDirectShipment.create({ data: { shipmentNo, orderNo: production.orderNo, productionOrderId: production.id, productDescription: input.product_description, unitId: input.unit_id, quantity: input.quantity, shipmentDate: new Date(input.shipment_date), logisticsReference: input.logistics_reference, remark: input.remark, ...this.audit.create(user) } });
      await this.progress.recalculateInTransaction(tx, production.id, "outsource_direct_shipment", row.id, user);
      return row;
    });
    await this.audit.record("outsource_direct_shipment.create", "outsource_direct_shipment", user.id, created.id, { order_no: created.orderNo, shipment_no: shipmentNo });
    return created;
  }

  async dispatchDirectShipment(id: string, user: CurrentUser) {
    const current = await this.prisma.outsourceDirectShipment.findFirst({ where: { id, deletedAt: null } });
    if (!current) throw new NotFoundException({ code: "OUTSOURCE_DIRECT_SHIPMENT_NOT_FOUND", message: "外加工直装柜记录不存在", details: [] });
    if (current.status !== "draft") throw new UnprocessableEntityException({ code: "OUTSOURCE_DIRECT_SHIPMENT_NOT_DISPATCHABLE", message: "当前直装柜记录不可发出", details: [] });
    const result = await this.prisma.$transaction(async (tx) => {
      const row = await tx.outsourceDirectShipment.update({ where: { id }, data: { status: "dispatched", ...this.audit.update(user) } });
      await this.progress.recalculateInTransaction(tx, current.productionOrderId, "outsource_direct_shipment", id, user);
      return row;
    });
    await this.audit.record("outsource_direct_shipment.dispatch", "outsource_direct_shipment", user.id, id, { order_no: current.orderNo, quantity: current.quantity.toString() });
    return result;
  }

  async reverseDirectShipment(id: string, reason: string, user: CurrentUser) {
    if (!reason?.trim()) throw new UnprocessableEntityException({ code: "REVERSAL_REASON_REQUIRED", message: "冲销必须填写原因", details: [] });
    const current = await this.prisma.outsourceDirectShipment.findFirst({ where: { id, deletedAt: null } });
    if (!current) throw new NotFoundException({ code: "OUTSOURCE_DIRECT_SHIPMENT_NOT_FOUND", message: "外加工直装柜记录不存在", details: [] });
    if (current.status !== "dispatched") throw new UnprocessableEntityException({ code: "OUTSOURCE_DIRECT_SHIPMENT_NOT_REVERSIBLE", message: "只有已发出的直装柜记录可以冲销", details: [] });
    const result = await this.prisma.$transaction(async (tx) => {
      const row = await tx.outsourceDirectShipment.update({ where: { id }, data: { status: "corrected", reversalQuantity: current.quantity, reversalReason: reason, ...this.audit.update(user) } });
      await this.progress.recalculateInTransaction(tx, current.productionOrderId, "outsource_direct_shipment", id, user);
      return row;
    });
    await this.audit.record("outsource_direct_shipment.reverse", "outsource_direct_shipment", user.id, id, { order_no: current.orderNo, reason });
    return result;
  }

  private async returnRefs(input: { production_order_id: string; logistics_batch_id: string }) {
    const [production, batch] = await Promise.all([this.prisma.productionOrder.findFirst({ where: { id: input.production_order_id, deletedAt: null } }), this.prisma.outsourceLogisticsBatch.findFirst({ where: { id: input.logistics_batch_id, deletedAt: null } })]);
    if (!production || production.executionMode !== "outsourced") throw new NotFoundException({ code: "OUTSOURCE_PRODUCTION_NOT_FOUND", message: "外加工生产单不存在", details: [] });
    if (!batch || batch.orderNo !== production.orderNo) throw new UnprocessableEntityException({ code: "RETURN_ORDER_MISMATCH", message: "回厂批次与生产单订单号不一致", details: [] });
    if (batch.status === "cancelled") throw new UnprocessableEntityException({ code: "OUTSOURCE_BATCH_CANCELLED", message: "已取消的外加工批次不能回厂", details: [] });
    return { production, batch };
  }

  private async requireActiveUnit(id: string) { const unit = await this.prisma.unit.findFirst({ where: { id, deletedAt: null, isActive: true } }); if (!unit) throw new NotFoundException({ code: "UNIT_NOT_FOUND", message: "单位不存在或已停用", details: [] }); return unit; }

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
