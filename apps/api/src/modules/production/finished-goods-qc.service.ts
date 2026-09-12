import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { AuditService } from "../../platform/audit/audit.service";
import type { CurrentUser } from "../../platform/auth/auth.service";
import { PrismaService } from "../../platform/database/prisma.service";
import { deriveFinishedGoodsQcConclusion, availableFinishedGoodsInboundQuantity } from "../warehouse/finished-goods-qc.domain";
import { syncFinishedGoodsInboundNoticeStatus } from "./finished-goods-inbound-notice-status";

// 厂内成品送检来源已改为「成品入库通知」（按包装工序累计报工量分批通知）；
// in_house_completion 仅保留给历史送检单读取，不再接受新建。
type SourceType = "finished_goods_inbound_notice" | "outsource_finished_goods_return" | "in_house_completion";
type SubmissionInput = { production_order_id: string; source_type: SourceType; source_id: string; submitted_quantity: string; submission_date: string; remark?: string };
type QcInput = { submission_id: string; inspection_date: string; inspected_quantity: string; qualified_quantity: string; conditional_accept_quantity: string; rejected_quantity: string; rejection_reason?: string; remark?: string };

@Injectable()
export class FinishedGoodsQcService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  async listSources(orderNo?: string, productionOrderId?: string, sourceType?: SourceType) {
    const orders = await this.prisma.productionOrder.findMany({ where: { deletedAt: null, ...(orderNo ? { orderNo } : {}), ...(productionOrderId ? { id: productionOrderId } : {}), executionMode: { in: ["in_house", "outsourced"] } }, include: { unit: true, operations: { where: { deletedAt: null, status: "active" }, include: { unit: true }, orderBy: { sequenceNo: "asc" } } }, orderBy: { updatedAt: "desc" } });
    const result: Array<Record<string, unknown>> = [];
    for (const order of orders) {
      // 厂内：来源是「成品入库通知」（包装工序累计报工量分批通知），不再按“全部工序最小完工量”自动给出可送检量。
      if (!sourceType || sourceType === "finished_goods_inbound_notice") {
        const notices = await this.prisma.finishedGoodsInboundNotice.findMany({ where: { productionOrderId: order.id, deletedAt: null, status: { not: "cancelled" } }, orderBy: [{ noticeDate: "asc" }, { createdAt: "asc" }] });
        for (const notice of notices) {
          const used = await this.noticeSubmittedQuantity(notice.id);
          const available = new Prisma.Decimal(notice.noticeQuantity).minus(used);
          if (available.lte(0)) continue;
          result.push({
            source_type: "finished_goods_inbound_notice",
            source_id: notice.id,
            notice_id: notice.id,
            notice_no: notice.noticeNo,
            batch_no: notice.batchNo,
            notice_date: notice.noticeDate.toISOString().slice(0, 10),
            notice_quantity: notice.noticeQuantity.toString(),
            packaging_operation_name: notice.operationNameSnapshot,
            order_no: order.orderNo,
            production_order_id: order.id,
            production_order_no: order.productionOrderNo,
            product_name: notice.productNameSnapshot,
            product_specification: notice.productSpecificationSnapshot ?? order.productSpecification,
            unit_id: notice.unitId,
            unit: notice.unitNameSnapshot,
            available_quantity: available.toString(),
            source_status: notice.status,
          });
        }
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
      const lockedOrder = await tx.productionOrder.findFirst({ where: { id: source.productionOrder.id, deletedAt: null } });
      if (!lockedOrder) throw new NotFoundException({ code: "PRODUCTION_ORDER_NOT_FOUND", message: "生产单不存在", details: [] });
      if (input.source_type === "in_house_completion" && !["in_progress", "completed"].includes(lockedOrder.status)) throw new UnprocessableEntityException({ code: "FINISHED_GOODS_QC_SOURCE_NOT_READY", message: "厂内成品送检要求生产单处于生产中或已完成，当前状态不允许送检", details: [{ production_order_status: lockedOrder.status }] });
      const available = await this.sourceAvailable(tx, source.productionOrder.id, input.source_type, input.source_id);
      if (quantity.gt(available)) throw new UnprocessableEntityException({ code: "FINISHED_GOODS_SUBMISSION_QUANTITY_EXCEEDED", message: "送检数量超过来源可送检数量", details: [{ available_quantity: available.toString() }] });
      const row = await tx.finishedGoodsInspectionSubmission.create({ data: { submissionNo: `FGI-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomUUID().slice(0, 8).toUpperCase()}`, orderNo: source.productionOrder.orderNo, productionOrderId: source.productionOrder.id, sourceType: input.source_type, sourceId: input.source_id, productionOrderNoSnapshot: source.productionOrder.productionOrderNo, productNameSnapshot: source.productName, productSpecificationSnapshot: source.productionOrder.productSpecification, unitId: source.unitId, unitNameSnapshot: source.unitName, submittedQuantity: quantity, submissionDate: date, remark: input.remark, ...this.audit.create(user) } });
      await syncFinishedGoodsInboundNoticeStatus(tx, source.noticeId, user);
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
      const updated = await tx.finishedGoodsInspectionSubmission.update({ where: { id }, data: { submittedQuantity: quantity, ...(input.submission_date ? { submissionDate: this.date(input.submission_date) } : {}), ...(input.remark === undefined ? {} : { remark: input.remark }), version: { increment: 1 }, ...this.audit.update(user) } });
      // 草稿送检量变化会影响「通知量是否已全部送检」，因此同样要刷新来源入库通知的状态。
      if (current.sourceType === "finished_goods_inbound_notice") await syncFinishedGoodsInboundNoticeStatus(tx, current.sourceId, user);
      return updated;
    });
    await this.audit.record("finished_goods_inspection_submission.update", "finished_goods_inspection_submission", user.id, id, { order_no: current.orderNo, reason: input.reason });
    return updated;
  }

  async submit(id: string, user: CurrentUser) {
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM finished_goods_inspection_submissions WHERE id = ${id}::uuid FOR UPDATE`;
      const locked = await tx.finishedGoodsInspectionSubmission.findFirst({ where: { id, deletedAt: null } });
      if (!locked) throw new NotFoundException({ code: "FINISHED_GOODS_SUBMISSION_NOT_FOUND", message: "成品送检单不存在", details: [] });
      if (locked.status !== "draft") throw new UnprocessableEntityException({ code: "FINISHED_GOODS_SUBMISSION_NOT_SUBMITTABLE", message: "只有草稿送检单可以提交", details: [] });
      const updated = await tx.finishedGoodsInspectionSubmission.update({ where: { id }, data: { status: "submitted", ...this.audit.update(user) } });
      if (locked.sourceType === "finished_goods_inbound_notice") await syncFinishedGoodsInboundNoticeStatus(tx, locked.sourceId, user);
      if (locked.sourceType === "outsource_finished_goods_return") {
        await tx.$queryRaw`SELECT id FROM outsource_return_transfers WHERE id = ${locked.sourceId}::uuid FOR UPDATE`;
        const transfer = await tx.outsourceReturnTransfer.findFirst({ where: { id: locked.sourceId, deletedAt: null } });
        if (transfer) await tx.outsourceReturnTransfer.update({ where: { id: transfer.id }, data: { finishedGoodsQcStatus: "submitted", ...this.audit.update(user) } });
      }
      return updated;
    });
    await this.audit.record("finished_goods_inspection_submission.submit", "finished_goods_inspection_submission", user.id, id, { order_no: result.orderNo });
    return result;
  }

  async cancel(id: string, reason: string, user: CurrentUser) {
    if (!reason?.trim()) throw new UnprocessableEntityException({ code: "CANCELLATION_REASON_REQUIRED", message: "取消送检必须填写原因", details: [] });
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM finished_goods_inspection_submissions WHERE id = ${id}::uuid FOR UPDATE`;
      const locked = await tx.finishedGoodsInspectionSubmission.findFirst({ where: { id, deletedAt: null }, include: { qcRecords: { where: { deletedAt: null } } } });
      if (!locked) throw new NotFoundException({ code: "FINISHED_GOODS_SUBMISSION_NOT_FOUND", message: "成品送检单不存在", details: [] });
      if (!["draft", "submitted"].includes(locked.status) || locked.qcRecords.length > 0) throw new UnprocessableEntityException({ code: "FINISHED_GOODS_SUBMISSION_NOT_CANCELLABLE", message: "当前送检单不允许取消", details: [] });
      const updated = await tx.finishedGoodsInspectionSubmission.update({ where: { id }, data: { status: "cancelled", remark: `${locked.remark ?? ""}\n取消：${reason}`, ...this.audit.update(user) } });
      if (locked.sourceType === "finished_goods_inbound_notice") await syncFinishedGoodsInboundNoticeStatus(tx, locked.sourceId, user);
      if (locked.sourceType === "outsource_finished_goods_return") {
        await tx.$queryRaw`SELECT id FROM outsource_return_transfers WHERE id = ${locked.sourceId}::uuid FOR UPDATE`;
        const transfer = await tx.outsourceReturnTransfer.findFirst({ where: { id: locked.sourceId, deletedAt: null } });
        if (transfer) await tx.outsourceReturnTransfer.update({ where: { id: transfer.id }, data: { finishedGoodsQcStatus: "not_submitted", ...this.audit.update(user) } });
      }
      return updated;
    });
    await this.audit.record("finished_goods_inspection_submission.cancel", "finished_goods_inspection_submission", user.id, id, { order_no: result.orderNo, reason });
    return result;
  }

  async listQcRecords(orderNo?: string) {
    const rows = await this.prisma.finishedGoodsQcRecord.findMany({ where: { deletedAt: null, ...(orderNo ? { orderNo } : {}) }, include: { submission: true }, orderBy: { inspectionDate: "desc" } });
    // 与入库时的服务端校验（acceptedAvailable 扣减 draft+posted）保持同一口径：
    // 列表里的“可入库数量”必须是净值，否则界面会显示一个已经用掉的额度，用户点进去才发现超量。
    const used = await this.inboundUsedMap(rows.filter((row) => row.status === "active").map((row) => row.id));
    return rows.map((row) => ({ ...row, availableForInboundQuantity: availableFinishedGoodsInboundQuantity(row.qualifiedQuantity.toString(), row.conditionalAcceptQuantity.toString(), (used.get(row.id) ?? new Prisma.Decimal(0)).toString()).toString() }));
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
      const lockedSubmission = await tx.finishedGoodsInspectionSubmission.findFirst({ where: { id: submission.id, deletedAt: null } });
      if (!lockedSubmission || !["submitted", "inspecting"].includes(lockedSubmission.status)) throw new UnprocessableEntityException({ code: "FINISHED_GOODS_SUBMISSION_NOT_INSPECTABLE", message: "当前送检单不允许录入 QC", details: [] });
      const existing = await tx.finishedGoodsQcRecord.aggregate({ where: { submissionId: lockedSubmission.id, status: "active", deletedAt: null }, _sum: { inspectedQuantity: true } });
      const used = new Prisma.Decimal(existing._sum.inspectedQuantity ?? 0);
      if (used.plus(inspected).gt(lockedSubmission.submittedQuantity)) throw new UnprocessableEntityException({ code: "QC_INSPECTION_QUANTITY_EXCEEDED", message: "累计检验数量超过送检数量", details: [{ remaining_quantity: lockedSubmission.submittedQuantity.minus(used).toString() }] });
      const row = await tx.finishedGoodsQcRecord.create({ data: { qcNo: `FQC-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomUUID().slice(0, 8).toUpperCase()}`, submissionId: lockedSubmission.id, orderNo: lockedSubmission.orderNo, productionOrderId: lockedSubmission.productionOrderId, sourceType: lockedSubmission.sourceType, sourceId: lockedSubmission.sourceId, inspectionDate: date, inspectedQuantity: quantities.inspected_quantity, qualifiedQuantity: quantities.qualified_quantity, conditionalAcceptQuantity: quantities.conditional_accept_quantity, rejectedQuantity: quantities.rejected_quantity, conclusion: quantities.conclusion, rejectionReason: input.rejection_reason, remark: input.remark, ...this.audit.create(user) } });
      const nextStatus = used.plus(inspected).eq(lockedSubmission.submittedQuantity) ? "qc_completed" : "inspecting";
      await tx.finishedGoodsInspectionSubmission.update({ where: { id: lockedSubmission.id }, data: { status: nextStatus, ...this.audit.update(user) } });
      if (lockedSubmission.sourceType === "outsource_finished_goods_return") await tx.outsourceReturnTransfer.update({ where: { id: lockedSubmission.sourceId }, data: { finishedGoodsQcStatus: nextStatus === "qc_completed" ? "qc_completed" : "inspecting", ...this.audit.update(user) } });
      return row;
    });
    await this.audit.record("finished_goods_qc_record.create", "finished_goods_qc_record", user.id, created.id, { order_no: created.orderNo, submission_id: created.submissionId, conclusion: created.conclusion, inspected_quantity: created.inspectedQuantity.toString() });
    return created;
  }

  async availableInboundSources(orderNo?: string) {
    const rows = await this.prisma.finishedGoodsQcRecord.findMany({ where: { deletedAt: null, status: "active", ...(orderNo ? { orderNo } : {}) }, include: { submission: { include: { unit: true } } }, orderBy: { inspectionDate: "asc" } });
    const used = await this.inboundUsedMap(rows.map((row) => row.id));
    return rows.map((row) => ({ qc_id: row.id, qc_no: row.qcNo, submission_id: row.submissionId, order_no: row.orderNo, production_order_id: row.productionOrderId, source_type: row.sourceType, source_id: row.sourceId, unit_id: row.submission.unitId, unit: row.submission.unitNameSnapshot, qualified_quantity: row.qualifiedQuantity.toString(), conditional_accept_quantity: row.conditionalAcceptQuantity.toString(), available_for_inbound_quantity: availableFinishedGoodsInboundQuantity(row.qualifiedQuantity.toString(), row.conditionalAcceptQuantity.toString(), (used.get(row.id) ?? new Prisma.Decimal(0)).toString()), conditionally_accepted: row.conditionalAcceptQuantity.gt(0), source_read_only: true }));
  }

  /** 每个 QC 已占用的入库量（草稿 + 已过账，与 acceptedAvailable 一致）。 */
  private async inboundUsedMap(qcRecordIds: string[]) {
    const map = new Map<string, Prisma.Decimal>();
    if (!qcRecordIds.length) return map;
    const rows = await this.prisma.finishedGoodsInbound.groupBy({ by: ["qcRecordId"], where: { qcRecordId: { in: qcRecordIds }, deletedAt: null, status: { in: ["draft", "posted"] } }, _sum: { quantity: true } });
    for (const row of rows) map.set(row.qcRecordId, new Prisma.Decimal(row._sum.quantity ?? 0));
    return map;
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
      // 锁 submission 行：与 createQcRecord/并发更正串行，避免送检上限被绕过
      await tx.$queryRaw`SELECT id FROM finished_goods_inspection_submissions WHERE id = ${current.submissionId}::uuid FOR UPDATE`;
      const lockedSubmission = await tx.finishedGoodsInspectionSubmission.findFirst({ where: { id: current.submissionId, deletedAt: null } });
      if (!lockedSubmission) throw new NotFoundException({ code: "FINISHED_GOODS_SUBMISSION_NOT_FOUND", message: "成品送检单不存在", details: [] });
      await tx.$queryRaw`SELECT id FROM finished_goods_qc_records WHERE id = ${id}::uuid FOR UPDATE`;
      const lockedRecord = await tx.finishedGoodsQcRecord.findFirst({ where: { id, deletedAt: null, status: "active" } });
      if (!lockedRecord) throw new NotFoundException({ code: "FINISHED_GOODS_QC_NOT_FOUND", message: "成品 QC 记录不存在或已更正", details: [] });
      const [lockedInboundCount, lockedDefectiveCount] = await Promise.all([
        tx.finishedGoodsInbound.count({ where: { qcRecordId: id, deletedAt: null, status: { in: ["draft", "posted"] } } }),
        tx.finishedGoodsDefective.count({ where: { qcRecordId: id, deletedAt: null, status: { in: ["draft", "posted"] } } }),
      ]);
      if (lockedInboundCount || lockedDefectiveCount) throw new UnprocessableEntityException({ code: "FINISHED_GOODS_QC_DOWNSTREAM_EXISTS", message: "已有成品入库或不良品下游事实，必须先删除草稿或冲销过账记录后再更正 QC", details: [{ inbound_count: lockedInboundCount, defective_count: lockedDefectiveCount }] });
      // 上限：该 submission 下其它 active（非 corrected）QC 的 inspected 合计 + 本次 replacement inspected ≤ submittedQuantity
      const inspected = new Prisma.Decimal(quantities.inspected_quantity);
      const others = await tx.finishedGoodsQcRecord.aggregate({ where: { submissionId: lockedSubmission.id, status: "active", deletedAt: null, id: { not: id } }, _sum: { inspectedQuantity: true } });
      const othersInspected = new Prisma.Decimal(others._sum.inspectedQuantity ?? 0);
      if (othersInspected.plus(inspected).gt(lockedSubmission.submittedQuantity)) throw new UnprocessableEntityException({ code: "FINISHED_GOODS_QC_INSPECTION_QUANTITY_EXCEEDED", message: "更正后累计检验数量不能超过送检数量", details: [{ remaining_quantity: lockedSubmission.submittedQuantity.minus(othersInspected).toString() }] });
      const marked = await tx.finishedGoodsQcRecord.updateMany({ where: { id, status: "active" }, data: { status: "corrected", correctionReason: input.reason, correctedAt: new Date(), ...this.audit.update(user) } });
      if (marked.count !== 1) throw new ConflictException({ code: "VERSION_CONFLICT", message: "成品 QC 记录已被其他操作处理，请刷新后重试", details: [] });
      const created = await tx.finishedGoodsQcRecord.create({ data: { qcNo: `FQC-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomUUID().slice(0, 8).toUpperCase()}`, submissionId: lockedRecord.submissionId, orderNo: lockedRecord.orderNo, productionOrderId: lockedRecord.productionOrderId, sourceType: lockedRecord.sourceType, sourceId: lockedRecord.sourceId, inspectionDate: this.date(input.inspection_date), inspectedQuantity: quantities.inspected_quantity, qualifiedQuantity: quantities.qualified_quantity, conditionalAcceptQuantity: quantities.conditional_accept_quantity, rejectedQuantity: quantities.rejected_quantity, conclusion: quantities.conclusion, rejectionReason: input.rejection_reason, remark: input.remark, ...this.audit.create(user) } });
      // 更正后按 active 记录 inspected 合计是否等于 submittedQuantity 推导 submission.status
      const active = await tx.finishedGoodsQcRecord.aggregate({ where: { submissionId: lockedSubmission.id, status: "active", deletedAt: null }, _sum: { inspectedQuantity: true } });
      const nextStatus = new Prisma.Decimal(active._sum.inspectedQuantity ?? 0).eq(lockedSubmission.submittedQuantity) ? "qc_completed" : "inspecting";
      await tx.finishedGoodsInspectionSubmission.update({ where: { id: lockedSubmission.id }, data: { status: nextStatus, ...this.audit.update(user) } });
      if (lockedRecord.sourceType === "outsource_finished_goods_return") await tx.outsourceReturnTransfer.update({ where: { id: lockedRecord.sourceId }, data: { finishedGoodsQcStatus: nextStatus === "qc_completed" ? "qc_completed" : "inspecting", ...this.audit.update(user) } });
      return created;
    });
    await this.audit.record("finished_goods_qc_record.correct", "finished_goods_qc_record", user.id, id, { order_no: current.orderNo, replacement_qc_id: replacement.id, reason: input.reason });
    return replacement;
  }

  private async requireSource(input: SubmissionInput) {
    // 厂内成品送检已改为按「成品入库通知」发起；旧的整单完工来源不再接受新建（历史送检单仍可查询）。
    if (input.source_type === "in_house_completion") throw new UnprocessableEntityException({ code: "FINISHED_GOODS_QC_SOURCE_TYPE_RETIRED", message: "厂内成品送检已改为按「成品入库通知」发起：请先在生产单包装工序发成品入库通知，再对通知送检", details: [] });
    const productionOrder = await this.prisma.productionOrder.findFirst({ where: { id: input.production_order_id, deletedAt: null }, include: { unit: true, operations: { where: { deletedAt: null, status: "active" }, select: { id: true, targetQuantity: true } } } });
    if (!productionOrder || productionOrder.executionMode !== (input.source_type === "outsource_finished_goods_return" ? "outsourced" : "in_house")) throw new NotFoundException({ code: "FINISHED_GOODS_QC_SOURCE_NOT_FOUND", message: "成品 QC 来源不存在或执行方式不匹配", details: [] });
    if (input.source_type === "outsource_finished_goods_return") {
      const source = await this.prisma.outsourceReturnTransfer.findFirst({ where: { id: input.source_id, productionOrderId: productionOrder.id, transferType: "finished_goods_return", status: "pending_qc", deletedAt: null }, include: { unit: true } });
      if (!source) throw new UnprocessableEntityException({ code: "FINISHED_GOODS_QC_SOURCE_NOT_READY", message: "外加工成品回厂来源尚未进入待 QC", details: [] });
      return { productionOrder, unitId: source.unitId, unitName: source.unit.name, productName: source.productDescription, noticeId: null as string | null };
    }
    const notice = await this.prisma.finishedGoodsInboundNotice.findFirst({ where: { id: input.source_id, productionOrderId: productionOrder.id, deletedAt: null }, include: { unit: true } });
    if (!notice) throw new NotFoundException({ code: "FINISHED_GOODS_QC_SOURCE_NOT_FOUND", message: "成品入库通知不存在或不属于该生产单", details: [] });
    if (notice.status === "cancelled") throw new UnprocessableEntityException({ code: "FINISHED_GOODS_QC_SOURCE_NOT_READY", message: "该成品入库通知已取消，不能送检", details: [] });
    if (!["in_progress", "completed"].includes(productionOrder.status)) throw new UnprocessableEntityException({ code: "FINISHED_GOODS_QC_SOURCE_NOT_READY", message: "厂内成品送检要求生产单处于生产中或已完成，当前状态不允许送检", details: [{ production_order_status: productionOrder.status }] });
    const available = await this.noticeAvailable(this.prisma, notice.id);
    if (available.lte(0)) throw new UnprocessableEntityException({ code: "FINISHED_GOODS_QC_SOURCE_NOT_READY", message: "该入库通知已全部送检", details: [] });
    return { productionOrder, unitId: notice.unitId, unitName: notice.unitNameSnapshot, productName: notice.productNameSnapshot, noticeId: notice.id };
  }

  private async sourceAvailable(client: PrismaService | Prisma.TransactionClient, productionOrderId: string, sourceType: SourceType, sourceId: string, excludeSubmissionId?: string) {
    if (sourceType === "finished_goods_inbound_notice") return this.noticeAvailable(client, sourceId, excludeSubmissionId);
    const order = await client.productionOrder.findFirst({ where: { id: productionOrderId, deletedAt: null }, include: { unit: true, operations: { where: { deletedAt: null, status: "active" }, include: { unit: true }, orderBy: { sequenceNo: "asc" } } } });
    if (!order) throw new NotFoundException({ code: "PRODUCTION_ORDER_NOT_FOUND", message: "生产单不存在", details: [] });
    const used = await client.finishedGoodsInspectionSubmission.aggregate({ where: { sourceType, sourceId, deletedAt: null, status: { notIn: ["cancelled", "corrected"] }, ...(excludeSubmissionId ? { id: { not: excludeSubmissionId } } : {}) }, _sum: { submittedQuantity: true } });
    return (await this.returnAvailable(client, sourceId)).minus(used._sum.submittedQuantity ?? 0);
  }

  /** 入库通知的可送检量 = 通知数量 − 该通知下未取消的送检量。 */
  private async noticeAvailable(client: PrismaService | Prisma.TransactionClient, noticeId: string, excludeSubmissionId?: string) {
    const notice = await client.finishedGoodsInboundNotice.findFirst({ where: { id: noticeId, deletedAt: null }, select: { id: true, noticeQuantity: true, status: true } });
    if (!notice) throw new NotFoundException({ code: "FINISHED_GOODS_QC_SOURCE_NOT_FOUND", message: "成品入库通知不存在", details: [] });
    if (notice.status === "cancelled") return new Prisma.Decimal(0);
    const used = await client.finishedGoodsInspectionSubmission.aggregate({ where: { sourceType: "finished_goods_inbound_notice", sourceId: noticeId, deletedAt: null, status: { notIn: ["cancelled", "corrected"] }, ...(excludeSubmissionId ? { id: { not: excludeSubmissionId } } : {}) }, _sum: { submittedQuantity: true } });
    return new Prisma.Decimal(notice.noticeQuantity).minus(used._sum.submittedQuantity ?? 0);
  }

  /** 该通知下未取消的送检量。 */
  private async noticeSubmittedQuantity(noticeId: string) {
    const result = await this.prisma.finishedGoodsInspectionSubmission.aggregate({ where: { sourceType: "finished_goods_inbound_notice", sourceId: noticeId, deletedAt: null, status: { notIn: ["cancelled", "corrected"] } }, _sum: { submittedQuantity: true } });
    return new Prisma.Decimal(result._sum.submittedQuantity ?? 0);
  }

  private async submittedQuantity(sourceId: string, sourceType: SourceType) { const result = await this.prisma.finishedGoodsInspectionSubmission.aggregate({ where: { sourceId, sourceType, deletedAt: null, status: { notIn: ["cancelled", "corrected"] } }, _sum: { submittedQuantity: true } }); return new Prisma.Decimal(result._sum.submittedQuantity ?? 0); }
  private async returnAvailable(client: PrismaService | Prisma.TransactionClient, sourceId: string) { const source = await client.outsourceReturnTransfer.findFirst({ where: { id: sourceId, deletedAt: null, transferType: "finished_goods_return" } }); if (!source) throw new NotFoundException({ code: "FINISHED_GOODS_QC_SOURCE_NOT_FOUND", message: "外加工成品回厂来源不存在", details: [] }); return new Prisma.Decimal(source.quantity); }
  private decimal(value: string, code: string) {
    if (typeof value !== "string" || value.length === 0 || !/^\d+(?:\.\d+)?$/.test(value)) throw this.quantityError(code);
    const [integerPart, fractionPart = ""] = value.split(".");
    if (fractionPart.length > 4 || (integerPart.replace(/^0+/, "").length || 1) > 14) throw this.quantityError(code);
    try { const result = new Prisma.Decimal(value); if (result.lte(0)) throw new Error(); return result; } catch { throw this.quantityError(code); }
  }
  private quantityError(code: string) { return new UnprocessableEntityException({ code, message: "数量必须是大于零的十进制数，且最多 4 位小数、总精度不超过 18 位", details: [] }); }
  private date(value: string) { const date = new Date(`${value}T00:00:00.000Z`); if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(date.valueOf())) throw new UnprocessableEntityException({ code: "INVALID_SUBMISSION_DATE", message: "送检日期无效", details: [] }); return date; }
}
