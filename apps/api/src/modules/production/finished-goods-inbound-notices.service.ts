import { Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { FinishedGoodsInboundNotice } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { AuditService } from "../../platform/audit/audit.service";
import { AuditActorService } from "../../platform/audit/audit-actor.service";
import type { CurrentUser } from "../../platform/auth/auth.service";
import { PrismaService } from "../../platform/database/prisma.service";
import { syncFinishedGoodsInboundNoticeStatus } from "./finished-goods-inbound-notice-status";
import { findPackagingOperation } from "./packaging-operation";

type NoticeInput = { production_order_id: string; notice_quantity: string; notice_date: string; batch_no?: string; remark?: string; idempotency_key?: string };
type NoticeRow = FinishedGoodsInboundNotice;

/**
 * 成品入库通知（分批）：
 * - 包装工序（工序名称含「包装」）是每个生产单的收尾工序，其累计报工量就是「可通知入库」的数量；
 * - 生产可分批手动发通知（数量不得超过 包装累计报工 − 已通知未取消量），不需要等包装工序全部完成；
 * - 仓库按通知送检/QC，QC 合格量再入库；QC 仍是入库前置，但不再要求全部工序完工。
 */
@Injectable()
export class FinishedGoodsInboundNoticesService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly actors: AuditActorService) {}

  async list(filter: { order_no?: string; production_order_id?: string; status?: string }) {
    const rows = await this.prisma.finishedGoodsInboundNotice.findMany({
      where: { deletedAt: null, ...(filter.order_no ? { orderNo: filter.order_no } : {}), ...(filter.production_order_id ? { productionOrderId: filter.production_order_id } : {}), ...(filter.status ? { status: filter.status } : {}) },
      orderBy: [{ noticeDate: "desc" }, { createdAt: "desc" }],
    });
    const progress = await this.progressMap(rows.map((row) => row.id));
    return rows.map((row) => this.decorate(row, progress.get(row.id)));
  }

  async get(id: string) {
    const row = await this.prisma.finishedGoodsInboundNotice.findFirst({ where: { id, deletedAt: null } });
    if (!row) throw new NotFoundException({ code: "FINISHED_GOODS_INBOUND_NOTICE_NOT_FOUND", message: "成品入库通知不存在", details: [] });
    const progress = await this.progressMap([id]);
    return this.decorate(row, progress.get(id));
  }

  /** 生产单侧汇总：包装累计报工、已通知、可通知、送检/QC/入库进度。 */
  async orderSummary(productionOrderId: string) {
    const order = await this.prisma.productionOrder.findFirst({ where: { id: productionOrderId, deletedAt: null }, include: { unit: true, operations: { where: { deletedAt: null }, orderBy: { sequenceNo: "asc" } } } });
    if (!order) throw new NotFoundException({ code: "PRODUCTION_ORDER_NOT_FOUND", message: "生产单不存在", details: [] });
    const packaging = findPackagingOperation(order.operations);
    const reported = packaging ? await this.packagingReportedQuantity(packaging.id) : new Prisma.Decimal(0);
    const notices = await this.prisma.finishedGoodsInboundNotice.findMany({ where: { productionOrderId, deletedAt: null }, orderBy: [{ noticeDate: "asc" }, { createdAt: "asc" }] });
    const progress = await this.progressMap(notices.map((row) => row.id));
    const notified = notices.filter((row) => row.status !== "cancelled").reduce((sum, row) => sum.plus(row.noticeQuantity), new Prisma.Decimal(0));
    const totals = [...progress.values()].reduce((sum, item) => ({
      submitted: sum.submitted.plus(item.submitted),
      qc_qualified: sum.qc_qualified.plus(item.qc_qualified),
      inbound_draft: sum.inbound_draft.plus(item.inbound_draft),
      inbound_posted: sum.inbound_posted.plus(item.inbound_posted),
    }), { submitted: new Prisma.Decimal(0), qc_qualified: new Prisma.Decimal(0), inbound_draft: new Prisma.Decimal(0), inbound_posted: new Prisma.Decimal(0) });
    const facts = await this.prisma.inventoryFact.findMany({ where: { productionOrderId, inventoryCategory: { in: ["finished_goods", "defective_goods"] } }, select: { inventoryCategory: true, quantityDelta: true, sourceType: true } });
    const balance = (category: string) => facts.filter((fact) => fact.inventoryCategory === category).reduce((sum, fact) => sum.plus(fact.quantityDelta), new Prisma.Decimal(0));
    const moved = (sourceType: string) => facts.filter((fact) => fact.sourceType === sourceType).reduce((sum, fact) => sum.plus(fact.quantityDelta.abs()), new Prisma.Decimal(0));
    return {
      production_order_id: order.id,
      production_order_no: order.productionOrderNo,
      order_no: order.orderNo,
      execution_mode: order.executionMode,
      status: order.status,
      planned_quantity: order.plannedQuantity.toString(),
      unit_id: order.unitId,
      unit_name: order.unit.name,
      packaging_operation: packaging ? { id: packaging.id, name: packaging.operationNameSnapshot, sequence_no: packaging.sequenceNo, target_quantity: packaging.targetQuantity.toString(), status: packaging.status } : null,
      packaging_reported_quantity: reported.toString(),
      notified_quantity: notified.toString(),
      available_notice_quantity: Prisma.Decimal.max(reported.minus(notified), new Prisma.Decimal(0)).toString(),
      submitted_quantity: totals.submitted.toString(),
      qc_qualified_quantity: totals.qc_qualified.toString(),
      inbound_draft_quantity: totals.inbound_draft.toString(),
      inbound_posted_quantity: totals.inbound_posted.toString(),
      finished_goods_stock: balance("finished_goods").toString(),
      defective_goods_stock: balance("defective_goods").toString(),
      outbound_quantity: moved("finished_goods_outbound").toString(),
      customer_return_quantity: moved("finished_goods_customer_return").toString(),
      notice_count: notices.length,
      // 这个响应是**手工拼的对象**、通知行在嵌套数组里，而响应出口的 AuditActorInterceptor
      // 只处理顶层行（刻意如此：递归整个响应体会悄悄改动大量接口的载荷）。
      // 所以嵌套的行数组要在这里自己补姓名，否则界面上的「创建人 / 最后修改人」恒为「—」。
      notices: await this.actors.attachAll(notices.map((row) => this.decorate(row, progress.get(row.id)))),
    };
  }

  async create(input: NoticeInput, user: CurrentUser) {
    const quantity = this.decimal(input.notice_quantity);
    const noticeDate = this.date(input.notice_date);
    if (input.idempotency_key?.trim()) {
      const previous = await this.prisma.finishedGoodsInboundNotice.findFirst({ where: { idempotencyKey: input.idempotency_key.trim(), deletedAt: null } });
      if (previous) return this.get(previous.id);
    }
    const order = await this.prisma.productionOrder.findFirst({ where: { id: input.production_order_id, deletedAt: null }, include: { unit: true, operations: { where: { deletedAt: null }, orderBy: { sequenceNo: "asc" } } } });
    if (!order) throw new NotFoundException({ code: "PRODUCTION_ORDER_NOT_FOUND", message: "生产单不存在", details: [] });
    // 成品入库通知只服务厂内生产的成品；外加工走成品回厂交接。
    if (order.executionMode !== "in_house") throw new UnprocessableEntityException({ code: "INBOUND_NOTICE_ORDER_MODE_UNSUPPORTED", message: "外加工生产单请使用成品回厂交接，不走成品入库通知", details: [] });
    if (!["in_progress", "completed"].includes(order.status)) throw new UnprocessableEntityException({ code: "INBOUND_NOTICE_ORDER_NOT_READY", message: "只有生产中或已完成的生产单可以发成品入库通知", details: [{ production_order_status: order.status }] });
    const packaging = findPackagingOperation(order.operations);
    if (!packaging) throw new UnprocessableEntityException({ code: "PACKAGING_OPERATION_REQUIRED", message: "该生产单还没有包装（收尾）工序，请先补建包装工序后再通知入库", details: [{ production_order_id: order.id }] });
    const created = await this.prisma.$transaction(async (tx) => {
      // 与并发通知/报工串行：锁生产单行后再计算可通知量。
      await tx.$queryRaw`SELECT id FROM production_orders WHERE id = ${order.id}::uuid FOR UPDATE`;
      const reported = await this.packagingReportedQuantity(packaging.id, tx);
      const notified = await this.notifiedQuantity(order.id, tx);
      const available = reported.minus(notified);
      if (quantity.gt(available)) throw new UnprocessableEntityException({ code: "INBOUND_NOTICE_QUANTITY_EXCEEDED", message: "通知数量超过包装工序可通知入库的数量", details: [{ packaging_reported_quantity: reported.toString(), notified_quantity: notified.toString(), available_quantity: available.toString() }] });
      return tx.finishedGoodsInboundNotice.create({
        data: {
          noticeNo: `FGN-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomUUID().slice(0, 8).toUpperCase()}`,
          orderNo: order.orderNo,
          productionOrderId: order.id,
          productionOrderOperationId: packaging.id,
          productionOrderNoSnapshot: order.productionOrderNo,
          operationNameSnapshot: packaging.operationNameSnapshot,
          productNameSnapshot: await this.productName(order.orderNo, tx),
          productSpecificationSnapshot: order.productSpecification,
          unitId: order.unitId,
          unitNameSnapshot: order.unit.name,
          noticeQuantity: quantity,
          noticeDate,
          batchNo: input.batch_no?.trim() || null,
          remark: input.remark,
          idempotencyKey: input.idempotency_key?.trim() || `notice:${randomUUID()}`,
          ...this.audit.create(user),
        },
      });
    });
    await this.audit.record("finished_goods_inbound_notice.create", "finished_goods_inbound_notice", user.id, created.id, { order_no: created.orderNo, production_order_id: created.productionOrderId, production_order_operation_id: created.productionOrderOperationId, notice_quantity: created.noticeQuantity.toString(), notice_date: input.notice_date, batch_no: created.batchNo });
    return this.get(created.id);
  }

  async cancel(id: string, reason: string, user: CurrentUser) {
    if (!reason?.trim()) throw new UnprocessableEntityException({ code: "CANCELLATION_REASON_REQUIRED", message: "取消成品入库通知必须填写原因", details: [] });
    const current = await this.prisma.finishedGoodsInboundNotice.findFirst({ where: { id, deletedAt: null } });
    if (!current) throw new NotFoundException({ code: "FINISHED_GOODS_INBOUND_NOTICE_NOT_FOUND", message: "成品入库通知不存在", details: [] });
    const row = await this.prisma.$transaction(async (tx) => {
      // 先抢生产单行锁（与 createSubmission 一致），再锁通知行：
      // 否则「取消通知」与「按该通知建送检单」可以并发各自成功，出现“通知已取消但已有送检/入库”的矛盾状态。
      await tx.$queryRaw`SELECT id FROM production_orders WHERE id = ${current.productionOrderId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM finished_goods_inbound_notices WHERE id = ${id}::uuid FOR UPDATE`;
      const locked = await tx.finishedGoodsInboundNotice.findFirst({ where: { id, deletedAt: null } });
      if (!locked) throw new NotFoundException({ code: "FINISHED_GOODS_INBOUND_NOTICE_NOT_FOUND", message: "成品入库通知不存在", details: [] });
      if (locked.status === "cancelled") return locked;
      const submissions = await tx.finishedGoodsInspectionSubmission.count({ where: { sourceType: "finished_goods_inbound_notice", sourceId: id, deletedAt: null, status: { notIn: ["cancelled", "corrected"] } } });
      if (submissions > 0) throw new UnprocessableEntityException({ code: "INBOUND_NOTICE_HAS_SUBMISSIONS", message: "该通知已有送检/质检记录，不能取消；如需调整请先作废送检单", details: [{ submission_count: submissions }] });
      return tx.finishedGoodsInboundNotice.update({ where: { id }, data: { status: "cancelled", remark: `${locked.remark ?? ""}\n取消：${reason}`, version: { increment: 1 }, ...this.audit.update(user) } });
    });
    await this.audit.record("finished_goods_inbound_notice.cancel", "finished_goods_inbound_notice", user.id, id, { order_no: current.orderNo, reason: reason.trim(), notice_quantity: current.noticeQuantity.toString() });
    return this.get(row.id);
  }

  /**
   * 依据送检/QC/入库事实刷新通知状态（口径见 finished-goods-inbound-notice-status.ts）。
   * 送检/入库侧也调用同一个函数，避免各处推导不一致。
   */
  async syncStatus(client: Prisma.TransactionClient, noticeId: string, user: CurrentUser) {
    return syncFinishedGoodsInboundNoticeStatus(client, noticeId, user);
  }

  /**
   * 包装工序累计报工量：与生产进度/完工口径完全一致，取 max(工序日报累计, 员工日报累计)。
   * 只算工序日报会永远低估——员工日报（工序员工日报表）才是当前唯一有 UI 录入入口的路径；
   * 直接相加则会在两个录入面都填时双重计数（每日差异告警负责提示两者不一致）。
   */
  async packagingReportedQuantity(operationId: string, client: PrismaService | Prisma.TransactionClient = this.prisma) {
    const [operationRows, employeeRows] = await Promise.all([
      client.operationDailyReport.aggregate({ where: { productionOrderOperationId: operationId, deletedAt: null }, _sum: { completedQuantity: true } }),
      client.employeeDailyReport.aggregate({ where: { productionOrderOperationId: operationId, deletedAt: null }, _sum: { quantity: true } }),
    ]);
    const operationTotal = new Prisma.Decimal(operationRows._sum.completedQuantity ?? 0);
    const employeeTotal = new Prisma.Decimal(employeeRows._sum.quantity ?? 0);
    return employeeTotal.gt(operationTotal) ? employeeTotal : operationTotal;
  }

  private async notifiedQuantity(productionOrderId: string, client: PrismaService | Prisma.TransactionClient) {
    const result = await client.finishedGoodsInboundNotice.aggregate({ where: { productionOrderId, deletedAt: null, status: { not: "cancelled" } }, _sum: { noticeQuantity: true } });
    return new Prisma.Decimal(result._sum.noticeQuantity ?? 0);
  }

  private async productName(orderNo: string, client: PrismaService | Prisma.TransactionClient) {
    const order = await client.salesOrder.findFirst({ where: { orderNo, deletedAt: null }, select: { productName: true } });
    return order?.productName ?? null;
  }

  /** 一次查完所有通知的送检/QC/入库进度，避免列表逐条查询。 */
  private async progressMap(noticeIds: string[]) {
    const result = new Map<string, { submitted: Prisma.Decimal; qc_qualified: Prisma.Decimal; qc_rejected: Prisma.Decimal; inbound_draft: Prisma.Decimal; inbound_posted: Prisma.Decimal }>();
    if (!noticeIds.length) return result;
    const submissions = await this.prisma.finishedGoodsInspectionSubmission.findMany({ where: { sourceType: "finished_goods_inbound_notice", sourceId: { in: noticeIds }, deletedAt: null, status: { notIn: ["cancelled", "corrected"] } }, select: { id: true, sourceId: true, submittedQuantity: true } });
    const submissionIds = submissions.map((row) => row.id);
    const qcRows = submissionIds.length ? await this.prisma.finishedGoodsQcRecord.findMany({ where: { submissionId: { in: submissionIds }, status: "active", deletedAt: null }, select: { submissionId: true, qualifiedQuantity: true, conditionalAcceptQuantity: true, rejectedQuantity: true } }) : [];
    const inboundRows = submissionIds.length ? await this.prisma.finishedGoodsInbound.findMany({ where: { submissionId: { in: submissionIds }, deletedAt: null, status: { in: ["draft", "posted"] } }, select: { submissionId: true, quantity: true, status: true } }) : [];
    const empty = () => ({ submitted: new Prisma.Decimal(0), qc_qualified: new Prisma.Decimal(0), qc_rejected: new Prisma.Decimal(0), inbound_draft: new Prisma.Decimal(0), inbound_posted: new Prisma.Decimal(0) });
    for (const id of noticeIds) result.set(id, empty());
    const submissionOwner = new Map(submissions.map((row) => [row.id, row.sourceId]));
    for (const row of submissions) result.get(row.sourceId)!.submitted = result.get(row.sourceId)!.submitted.plus(row.submittedQuantity);
    for (const row of qcRows) {
      const owner = submissionOwner.get(row.submissionId);
      if (!owner) continue;
      const item = result.get(owner)!;
      item.qc_qualified = item.qc_qualified.plus(row.qualifiedQuantity).plus(row.conditionalAcceptQuantity);
      item.qc_rejected = item.qc_rejected.plus(row.rejectedQuantity);
    }
    for (const row of inboundRows) {
      const owner = submissionOwner.get(row.submissionId);
      if (!owner) continue;
      const item = result.get(owner)!;
      if (row.status === "draft") item.inbound_draft = item.inbound_draft.plus(row.quantity);
      else item.inbound_posted = item.inbound_posted.plus(row.quantity);
    }
    return result;
  }

  private decorate(row: NoticeRow, progress: { submitted: Prisma.Decimal; qc_qualified: Prisma.Decimal; qc_rejected: Prisma.Decimal; inbound_draft: Prisma.Decimal; inbound_posted: Prisma.Decimal } | undefined) {
    const item = progress ?? { submitted: new Prisma.Decimal(0), qc_qualified: new Prisma.Decimal(0), qc_rejected: new Prisma.Decimal(0), inbound_draft: new Prisma.Decimal(0), inbound_posted: new Prisma.Decimal(0) };
    const available = row.status === "cancelled" ? new Prisma.Decimal(0) : Prisma.Decimal.max(row.noticeQuantity.minus(item.submitted), new Prisma.Decimal(0));
    return {
      ...row,
      noticeQuantity: row.noticeQuantity.toString(),
      submittedQuantity: item.submitted.toString(),
      qcQualifiedQuantity: item.qc_qualified.toString(),
      qcRejectedQuantity: item.qc_rejected.toString(),
      inboundDraftQuantity: item.inbound_draft.toString(),
      inboundPostedQuantity: item.inbound_posted.toString(),
      availableSubmissionQuantity: available.toString(),
      remainingForInbound: Prisma.Decimal.max(row.noticeQuantity.minus(item.inbound_posted), new Prisma.Decimal(0)).toString(),
    };
  }

  private decimal(value: string) {
    const trimmed = value?.trim();
    const match = trimmed ? /^(\d+)(?:\.(\d{1,4}))?$/.exec(trimmed) : null;
    if (!match || match[1].replace(/^0+/, "").length > 14 || !new Prisma.Decimal(trimmed).gt(0)) throw new UnprocessableEntityException({ code: "INVALID_INBOUND_NOTICE_QUANTITY", message: "通知数量必须是大于 0 的十进制数（最多 4 位小数）", details: [] });
    return new Prisma.Decimal(trimmed);
  }

  private date(value: string) {
    const date = new Date(`${value}T00:00:00.000Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(date.valueOf())) throw new UnprocessableEntityException({ code: "INVALID_INBOUND_NOTICE_DATE", message: "通知日期必须是有效日期", details: [] });
    const today = new Date(); today.setUTCHours(0, 0, 0, 0);
    if (date > today) throw new UnprocessableEntityException({ code: "INVALID_INBOUND_NOTICE_DATE", message: "通知日期不能晚于今天", details: [] });
    return date;
  }
}
