import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { AuditService } from "../../platform/audit/audit.service";
import type { CurrentUser } from "../../platform/auth/auth.service";
import { PrismaService } from "../../platform/database/prisma.service";

type SalesOrderInput = { order_no: string; customer_id: string; contact_id?: string; customer_po_no?: string; external_contract_no?: string; order_date: string; product_name: string; product_spec?: string; quantity: string; unit: string; delivery_date?: string; currency: string; unit_price?: string; total_amount?: string; tax_rate?: string; extension_data?: Record<string, unknown> };
type SalesOrderUpdate = Partial<Omit<SalesOrderInput, "order_no" | "customer_id">> & { reason?: string };

@Injectable()
export class SalesOrdersService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  async list(page = 1, pageSize = 20, search?: string, status?: string) {
    const where = { deletedAt: null, ...(status ? { status } : {}), ...(search ? { OR: [{ orderNo: { contains: search, mode: "insensitive" as const } }, { productName: { contains: search, mode: "insensitive" as const } }] } : {}) };
    const [data, total] = await this.prisma.$transaction([this.prisma.salesOrder.findMany({ where, orderBy: { updatedAt: "desc" }, skip: (page - 1) * pageSize, take: pageSize, include: { customer: true, contact: true, boms: { where: { deletedAt: null }, select: { id: true, version: true, status: true } } } }), this.prisma.salesOrder.count({ where })]);
    return { data, total };
  }

  async get(id: string) {
    const order = await this.prisma.salesOrder.findFirst({ where: { id, deletedAt: null }, include: { customer: true, contact: true, versions: { orderBy: { version: "desc" } }, boms: { where: { deletedAt: null }, orderBy: { version: "desc" } } } });
    if (!order) throw new NotFoundException({ code: "SALES_ORDER_NOT_FOUND", message: "销售单不存在", details: [] });
    return order;
  }

  async create(input: SalesOrderInput, user: CurrentUser) {
    const refs = await this.resolveReferences(input, user);
    const snapshot = this.snapshot(input, refs.customer, refs.contact);
    try {
      const order = await this.prisma.$transaction(async (tx) => {
        const created = await tx.salesOrder.create({ data: { orderNo: input.order_no, customerId: input.customer_id, contactId: input.contact_id, customerSnapshot: refs.customer as Prisma.InputJsonValue, contactSnapshot: refs.contact as Prisma.InputJsonValue, customerPoNo: input.customer_po_no, externalContractNo: input.external_contract_no, orderDate: new Date(input.order_date), productName: input.product_name, productSpec: input.product_spec, quantity: input.quantity, unit: input.unit, deliveryDate: input.delivery_date ? new Date(input.delivery_date) : undefined, currency: input.currency, unitPrice: input.unit_price, totalAmount: input.total_amount, taxRate: input.tax_rate, extensionData: (input.extension_data ?? {}) as Prisma.InputJsonValue, ...this.audit.create(user) } });
        await tx.salesOrderVersion.create({ data: { salesOrderId: created.id, version: 1, snapshot, ...this.audit.create(user) } });
        return created;
      });
      await this.audit.record("sales_order.create", "sales_order", user.id, order.id, { order_no: order.orderNo });
      return this.get(order.id);
    } catch (error) { this.handleUnique(error); throw error; }
  }

  async update(id: string, input: SalesOrderUpdate, user: CurrentUser) {
    const current = await this.get(id);
    if (current.status === "closed") throw new UnprocessableEntityException({ code: "SALES_ORDER_CLOSED", message: "已关闭销售单不可编辑", details: [] });
    if (current.status === "confirmed" && !input.reason?.trim()) throw new UnprocessableEntityException({ code: "CORRECTION_REASON_REQUIRED", message: "已确认销售单修改必须填写原因", details: [] });
    const coreFields = ["product_name", "product_spec", "quantity", "unit", "currency", "unit_price", "total_amount", "tax_rate"] as const;
    if (current.status === "confirmed" && coreFields.some((field) => input[field] !== undefined)) {
      const [purchaseCount, productionCount] = await Promise.all([
        this.prisma.purchaseOrder.count({ where: { salesOrderId: id, deletedAt: null } }),
        this.prisma.productionOrder.count({ where: { salesOrderId: id, deletedAt: null } }),
      ]);
      if (current.boms.length || purchaseCount || productionCount) throw new UnprocessableEntityException({ code: "SALES_ORDER_CORE_FIELDS_LOCKED", message: "销售单已有 BOM、采购或生产下游事实，核心字段需先回退下游", details: [{ bom_count: current.boms.length, purchase_order_count: purchaseCount, production_order_count: productionCount }] });
    }
    const refs = await this.resolveReferences({ customer_id: current.customerId, contact_id: input.contact_id ?? current.contactId ?? undefined }, user);
    const nextInput = { ...input, customer_id: current.customerId, contact_id: input.contact_id ?? current.contactId ?? undefined, order_no: current.orderNo, order_date: input.order_date ?? current.orderDate.toISOString(), product_name: input.product_name ?? current.productName, quantity: input.quantity ?? current.quantity.toString(), unit: input.unit ?? current.unit, currency: input.currency ?? current.currency, extension_data: input.extension_data ?? (current.extensionData as Record<string, unknown>) };
    const nextVersion = current.currentVersion + 1;
    const snapshot = this.snapshot(nextInput, refs.customer, refs.contact);
    const updated = await this.prisma.$transaction(async (tx) => {
      const data: Prisma.SalesOrderUncheckedUpdateInput = { ...(input.contact_id === undefined ? {} : { contactId: input.contact_id }), ...(input.customer_po_no === undefined ? {} : { customerPoNo: input.customer_po_no }), ...(input.external_contract_no === undefined ? {} : { externalContractNo: input.external_contract_no }), ...(input.order_date === undefined ? {} : { orderDate: new Date(input.order_date) }), ...(input.product_name === undefined ? {} : { productName: input.product_name }), ...(input.product_spec === undefined ? {} : { productSpec: input.product_spec }), ...(input.quantity === undefined ? {} : { quantity: input.quantity }), ...(input.unit === undefined ? {} : { unit: input.unit }), ...(input.delivery_date === undefined ? {} : { deliveryDate: input.delivery_date ? new Date(input.delivery_date) : null }), ...(input.currency === undefined ? {} : { currency: input.currency }), ...(input.unit_price === undefined ? {} : { unitPrice: input.unit_price }), ...(input.total_amount === undefined ? {} : { totalAmount: input.total_amount }), ...(input.tax_rate === undefined ? {} : { taxRate: input.tax_rate }), ...(input.extension_data === undefined ? {} : { extensionData: input.extension_data as Prisma.InputJsonValue }), customerSnapshot: refs.customer as Prisma.InputJsonValue, contactSnapshot: refs.contact as Prisma.InputJsonValue, currentVersion: nextVersion, ...this.audit.update(user) };
      const result = await tx.salesOrder.update({ where: { id }, data });
      await tx.salesOrderVersion.create({ data: { salesOrderId: id, version: nextVersion, snapshot, ...this.audit.create(user) } });
      return result;
    });
    await this.audit.record("sales_order.update", "sales_order", user.id, id, { order_no: current.orderNo, version: nextVersion, reason: input.reason, fields: Object.keys(input).filter((field) => field !== "reason") });
    return { ...(await this.get(updated.id)), impact_warning: current.status === "confirmed" && current.boms.length > 0 ? "销售单已有关联 BOM，请物控复核来源版本" : null };
  }

  async impactPreview(id: string) {
    const order = await this.get(id);
    return { sales_order_id: order.id, order_no: order.orderNo, current_version: order.currentVersion, status: order.status, bom_count: order.boms.length, warning: order.boms.length > 0 ? "已存在 BOM，销售单变更不会自动改写下游事实" : null };
  }

  async confirm(id: string, user: CurrentUser) {
    const order = await this.get(id);
    if (order.status !== "draft") throw new UnprocessableEntityException({ code: "INVALID_STATE_TRANSITION", message: "只有草稿销售单可以确认", details: [{ from: order.status, to: "confirmed" }] });
    const updated = await this.prisma.salesOrder.update({ where: { id }, data: { status: "confirmed", ...this.audit.update(user) } });
    await this.audit.record("sales_order.confirm", "sales_order", user.id, id, { order_no: order.orderNo, from: "draft", to: "confirmed" });
    return updated;
  }

  async revertToDraft(id: string, reason: string, user: CurrentUser) {
    if (!reason?.trim()) throw new UnprocessableEntityException({ code: "CORRECTION_REASON_REQUIRED", message: "销售单回退草稿必须填写原因", details: [] });
    const current = await this.get(id);
    if (current.status !== "confirmed") throw new UnprocessableEntityException({ code: "SALES_ORDER_NOT_REVERTIBLE", message: "仅已确认销售单可以回退草稿", details: [] });
    const [purchaseCount, productionCount] = await Promise.all([
      this.prisma.purchaseOrder.count({ where: { salesOrderId: id, deletedAt: null } }),
      this.prisma.productionOrder.count({ where: { salesOrderId: id, deletedAt: null } }),
    ]);
    if (current.boms.length || purchaseCount || productionCount) throw new UnprocessableEntityException({ code: "SALES_ORDER_DOWNSTREAM_EXISTS", message: "销售单已有 BOM、采购或生产下游事实，不能直接回退", details: [{ bom_count: current.boms.length, purchase_order_count: purchaseCount, production_order_count: productionCount }] });
    const updated = await this.prisma.salesOrder.update({ where: { id }, data: { status: "draft", ...this.audit.update(user) } });
    await this.audit.record("sales_order.revert_to_draft", "sales_order", user.id, id, { order_no: current.orderNo, reason: reason.trim(), from: "confirmed", to: "draft" });
    return updated;
  }

  async close(id: string, user: CurrentUser) {
    const order = await this.get(id);
    if (order.status !== "confirmed") throw new UnprocessableEntityException({ code: "INVALID_STATE_TRANSITION", message: "只有已确认销售单可以关闭", details: [{ from: order.status, to: "closed" }] });
    const updated = await this.prisma.salesOrder.update({ where: { id }, data: { status: "closed", ...this.audit.update(user) } });
    await this.audit.record("sales_order.close", "sales_order", user.id, id, { order_no: order.orderNo, from: "confirmed", to: "closed" });
    return updated;
  }

  private async resolveReferences(input: { customer_id: string; contact_id?: string }, _user: CurrentUser) {
    const customer = await this.prisma.customer.findFirst({ where: { id: input.customer_id, deletedAt: null, isActive: true } });
    if (!customer) throw new NotFoundException({ code: "CUSTOMER_NOT_FOUND", message: "客户不存在或已停用", details: [] });
    let contact: object | null = null;
    if (input.contact_id) {
      contact = await this.prisma.customerContact.findFirst({ where: { id: input.contact_id, customerId: input.customer_id, deletedAt: null, isActive: true } });
      if (!contact) throw new NotFoundException({ code: "CUSTOMER_CONTACT_NOT_FOUND", message: "客户联系人不存在或不属于该客户", details: [] });
    }
    return { customer: this.compact(customer), contact: contact ? this.compact(contact) : null };
  }

  private snapshot(input: Record<string, unknown>, customer: object, contact: object | null) { return this.compact({ order_no: input.order_no, customer, contact, customer_po_no: input.customer_po_no, external_contract_no: input.external_contract_no, order_date: input.order_date, product_name: input.product_name, product_spec: input.product_spec, quantity: input.quantity, unit: input.unit, delivery_date: input.delivery_date, currency: input.currency, unit_price: input.unit_price, total_amount: input.total_amount, tax_rate: input.tax_rate, extension_data: input.extension_data ?? {} }); }
  private compact(value: object) { return JSON.parse(JSON.stringify(value, (_key, item) => item === undefined ? undefined : item)); }
  private handleUnique(error: unknown) { if (error && typeof error === "object" && "code" in error && error.code === "P2002") throw new ConflictException({ code: "ORDER_NO_CONFLICT", message: "订单号已存在", details: [] }); }
}
