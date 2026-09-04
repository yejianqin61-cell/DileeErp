import { Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { AuditService } from "../../platform/audit/audit.service";
import type { CurrentUser } from "../../platform/auth/auth.service";
import { PrismaService } from "../../platform/database/prisma.service";

@Injectable()
export class IncomingInspectionsService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}
  async list(orderNo?: string) { const rows = await this.prisma.incomingInspection.findMany({ where: { deletedAt: null, ...(orderNo ? { orderNo } : {}) }, include: { purchaseReceipt: true }, orderBy: { createdAt: "asc" } }); return rows.map((row) => ({ ...row, batchSequence: Number((row.purchaseReceipt.extensionData as { batch_sequence?: number } | null)?.batch_sequence ?? (row.extensionData as { batch_sequence?: number } | null)?.batch_sequence ?? 1) })).reverse(); }
  async create(input: { purchase_receipt_id: string; inspected_quantity: string; accepted_quantity: string; conditional_quantity: string; rejected_quantity: string; extension_data?: Record<string, unknown>; remark?: string }, user: CurrentUser) {
    const values = [input.inspected_quantity, input.accepted_quantity, input.conditional_quantity, input.rejected_quantity].map((value) => { try { const decimal = new Prisma.Decimal(value); if (decimal.isNegative()) throw new Error(); return decimal; } catch { throw new UnprocessableEntityException({ code: "INSPECTION_QUANTITY_MISMATCH", message: "检验数量分流不合法", details: [] }); } });
    if (!values[1].plus(values[2]).plus(values[3]).eq(values[0])) throw new UnprocessableEntityException({ code: "INSPECTION_QUANTITY_MISMATCH", message: "检验数量分流不合法", details: [] });
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM purchase_receipts WHERE id = ${input.purchase_receipt_id}::uuid FOR UPDATE`;
      const receipt = await tx.purchaseReceipt.findFirst({ where: { id: input.purchase_receipt_id, deletedAt: null }, include: { inspections: { where: { deletedAt: null }, include: { rawMaterialInbounds: { where: { deletedAt: null }, select: { id: true } } } } } });
      if (!receipt) throw new NotFoundException({ code: "RECEIPT_NOT_FOUND", message: "到货记录不存在", details: [] });
      const inspectedBefore = receipt.inspections.reduce((sum, inspection) => sum.plus(inspection.inspectedQuantity), new Prisma.Decimal(0));
      if (values[0].plus(inspectedBefore).gt(receipt.quantity)) throw new UnprocessableEntityException({ code: "INSPECTION_QUANTITY_MISMATCH", message: "累计检验数量不能超过到货数量", details: [] });
      const existing = receipt.inspections[0];
      if (existing?.rawMaterialInbounds?.length) throw new UnprocessableEntityException({ code: "INSPECTION_DOWNSTREAM_EXISTS", message: "已有原料入库事实的质检批次不可修改", details: [] });
      const inspected = (existing?.inspectedQuantity ?? new Prisma.Decimal(0)).plus(values[0]);
      const accepted = (existing?.acceptedQuantity ?? new Prisma.Decimal(0)).plus(values[1]);
      const conditional = (existing?.conditionalQuantity ?? new Prisma.Decimal(0)).plus(values[2]);
      const rejected = (existing?.rejectedQuantity ?? new Prisma.Decimal(0)).plus(values[3]);
      const status = rejected.eq(inspected) ? "rejected" : accepted.plus(conditional).eq(inspected) ? (conditional.gt(0) ? "conditionally_accepted" : "accepted") : "partially_accepted";
      const batchSequence = Number((receipt.extensionData as { batch_sequence?: number } | null)?.batch_sequence ?? 1);
      return existing
        ? tx.incomingInspection.update({ where: { id: existing.id }, data: { inspectedQuantity: inspected, acceptedQuantity: accepted, conditionalQuantity: conditional, rejectedQuantity: rejected, status, extensionData: { ...(existing.extensionData as Record<string, unknown>), ...(input.extension_data ?? {}), batch_sequence: batchSequence } as Prisma.InputJsonValue, remark: input.remark ?? existing.remark, ...this.audit.update(user) } })
        : tx.incomingInspection.create({ data: { purchaseReceiptId: receipt.id, orderNo: receipt.orderNo, inspectedQuantity: values[0], acceptedQuantity: values[1], conditionalQuantity: values[2], rejectedQuantity: values[3], status, extensionData: { ...(input.extension_data ?? {}), batch_sequence: batchSequence } as Prisma.InputJsonValue, remark: input.remark, ...this.audit.create(user) } });
    });
    await this.audit.record("incoming_inspection.create", "incoming_inspection", user.id, result.id, { order_no: result.orderNo, purchase_receipt_id: input.purchase_receipt_id, status: result.status });
    return result;
  }

  async transition(id: string, target: string, reason: string | undefined, user: CurrentUser) {
    const current = await this.prisma.incomingInspection.findFirst({ where: { id, deletedAt: null }, include: { rawMaterialInbounds: { where: { deletedAt: null } } } });
    if (!current) throw new NotFoundException({ code: "INCOMING_INSPECTION_NOT_FOUND", message: "来料质检记录不存在", details: [] });
    const completedStatuses = ["accepted", "conditionally_accepted", "partially_accepted", "rejected", "completed"];
    const allowed = (current.status === "pending" && target === "inspecting") || (current.status === "inspecting" && target === "completed") || (completedStatuses.includes(current.status) && ["pending", "cancelled"].includes(target));
    if (!allowed) throw new UnprocessableEntityException({ code: "INVALID_INSPECTION_STATE", message: "来料质检状态不可流转", details: [{ from: current.status, to: target }] });
    if (completedStatuses.includes(current.status) && !reason?.trim()) throw new UnprocessableEntityException({ code: "INSPECTION_REVERSAL_REASON_REQUIRED", message: "质检回退必须填写原因", details: [] });
    if (completedStatuses.includes(current.status) && current.rawMaterialInbounds.length) throw new UnprocessableEntityException({ code: "INSPECTION_DOWNSTREAM_EXISTS", message: "已有原料入库事实的质检批次不可直接回退", details: [] });
    const result = await this.prisma.incomingInspection.update({ where: { id }, data: { status: target, remark: reason?.trim() ? `${current.remark ?? ""}\n${reason.trim()}` : current.remark, ...this.audit.update(user) } });
    await this.audit.record("incoming_inspection.transition", "incoming_inspection", user.id, id, { from: current.status, to: target, reason: reason ?? null });
    return result;
  }
}
