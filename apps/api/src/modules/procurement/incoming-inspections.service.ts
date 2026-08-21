import { Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { AuditService } from "../../platform/audit/audit.service";
import type { CurrentUser } from "../../platform/auth/auth.service";
import { PrismaService } from "../../platform/database/prisma.service";

@Injectable()
export class IncomingInspectionsService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}
  async list(orderNo?: string) { return this.prisma.incomingInspection.findMany({ where: { deletedAt: null, ...(orderNo ? { orderNo } : {}) }, include: { purchaseReceipt: true }, orderBy: { createdAt: "desc" } }); }
  async create(input: { purchase_receipt_id: string; inspected_quantity: string; accepted_quantity: string; conditional_quantity: string; rejected_quantity: string; extension_data?: Record<string, unknown>; remark?: string }, user: CurrentUser) {
    const receipt = await this.prisma.purchaseReceipt.findFirst({ where: { id: input.purchase_receipt_id, deletedAt: null }, include: { inspections: { where: { deletedAt: null } } } });
    if (!receipt) throw new NotFoundException({ code: "RECEIPT_NOT_FOUND", message: "到货记录不存在", details: [] });
    const values = [input.inspected_quantity, input.accepted_quantity, input.conditional_quantity, input.rejected_quantity].map(Number);
    const inspectedBefore = receipt.inspections.reduce((sum, inspection) => sum + Number(inspection.inspectedQuantity), 0);
    if (values.some((value) => !Number.isFinite(value) || value < 0) || values[1] + values[2] + values[3] !== values[0] || values[0] + inspectedBefore > Number(receipt.quantity)) throw new UnprocessableEntityException({ code: "INSPECTION_QUANTITY_MISMATCH", message: "检验数量分流不合法", details: [] });
    const status = values[3] === 0 && values[2] === 0 ? "accepted" : values[1] === 0 && values[2] === 0 ? "rejected" : values[2] > 0 ? "conditionally_accepted" : "partially_accepted";
    const result = await this.prisma.incomingInspection.create({ data: { purchaseReceiptId: receipt.id, orderNo: receipt.orderNo, inspectedQuantity: input.inspected_quantity, acceptedQuantity: input.accepted_quantity, conditionalQuantity: input.conditional_quantity, rejectedQuantity: input.rejected_quantity, status, extensionData: (input.extension_data ?? {}) as Prisma.InputJsonValue, remark: input.remark, ...this.audit.create(user) } });
    await this.audit.record("incoming_inspection.create", "incoming_inspection", user.id, result.id, { order_no: receipt.orderNo, purchase_receipt_id: receipt.id, status });
    return result;
  }
}
