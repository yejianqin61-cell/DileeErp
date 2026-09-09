import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { AuditService } from "../../platform/audit/audit.service";
import type { CurrentUser } from "../../platform/auth/auth.service";
import { PrismaService } from "../../platform/database/prisma.service";
import { RawMaterialInboundsService } from "./raw-material-inbounds.service";

const READY_STATUSES = ["accepted", "conditionally_accepted", "partially_accepted", "completed"];

@Injectable()
export class RawMaterialInboundNoticesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly inbounds: RawMaterialInboundsService
  ) {}

  async list(status?: string, orderNo?: string) {
    return this.prisma.rawMaterialInboundNotice.findMany({
      where: { deletedAt: null, ...(status ? { status } : {}), ...(orderNo ? { orderNo } : {}) },
      include: this.include(),
      orderBy: [{ status: "asc" }, { notifiedAt: "desc" }]
    });
  }

  async get(id: string) {
    const notice = await this.prisma.rawMaterialInboundNotice.findFirst({ where: { id, deletedAt: null }, include: this.include() });
    if (!notice) throw new NotFoundException({ code: "INBOUND_NOTICE_NOT_FOUND", message: "入库通知不存在", details: [] });
    return notice;
  }

  async createFromInspection(inspectionId: string, remark: string | undefined, user: CurrentUser) {
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM incoming_inspections WHERE id = ${inspectionId}::uuid FOR UPDATE`;
      const inspection = await tx.incomingInspection.findFirst({
        where: { id: inspectionId, deletedAt: null },
        include: {
          purchaseReceipt: { include: { purchaseOrder: true, purchaseOrderItem: { include: { material: true } } } },
          rawMaterialInbounds: { where: { deletedAt: null }, select: { quantity: true, status: true } },
          inboundNotices: { where: { deletedAt: null }, orderBy: { createdAt: "desc" }, take: 1 }
        }
      });
      if (!inspection) throw new NotFoundException({ code: "INCOMING_INSPECTION_NOT_FOUND", message: "来料质检记录不存在", details: [] });
      if (inspection.inboundNotices[0]) return inspection.inboundNotices[0];
      if (!READY_STATUSES.includes(inspection.status) || inspection.qcResult === "rejected") {
        throw new UnprocessableEntityException({ code: "INBOUND_NOTICE_QC_NOT_READY", message: "来料质检未完成或该批次不可入库", details: [{ status: inspection.status }] });
      }
      if (inspection.purchaseReceipt.purchaseOrderItem.material.materialType !== "raw_material") {
        throw new UnprocessableEntityException({ code: "INBOUND_FINISHED_PRODUCT_FORBIDDEN", message: "原料入库通知只能针对原料物料", details: [] });
      }
      const accepted = new Prisma.Decimal(inspection.acceptedQuantity).plus(inspection.conditionalQuantity);
      const used = inspection.rawMaterialInbounds.filter((row) => row.status !== "reversed").reduce((sum, row) => sum.plus(row.quantity), new Prisma.Decimal(0));
      if (accepted.lte(used)) throw new UnprocessableEntityException({ code: "INBOUND_NOTICE_NO_REMAINING_QUANTITY", message: "该质检批次没有剩余可入库数量", details: [] });
      const notice = await tx.rawMaterialInboundNotice.create({
        data: {
          noticeNo: `RIN-${randomUUID().slice(0, 12).toUpperCase()}`,
          orderNo: inspection.orderNo,
          purchaseOrderId: inspection.purchaseReceipt.purchaseOrderId,
          purchaseOrderItemId: inspection.purchaseReceipt.purchaseOrderItemId,
          purchaseReceiptId: inspection.purchaseReceiptId,
          incomingInspectionId: inspection.id,
          materialId: inspection.purchaseReceipt.purchaseOrderItem.materialId,
          unitId: inspection.purchaseReceipt.purchaseOrderItem.unitId,
          notifiedQuantity: accepted.minus(used),
          status: "pending",
          notifiedBy: user.id,
          remark: remark?.trim() || undefined,
          createdBy: user.id,
          updatedBy: user.id
        }
      });
      return notice;
    });
    await this.audit.record("raw_material_inbound_notice.create", "raw_material_inbound_notice", user.id, result.id, { order_no: result.orderNo, incoming_inspection_id: inspectionId });
    return this.get(result.id);
  }

  async acknowledge(id: string, user: CurrentUser) {
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM raw_material_inbound_notices WHERE id = ${id}::uuid FOR UPDATE`;
      const current = await tx.rawMaterialInboundNotice.findFirst({ where: { id, deletedAt: null } });
      if (!current) throw new NotFoundException({ code: "INBOUND_NOTICE_NOT_FOUND", message: "入库通知不存在", details: [] });
      if (current.status === "acknowledged" || current.status === "processing") return current;
      if (current.status !== "pending") throw new ConflictException({ code: "INBOUND_NOTICE_NOT_ACKNOWLEDGEABLE", message: "当前入库通知不可接收", details: [{ status: current.status }] });
      const acknowledged = await tx.rawMaterialInboundNotice.update({ where: { id }, data: { status: "acknowledged", receivedBy: user.id, receivedAt: new Date(), updatedBy: user.id } });
      const draft = await this.inbounds.createDraftForInspection(tx, current.incomingInspectionId, user);
      if (draft) await tx.rawMaterialInbound.update({ where: { id: draft.id }, data: { inboundNoticeId: current.id } });
      return acknowledged;
    });
    await this.audit.record("raw_material_inbound_notice.acknowledge", "raw_material_inbound_notice", user.id, id, { status: result.status });
    return this.get(result.id);
  }

  private include() {
    return {
      purchaseOrder: { select: { purchaseOrderNo: true, currency: true } },
      purchaseOrderItem: { include: { material: true, unit: true, supplier: true } },
      purchaseReceipt: { select: { receiptNo: true, referenceNo: true, receivedDate: true, quantity: true, extensionData: true, remark: true } },
      incomingInspection: { select: { status: true, qcResult: true, inspectedQuantity: true, acceptedQuantity: true, conditionalQuantity: true, rejectedQuantity: true } },
      inbounds: { where: { deletedAt: null }, orderBy: { createdAt: "asc" } }
    } as const;
  }
}
