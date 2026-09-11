import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
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
    const used = existing._sum.plannedQuantity ?? new Prisma.Decimal(0);
    if (planned.plus(used).gt(refs.item.quantity)) throw new UnprocessableEntityException({ code: "OUTSOURCE_BATCH_QUANTITY_EXCEEDED", message: "外加工直发计划数量超过采购明细数量", details: [{ available: refs.item.quantity.minus(used).toString() }] });
    const batchNo = `OB-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomUUID().slice(0, 8).toUpperCase()}`;
    const created = await this.prisma.outsourceLogisticsBatch.create({ data: { batchNo, orderNo: refs.production.orderNo, productionOrderId: refs.production.id, outsourceLocationId: refs.location.id, purchaseOrderId: refs.po.id, purchaseOrderItemId: refs.item.id, materialId: refs.item.materialId, unitId: refs.item.unitId, plannedQuantity: input.planned_quantity, remark: input.remark, ...this.audit.create(user) } });
    await this.audit.record("outsource_logistics_batch.create", "outsource_logistics_batch", user.id, created.id, { order_no: created.orderNo, batch_no: batchNo });
    return this.get(created.id);
  }

  async update(id: string, input: { planned_quantity?: string; remark?: string }, user: CurrentUser) {
    const planned = input.planned_quantity === undefined ? null : this.decimal(input.planned_quantity, "INVALID_OUTSOURCE_BATCH_QUANTITY");
    let before: { planned_quantity: string; remark: string | null } | undefined;
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM outsource_logistics_batches WHERE id = ${id}::uuid FOR UPDATE`;
      const current = await tx.outsourceLogisticsBatch.findFirst({ where: { id, deletedAt: null }, include: { purchaseOrderItem: true } });
      if (!current) throw new NotFoundException({ code: "OUTSOURCE_BATCH_NOT_FOUND", message: "外加工物流批次不存在", details: [] });
      if (current.status !== "draft") throw new UnprocessableEntityException({ code: "OUTSOURCE_BATCH_NOT_EDITABLE", message: "只有草稿外加工批次可以编辑", details: [] });
      before = { planned_quantity: current.plannedQuantity.toString(), remark: current.remark };
      if (planned) {
        await tx.$queryRaw`SELECT id FROM purchase_order_items WHERE id = ${current.purchaseOrderItemId}::uuid FOR UPDATE`;
        const existing = await tx.outsourceLogisticsBatch.aggregate({ where: { purchaseOrderItemId: current.purchaseOrderItemId, id: { not: id }, deletedAt: null, status: { not: "cancelled" } }, _sum: { plannedQuantity: true } });
        const used = existing._sum.plannedQuantity ?? new Prisma.Decimal(0);
        if (planned.plus(used).gt(current.purchaseOrderItem.quantity)) throw new UnprocessableEntityException({ code: "OUTSOURCE_BATCH_QUANTITY_EXCEEDED", message: "外加工直发计划数量超过采购明细数量", details: [{ available: current.purchaseOrderItem.quantity.minus(used).toString() }] });
      }
      const updated = await tx.outsourceLogisticsBatch.updateMany({ where: { id, status: "draft" }, data: { ...(planned === null ? {} : { plannedQuantity: planned.toString() }), ...(input.remark === undefined ? {} : { remark: input.remark }), ...this.audit.update(user) } });
      if (updated.count !== 1) throw new ConflictException({ code: "VERSION_CONFLICT", message: "外加工批次已被其他操作处理，请刷新后重试", details: [] });
      const row = await tx.outsourceLogisticsBatch.findFirst({ where: { id, deletedAt: null } });
      if (!row) throw new NotFoundException({ code: "OUTSOURCE_BATCH_NOT_FOUND", message: "外加工物流批次不存在", details: [] });
      return row;
    });
    await this.audit.record("outsource_logistics_batch.update", "outsource_logistics_batch", user.id, id, { order_no: result.orderNo, before: before ?? { planned_quantity: result.plannedQuantity.toString(), remark: result.remark }, after: input });
    return result;
  }

  async dispatch(id: string, input: { quantity: string; dispatch_date: string; proof_remark?: string }, user: CurrentUser) {
    const quantity = this.decimal(input.quantity, "INVALID_DISPATCH_QUANTITY");
    if (!input.proof_remark?.trim()) throw new UnprocessableEntityException({ code: "DISPATCH_PROOF_REQUIRED", message: "直发凭据或交接说明不能为空", details: [] });
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM outsource_logistics_batches WHERE id = ${id}::uuid FOR UPDATE`;
      const current = await tx.outsourceLogisticsBatch.findFirst({ where: { id, deletedAt: null } });
      if (!current) throw new NotFoundException({ code: "OUTSOURCE_BATCH_NOT_FOUND", message: "外加工物流批次不存在", details: [] });
      if (current.status !== "draft") throw new UnprocessableEntityException({ code: "OUTSOURCE_BATCH_NOT_DISPATCHABLE", message: "只有草稿批次可以直发", details: [] });
      if (quantity.gt(current.plannedQuantity)) throw new UnprocessableEntityException({ code: "DISPATCH_QUANTITY_EXCEEDED", message: "直发数量不能超过批次计划数量", details: [] });
      const updated = await tx.outsourceLogisticsBatch.updateMany({ where: { id, status: "draft" }, data: { dispatchedQuantity: quantity, dispatchDate: new Date(input.dispatch_date), dispatchProofRemark: input.proof_remark, status: "dispatched", ...this.audit.update(user) } });
      if (updated.count !== 1) throw new ConflictException({ code: "VERSION_CONFLICT", message: "外加工批次已被其他操作处理，请刷新后重试", details: [] });
      const row = await tx.outsourceLogisticsBatch.findFirst({ where: { id, deletedAt: null } });
      if (!row) throw new NotFoundException({ code: "OUTSOURCE_BATCH_NOT_FOUND", message: "外加工物流批次不存在", details: [] });
      return row;
    });
    await this.audit.record("outsource_logistics_batch.dispatch", "outsource_logistics_batch", user.id, id, { order_no: result.orderNo, quantity: input.quantity });
    return result;
  }

  async receipt(id: string, input: { quantity: string; receipt_date: string; receiver_name?: string; proof_remark?: string; difference_reason?: string; idempotency_key: string }, user: CurrentUser) {
    const quantity = this.decimal(input.quantity, "INVALID_RECEIPT_QUANTITY");
    if (!input.proof_remark?.trim()) throw new UnprocessableEntityException({ code: "RECEIPT_PROOF_REQUIRED", message: "签收凭据或签收说明不能为空", details: [] });
    let shortReceipt = false;
    try {
      const receipt = await this.prisma.$transaction(async (tx) => {
        // 事务第一句锁批次行：串行化同一批次的全部签收，杜绝并发双花
        await tx.$queryRaw`SELECT id FROM outsource_logistics_batches WHERE id = ${id}::uuid FOR UPDATE`;
        // 幂等复查限定批次作用域并比对请求数量：先于状态/余量校验执行，使重复提交可安全重放
        const duplicate = await tx.outsourceReceipt.findFirst({ where: { idempotencyKey: input.idempotency_key, logisticsBatchId: id, deletedAt: null } });
        if (duplicate) {
          if (new Prisma.Decimal(duplicate.quantity).eq(quantity)) return null;
          throw new ConflictException({ code: "OUTSOURCE_RECEIPT_IDEMPOTENCY_CONFLICT", message: "幂等键已被该批次其它签收使用，请检查后重试", details: [] });
        }
        const current = await tx.outsourceLogisticsBatch.findFirst({ where: { id, deletedAt: null }, include: { receipts: { where: { deletedAt: null } }, purchaseOrderItem: true, purchaseOrder: { select: { supplierId: true, currency: true } } } });
        if (!current) throw new NotFoundException({ code: "OUTSOURCE_BATCH_NOT_FOUND", message: "外加工物流批次不存在", details: [] });
        if (!["dispatched", "partially_received"].includes(current.status)) throw new UnprocessableEntityException({ code: "OUTSOURCE_BATCH_NOT_RECEIVABLE", message: "当前批次不允许签收", details: [] });
        // 锁内重读 receipts 并以 Decimal 重算剩余可签收量
        const received = current.receipts.reduce((sum, row) => sum.plus(row.quantity).minus(row.reversalQuantity), new Prisma.Decimal(0));
        const remaining = new Prisma.Decimal(current.dispatchedQuantity).minus(received);
        if (quantity.gt(remaining)) throw new UnprocessableEntityException({ code: "OUTSOURCE_RECEIPT_QUANTITY_EXCEEDED", message: "签收数量超过未签收直发数量", details: [{ remaining: remaining.toString() }] });
        if (quantity.lt(remaining) && !input.difference_reason?.trim()) throw new UnprocessableEntityException({ code: "RECEIPT_DIFFERENCE_REASON_REQUIRED", message: "短收必须填写差异原因", details: [] });
        const status = quantity.eq(remaining) ? "received" : "partially_received";
        shortReceipt = quantity.lt(remaining);
        const row = await tx.outsourceReceipt.create({ data: { logisticsBatchId: id, orderNo: current.orderNo, receiptDate: new Date(input.receipt_date), quantity, receiverName: input.receiver_name, proofRemark: input.proof_remark, differenceReason: input.difference_reason, idempotencyKey: input.idempotency_key, ...this.audit.create(user) } });
        // 批次状态写入使用带期望状态的条件更新以检测并发
        const batchUpdated = await tx.outsourceLogisticsBatch.updateMany({ where: { id, status: current.status }, data: { status, ...this.audit.update(user) } });
        if (batchUpdated.count !== 1) throw new ConflictException({ code: "VERSION_CONFLICT", message: "外加工批次已被其他操作处理，请刷新后重试", details: [] });
        const item = current.purchaseOrderItem;
        const amount = quantity.mul(item.unitPrice).toDecimalPlaces(4);
        await tx.outsourcePayableSource.create({ data: { outsourceReceiptId: row.id, logisticsBatchId: id, orderNo: current.orderNo, purchaseOrderId: current.purchaseOrderId, purchaseOrderItemId: current.purchaseOrderItemId, supplierId: current.purchaseOrder.supplierId ?? item.supplierId, quantity, unitPrice: item.unitPrice, currency: current.purchaseOrder.currency ?? "CNY", taxRate: item.taxRate, amount, ...this.audit.create(user) } });
        return row;
      });
      if (!receipt) return this.get(id);
      await this.audit.record("outsource_receipt.create", "outsource_receipt", user.id, receipt.id, { order_no: receipt.orderNo, logistics_batch_id: id, quantity: receipt.quantity.toString(), payable_source: true });
      return { batch: await this.get(id), warning: shortReceipt ? "OUTSOURCE_RECEIPT_SHORT" : null };
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "P2002") throw new ConflictException({ code: "UNIQUE_VALUE_CONFLICT", message: "签收记录重复（幂等键或应付来源冲突），请检查后重试", details: [] });
      if (error && typeof error === "object" && "code" in error && error.code === "P2034") throw new ConflictException({ code: "VERSION_CONFLICT", message: "签收已被其他操作处理，请刷新后重试", details: [] });
      throw error;
    }
  }

  async payableSources(orderNo?: string) {
    return this.prisma.outsourcePayableSource.findMany({ where: orderNo ? { orderNo, deletedAt: null, status: { not: "voided" } } : { deletedAt: null, status: { not: "voided" } }, include: { outsourceReceipt: true, logisticsBatch: true, purchaseOrder: { select: { purchaseOrderNo: true } }, supplier: { select: { id: true, name: true, supplierCode: true } } }, orderBy: { createdAt: "desc" } });
  }

  async impactPreview(id: string) {
    const current = await this.get(id);
    const received = current.receipts.reduce((sum, row) => sum.plus(row.quantity).minus(row.reversalQuantity), new Prisma.Decimal(0));
    const payable = await this.prisma.outsourcePayableSource.count({ where: { logisticsBatchId: id, deletedAt: null, status: { not: "voided" } } });
    return { order_no: current.orderNo, batch_no: current.batchNo, status: current.status, planned_quantity: current.plannedQuantity.toString(), dispatched_quantity: current.dispatchedQuantity.toString(), received_quantity: received.toString(), payable_source_count: payable, inventory_effect: "none", warnings: current.status === "received" ? [] : ["该批次尚未全部签收"] };
  }

  async auditEvents(id: string) {
    const batch = await this.get(id);
    const receiptIds = batch.receipts.map((receipt) => receipt.id);
    return this.prisma.auditEvent.findMany({ where: { OR: [{ entityType: "outsource_logistics_batch", entityId: id }, { entityType: "outsource_receipt", entityId: { in: receiptIds } }] }, orderBy: { createdAt: "desc" } });
  }

  async reverseReceipt(receiptId: string, reason: string, user: CurrentUser) {
    if (!reason?.trim()) throw new UnprocessableEntityException({ code: "REVERSAL_REASON_REQUIRED", message: "冲销必须填写原因", details: [] });
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM outsource_receipts WHERE id = ${receiptId}::uuid FOR UPDATE`;
      const receipt = await tx.outsourceReceipt.findFirst({ where: { id: receiptId, deletedAt: null }, include: { logisticsBatch: true, payableSource: true } });
      if (!receipt) throw new NotFoundException({ code: "OUTSOURCE_RECEIPT_NOT_FOUND", message: "外加工签收记录不存在", details: [] });
      if (receipt.status === "reversed") throw new ConflictException({ code: "OUTSOURCE_RECEIPT_ALREADY_REVERSED", message: "外加工签收已冲销", details: [] });
      await tx.$queryRaw`SELECT id FROM outsource_logistics_batches WHERE id = ${receipt.logisticsBatchId}::uuid FOR UPDATE`;
      const batch = await tx.outsourceLogisticsBatch.findFirst({ where: { id: receipt.logisticsBatchId, deletedAt: null } });
      if (!batch) throw new NotFoundException({ code: "OUTSOURCE_BATCH_NOT_FOUND", message: "外加工物流批次不存在", details: [] });
      const reversed = await tx.outsourceReceipt.updateMany({ where: { id: receiptId, status: "received" }, data: { status: "reversed", reversalQuantity: receipt.quantity, reversalReason: reason, ...this.audit.update(user) } });
      if (reversed.count !== 1) throw new ConflictException({ code: "OUTSOURCE_RECEIPT_ALREADY_REVERSED", message: "外加工签收已冲销", details: [] });
      if (receipt.payableSource) await tx.outsourcePayableSource.updateMany({ where: { id: receipt.payableSource.id, status: { not: "voided" } }, data: { status: "voided", ...this.audit.update(user) } });
      const allReceipts = await tx.outsourceReceipt.findMany({ where: { logisticsBatchId: receipt.logisticsBatchId, deletedAt: null } });
      const active = allReceipts.filter((row) => row.id !== receiptId && row.status !== "reversed").reduce((sum, row) => sum.plus(row.quantity).minus(row.reversalQuantity), new Prisma.Decimal(0));
      const target = active.eq(0) ? "dispatched" : active.gte(batch.dispatchedQuantity) ? "received" : "partially_received";
      const batchUpdated = await tx.outsourceLogisticsBatch.updateMany({ where: { id: batch.id, status: batch.status }, data: { status: target, ...this.audit.update(user) } });
      if (batchUpdated.count !== 1) throw new ConflictException({ code: "VERSION_CONFLICT", message: "外加工批次已被其他操作处理，请刷新后重试", details: [] });
      const updatedReceipt = await tx.outsourceReceipt.findFirst({ where: { id: receiptId } });
      if (!updatedReceipt) throw new NotFoundException({ code: "OUTSOURCE_RECEIPT_NOT_FOUND", message: "外加工签收记录不存在", details: [] });
      return updatedReceipt;
    });
    await this.audit.record("outsource_receipt.reverse", "outsource_receipt", user.id, receiptId, { order_no: result.orderNo, reason, before_quantity: result.quantity.toString() });
    return result;
  }

  async cancelDispatch(id: string, reason: string, user: CurrentUser) {
    if (!reason?.trim()) throw new UnprocessableEntityException({ code: "CANCELLATION_REASON_REQUIRED", message: "取消直发必须填写原因", details: [] });
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM outsource_logistics_batches WHERE id = ${id}::uuid FOR UPDATE`;
      const current = await tx.outsourceLogisticsBatch.findFirst({ where: { id, deletedAt: null }, include: { receipts: { where: { deletedAt: null } } } });
      if (!current) throw new NotFoundException({ code: "OUTSOURCE_BATCH_NOT_FOUND", message: "外加工物流批次不存在", details: [] });
      if (!["dispatched", "partially_received"].includes(current.status) || current.receipts.some((receipt) => receipt.status !== "reversed")) throw new UnprocessableEntityException({ code: "OUTSOURCE_DISPATCH_NOT_REVERSIBLE", message: "已存在有效签收的直发不能直接取消", details: [] });
      const updated = await tx.outsourceLogisticsBatch.updateMany({ where: { id, status: current.status }, data: { status: "cancelled", remark: `${current.remark ?? ""}\n直发取消：${reason}`, ...this.audit.update(user) } });
      if (updated.count !== 1) throw new ConflictException({ code: "VERSION_CONFLICT", message: "外加工批次已被其他操作处理，请刷新后重试", details: [] });
      const row = await tx.outsourceLogisticsBatch.findFirst({ where: { id, deletedAt: null } });
      if (!row) throw new NotFoundException({ code: "OUTSOURCE_BATCH_NOT_FOUND", message: "外加工物流批次不存在", details: [] });
      return row;
    });
    await this.audit.record("outsource_logistics_batch.cancel_dispatch", "outsource_logistics_batch", user.id, id, { order_no: result.orderNo, reason });
    return result;
  }

  async listReturns(orderNo?: string, transferType?: string) {
    return this.prisma.outsourceReturnTransfer.findMany({ where: { deletedAt: null, ...(transferType ? { transferType } : {}), ...(orderNo ? { orderNo } : {}) }, include: { productionOrder: { select: { productionOrderNo: true, executionMode: true } }, logisticsBatch: true, material: true, unit: true }, orderBy: { updatedAt: "desc" } });
  }

  async createMaterialReturn(input: { production_order_id: string; logistics_batch_id: string; material_id: string; unit_id: string; quantity: string; transfer_date: string; remark?: string }, user: CurrentUser) {
    const created = await this.prisma.$transaction(async (tx) => {
      const refs = await this.lockReturnRefs(tx, input);
      const quantity = this.decimal(input.quantity, "INVALID_RETURN_QUANTITY");
      if (refs.batch.materialId !== input.material_id || refs.batch.unitId !== input.unit_id) throw new UnprocessableEntityException({ code: "RETURN_REFERENCE_MISMATCH", message: "余料回厂物料或单位与直发批次不一致", details: [] });
      const transferNo = `RT-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomUUID().slice(0, 8).toUpperCase()}`;
      const row = await tx.outsourceReturnTransfer.create({ data: { transferNo, transferType: "material_return", orderNo: refs.production.orderNo, productionOrderId: refs.production.id, logisticsBatchId: refs.batch.id, materialId: input.material_id, unitId: input.unit_id, quantity, transferDate: new Date(input.transfer_date), remark: input.remark, ...this.audit.create(user) } });
      return row;
    });
    await this.audit.record("outsource_material_return.create", "outsource_return_transfer", user.id, created.id, { order_no: created.orderNo, transfer_no: created.transferNo, quantity: created.quantity.toString() });
    return created;
  }

  async submitReturnForQc(id: string, user: CurrentUser) {
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM outsource_return_transfers WHERE id = ${id}::uuid FOR UPDATE`;
      const current = await tx.outsourceReturnTransfer.findFirst({ where: { id, deletedAt: null } });
      if (!current) throw new NotFoundException({ code: "OUTSOURCE_RETURN_NOT_FOUND", message: "外加工回厂记录不存在", details: [] });
      if (current.transferType !== "material_return" || current.status !== "draft") throw new UnprocessableEntityException({ code: "OUTSOURCE_RETURN_NOT_SUBMITTABLE", message: "当前回厂记录不可提交 QC", details: [] });
      const updated = await tx.outsourceReturnTransfer.updateMany({ where: { id, status: "draft" }, data: { status: "pending_qc", ...this.audit.update(user) } });
      if (updated.count !== 1) throw new ConflictException({ code: "VERSION_CONFLICT", message: "外加工回厂记录已被其他操作处理，请刷新后重试", details: [] });
      const row = await tx.outsourceReturnTransfer.findFirst({ where: { id, deletedAt: null } });
      if (!row) throw new NotFoundException({ code: "OUTSOURCE_RETURN_NOT_FOUND", message: "外加工回厂记录不存在", details: [] });
      return row;
    });
    await this.audit.record("outsource_material_return.submit_qc", "outsource_return_transfer", user.id, id, { order_no: result.orderNo });
    return result;
  }

  async createFinishedReturn(input: { production_order_id: string; unit_id: string; product_description: string; quantity: string; transfer_date: string; remark?: string }, user: CurrentUser) {
    const quantity = this.decimal(input.quantity, "INVALID_RETURN_QUANTITY");
    if (!input.product_description?.trim()) throw new UnprocessableEntityException({ code: "PRODUCT_DESCRIPTION_REQUIRED", message: "成品描述不能为空", details: [] });
    const transferNo = `FG-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomUUID().slice(0, 8).toUpperCase()}`;
    const created = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM production_orders WHERE id = ${input.production_order_id}::uuid FOR UPDATE`;
      const production = await tx.productionOrder.findFirst({ where: { id: input.production_order_id, deletedAt: null }, include: { unit: true } });
      if (!production || production.executionMode !== "outsourced") throw new NotFoundException({ code: "OUTSOURCE_PRODUCTION_NOT_FOUND", message: "外加工生产单不存在", details: [] });
      if (["closed", "cancelled"].includes(production.status)) throw new UnprocessableEntityException({ code: "PRODUCTION_ORDER_NOT_WRITABLE", message: "当前生产单不允许登记成品回厂", details: [] });
      await this.requireActiveUnit(input.unit_id, tx);
      const row = await tx.outsourceReturnTransfer.create({ data: { transferNo, transferType: "finished_goods_return", orderNo: production.orderNo, productionOrderId: production.id, unitId: input.unit_id, productDescription: input.product_description, quantity, transferDate: new Date(input.transfer_date), remark: input.remark, ...this.audit.create(user) } });
      await this.progress.recalculateInTransaction(tx, production.id, "outsource_finished_goods_return", row.id, user);
      return row;
    });
    await this.audit.record("outsource_finished_return.create", "outsource_return_transfer", user.id, created.id, { order_no: created.orderNo, transfer_no: transferNo, quantity: created.quantity.toString() });
    return created;
  }

  async submitFinishedReturnForQc(id: string, user: CurrentUser) {
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM outsource_return_transfers WHERE id = ${id}::uuid FOR UPDATE`;
      const current = await tx.outsourceReturnTransfer.findFirst({ where: { id, deletedAt: null } });
      if (!current || current.transferType !== "finished_goods_return") throw new NotFoundException({ code: "OUTSOURCE_FINISHED_RETURN_NOT_FOUND", message: "外加工成品回厂记录不存在", details: [] });
      if (current.status !== "draft") throw new UnprocessableEntityException({ code: "OUTSOURCE_RETURN_NOT_SUBMITTABLE", message: "当前回厂记录不可提交 QC", details: [] });
      const updated = await tx.outsourceReturnTransfer.updateMany({ where: { id, status: "draft" }, data: { status: "pending_qc", ...this.audit.update(user) } });
      if (updated.count !== 1) throw new ConflictException({ code: "VERSION_CONFLICT", message: "外加工回厂记录已被其他操作处理，请刷新后重试", details: [] });
      const row = await tx.outsourceReturnTransfer.findFirst({ where: { id, deletedAt: null } });
      if (!row) throw new NotFoundException({ code: "OUTSOURCE_FINISHED_RETURN_NOT_FOUND", message: "外加工成品回厂记录不存在", details: [] });
      await this.progress.recalculateInTransaction(tx, current.productionOrderId, "outsource_finished_goods_return", id, user);
      return row;
    });
    await this.audit.record("outsource_finished_return.submit_qc", "outsource_return_transfer", user.id, id, { order_no: result.orderNo });
    return result;
  }

  async updateReturn(id: string, input: { quantity?: string; remark?: string; product_description?: string }, user: CurrentUser) {
    if (input.quantity !== undefined) this.decimal(input.quantity, "INVALID_RETURN_QUANTITY");
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM outsource_return_transfers WHERE id = ${id}::uuid FOR UPDATE`;
      const current = await tx.outsourceReturnTransfer.findFirst({ where: { id, deletedAt: null } });
      if (!current) throw new NotFoundException({ code: "OUTSOURCE_RETURN_NOT_FOUND", message: "外加工回厂记录不存在", details: [] });
      if (current.status !== "draft") throw new UnprocessableEntityException({ code: "OUTSOURCE_RETURN_NOT_EDITABLE", message: "只有草稿回厂记录可以编辑", details: [] });
      const updated = await tx.outsourceReturnTransfer.updateMany({ where: { id, status: "draft" }, data: { ...(input.quantity === undefined ? {} : { quantity: input.quantity }), ...(input.remark === undefined ? {} : { remark: input.remark }), ...(input.product_description === undefined ? {} : { productDescription: input.product_description }), ...this.audit.update(user) } });
      if (updated.count !== 1) throw new ConflictException({ code: "VERSION_CONFLICT", message: "外加工回厂记录已被其他操作处理，请刷新后重试", details: [] });
      if (current.transferType === "finished_goods_return") await this.progress.recalculateInTransaction(tx, current.productionOrderId, "outsource_finished_goods_return", id, user);
      const row = await tx.outsourceReturnTransfer.findFirst({ where: { id, deletedAt: null } });
      if (!row) throw new NotFoundException({ code: "OUTSOURCE_RETURN_NOT_FOUND", message: "外加工回厂记录不存在", details: [] });
      return row;
    });
    return result;
  }

  async removeReturn(id: string, user: CurrentUser) {
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM outsource_return_transfers WHERE id = ${id}::uuid FOR UPDATE`;
      const current = await tx.outsourceReturnTransfer.findFirst({ where: { id, deletedAt: null } });
      if (!current) throw new NotFoundException({ code: "OUTSOURCE_RETURN_NOT_FOUND", message: "外加工回厂记录不存在", details: [] });
      if (current.status !== "draft") throw new UnprocessableEntityException({ code: "OUTSOURCE_RETURN_NOT_DELETABLE", message: "只有草稿回厂记录可以删除", details: [] });
      const updated = await tx.outsourceReturnTransfer.updateMany({ where: { id, status: "draft" }, data: this.audit.softDelete(user) });
      if (updated.count !== 1) throw new ConflictException({ code: "VERSION_CONFLICT", message: "外加工回厂记录已被其他操作处理，请刷新后重试", details: [] });
      if (current.transferType === "finished_goods_return") await this.progress.recalculateInTransaction(tx, current.productionOrderId, "outsource_finished_goods_return", id, user);
      const row = await tx.outsourceReturnTransfer.findFirst({ where: { id } });
      if (!row) throw new NotFoundException({ code: "OUTSOURCE_RETURN_NOT_FOUND", message: "外加工回厂记录不存在", details: [] });
      return row;
    });
    return result;
  }

  async updateDirectShipment(id: string, input: { quantity?: string; product_description?: string; logistics_reference?: string; remark?: string }, user: CurrentUser) {
    if (input.quantity !== undefined) this.decimal(input.quantity, "INVALID_SHIPMENT_QUANTITY");
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM outsource_direct_shipments WHERE id = ${id}::uuid FOR UPDATE`;
      const current = await tx.outsourceDirectShipment.findFirst({ where: { id, deletedAt: null } });
      if (!current) throw new NotFoundException({ code: "OUTSOURCE_DIRECT_SHIPMENT_NOT_FOUND", message: "外加工直装柜记录不存在", details: [] });
      if (current.status !== "draft") throw new UnprocessableEntityException({ code: "OUTSOURCE_DIRECT_SHIPMENT_NOT_EDITABLE", message: "只有草稿直装柜记录可以编辑", details: [] });
      const updated = await tx.outsourceDirectShipment.updateMany({ where: { id, status: "draft" }, data: { ...(input.quantity === undefined ? {} : { quantity: input.quantity }), ...(input.product_description === undefined ? {} : { productDescription: input.product_description }), ...(input.logistics_reference === undefined ? {} : { logisticsReference: input.logistics_reference }), ...(input.remark === undefined ? {} : { remark: input.remark }), ...this.audit.update(user) } });
      if (updated.count !== 1) throw new ConflictException({ code: "VERSION_CONFLICT", message: "外加工直装柜记录已被其他操作处理，请刷新后重试", details: [] });
      const row = await tx.outsourceDirectShipment.findFirst({ where: { id, deletedAt: null } });
      if (!row) throw new NotFoundException({ code: "OUTSOURCE_DIRECT_SHIPMENT_NOT_FOUND", message: "外加工直装柜记录不存在", details: [] });
      return row;
    });
    return result;
  }

  async removeDirectShipment(id: string, user: CurrentUser) {
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM outsource_direct_shipments WHERE id = ${id}::uuid FOR UPDATE`;
      const current = await tx.outsourceDirectShipment.findFirst({ where: { id, deletedAt: null } });
      if (!current) throw new NotFoundException({ code: "OUTSOURCE_DIRECT_SHIPMENT_NOT_FOUND", message: "外加工直装柜记录不存在", details: [] });
      if (current.status !== "draft") throw new UnprocessableEntityException({ code: "OUTSOURCE_DIRECT_SHIPMENT_NOT_DELETABLE", message: "只有草稿直装柜记录可以删除", details: [] });
      const updated = await tx.outsourceDirectShipment.updateMany({ where: { id, status: "draft" }, data: this.audit.softDelete(user) });
      if (updated.count !== 1) throw new ConflictException({ code: "VERSION_CONFLICT", message: "外加工直装柜记录已被其他操作处理，请刷新后重试", details: [] });
      const row = await tx.outsourceDirectShipment.findFirst({ where: { id } });
      if (!row) throw new NotFoundException({ code: "OUTSOURCE_DIRECT_SHIPMENT_NOT_FOUND", message: "外加工直装柜记录不存在", details: [] });
      return row;
    });
    return result;
  }

  async listDirectShipments(orderNo?: string) {
    return this.prisma.outsourceDirectShipment.findMany({ where: { deletedAt: null, ...(orderNo ? { orderNo } : {}) }, include: { productionOrder: { select: { productionOrderNo: true, executionMode: true } }, unit: true }, orderBy: { updatedAt: "desc" } });
  }

  async createDirectShipment(input: { production_order_id: string; unit_id: string; product_description: string; quantity: string; shipment_date: string; logistics_reference: string; remark?: string }, user: CurrentUser) {
    const quantity = this.decimal(input.quantity, "INVALID_SHIPMENT_QUANTITY");
    if (!input.product_description?.trim() || !input.logistics_reference?.trim()) throw new UnprocessableEntityException({ code: "SHIPMENT_REFERENCE_REQUIRED", message: "成品描述和物流/装柜资料不能为空", details: [] });
    const shipmentNo = `OS-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomUUID().slice(0, 8).toUpperCase()}`;
    const created = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM production_orders WHERE id = ${input.production_order_id}::uuid FOR UPDATE`;
      const production = await tx.productionOrder.findFirst({ where: { id: input.production_order_id, deletedAt: null } });
      if (!production || production.executionMode !== "outsourced") throw new NotFoundException({ code: "OUTSOURCE_PRODUCTION_NOT_FOUND", message: "外加工生产单不存在", details: [] });
      if (["closed", "cancelled"].includes(production.status)) throw new UnprocessableEntityException({ code: "PRODUCTION_ORDER_NOT_WRITABLE", message: "当前生产单不允许直装柜", details: [] });
      await this.requireActiveUnit(input.unit_id, tx);
      const row = await tx.outsourceDirectShipment.create({ data: { shipmentNo, orderNo: production.orderNo, productionOrderId: production.id, productDescription: input.product_description, unitId: input.unit_id, quantity, shipmentDate: new Date(input.shipment_date), logisticsReference: input.logistics_reference, remark: input.remark, ...this.audit.create(user) } });
      await this.progress.recalculateInTransaction(tx, production.id, "outsource_direct_shipment", row.id, user);
      return row;
    });
    await this.audit.record("outsource_direct_shipment.create", "outsource_direct_shipment", user.id, created.id, { order_no: created.orderNo, shipment_no: shipmentNo });
    return created;
  }

  async dispatchDirectShipment(id: string, user: CurrentUser) {
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM outsource_direct_shipments WHERE id = ${id}::uuid FOR UPDATE`;
      const current = await tx.outsourceDirectShipment.findFirst({ where: { id, deletedAt: null } });
      if (!current) throw new NotFoundException({ code: "OUTSOURCE_DIRECT_SHIPMENT_NOT_FOUND", message: "外加工直装柜记录不存在", details: [] });
      if (current.status !== "draft") throw new UnprocessableEntityException({ code: "OUTSOURCE_DIRECT_SHIPMENT_NOT_DISPATCHABLE", message: "当前直装柜记录不可发出", details: [] });
      const updated = await tx.outsourceDirectShipment.updateMany({ where: { id, status: "draft" }, data: { status: "dispatched", ...this.audit.update(user) } });
      if (updated.count !== 1) throw new ConflictException({ code: "VERSION_CONFLICT", message: "外加工直装柜记录已被其他操作处理，请刷新后重试", details: [] });
      await this.progress.recalculateInTransaction(tx, current.productionOrderId, "outsource_direct_shipment", id, user);
      const row = await tx.outsourceDirectShipment.findFirst({ where: { id, deletedAt: null } });
      if (!row) throw new NotFoundException({ code: "OUTSOURCE_DIRECT_SHIPMENT_NOT_FOUND", message: "外加工直装柜记录不存在", details: [] });
      return row;
    });
    await this.audit.record("outsource_direct_shipment.dispatch", "outsource_direct_shipment", user.id, id, { order_no: result.orderNo, quantity: result.quantity.toString() });
    return result;
  }

  async reverseDirectShipment(id: string, reason: string, user: CurrentUser) {
    if (!reason?.trim()) throw new UnprocessableEntityException({ code: "REVERSAL_REASON_REQUIRED", message: "冲销必须填写原因", details: [] });
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM outsource_direct_shipments WHERE id = ${id}::uuid FOR UPDATE`;
      const current = await tx.outsourceDirectShipment.findFirst({ where: { id, deletedAt: null } });
      if (!current) throw new NotFoundException({ code: "OUTSOURCE_DIRECT_SHIPMENT_NOT_FOUND", message: "外加工直装柜记录不存在", details: [] });
      if (current.status !== "dispatched") throw new UnprocessableEntityException({ code: "OUTSOURCE_DIRECT_SHIPMENT_NOT_REVERSIBLE", message: "只有已发出的直装柜记录可以冲销", details: [] });
      const updated = await tx.outsourceDirectShipment.updateMany({ where: { id, status: "dispatched" }, data: { status: "corrected", reversalQuantity: current.quantity, reversalReason: reason, ...this.audit.update(user) } });
      if (updated.count !== 1) throw new ConflictException({ code: "VERSION_CONFLICT", message: "外加工直装柜记录已被其他操作处理，请刷新后重试", details: [] });
      await this.progress.recalculateInTransaction(tx, current.productionOrderId, "outsource_direct_shipment", id, user);
      const row = await tx.outsourceDirectShipment.findFirst({ where: { id, deletedAt: null } });
      if (!row) throw new NotFoundException({ code: "OUTSOURCE_DIRECT_SHIPMENT_NOT_FOUND", message: "外加工直装柜记录不存在", details: [] });
      return row;
    });
    await this.audit.record("outsource_direct_shipment.reverse", "outsource_direct_shipment", user.id, id, { order_no: result.orderNo, reason });
    return result;
  }

  private async lockReturnRefs(tx: Prisma.TransactionClient, input: { production_order_id: string; logistics_batch_id: string }) {
    await tx.$queryRaw`SELECT id FROM production_orders WHERE id = ${input.production_order_id}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM outsource_logistics_batches WHERE id = ${input.logistics_batch_id}::uuid FOR UPDATE`;
    const [production, batch] = await Promise.all([tx.productionOrder.findFirst({ where: { id: input.production_order_id, deletedAt: null } }), tx.outsourceLogisticsBatch.findFirst({ where: { id: input.logistics_batch_id, deletedAt: null } })]);
    if (!production || production.executionMode !== "outsourced") throw new NotFoundException({ code: "OUTSOURCE_PRODUCTION_NOT_FOUND", message: "外加工生产单不存在", details: [] });
    if (!batch || batch.orderNo !== production.orderNo) throw new UnprocessableEntityException({ code: "RETURN_ORDER_MISMATCH", message: "回厂批次与生产单订单号不一致", details: [] });
    if (batch.status === "cancelled") throw new UnprocessableEntityException({ code: "OUTSOURCE_BATCH_CANCELLED", message: "已取消的外加工批次不能回厂", details: [] });
    return { production, batch };
  }

  private async requireActiveUnit(id: string, client: PrismaService | Prisma.TransactionClient = this.prisma) { const unit = await client.unit.findFirst({ where: { id, deletedAt: null, isActive: true } }); if (!unit) throw new NotFoundException({ code: "UNIT_NOT_FOUND", message: "单位不存在或已停用", details: [] }); return unit; }

  async remove(id: string, user: CurrentUser) {
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM outsource_logistics_batches WHERE id = ${id}::uuid FOR UPDATE`;
      const current = await tx.outsourceLogisticsBatch.findFirst({ where: { id, deletedAt: null } });
      if (!current) throw new NotFoundException({ code: "OUTSOURCE_BATCH_NOT_FOUND", message: "外加工物流批次不存在", details: [] });
      if (current.status !== "draft") throw new UnprocessableEntityException({ code: "OUTSOURCE_BATCH_NOT_DELETABLE", message: "只有草稿外加工批次可以删除", details: [] });
      const updated = await tx.outsourceLogisticsBatch.updateMany({ where: { id, status: "draft" }, data: this.audit.softDelete(user) });
      if (updated.count !== 1) throw new ConflictException({ code: "VERSION_CONFLICT", message: "外加工批次已被其他操作处理，请刷新后重试", details: [] });
      const row = await tx.outsourceLogisticsBatch.findFirst({ where: { id } });
      if (!row) throw new NotFoundException({ code: "OUTSOURCE_BATCH_NOT_FOUND", message: "外加工物流批次不存在", details: [] });
      return row;
    });
    await this.audit.record("outsource_logistics_batch.delete", "outsource_logistics_batch", user.id, id, { order_no: result.orderNo });
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

  private decimal(value: string, code: string) {
    const invalid = () => new UnprocessableEntityException({ code, message: "数量必须是大于零的十进制数，且最多 4 位小数、总精度不超过 18 位", details: [] });
    if (typeof value !== "string" || value.length === 0 || !/^\d+(?:\.\d+)?$/.test(value)) throw invalid();
    const [integerPart, fractionPart = ""] = value.split(".");
    if (fractionPart.length > 4 || (integerPart.replace(/^0+/, "").length || 1) > 14) throw invalid();
    let parsed: Prisma.Decimal;
    try { parsed = new Prisma.Decimal(value); } catch { throw invalid(); }
    if (parsed.lte(0)) throw invalid();
    return parsed;
  }
}
