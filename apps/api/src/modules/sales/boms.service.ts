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
    const bom = await this.prisma.bom.findFirst({ where: { id, deletedAt: null }, include: { salesOrder: true, salesOrderVersion: true, items: { where: { deletedAt: null }, orderBy: { createdAt: "asc" } } } });
    if (!bom) throw new NotFoundException({ code: "BOM_NOT_FOUND", message: "BOM 不存在", details: [] });
    return bom;
  }

  async createFromSalesOrder(salesOrderId: string, input: { extension_data?: Record<string, unknown>; form_definition_id?: string }, user: CurrentUser) {
    const order = await this.prisma.salesOrder.findFirst({ where: { id: salesOrderId, deletedAt: null }, include: { versions: { orderBy: { version: "desc" }, take: 1 }, boms: { where: { deletedAt: null }, orderBy: { version: "desc" }, take: 1 } } });
    if (!order) throw new NotFoundException({ code: "SALES_ORDER_NOT_FOUND", message: "销售单不存在", details: [] });
    if (order.status !== "confirmed") throw new UnprocessableEntityException({ code: "SALES_ORDER_NOT_CONFIRMED", message: "只有已确认销售单可以创建 BOM", details: [{ status: order.status }] });
    const sourceVersion = order.versions[0];
    if (!sourceVersion) throw new UnprocessableEntityException({ code: "SALES_ORDER_VERSION_MISSING", message: "销售单版本不存在", details: [] });
    if (order.boms[0]) throw new ConflictException({ code: "BOM_ALREADY_EXISTS", message: "该销售单已经存在 BOM 表", details: [{ bom_id: order.boms[0].id }] });
    const version = 1;
    try {
      if (input.form_definition_id) {
        const form = await this.prisma.formDefinition.findFirst({ where: { id: input.form_definition_id, status: "published", deletedAt: null } });
        if (!form) throw new UnprocessableEntityException({ code: "FORM_DEFINITION_NOT_AVAILABLE", message: "表单定义不存在或未发布", details: [] });
      }
      const bom = await this.prisma.bom.create({ data: { orderNo: order.orderNo, salesOrderId: order.id, salesOrderVersionId: sourceVersion.id, formDefinitionId: input.form_definition_id, version, status: "draft", extensionData: (input.extension_data ?? {}) as Prisma.InputJsonValue, ...this.audit.create(user) } });
      await this.audit.record("bom.create", "bom", user.id, bom.id, { order_no: order.orderNo, sales_order_version: sourceVersion.version, bom_version: version });
      return this.get(bom.id);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "P2002") throw new ConflictException({ code: "BOM_ALREADY_EXISTS", message: "该销售单已经存在 BOM 表", details: [] });
      throw error;
    }
  }

  async update(id: string, extensionData: Record<string, unknown>, user: CurrentUser) {
    const bom = await this.get(id);
    const updated = await this.prisma.bom.update({ where: { id }, data: { extensionData: extensionData as Prisma.InputJsonValue, ...this.audit.update(user) } });
    await this.audit.record("bom.update", "bom", user.id, id, { order_no: bom.orderNo, version: bom.version });
    return updated;
  }

  async replaceItems(id: string, items: Array<{ material_id: string; material_name?: string; model?: string; color?: string; material_snapshot: Record<string, unknown>; required_quantity: string; unit: string; loss_quantity?: string; loss_rate?: string; extension_data?: Record<string, unknown> }>, user: CurrentUser) {
    const bom = await this.get(id);
    if (items.some((item) => !item.material_id || !item.unit || !(item.material_name ?? String(item.material_snapshot.name ?? "")).trim() || !this.isPositiveDecimal(item.required_quantity) || (item.loss_quantity !== undefined && !this.isNonNegativeDecimal(item.loss_quantity)) || (item.loss_rate !== undefined && !this.isNonNegativeDecimal(item.loss_rate)))) {
      throw new UnprocessableEntityException({ code: "INVALID_BOM_ITEM", message: "BOM 明细的物料、数量或单位不合法", details: [] });
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.bomItem.updateMany({ where: { bomId: id, deletedAt: null }, data: { deletedAt: new Date(), deletedBy: user.id, updatedBy: user.id } });
      if (items.length) await tx.bomItem.createMany({ data: items.map((item) => ({ bomId: id, materialId: item.material_id, materialName: item.material_name ?? String(item.material_snapshot.name ?? ""), model: item.model, color: item.color, materialSnapshot: item.material_snapshot as Prisma.InputJsonValue, requiredQuantity: item.required_quantity, unit: item.unit, lossQuantity: item.loss_quantity, lossRate: item.loss_rate, extensionData: (item.extension_data ?? {}) as Prisma.InputJsonValue, ...this.audit.create(user) })) });
    });
    await this.audit.record("bom.items.replace", "bom", user.id, id, { order_no: bom.orderNo, version: bom.version, item_count: items.length });
    return this.get(id);
  }

  private isPositiveDecimal(value: string) { return /^(?:0|[1-9]\d*)(?:\.\d{1,4})?$/.test(value) && Number(value) > 0; }
  private isNonNegativeDecimal(value: string) { return /^(?:0|[1-9]\d*)(?:\.\d{1,4})?$/.test(value) && Number(value) >= 0; }
}
