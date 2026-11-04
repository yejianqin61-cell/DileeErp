import { forwardRef, Inject, Injectable, NotFoundException, Optional, UnprocessableEntityException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { AuditService } from "../../platform/audit/audit.service";
import type { CurrentUser } from "../../platform/auth/auth.service";
import { PrismaService } from "../../platform/database/prisma.service";
import { RawMaterialInboundsService } from "./raw-material-inbounds.service";

/** 供应商超送时，把到货批次数量抬到实收量的一次修正（审计详情与返回值都用它）。 */
type OverReceiptCorrection = { receiptId: string; orderNo: string; from: string; to: string };

@Injectable()
export class IncomingInspectionsService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, @Optional() @Inject(forwardRef(() => RawMaterialInboundsService)) private readonly inbounds?: RawMaterialInboundsService) {}
  async list(orderNo?: string) { const rows = await this.prisma.incomingInspection.findMany({ where: { deletedAt: null, ...(orderNo ? { orderNo } : {}) }, include: { rawMaterialInbounds: { where: { deletedAt: null }, select: { id: true } }, purchaseReceipt: { include: { purchaseOrderItem: { include: { material: { select: { name: true } } } }, purchaseOrder: { select: { purchaseOrderNo: true } }, rawMaterialInbounds: { where: { deletedAt: null }, select: { id: true } } } } }, orderBy: { createdAt: "asc" } }); return rows.map((row) => ({ ...row, material_name: row.purchaseReceipt?.purchaseOrderItem?.material?.name ?? null, purchase_order_no: row.purchaseReceipt?.purchaseOrder?.purchaseOrderNo ?? null, downstream_exists: Boolean(row.rawMaterialInbounds?.length || row.purchaseReceipt?.rawMaterialInbounds?.length), batchSequence: Number((row.purchaseReceipt?.extensionData as { batch_sequence?: number } | null)?.batch_sequence ?? (row.extensionData as { batch_sequence?: number } | null)?.batch_sequence ?? 1) })).reverse(); }

  async update(id: string, input: { inspected_quantity: string; accepted_quantity: string; conditional_quantity: string; rejected_quantity: string; qc_result?: string; extension_data?: Record<string, unknown>; remark?: string; reason: string }, user: CurrentUser) {
    if (!input.reason?.trim()) throw new UnprocessableEntityException({ code: "CORRECTION_REASON_REQUIRED", message: "质检更正必须填写原因", details: [] });
    const values = [input.inspected_quantity, input.accepted_quantity, input.conditional_quantity, input.rejected_quantity].map((value) => { try { const decimal = new Prisma.Decimal(value); if (decimal.isNegative()) throw new Error(); return decimal; } catch { throw new UnprocessableEntityException({ code: "INSPECTION_QUANTITY_MISMATCH", message: "检验数量分流不合法", details: [] }); } });
    if (!values[1].plus(values[2]).plus(values[3]).eq(values[0])) throw new UnprocessableEntityException({ code: "INSPECTION_QUANTITY_MISMATCH", message: "检验数量分流不合法", details: [] });
    const overReceipt: { value: OverReceiptCorrection | null } = { value: null };
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT purchase_receipt_id FROM incoming_inspections WHERE id = ${id}::uuid FOR UPDATE`;
      const current = await tx.incomingInspection.findFirst({ where: { id, deletedAt: null }, include: { purchaseReceipt: { include: { rawMaterialInbounds: { where: { deletedAt: null }, select: { id: true } } } }, rawMaterialInbounds: { where: { deletedAt: null }, select: { id: true } } } });
      if (!current) throw new NotFoundException({ code: "INCOMING_INSPECTION_NOT_FOUND", message: "来料质检记录不存在", details: [] });
      if (current.status === "cancelled") throw new UnprocessableEntityException({ code: "INSPECTION_RETURNED_NOT_CORRECTABLE", message: "已整批退货的质检批次不可更正", details: [] });
      if (current.rawMaterialInbounds.length || current.purchaseReceipt.rawMaterialInbounds.length) throw new UnprocessableEntityException({ code: "INSPECTION_DOWNSTREAM_EXISTS", message: "已有原料入库事实的质检批次不可修改", details: [] });
      // 供应商超送（用户 2026-11-04）：实收数量可能大于到货数量，而到货数量又守着采购数量。
      // 质检登记的就是实收事实，所以这里不再按到货数量拦截，而是把到货批次数量抬到实收量。
      overReceipt.value = await this.raiseReceiptToActual(tx, current.purchaseReceipt, values[0], input.reason, user);
      const status = values[0].isZero() ? current.status : values[3].eq(values[0]) ? "rejected" : values[1].plus(values[2]).eq(values[0]) ? (values[2].gt(0) ? "conditionally_accepted" : "accepted") : "partially_accepted";
        const qcResult = status === "rejected" ? "rejected" : status === "accepted" || status === "conditionally_accepted" ? "all_inbound" : status === "partially_accepted" ? "partial_inbound" : null;
        if (input.qc_result && input.qc_result !== qcResult) throw new UnprocessableEntityException({ code: "QC_RESULT_MISMATCH", message: "QC 最终结果与检验数量分流不一致", details: [{ requested: input.qc_result, derived: qcResult }] });
      const updated = await tx.incomingInspection.update({ where: { id }, data: { inspectedQuantity: values[0], acceptedQuantity: values[1], conditionalQuantity: values[2], rejectedQuantity: values[3], qcResult, status, extensionData: { ...(current.extensionData as Record<string, unknown>), ...(input.extension_data ?? {}) } as Prisma.InputJsonValue, remark: `${current.remark ?? ""}${current.remark ? "\n" : ""}${input.reason.trim()}${input.remark?.trim() ? `\n${input.remark.trim()}` : ""}`, ...this.audit.update(user) } });
      // 入库草稿由仓库接收入库通知时创建，质检阶段只产生可入库数量。
      return updated;
    });
    await this.audit.record("incoming_inspection.update", "incoming_inspection", user.id, id, { order_no: result.orderNo, reason: input.reason.trim() });
    if (overReceipt.value) await this.recordOverReceipt(overReceipt.value, "incoming_inspection.update", input.reason, user);
    return result;
  }
  async create(input: { purchase_receipt_id: string; inspected_quantity: string; accepted_quantity: string; conditional_quantity: string; rejected_quantity: string; qc_result?: string; extension_data?: Record<string, unknown>; remark?: string }, user: CurrentUser) {
    const values = [input.inspected_quantity, input.accepted_quantity, input.conditional_quantity, input.rejected_quantity].map((value) => { try { const decimal = new Prisma.Decimal(value); if (decimal.isNegative()) throw new Error(); return decimal; } catch { throw new UnprocessableEntityException({ code: "INSPECTION_QUANTITY_MISMATCH", message: "检验数量分流不合法", details: [] }); } });
    if (!values[1].plus(values[2]).plus(values[3]).eq(values[0])) throw new UnprocessableEntityException({ code: "INSPECTION_QUANTITY_MISMATCH", message: "检验数量分流不合法", details: [] });
    const overReceipt: { value: OverReceiptCorrection | null } = { value: null };
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM purchase_receipts WHERE id = ${input.purchase_receipt_id}::uuid FOR UPDATE`;
      const receipt = await tx.purchaseReceipt.findFirst({ where: { id: input.purchase_receipt_id, deletedAt: null }, include: { inspections: { where: { deletedAt: null }, include: { rawMaterialInbounds: { where: { deletedAt: null }, select: { id: true } } } } } });
      if (!receipt) throw new NotFoundException({ code: "RECEIPT_NOT_FOUND", message: "到货记录不存在", details: [] });
      const inspectedBefore = receipt.inspections.reduce((sum, inspection) => sum.plus(inspection.inspectedQuantity), new Prisma.Decimal(0));
      const inspectedTotal = values[0].plus(inspectedBefore);
      // 供应商超送（用户 2026-11-04）：实收 1600 而到货只登记了 1500 时，质检不能因为
      // 「累计检验数量不能超过到货数量」被卡住 —— 到货数量本来就是按订单量估的，实收才是事实。
      // 这里把到货批次数量抬到累计实收量（只升不降），入库与应付随之按实数走。
      overReceipt.value = await this.raiseReceiptToActual(tx, receipt, inspectedTotal, input.remark, user);
      const existing = receipt.inspections[0];
      if (existing?.rawMaterialInbounds?.length) throw new UnprocessableEntityException({ code: "INSPECTION_DOWNSTREAM_EXISTS", message: "已有原料入库事实的质检批次不可修改", details: [] });
      const inspected = (existing?.inspectedQuantity ?? new Prisma.Decimal(0)).plus(values[0]);
      const accepted = (existing?.acceptedQuantity ?? new Prisma.Decimal(0)).plus(values[1]);
      const conditional = (existing?.conditionalQuantity ?? new Prisma.Decimal(0)).plus(values[2]);
      const rejected = (existing?.rejectedQuantity ?? new Prisma.Decimal(0)).plus(values[3]);
      const status = inspected.isZero() ? "pending" : rejected.eq(inspected) ? "rejected" : accepted.plus(conditional).eq(inspected) ? (conditional.gt(0) ? "conditionally_accepted" : "accepted") : "partially_accepted";
        const qcResult = status === "rejected" ? "rejected" : status === "accepted" || status === "conditionally_accepted" ? "all_inbound" : status === "partially_accepted" ? "partial_inbound" : null;
        if (input.qc_result && input.qc_result !== qcResult) throw new UnprocessableEntityException({ code: "QC_RESULT_MISMATCH", message: "QC 最终结果与检验数量分流不一致", details: [{ requested: input.qc_result, derived: qcResult }] });
      const batchSequence = Number((receipt.extensionData as { batch_sequence?: number } | null)?.batch_sequence ?? 1);
      const result = existing
        ? await tx.incomingInspection.update({ where: { id: existing.id }, data: { inspectedQuantity: inspected, acceptedQuantity: accepted, conditionalQuantity: conditional, rejectedQuantity: rejected, status, extensionData: { ...(existing.extensionData as Record<string, unknown>), ...(input.extension_data ?? {}), batch_sequence: batchSequence } as Prisma.InputJsonValue, qcResult, remark: input.remark ?? existing.remark, ...this.audit.update(user) } })
        : await tx.incomingInspection.create({ data: { purchaseReceiptId: receipt.id, orderNo: receipt.orderNo, inspectedQuantity: values[0], acceptedQuantity: values[1], conditionalQuantity: values[2], rejectedQuantity: values[3], status, qcResult, extensionData: { ...(input.extension_data ?? {}), batch_sequence: batchSequence } as Prisma.InputJsonValue, remark: input.remark, ...this.audit.create(user) } });
      // 入库草稿由仓库接收入库通知时创建，质检阶段只产生可入库数量。
      return result;
    });
    await this.audit.record("incoming_inspection.create", "incoming_inspection", user.id, result.id, { order_no: result.orderNo, purchase_receipt_id: input.purchase_receipt_id, status: result.status });
    if (overReceipt.value) await this.recordOverReceipt(overReceipt.value, "incoming_inspection.create", input.remark, user);
    return result;
  }

  /**
   * 供应商超送：把到货批次数量抬到累计实收量。
   *
   * 为什么在质检里改到货数量：到货登记是采购按订单量填的，实收数量往往要等质检/仓库点过才知道；
   * 用户 2026-11-04 的原话是「在来料质检中无法修改」。不改到货数量的话，入库与应付会被一个偏小的
   * 到货数量卡住（入库上限 = 合格 + 条件接收，应付 = 入库数量 × 单价），而实收数量才是事实。
   *
   * 只升不降：把数量往下改（例如输错）不属于超收，质检侧的更正不会把已登记的到货改小。
   * 返回 null 表示没超收、没写库；调用方据此记一条 `purchase_receipt.over_receipt` 审计。
   */
  private async raiseReceiptToActual(
    tx: Prisma.TransactionClient,
    receipt: { id: string; orderNo: string; quantity: Prisma.Decimal; extensionData: Prisma.JsonValue | null },
    actual: Prisma.Decimal,
    reason: string | undefined,
    user: CurrentUser
  ): Promise<OverReceiptCorrection | null> {
    if (!actual.gt(receipt.quantity)) return null;
    const from = receipt.quantity.toString();
    const extensionData = { ...((receipt.extensionData ?? {}) as Record<string, unknown>), over_receipt: true, over_receipt_reason: reason?.trim() || null, over_receipt_corrected_from: from };
    await tx.purchaseReceipt.update({ where: { id: receipt.id }, data: { quantity: actual, extensionData: extensionData as Prisma.InputJsonValue, ...this.audit.update(user) } });
    return { receiptId: receipt.id, orderNo: receipt.orderNo, from, to: actual.toString() };
  }

  private async recordOverReceipt(correction: OverReceiptCorrection, source: string, reason: string | undefined, user: CurrentUser) {
    await this.audit.record("purchase_receipt.over_receipt", "purchase_receipt", user.id, correction.receiptId, { order_no: correction.orderNo, from: correction.from, to: correction.to, source, reason: reason?.trim() || null });
  }

  async transition(id: string, target: string, reason: string | undefined, user: CurrentUser) {
    const initial = await this.prisma.incomingInspection.findFirst({ where: { id, deletedAt: null }, include: { rawMaterialInbounds: { where: { deletedAt: null } } } });
    if (!initial) throw new NotFoundException({ code: "INCOMING_INSPECTION_NOT_FOUND", message: "来料质检记录不存在", details: [] });
    this.assertTransitionAllowed(initial, target, reason);
    const result = this.inbounds
      ? await this.prisma.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT id FROM incoming_inspections WHERE id = ${id}::uuid FOR UPDATE`;
          // TOCTOU 防护：锁内重读最新状态并复核全部流转条件，防止并发回退/退货互相覆盖。
          const current = await tx.incomingInspection.findFirst({ where: { id, deletedAt: null }, include: { rawMaterialInbounds: { where: { deletedAt: null } } } });
          if (!current) throw new NotFoundException({ code: "INCOMING_INSPECTION_NOT_FOUND", message: "来料质检记录不存在", details: [] });
          this.assertTransitionAllowed(current, target, reason);
          const updated = await tx.incomingInspection.update({ where: { id }, data: { status: target, remark: reason?.trim() ? `${current.remark ?? ""}\n${reason.trim()}` : current.remark, ...this.audit.update(user) } });
          // 入库草稿由仓库接收入库通知时创建。
          return updated;
        })
      : (async () => {
          // 无入库服务注入的降级路径（仅测试桩使用）：同样锁内重读并复核，避免复刻 TOCTOU。
          const current = await this.prisma.incomingInspection.findFirst({ where: { id, deletedAt: null }, include: { rawMaterialInbounds: { where: { deletedAt: null } } } });
          if (!current) throw new NotFoundException({ code: "INCOMING_INSPECTION_NOT_FOUND", message: "来料质检记录不存在", details: [] });
          this.assertTransitionAllowed(current, target, reason);
          return this.prisma.incomingInspection.update({ where: { id }, data: { status: target, remark: reason?.trim() ? `${current.remark ?? ""}\n${reason.trim()}` : current.remark, ...this.audit.update(user) } });
        })();
    await this.audit.record("incoming_inspection.transition", "incoming_inspection", user.id, id, { from: initial.status, to: target, reason: reason ?? null });
    return result;
  }

  /** 锁外快速失败与锁内复核共用：状态流转白名单、数量与原因门禁、下游事实拦截。 */
  private assertTransitionAllowed(current: { status: string; inspectedQuantity: Prisma.Decimal | string | null; rawMaterialInbounds: Array<{ id: string }> }, target: string, reason: string | undefined) {
    const completedStatuses = ["accepted", "conditionally_accepted", "partially_accepted", "rejected", "completed"];
    const allowed = (current.status === "pending" && target === "inspecting") || (current.status === "inspecting" && target === "completed") || (completedStatuses.includes(current.status) && ["pending", "cancelled"].includes(target));
    if (!allowed) throw new UnprocessableEntityException({ code: "INVALID_INSPECTION_STATE", message: "来料质检状态不可流转", details: [{ from: current.status, to: target }] });
    if (current.status === "inspecting" && target === "completed" && new Prisma.Decimal(current.inspectedQuantity ?? 0).isZero()) throw new UnprocessableEntityException({ code: "INSPECTION_QUANTITY_REQUIRED", message: "完成质检前必须登记检验数量", details: [] });
    if (completedStatuses.includes(current.status) && !reason?.trim()) throw new UnprocessableEntityException({ code: "INSPECTION_REVERSAL_REASON_REQUIRED", message: "质检回退必须填写原因", details: [] });
    if (completedStatuses.includes(current.status) && current.rawMaterialInbounds.length) throw new UnprocessableEntityException({ code: "INSPECTION_DOWNSTREAM_EXISTS", message: "已有原料入库事实的质检批次不可直接回退", details: [] });
  }

  /** 整批退货：锁定质检行，禁止已有入库事实或已过账应付的批次退货；未过账应付一并作废。 */
  async returnToSupplier(id: string, reason: string, user: CurrentUser) {
    if (!reason?.trim()) throw new UnprocessableEntityException({ code: "INSPECTION_RETURN_REASON_REQUIRED", message: "来料退货必须填写原因", details: [] });
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM incoming_inspections WHERE id = ${id}::uuid FOR UPDATE`;
      const current = await tx.incomingInspection.findFirst({ where: { id, deletedAt: null }, include: { rawMaterialInbounds: { where: { deletedAt: null }, select: { id: true } }, purchaseReceipt: { include: { payableSources: { where: { status: { not: "voided" } }, include: { supplierPayableEntry: true } } } } } });
      if (!current) throw new NotFoundException({ code: "INCOMING_INSPECTION_NOT_FOUND", message: "来料质检记录不存在", details: [] });
      if (current.status === "cancelled") throw new UnprocessableEntityException({ code: "INSPECTION_ALREADY_RETURNED", message: "该质检批次已整批退货，无需重复操作", details: [] });
      if (current.rawMaterialInbounds.length) throw new UnprocessableEntityException({ code: "INSPECTION_DOWNSTREAM_EXISTS", message: "已有原料入库事实的质检批次不能退货", details: [] });
      if (current.purchaseReceipt.payableSources.some((source) => source.status === "posted")) throw new UnprocessableEntityException({ code: "PAYABLE_SOURCE_POSTED", message: "应付来源已过账，不能整批退货", details: [] });
        if (current.purchaseReceipt.payableSources.some((source) => source.supplierPayableEntry && !["reversed", "voided"].includes(source.supplierPayableEntry.status))) throw new UnprocessableEntityException({ code: "PAYABLE_ENTRY_EXISTS", message: "应付条目已生成，不能整批退货", details: [] });
      await tx.payableSource.updateMany({ where: { purchaseReceiptId: current.purchaseReceiptId, status: { not: "voided" } }, data: { status: "voided", ...this.audit.update(user) } });
      return tx.incomingInspection.update({ where: { id }, data: { status: "cancelled", remark: `${current.remark ?? ""}${current.remark ? "\n" : ""}整批退货：${reason.trim()}`, ...this.audit.update(user) } });
    });
    await this.audit.record("incoming_inspection.return", "incoming_inspection", user.id, id, { order_no: result.orderNo, reason: reason.trim() });
    return result;
  }
}
