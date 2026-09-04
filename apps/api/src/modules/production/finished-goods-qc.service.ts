import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { AuditService } from "../../platform/audit/audit.service";
import type { CurrentUser } from "../../platform/auth/auth.service";
import { PrismaService } from "../../platform/database/prisma.service";
import { deriveFinishedGoodsQcConclusion, availableFinishedGoodsInboundQuantity } from "../warehouse/finished-goods-qc.domain";

type SourceType = "in_house_completion" | "outsource_finished_goods_return";
type SubmissionInput = { production_order_id: string; source_type: SourceType; source_id: string; submitted_quantity: string; submission_date: string; remark?: string };
type QcInput = { submission_id: string; inspection_date: string; inspected_quantity: string; qualified_quantity: string; conditional_accept_quantity: string; rejected_quantity: string; rejection_reason?: string; remark?: string };

@Injectable()
export class FinishedGoodsQcService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  async listSources(orderNo?: string, productionOrderId?: string, sourceType?: SourceType) {
    const orders = await this.prisma.productionOrder.findMany({ where: { deletedAt: null, ...(orderNo ? { orderNo } : {}), ...(productionOrderId ? { id: productionOrderId } : {}), executionMode: { in: ["in_house", "outsourced"] } }, include: { unit: true, operations: { where: { deletedAt: null, status: "active" }, include: { unit: true }, orderBy: { sequenceNo: "asc" } } }, orderBy: { updatedAt: "desc" } });
    const result: Array<Record<string, unknown>> = [];
    for (const order of orders) {
      if (!sourceType || sourceType === "in_house_completion") {
        const available = await this.inHouseAvailable(order);
        if (available.gt(0)) result.push({ source_type: "in_house_completion", source_id: order.id, order_no: order.orderNo, production_order_id: order.id, production_order_no: order.productionOrderNo, product_name: null, product_specification: order.productSpecification, unit_id: order.unitId, unit: order.unit.name, available_quantity: available.toString(), source_status: order.status });
      }
      if ((!sourceType || sourceType === "outsource_finished_goods_return") && order.executionMode === "outsourced") {
        const returns = await this.prisma.outsourceReturnTransfer.findMany({ where: { productionOrderId: order.id, transferType: "finished_goods_return", status: "pending_qc", deletedAt: null }, include: { unit: true } });
        for (const source of returns) {
          const used = await this.submittedQuantity(source.id, "outsource_finished_goods_return");
          const available = new Prisma.Decimal(source.quantity).minus(used);
          if (available.gt(0)) result.push({ source_type: "outsource_finished_goods_return", source_id: source.id, order_no: order.orderNo, production_order_id: order.id, production_order_no: order.productionOrderNo, product_name: source.productDescription, product_specification: order.productSpecification, unit_id: source.unitId, unit: source.unit.name, available_quantity: available.toString(), source_status: source.status });
        }
      }
    }
    return result;
  }

  async listSubmissions(orderNo?: string) {
    return this.prisma.finishedGoodsInspectionSubmission.findMany({ where: { deletedAt: null, ...(orderNo ? { orderNo } : {}) }, include: { qcRecords: { where: { deletedAt: null }, orderBy: { inspectionDate: "asc" } }, unit: true }, orderBy: { updatedAt: "desc" } });
  }

  async getSubmission(id: string) {
    const row = await this.prisma.finishedGoodsInspectionSubmission.findFirst({ where: { id, deletedAt: null }, include: { qcRecords: { where: { deletedAt: null }, orderBy: { inspectionDate: "asc" } }, productionOrder: true, unit: true } });
    if (!row) throw new NotFoundException({ code: "FINISHED_GOODS_SUBMISSION_NOT_FOUND", message: "成品送检单不存在", details: [] });
    return row;
  }

  async createSubmission(input: SubmissionInput, user: CurrentUser) {
    const source = await this.requireSource(input);
    const quantity = this.decimal(input.submitted_quantity, "INVALID_FINISHED_GOODS_SUBMISSION_QUANTITY");
    const date = this.date(input.submission_date);
    const created = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM production_orders WHERE id = ${source.productionOrder.id}::uuid FOR UPDATE`;
      const available = await this.sourceAvailable(tx, source.productionOrder.id, input.source_type, input.source_id);
      if (quantity.gt(available)) throw new UnprocessableEntityException({ code: "FINISHED_GOODS_SUBMISSION_QUANTITY_EXCEEDED", message: "送检数量超过来源可送检数量", details: [{ available_quantity: available.toString() }] });
      const row = await tx.finishedGoodsInspectionSubmission.create({ data: { submissionNo: `FGI-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomUUID().slice(0, 8).toUpperCase()}`, orderNo: source.productionOrder.orderNo, productionOrderId: source.productionOrder.id, sourceType: input.source_type, sourceId: input.source_id, productionOrderNoSnapshot: source.productionOrder.productionOrderNo, productNameSnapshot: source.productName, productSpecificationSnapshot: source.productionOrder.productSpecification, unitId: source.unitId, unitNameSnapshot: source.unitName, submittedQuantity: quantity, submissionDate: date, remark: input.remark, ...this.audit.create(user) } });
      return row;
    });
    await this.audit.record("finished_goods_inspection_submission.create", "finished_goods_inspection_submission", user.id, created.id, { order_no: created.orderNo, source_type: created.sourceType, source_id: created.sourceId, submitted_quantity: created.submittedQuantity.toString() });
    return this.getSubmission(created.id);
  }

  async updateSubmission(id: string, input: { submitted_quantity?: string; submission_date?: string; remark?: string; expected_version?: number; reason: string }, user: CurrentUser) {
    if (!input.reason?.trim()) throw new UnprocessableEntityException({ code: "CORRECTION_REASON_REQUIRED", message: "修改送检单必须填写原因", details: [] });
    const current = await this.getSubmission(id);
    if (current.status !== "draft") throw new UnprocessableEntityException({ code: "FINISHED_GOODS_SUBMISSION_NOT_EDITABLE", message: "只有草稿送检单可以修改", details: [] });
    if (input.expected_version !== undefined && input.expected_version !== current.version) throw new ConflictException({ code: "FINISHED_GOODS_SUBMISSION_VERSION_CONFLICT", message: "送检单版本已变化，请刷新后重试", details: [] });
    const quantity = input.submitted_quantity === undefined ? current.submittedQuantity : this.decimal(input.submitted_quantity, "INVALID_FINISHED_GOODS_SUBMISSION_QUANTITY");
    const updated = await this.prisma.$transaction(async (tx) => {
      const available = await this.sourceAvailable(tx, current.productionOrderId, current.sourceType as SourceType, current.sourceId, id);
      if (quantity.gt(available)) throw new UnprocessableEntityException({ code: "FINISHED_GOODS_SUBMISSION_QUANTITY_EXCEEDED", message: "送检数量超过来源可送检数量", details: [{ available_quantity: available.toString() }] });
      return tx.finishedGoodsInspectionSubmission.update({ where: { id }, data: { submittedQuantity: quantity, ...(input.submission_date ? { submissionDate: this.date(input.submission_date) } : {}), ...(input.remark === undefined ? {} : { remark: input.remark }), version: { increment: 1 }, ...this.audit.update(user) } });
    });
    await this.audit.record("finished_goods_inspection_submission.update", "finished_goods_inspection_submission", user.id, id, { order_no: current.orderNo, reason: input.reason });
    return updated;
  }

  async submit(id: string, user: CurrentUser) {
    const current = await this.getSubmission(id);
    if (current.status !== "draft") throw new UnprocessableEntityException({ code: "FINISHED_GOODS_SUBMISSION_NOT_SUBMITTABLE", message: "只有草稿送检单可以提交", details: [] });
    const result = await this.prisma.finishedGoodsInspectionSubmission.update({ where: { id }, data: { status: "submitted", ...this.audit.update(user) } });
    if (current.sourceType === "outsource_finished_goods_return") await this.prisma.outsourceReturnTransfer.update({ where: { id: current.sourceId }, data: { finishedGoodsQcStatus: "submitted", ...this.audit.update(user) } });
    await this.audit.record("finished_goods_inspection_submission.submit", "finished_goods_inspection_submission", user.id, id, { order_no: current.orderNo });
    return result;
  }

  async cancel(id: string, reason: string, user: CurrentUser) {
    if (!reason?.trim()) throw new UnprocessableEntityException({ code: "CANCELLATION_REASON_REQUIRED", message: "取消送检必须填写原因", details: [] });
    const current = await this.getSubmission(id);
    if (!["draft", "submitted"].includes(current.status) || current.qcRecords.length > 0) throw new UnprocessableEntityException({ code: "FINISHED_GOODS_SUBMISSION_NOT_CANCELLABLE", message: "当前送检单不允许取消", details: [] });
    const result = await this.prisma.finishedGoodsInspectionSubmission.update({ where: { id }, data: { status: "cancelled", remark: `${current.remark ?? ""}\n取消：${reason}`, ...this.audit.update(user) } });
    if (current.sourceType === "outsource_finished_goods_return") await this.prisma.outsourceReturnTransfer.update({ where: { id: current.sourceId }, data: { finishedGoodsQcStatus: "not_submitted", ...this.audit.update(user) } });
    await this.audit.record("finished_goods_inspection_submission.cancel", "finished_goods_inspection_submission", user.id, id, { order_no: current.orderNo, reason });
    return result;
  }

  async listQcRecords(orderNo?: string) {
    return this.prisma.finishedGoodsQcRecord.findMany({ where: { deletedAt: null, ...(orderNo ? { orderNo } : {}) }, include: { submission: true }, orderBy: { inspectionDate: "desc" } });
  }

  async createQcRecord(input: QcInput, user: CurrentUser) {
    const submission = await this.getSubmission(input.submission_id);
    if (!["submitted", "inspecting"].includes(submission.status)) throw new UnprocessableEntityException({ code: "FINISHED_GOODS_SUBMISSION_NOT_INSPECTABLE", message: "当前送检单不允许录入 QC", details: [] });
    const quantities = deriveFinishedGoodsQcConclusion({ inspected_quantity: input.inspected_quantity, qualified_quantity: input.qualified_quantity, conditional_accept_quantity: input.conditional_accept_quantity, rejected_quantity: input.rejected_quantity });
    if (quantities.rejected_quantity !== "0" && !input.rejection_reason?.trim()) throw new UnprocessableEntityException({ code: "QC_REJECTION_REASON_REQUIRED", message: "存在不合格数量时必须填写原因", details: [] });
    const inspected = new Prisma.Decimal(quantities.inspected_quantity);
    const date = this.date(input.inspection_date);
    const created = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM finished_goods_inspection_submissions WHERE id = ${submission.id}::uuid FOR UPDATE`;
      const existing = await tx.finishedGoodsQcRecord.aggregate({ where: { submissionId: submission.id, status: "active", deletedAt: null }, _sum: { inspectedQuantity: true } });
      const used = new Prisma.Decimal(existing._sum.inspectedQuantity ?? 0);
      if (used.plus(inspected).gt(submission.submittedQuantity)) throw new UnprocessableEntityException({ code: "QC_INSPECTION_QUANTITY_EXCEEDED", message: "累计检验数量超过送检数量", details: [{ remaining_quantity: submission.submittedQuantity.minus(used).toString() }] });
      const row = await tx.finishedGoodsQcRecord.create({ data: { qcNo: `FQC-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomUUID().slice(0, 8).toUpperCase()}`, submissionId: submission.id, orderNo: submission.orderNo, productionOrderId: submission.productionOrderId, sourceType: submission.sourceType, sourceId: submission.sourceId, inspectionDate: date, inspectedQuantity: quantities.inspected_quantity, qualifiedQuantity: quantities.qualified_quantity, conditionalAcceptQuantity: quantities.conditional_accept_quantity, rejectedQuantity: quantities.rejected_quantity, conclusion: quantities.conclusion, rejectionReason: input.rejection_reason, remark: input.remark, ...this.audit.create(user) } });
      const nextStatus = used.plus(inspected).eq(submission.submittedQuantity) ? "qc_completed" : "inspecting";
      await tx.finishedGoodsInspectionSubmission.update({ where: { id: submission.id }, data: { status: nextStatus, ...this.audit.update(user) } });
      if (submission.sourceType === "outsource_finished_goods_return") await tx.outsourceReturnTransfer.update({ where: { id: submission.sourceId }, data: { finishedGoodsQcStatus: nextStatus === "qc_completed" ? "qc_completed" : "inspecting", ...this.audit.update(user) } });
      return row;
    });
    await this.audit.record("finished_goods_qc_record.create", "finished_goods_qc_record", user.id, created.id, { order_no: created.orderNo, submission_id: created.submissionId, conclusion: created.conclusion, inspected_quantity: created.inspectedQuantity.toString() });
    return created;
  }

  async availableInboundSources(orderNo?: string) {
    const rows = await this.prisma.finishedGoodsQcRecord.findMany({ where: { deletedAt: null, status: "active", ...(orderNo ? { orderNo } : {}) }, include: { submission: { include: { unit: true } } }, orderBy: { inspectionDate: "asc" } });
    return rows.map((row) => ({ qc_id: row.id, qc_no: row.qcNo, submission_id: row.submissionId, order_no: row.orderNo, production_order_id: row.productionOrderId, source_type: row.sourceType, source_id: row.sourceId, unit_id: row.submission.unitId, unit: row.submission.unitNameSnapshot, qualified_quantity: row.qualifiedQuantity.toString(), conditional_accept_quantity: row.conditionalAcceptQuantity.toString(), available_for_inbound_quantity: availableFinishedGoodsInboundQuantity(row.qualifiedQuantity.toString(), row.conditionalAcceptQuantity.toString(), "0"), conditionally_accepted: row.conditionalAcceptQuantity.gt(0), source_read_only: true }));
  }

  async impactPreview(id: string) {
    const row = await this.prisma.finishedGoodsQcRecord.findFirst({ where: { id, deletedAt: null }, include: { submission: true } });
    if (!row) throw new NotFoundException({ code: "FINISHED_GOODS_QC_NOT_FOUND", message: "成品 QC 记录不存在", details: [] });
    const [inbounds, defectives] = await Promise.all([
      this.prisma.finishedGoodsInbound.aggregate({ where: { qcRecordId: id, deletedAt: null, status: "posted" }, _sum: { quantity: true }, _count: { _all: true } }),
      this.prisma.finishedGoodsDefective.aggregate({ where: { qcRecordId: id, deletedAt: null, status: "posted" }, _sum: { quantity: true }, _count: { _all: true } })
    ]);
    const inboundQuantity = new Prisma.Decimal(inbounds._sum.quantity ?? 0);
    const defectiveQuantity = new Prisma.Decimal(defectives._sum.quantity ?? 0);
    return { qc_id: id, qc_no: row.qcNo, order_no: row.orderNo, submission_id: row.submissionId, status: row.status, affected: { available_for_inbound_quantity: availableFinishedGoodsInboundQuantity(row.qualifiedQuantity.toString(), row.conditionalAcceptQuantity.toString(), inboundQuantity.toString()), available_for_defective_quantity: new Prisma.Decimal(row.rejectedQuantity).minus(defectiveQuantity).toString(), downstream_finished_goods_inbound_count: inbounds._count._all, downstream_finished_goods_inbound_quantity: inboundQuantity.toString(), downstream_defective_count: defectives._count._all, downstream_defective_quantity: defectiveQuantity.toString() }, warnings: [] };
  }

  async correctQc(id: string, input: Omit<QcInput, "submission_id"> & { reason: string }, user: CurrentUser) {
    if (!input.reason?.trim()) throw new UnprocessableEntityException({ code: "CORRECTION_REASON_REQUIRED", message: "更正 QC 必须填写原因", details: [] });
    const current = await this.prisma.finishedGoodsQcRecord.findFirst({ where: { id, deletedAt: null, status: "active" }, include: { submission: true } });
    if (!current) throw new NotFoundException({ code: "FINISHED_GOODS_QC_NOT_FOUND", message: "成品 QC 记录不存在或已更正", details: [] });
    const [inboundCount, defectiveCount] = await Promise.all([
      this.prisma.finishedGoodsInbound.count({ where: { qcRecordId: id, deletedAt: null, status: { in: ["draft", "posted"] } } }),
      this.prisma.finishedGoodsDefective.count({ where: { qcRecordId: id, deletedAt: null, status: { in: ["draft", "posted"] } } })
    ]);
    if (inboundCount || defectiveCount) throw new UnprocessableEntityException({ code: "FINISHED_GOODS_QC_DOWNSTREAM_EXISTS", message: "已有成品入库或不良品下游事实，必须先删除草稿或冲销过账记录后再更正 QC", details: [{ inbound_count: inboundCount, defective_count: defectiveCount }] });
    const quantities = deriveFinishedGoodsQcConclusion({ inspected_quantity: input.inspected_quantity, qualified_quantity: input.qualified_quantity, conditional_accept_quantity: input.conditional_accept_quantity, rejected_quantity: input.rejected_quantity });
    if (quantities.rejected_quantity !== "0" && !input.rejection_reason?.trim()) throw new UnprocessableEntityException({ code: "QC_REJECTION_REASON_REQUIRED", message: "存在不合格数量时必须填写原因", details: [] });
    const replacement = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM finished_goods_qc_records WHERE id = ${id}::uuid FOR UPDATE`;
      const [lockedInboundCount, lockedDefectiveCount] = await Promise.all([
        tx.finishedGoodsInbound.count({ where: { qcRecordId: id, deletedAt: null, status: { in: ["draft", "posted"] } } }),
        tx.finishedGoodsDefective.count({ where: { qcRecordId: id, deletedAt: null, status: { in: ["draft", "posted"] } } }),
      ]);
      if (lockedInboundCount || lockedDefectiveCount) throw new UnprocessableEntityException({ code: "FINISHED_GOODS_QC_DOWNSTREAM_EXISTS", message: "已有成品入库或不良品下游事实，必须先删除草稿或冲销过账记录后再更正 QC", details: [{ inbound_count: lockedInboundCount, defective_count: lockedDefectiveCount }] });
      await tx.finishedGoodsQcRecord.update({ where: { id }, data: { status: "corrected", correctionReason: input.reason, correctedAt: new Date(), ...this.audit.update(user) } });
      const created = await tx.finishedGoodsQcRecord.create({ data: { qcNo: `FQC-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomUUID().slice(0, 8).toUpperCase()}`, submissionId: current.submissionId, orderNo: current.orderNo, productionOrderId: current.productionOrderId, sourceType: current.sourceType, sourceId: current.sourceId, inspectionDate: this.date(input.inspection_date), inspectedQuantity: quantities.inspected_quantity, qualifiedQuantity: quantities.qualified_quantity, conditionalAcceptQuantity: quantities.conditional_accept_quantity, rejectedQuantity: quantities.rejected_quantity, conclusion: quantities.conclusion, rejectionReason: input.rejection_reason, remark: input.remark, ...this.audit.create(user) } });
      await tx.finishedGoodsInspectionSubmission.update({ where: { id: current.submissionId }, data: { status: "qc_completed", ...this.audit.update(user) } });
      if (current.sourceType === "outsource_finished_goods_return") await tx.outsourceReturnTransfer.update({ where: { id: current.sourceId }, data: { finishedGoodsQcStatus: "qc_completed", ...this.audit.update(user) } });
      return created;
    });
    await this.audit.record("finished_goods_qc_record.correct", "finished_goods_qc_record", user.id, id, { order_no: current.orderNo, replacement_qc_id: replacement.id, reason: input.reason });
    return replacement;
  }

  private async requireSource(input: SubmissionInput) {
    const productionOrder = await this.prisma.productionOrder.findFirst({ where: { id: input.production_order_id, deletedAt: null }, include: { unit: true, operations: { where: { deletedAt: null, status: "active" }, select: { id: true, targetQuantity: true } } } });
    if (!productionOrder || productionOrder.executionMode !== (input.source_type === "in_house_completion" ? "in_house" : "outsourced")) throw new NotFoundException({ code: "FINISHED_GOODS_QC_SOURCE_NOT_FOUND", message: "成品 QC 来源不存在或执行方式不匹配", details: [] });
    if (input.source_type === "outsource_finished_goods_return") {
      const source = await this.prisma.outsourceReturnTransfer.findFirst({ where: { id: input.source_id, productionOrderId: productionOrder.id, transferType: "finished_goods_return", status: "pending_qc", deletedAt: null }, include: { unit: true } });
      if (!source) throw new UnprocessableEntityException({ code: "FINISHED_GOODS_QC_SOURCE_NOT_READY", message: "外加工成品回厂来源尚未进入待 QC", details: [] });
      return { productionOrder, unitId: source.unitId, unitName: source.unit.name, productName: source.productDescription };
    }
    if (input.source_id !== productionOrder.id) throw new UnprocessableEntityException({ code: "FINISHED_GOODS_QC_SOURCE_MISMATCH", message: "厂内成品 QC 来源必须使用生产单", details: [] });
    const available = await this.inHouseAvailable(productionOrder);
    if (available.lte(0)) throw new UnprocessableEntityException({ code: "FINISHED_GOODS_QC_SOURCE_NOT_READY", message: "厂内生产单尚未形成可送检完工量", details: [] });
    return { productionOrder, unitId: productionOrder.unitId, unitName: productionOrder.unit.name, productName: null };
  }

  private async sourceAvailable(client: PrismaService | Prisma.TransactionClient, productionOrderId: string, sourceType: SourceType, sourceId: string, excludeSubmissionId?: string) {
    const order = await client.productionOrder.findFirst({ where: { id: productionOrderId, deletedAt: null }, include: { unit: true, operations: { where: { deletedAt: null, status: "active" }, include: { unit: true }, orderBy: { sequenceNo: "asc" } } } });
    if (!order) throw new NotFoundException({ code: "PRODUCTION_ORDER_NOT_FOUND", message: "生产单不存在", details: [] });
    const available = sourceType === "in_house_completion" ? await this.inHouseAvailable(order, client) : await this.returnAvailable(client, sourceId);
    const used = await client.finishedGoodsInspectionSubmission.aggregate({ where: { sourceType, sourceId, deletedAt: null, status: { notIn: ["cancelled", "corrected"] }, ...(excludeSubmissionId ? { id: { not: excludeSubmissionId } } : {}) }, _sum: { submittedQuantity: true } });
    return available.minus(used._sum.submittedQuantity ?? 0);
  }

  private async submittedQuantity(sourceId: string, sourceType: SourceType) { const result = await this.prisma.finishedGoodsInspectionSubmission.aggregate({ where: { sourceId, sourceType, deletedAt: null, status: { notIn: ["cancelled", "corrected"] } }, _sum: { submittedQuantity: true } }); return new Prisma.Decimal(result._sum.submittedQuantity ?? 0); }
  private async returnAvailable(client: PrismaService | Prisma.TransactionClient, sourceId: string) { const source = await client.outsourceReturnTransfer.findFirst({ where: { id: sourceId, deletedAt: null, transferType: "finished_goods_return" } }); if (!source) throw new NotFoundException({ code: "FINISHED_GOODS_QC_SOURCE_NOT_FOUND", message: "外加工成品回厂来源不存在", details: [] }); return new Prisma.Decimal(source.quantity); }
  private async inHouseAvailable(order: { id: string; plannedQuantity: Prisma.Decimal; operations: Array<{ id: string; targetQuantity: Prisma.Decimal }> }, client: PrismaService | Prisma.TransactionClient = this.prisma) {
    if (!order.operations.length) return new Prisma.Decimal(0);
    const quantities = await Promise.all(order.operations.map(async (operation) => { const rows = await client.operationDailyReport.aggregate({ where: { productionOrderOperationId: operation.id, deletedAt: null }, _sum: { completedQuantity: true } }); return new Prisma.Decimal(rows._sum.completedQuantity ?? 0); }));
    return quantities.reduce((min, current) => current.lt(min) ? current : min, new Prisma.Decimal(order.plannedQuantity));
  }
  private decimal(value: string, code: string) { try { const result = new Prisma.Decimal(value); if (result.lte(0)) throw new Error(); return result; } catch { throw new UnprocessableEntityException({ code, message: "数量必须是大于零的十进制数", details: [] }); } }
  private date(value: string) { const date = new Date(`${value}T00:00:00.000Z`); if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(date.valueOf())) throw new UnprocessableEntityException({ code: "INVALID_SUBMISSION_DATE", message: "送检日期无效", details: [] }); return date; }
}
