import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { AuditService } from "../../platform/audit/audit.service";
import type { CurrentUser } from "../../platform/auth/auth.service";
import { PrismaService } from "../../platform/database/prisma.service";

@Injectable()
export class BomsService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  async list(orderNo?: string) {
    return this.prisma.bom.findMany({ where: { deletedAt: null, ...(orderNo ? { orderNo } : {}) }, orderBy: [{ orderNo: "asc" }, { version: "desc" }], include: { salesOrder: { select: { id: true, orderNo: true, status: true, currentVersion: true } }, salesOrderVersion: { select: { id: true, version: true, createdAt: true } } } });
  }

  async get(id: string) {
    const bom = await this.prisma.bom.findFirst({ where: { id, deletedAt: null }, include: { salesOrder: true, salesOrderVersion: true } });
    if (!bom) throw new NotFoundException({ code: "BOM_NOT_FOUND", message: "BOM 不存在", details: [] });
    return bom;
  }

  async createFromSalesOrder(salesOrderId: string, input: { extension_data?: Record<string, unknown> }, user: CurrentUser) {
    const order = await this.prisma.salesOrder.findFirst({ where: { id: salesOrderId, deletedAt: null }, include: { versions: { orderBy: { version: "desc" }, take: 1 }, boms: { where: { deletedAt: null }, orderBy: { version: "desc" }, take: 1 } } });
    if (!order) throw new NotFoundException({ code: "SALES_ORDER_NOT_FOUND", message: "销售单不存在", details: [] });
    if (order.status !== "confirmed") throw new UnprocessableEntityException({ code: "SALES_ORDER_NOT_CONFIRMED", message: "只有已确认销售单可以创建 BOM", details: [{ status: order.status }] });
    const sourceVersion = order.versions[0];
    if (!sourceVersion) throw new UnprocessableEntityException({ code: "SALES_ORDER_VERSION_MISSING", message: "销售单版本不存在", details: [] });
    const version = (order.boms[0]?.version ?? 0) + 1;
    try {
      const bom = await this.prisma.bom.create({ data: { orderNo: order.orderNo, salesOrderId: order.id, salesOrderVersionId: sourceVersion.id, version, status: "draft", extensionData: (input.extension_data ?? {}) as Prisma.InputJsonValue, ...this.audit.create(user) } });
      await this.audit.record("bom.create", "bom", user.id, bom.id, { order_no: order.orderNo, sales_order_version: sourceVersion.version, bom_version: version });
      return this.get(bom.id);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "P2002") throw new ConflictException({ code: "BOM_VERSION_CONFLICT", message: "BOM 版本已存在，请重试", details: [] });
      throw error;
    }
  }

  async update(id: string, extensionData: Record<string, unknown>, user: CurrentUser) {
    const bom = await this.get(id);
    const updated = await this.prisma.bom.update({ where: { id }, data: { extensionData: extensionData as Prisma.InputJsonValue, ...this.audit.update(user) } });
    await this.audit.record("bom.update", "bom", user.id, id, { order_no: bom.orderNo, version: bom.version });
    return updated;
  }
}
