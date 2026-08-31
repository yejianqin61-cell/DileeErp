import { Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { AuditService } from "../../platform/audit/audit.service";
import type { CurrentUser } from "../../platform/auth/auth.service";
import { PrismaService } from "../../platform/database/prisma.service";

@Injectable()
export class IncomingInspectionsService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}
  async list(orderNo?: string) { const rows = await this.prisma.incomingInspection.findMany({ where: { deletedAt: null, ...(orderNo ? { orderNo } : {}) }, include: { purchaseReceipt: true }, orderBy: { createdAt: "asc" } }); const counters = new Map<string, number>(); return rows.map((row) => { const sequence = (counters.get(row.purchaseReceipt.purchaseOrderId) ?? 0) + 1; counters.set(row.purchaseReceipt.purchaseOrderId, sequence); return { ...row, batchSequence: sequence }; }).reverse(); }
  async create(input: { purchase_receipt_id: string; inspected_quantity: string; accepted_quantity: string; conditional_quantity: string; rejected_quantity: string; extension_data?: Record<string, unknown>; remark?: string }, user: CurrentUser) {
    const receipt = await this.prisma.purchaseReceipt.findFirst({ where: { id: input.purchase_receipt_id, deletedAt: null }, include: { inspections: { where: { deletedAt: null } } } });
    if (!receipt) throw new NotFoundException({ code: "RECEIPT_NOT_FOUND", message: "到货记录不存在", details: [] });
    const values = [input.inspected_quantity, input.accepted_quantity, input.conditional_quantity, input.rejected_quantity].map(Number);
    const inspectedBefore = receipt.inspections.reduce((sum, inspection) => sum + Number(inspection.inspectedQuantity), 0);
    if (values.some((value) => !Number.isFinite(value) || value < 0) || values[1] + values[2] + values[3] !== values[0] || values[0] + inspectedBefore > Number(receipt.quantity)) throw new UnprocessableEntityException({ code: "INSPECTION_QUANTITY_MISMATCH", message: "检验数量分流不合法", details: [] });
    const status = values[3] === 0 && values[2] === 0 ? "accepted" : values[1] === 0 && values[2] === 0 ? "rejected" : values[2] > 0 ? "conditionally_accepted" : "partially_accepted";
    const batchSequence = receipt.inspections.length || 1;
    const pending = receipt.inspections.find((inspection) => Number(inspection.inspectedQuantity) === 0 && inspection.status === "pending");
    const result = pending
      ? await this.prisma.incomingInspection.update({ where: { id: pending.id }, data: { inspectedQuantity: input.inspected_quantity, acceptedQuantity: input.accepted_quantity, conditionalQuantity: input.conditional_quantity, rejectedQuantity: input.rejected_quantity, status, extensionData: { ...(pending.extensionData as Record<string, unknown>), ...(input.extension_data ?? {}), batch_sequence: batchSequence } as Prisma.InputJsonValue, remark: input.remark, ...this.audit.update(user) } })
      : await this.prisma.incomingInspection.create({ data: { purchaseReceiptId: receipt.id, orderNo: receipt.orderNo, inspectedQuantity: input.inspected_quantity, acceptedQuantity: input.accepted_quantity, conditionalQuantity: input.conditional_quantity, rejectedQuantity: input.rejected_quantity, status, extensionData: { ...(input.extension_data ?? {}), batch_sequence: batchSequence } as Prisma.InputJsonValue, remark: input.remark, ...this.audit.create(user) } });
    await this.audit.record("incoming_inspection.create", "incoming_inspection", user.id, result.id, { order_no: receipt.orderNo, purchase_receipt_id: receipt.id, status });
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
