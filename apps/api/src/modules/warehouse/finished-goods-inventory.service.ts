import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { AuditService } from "../../platform/audit/audit.service";
import type { CurrentUser } from "../../platform/auth/auth.service";
import { PrismaService } from "../../platform/database/prisma.service";
import { InventoryService } from "../../platform/inventory/inventory.service";

type InventoryInput = { qc_record_id: string; quantity: string; idempotency_key?: string; remark?: string };
type ReverseInput = { reason: string };

@Injectable()
export class FinishedGoodsInventoryService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly inventory: InventoryService) {}

  async listInbounds(orderNo?: string) {
    return this.prisma.finishedGoodsInbound.findMany({ where: { deletedAt: null, ...(orderNo ? { orderNo } : {}) }, include: { inventoryFacts: true, qcRecord: true }, orderBy: { createdAt: "desc" } });
  }

  async listDefectives(orderNo?: string) {
    return this.prisma.finishedGoodsDefective.findMany({ where: { deletedAt: null, ...(orderNo ? { orderNo } : {}) }, include: { inventoryFacts: true, qcRecord: true }, orderBy: { createdAt: "desc" } });
  }

  async createInbound(input: InventoryInput, user: CurrentUser) {
    const quantity = this.decimal(input.quantity, "INVALID_FINISHED_GOODS_INBOUND_QUANTITY");
    const row = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM finished_goods_qc_records WHERE id = ${input.qc_record_id}::uuid FOR UPDATE`;
      const qc = await this.requireQc(input.qc_record_id, tx);
      const available = await this.acceptedAvailable(qc.id, tx);
      if (quantity.gt(available)) throw this.exceeded("FINISHED_GOODS_INBOUND_QUANTITY_EXCEEDED", available);
      return tx.finishedGoodsInbound.create({ data: { inboundNo: this.number("FGI"), orderNo: qc.orderNo, productionOrderId: qc.productionOrderId, qcRecordId: qc.id, submissionId: qc.submissionId, unitId: qc.submission.unitId, productNameSnapshot: qc.submission.productNameSnapshot, productSpecificationSnapshot: qc.submission.productSpecificationSnapshot, quantity, idempotencyKey: input.idempotency_key?.trim() || `draft:${randomUUID()}`, remark: input.remark, ...this.audit.create(user) } });
    });
    await this.audit.record("finished_goods_inbound.create", "finished_goods_inbound", user.id, row.id, { order_no: row.orderNo, qc_record_id: row.qcRecordId, quantity: quantity.toString() });
    return row;
  }

  async createDefective(input: InventoryInput, user: CurrentUser) {
    const quantity = this.decimal(input.quantity, "INVALID_FINISHED_GOODS_DEFECTIVE_QUANTITY");
    const row = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM finished_goods_qc_records WHERE id = ${input.qc_record_id}::uuid FOR UPDATE`;
      const qc = await this.requireQc(input.qc_record_id, tx);
      const available = await this.rejectedAvailable(qc.id, tx);
      if (quantity.gt(available)) throw this.exceeded("FINISHED_GOODS_DEFECTIVE_QUANTITY_EXCEEDED", available);
      return tx.finishedGoodsDefective.create({ data: { defectiveNo: this.number("FGD"), orderNo: qc.orderNo, productionOrderId: qc.productionOrderId, qcRecordId: qc.id, submissionId: qc.submissionId, unitId: qc.submission.unitId, productNameSnapshot: qc.submission.productNameSnapshot, productSpecificationSnapshot: qc.submission.productSpecificationSnapshot, quantity, idempotencyKey: input.idempotency_key?.trim() || `draft:${randomUUID()}`, remark: input.remark, ...this.audit.create(user) } });
    });
    await this.audit.record("finished_goods_defective.create", "finished_goods_defective", user.id, row.id, { order_no: row.orderNo, qc_record_id: row.qcRecordId, quantity: quantity.toString() });
    return row;
  }

  async postInbound(id: string, user: CurrentUser) {
    const current = await this.prisma.finishedGoodsInbound.findFirst({ where: { id, deletedAt: null }, include: { qcRecord: { include: { submission: true } } } });
    if (!current) throw this.notFound("FINISHED_GOODS_INBOUND_NOT_FOUND", "成品入库单不存在");
    if (current.status !== "draft") throw this.invalidState("FINISHED_GOODS_INBOUND_NOT_POSTABLE", "只有草稿成品入库单可以过账");
    const result = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.inventoryFact.findFirst({ where: { finishedGoodsInboundId: id, sourceType: "finished_goods_inbound" } });
      if (existing) throw this.invalidState("FINISHED_GOODS_INBOUND_ALREADY_POSTED", "成品入库单已过账");
      const available = await this.acceptedAvailable(current.qcRecordId, tx);
      if (current.quantity.gt(available)) throw this.exceeded("FINISHED_GOODS_INBOUND_QUANTITY_EXCEEDED", available);
      const posted = await tx.finishedGoodsInbound.update({ where: { id }, data: { status: "posted", idempotencyKey: `post:${id}`, ...this.audit.update(user) } });
      await tx.inventoryFact.create({ data: { finishedGoodsInboundId: id, materialId: null, unitId: current.unitId, inventoryCategory: "finished_goods", quantityDelta: current.quantity, sourceType: "finished_goods_inbound", sourceId: id, orderNo: current.orderNo, productionOrderId: current.productionOrderId, productNameSnapshot: current.productNameSnapshot, productSpecificationSnapshot: current.productSpecificationSnapshot, createdBy: user.id } });
      return posted;
    });
    await this.audit.record("finished_goods_inbound.post", "finished_goods_inbound", user.id, id, { order_no: result.orderNo, quantity: result.quantity.toString() });
    return result;
  }

  async postDefective(id: string, user: CurrentUser) {
    const current = await this.prisma.finishedGoodsDefective.findFirst({ where: { id, deletedAt: null }, include: { qcRecord: { include: { submission: true } } } });
    if (!current) throw this.notFound("FINISHED_GOODS_DEFECTIVE_NOT_FOUND", "成品不良品记录不存在");
    if (current.status !== "draft") throw this.invalidState("FINISHED_GOODS_DEFECTIVE_NOT_POSTABLE", "只有草稿不良品记录可以过账");
    const result = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.inventoryFact.findFirst({ where: { finishedGoodsDefectiveId: id, sourceType: "finished_goods_defective" } });
      if (existing) throw this.invalidState("FINISHED_GOODS_DEFECTIVE_ALREADY_POSTED", "成品不良品记录已过账");
      const available = await this.rejectedAvailable(current.qcRecordId, tx);
      if (current.quantity.gt(available)) throw this.exceeded("FINISHED_GOODS_DEFECTIVE_QUANTITY_EXCEEDED", available);
      const posted = await tx.finishedGoodsDefective.update({ where: { id }, data: { status: "posted", idempotencyKey: `post:${id}`, ...this.audit.update(user) } });
      await tx.inventoryFact.create({ data: { finishedGoodsDefectiveId: id, materialId: null, unitId: current.unitId, inventoryCategory: "defective_goods", quantityDelta: current.quantity, sourceType: "finished_goods_defective", sourceId: id, orderNo: current.orderNo, productionOrderId: current.productionOrderId, productNameSnapshot: current.productNameSnapshot, productSpecificationSnapshot: current.productSpecificationSnapshot, createdBy: user.id } });
      return posted;
    });
    await this.audit.record("finished_goods_defective.post", "finished_goods_defective", user.id, id, { order_no: result.orderNo, quantity: result.quantity.toString() });
    return result;
  }

  async reverseInbound(id: string, input: ReverseInput, user: CurrentUser) {
    if (!input.reason?.trim()) throw new UnprocessableEntityException({ code: "REVERSAL_REASON_REQUIRED", message: "冲销必须填写原因", details: [] });
    const current = await this.prisma.finishedGoodsInbound.findFirst({ where: { id, deletedAt: null }, include: { inventoryFacts: true } });
    if (!current) throw this.notFound("FINISHED_GOODS_INBOUND_NOT_FOUND", "成品入库单不存在");
    if (current.status !== "posted") throw this.invalidState("FINISHED_GOODS_INBOUND_NOT_REVERSIBLE", "只有已过账成品入库单可以冲销");
    const result = await this.prisma.$transaction(async (tx) => {
      const balance = await this.inventory.finishedGoodsBalance(tx, current.productionOrderId, current.unitId, "finished_goods");
      if (balance.minus(current.quantity).isNegative()) throw new UnprocessableEntityException({ code: "INVENTORY_INSUFFICIENT", message: "冲销会造成成品库存不足", details: [] });
      const updated = await tx.finishedGoodsInbound.update({ where: { id }, data: { status: "reversed", remark: `${current.remark ?? ""}\n冲销：${input.reason}`, ...this.audit.update(user) } });
      await tx.inventoryFact.create({ data: { finishedGoodsInboundId: id, materialId: null, unitId: current.unitId, inventoryCategory: "finished_goods", quantityDelta: current.quantity.negated(), sourceType: "finished_goods_inbound_reversal", sourceId: id, orderNo: current.orderNo, productionOrderId: current.productionOrderId, productNameSnapshot: current.productNameSnapshot, productSpecificationSnapshot: current.productSpecificationSnapshot, createdBy: user.id } });
      return updated;
    });
    await this.audit.record("finished_goods_inbound.reverse", "finished_goods_inbound", user.id, id, { order_no: result.orderNo, reason: input.reason });
    return result;
  }

  async reverseDefective(id: string, input: ReverseInput, user: CurrentUser) {
    if (!input.reason?.trim()) throw new UnprocessableEntityException({ code: "REVERSAL_REASON_REQUIRED", message: "冲销必须填写原因", details: [] });
    const current = await this.prisma.finishedGoodsDefective.findFirst({ where: { id, deletedAt: null }, include: { inventoryFacts: true } });
    if (!current) throw this.notFound("FINISHED_GOODS_DEFECTIVE_NOT_FOUND", "成品不良品记录不存在");
    if (current.status !== "posted") throw this.invalidState("FINISHED_GOODS_DEFECTIVE_NOT_REVERSIBLE", "只有已过账不良品记录可以冲销");
    const result = await this.prisma.$transaction(async (tx) => {
      const balance = await this.inventory.finishedGoodsBalance(tx, current.productionOrderId, current.unitId, "defective_goods");
      if (balance.minus(current.quantity).isNegative()) throw new UnprocessableEntityException({ code: "INVENTORY_INSUFFICIENT", message: "冲销会造成不良品库存不足", details: [] });
      const updated = await tx.finishedGoodsDefective.update({ where: { id }, data: { status: "reversed", remark: `${current.remark ?? ""}\n冲销：${input.reason}`, ...this.audit.update(user) } });
      await tx.inventoryFact.create({ data: { finishedGoodsDefectiveId: id, materialId: null, unitId: current.unitId, inventoryCategory: "defective_goods", quantityDelta: current.quantity.negated(), sourceType: "finished_goods_defective_reversal", sourceId: id, orderNo: current.orderNo, productionOrderId: current.productionOrderId, productNameSnapshot: current.productNameSnapshot, productSpecificationSnapshot: current.productSpecificationSnapshot, createdBy: user.id } });
      return updated;
    });
    await this.audit.record("finished_goods_defective.reverse", "finished_goods_defective", user.id, id, { order_no: result.orderNo, reason: input.reason });
    return result;
  }

  async impactPreview(qcRecordId: string) {
    const qc = await this.requireQc(qcRecordId);
    const [inbound, defective] = await Promise.all([this.acceptedUsed(qc.id), this.rejectedUsed(qc.id)]);
    return { qc_id: qc.id, qc_no: qc.qcNo, order_no: qc.orderNo, accepted_quantity: qc.qualifiedQuantity.plus(qc.conditionalAcceptQuantity).toString(), rejected_quantity: qc.rejectedQuantity.toString(), inbound_quantity: inbound.toString(), defective_quantity: defective.toString(), available_for_inbound_quantity: qc.qualifiedQuantity.plus(qc.conditionalAcceptQuantity).minus(inbound).toString(), available_for_defective_quantity: qc.rejectedQuantity.minus(defective).toString() };
  }

  private async requireQc(id: string, client: PrismaService | Prisma.TransactionClient = this.prisma) {
    const qc = await client.finishedGoodsQcRecord.findFirst({ where: { id, deletedAt: null, status: "active" }, include: { submission: true } });
    if (!qc || !["submitted", "inspecting", "qc_completed"].includes(qc.submission.status)) throw this.notFound("FINISHED_GOODS_QC_NOT_AVAILABLE", "成品 QC 不存在或不可作为库存来源");
    return qc;
  }

  private async acceptedUsed(qcRecordId: string, client: PrismaService | Prisma.TransactionClient = this.prisma) { const result = await client.finishedGoodsInbound.aggregate({ where: { qcRecordId, deletedAt: null, status: { in: ["draft", "posted"] } }, _sum: { quantity: true } }); return new Prisma.Decimal(result._sum.quantity ?? 0); }
  private async rejectedUsed(qcRecordId: string, client: PrismaService | Prisma.TransactionClient = this.prisma) { const result = await client.finishedGoodsDefective.aggregate({ where: { qcRecordId, deletedAt: null, status: { in: ["draft", "posted"] } }, _sum: { quantity: true } }); return new Prisma.Decimal(result._sum.quantity ?? 0); }
  private async acceptedAvailable(qcRecordId: string, client: PrismaService | Prisma.TransactionClient = this.prisma) { const qc = await client.finishedGoodsQcRecord.findFirst({ where: { id: qcRecordId, deletedAt: null, status: "active" } }); if (!qc) throw this.notFound("FINISHED_GOODS_QC_NOT_AVAILABLE", "成品 QC 不存在或已更正"); return qc.qualifiedQuantity.plus(qc.conditionalAcceptQuantity).minus(await this.acceptedUsed(qcRecordId, client)); }
  private async rejectedAvailable(qcRecordId: string, client: PrismaService | Prisma.TransactionClient = this.prisma) { const qc = await client.finishedGoodsQcRecord.findFirst({ where: { id: qcRecordId, deletedAt: null, status: "active" } }); if (!qc) throw this.notFound("FINISHED_GOODS_QC_NOT_AVAILABLE", "成品 QC 不存在或已更正"); return qc.rejectedQuantity.minus(await this.rejectedUsed(qcRecordId, client)); }
  private decimal(value: string, code: string) { try { const result = new Prisma.Decimal(value); if (result.lte(0)) throw new Error(); return result; } catch { throw new UnprocessableEntityException({ code, message: "数量必须是大于零的十进制数", details: [] }); } }
  private number(prefix: string) { return `${prefix}-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomUUID().slice(0, 8).toUpperCase()}`; }
  private exceeded(code: string, available: Prisma.Decimal) { return new UnprocessableEntityException({ code, message: "数量超过 QC 可用数量", details: [{ available_quantity: available.toString() }] }); }
  private notFound(code: string, message: string) { return new NotFoundException({ code, message, details: [] }); }
  private invalidState(code: string, message: string) { return new UnprocessableEntityException({ code, message, details: [] }); }
}
