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
          // 「该质检单已有通知就原样返回」的重放语义：这里不过滤 status。
          // 全仓没有把通知置为 cancelled 的路径（controller 只有 list/get/create/acknowledge），
          // 而且 DB 上有部分唯一索引 `raw_material_inbound_notices(incoming_inspection_id) WHERE deleted_at IS NULL`：
          // 将来若要支持「取消后重新通知」，只能软删旧通知（deletedAt 过滤已足够），
          // 仅按 status 过滤反而会让重建撞唯一键 → 409。
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
          // notifiedAt 必须在这里写入：仓库待入库通知要按通知时间排序和展示，
          // 之前只在 receive 时记录 receiveAt，通知时间一直是空。
          notifiedAt: new Date(),
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
      if (!["pending", "acknowledged", "processing"].includes(current.status)) throw new ConflictException({ code: "INBOUND_NOTICE_NOT_ACKNOWLEDGEABLE", message: "当前入库通知不可接收", details: [{ status: current.status }] });

      // 先确保有可入库的草稿，再改通知状态：
      // 早期实现是“状态一改就返回”，一旦当时没建成草稿（质检未就绪 / 通知曾被重复接收），
      // 通知会永久停在 acknowledged 且没有草稿，之后再点接收什么都不做 —— 仓储情况永远不更新。
      const draft = await this.inbounds.createDraftForInspection(tx, current.incomingInspectionId, user);
      if (draft) await tx.rawMaterialInbound.update({ where: { id: draft.id }, data: { inboundNoticeId: current.id } });
      const linked = draft ?? await tx.rawMaterialInbound.findFirst({ where: { incomingInspectionId: current.incomingInspectionId, deletedAt: null }, select: { id: true } });
      if (!linked) throw new UnprocessableEntityException({ code: "INBOUND_NOTICE_NOT_RECEIVABLE", message: "该通知对应批次当前没有可入库的草稿：请先完成来料质检，或核对该批次是否已全部入库", details: [{ inspection_id: current.incomingInspectionId }] });

      // 已接收过的通知：本次只做“补建并关联草稿”，状态保持不变（幂等 + 自愈）。
      if (current.status !== "pending") return current;

      const acknowledged = await tx.rawMaterialInboundNotice.update({ where: { id }, data: { status: "acknowledged", receivedBy: user.id, receivedAt: new Date(), updatedBy: user.id } });
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
