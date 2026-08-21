import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { AuditService } from "../../platform/audit/audit.service";
import type { CurrentUser } from "../../platform/auth/auth.service";
import { PrismaService } from "../../platform/database/prisma.service";

type CustomerInput = { customer_code: string; name: string; country_region?: string; address?: string; payment_terms?: string; currency?: string; remark?: string };
type ContactInput = { name: string; position?: string; phone?: string; email?: string; is_default?: boolean; remark?: string; is_active?: boolean };
type ContactUpdateInput = Partial<ContactInput>;

@Injectable()
export class CustomersService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  async list(page: number, pageSize: number, search?: string) {
    const where = { deletedAt: null, ...(search ? { OR: [{ name: { contains: search, mode: "insensitive" as const } }, { customerCode: { contains: search, mode: "insensitive" as const } }] } : {}) };
    const [data, total] = await this.prisma.$transaction([this.prisma.customer.findMany({ where, orderBy: { updatedAt: "desc" }, skip: (page - 1) * pageSize, take: pageSize, include: { contacts: { where: { deletedAt: null }, orderBy: [{ isDefault: "desc" }, { name: "asc" }] } } }), this.prisma.customer.count({ where })]);
    return { data, total };
  }

  async get(id: string) {
    return this.prisma.customer.findFirst({ where: { id, deletedAt: null }, include: { contacts: { where: { deletedAt: null }, orderBy: [{ isDefault: "desc" }, { name: "asc" }] } } }).then((customer) => {
      if (!customer) throw new NotFoundException({ code: "CUSTOMER_NOT_FOUND", message: "客户不存在", details: [] });
      return customer;
    });
  }

  async create(input: CustomerInput, user: CurrentUser) {
    try {
      const customer = await this.prisma.customer.create({ data: { customerCode: input.customer_code, name: input.name, countryRegion: input.country_region, address: input.address, paymentTerms: input.payment_terms, currency: input.currency, remark: input.remark, ...this.audit.create(user) } });
      await this.audit.record("customer.create", "customer", user.id, customer.id, { customer_code: customer.customerCode, name: customer.name });
      return customer;
    } catch (error) { this.handleUnique(error); throw error; }
  }

  async update(id: string, input: Partial<CustomerInput>, user: CurrentUser) {
    await this.get(id);
    try {
      const customer = await this.prisma.customer.update({ where: { id }, data: { ...(input.customer_code === undefined ? {} : { customerCode: input.customer_code }), ...(input.name === undefined ? {} : { name: input.name }), ...(input.country_region === undefined ? {} : { countryRegion: input.country_region }), ...(input.address === undefined ? {} : { address: input.address }), ...(input.payment_terms === undefined ? {} : { paymentTerms: input.payment_terms }), ...(input.currency === undefined ? {} : { currency: input.currency }), ...(input.remark === undefined ? {} : { remark: input.remark }), ...this.audit.update(user) } });
      await this.audit.record("customer.update", "customer", user.id, id, { fields: Object.keys(input) });
      return customer;
    } catch (error) { this.handleUnique(error); throw error; }
  }

  async setActive(id: string, isActive: boolean, user: CurrentUser) {
    await this.get(id);
    const customer = await this.prisma.customer.update({ where: { id }, data: { isActive, ...this.audit.update(user) } });
    await this.audit.record(isActive ? "customer.activate" : "customer.deactivate", "customer", user.id, id);
    return customer;
  }

  async delete(id: string, user: CurrentUser) {
    await this.get(id);
    const customer = await this.prisma.customer.update({ where: { id }, data: this.audit.softDelete(user) });
    await this.audit.record("customer.delete", "customer", user.id, id);
    return customer;
  }

  async createContact(customerId: string, input: ContactInput, user: CurrentUser) {
    await this.get(customerId);
    const contact = await this.prisma.$transaction(async (tx) => {
      if (input.is_default) await tx.customerContact.updateMany({ where: { customerId, deletedAt: null }, data: { isDefault: false, updatedBy: user.id } });
      return tx.customerContact.create({ data: { customerId, name: input.name, position: input.position, phone: input.phone, email: input.email, isDefault: input.is_default ?? false, isActive: input.is_active ?? true, remark: input.remark, ...this.audit.create(user) } });
    });
    await this.audit.record("customer_contact.create", "customer_contact", user.id, contact.id, { customer_id: customerId });
    return contact;
  }

  async updateContact(customerId: string, contactId: string, input: ContactUpdateInput, user: CurrentUser) {
    await this.get(customerId);
    const contact = await this.requireContact(customerId, contactId);
    const updated = await this.prisma.$transaction(async (tx) => {
      if (input.is_default) await tx.customerContact.updateMany({ where: { customerId, deletedAt: null }, data: { isDefault: false, updatedBy: user.id } });
      return tx.customerContact.update({ where: { id: contact.id }, data: { ...(input.name === undefined ? {} : { name: input.name }), ...(input.position === undefined ? {} : { position: input.position }), ...(input.phone === undefined ? {} : { phone: input.phone }), ...(input.email === undefined ? {} : { email: input.email }), ...(input.is_default === undefined ? {} : { isDefault: input.is_default }), ...(input.is_active === undefined ? {} : { isActive: input.is_active }), ...(input.remark === undefined ? {} : { remark: input.remark }), ...this.audit.update(user) } });
    });
    await this.audit.record("customer_contact.update", "customer_contact", user.id, contactId, { fields: Object.keys(input) });
    return updated;
  }

  async deleteContact(customerId: string, contactId: string, user: CurrentUser) {
    await this.get(customerId);
    await this.requireContact(customerId, contactId);
    const contact = await this.prisma.customerContact.update({ where: { id: contactId }, data: this.audit.softDelete(user) });
    await this.audit.record("customer_contact.delete", "customer_contact", user.id, contactId);
    return contact;
  }

  private async requireContact(customerId: string, id: string) { const contact = await this.prisma.customerContact.findFirst({ where: { id, customerId, deletedAt: null } }); if (!contact) throw new NotFoundException({ code: "CUSTOMER_CONTACT_NOT_FOUND", message: "客户联系人不存在", details: [] }); return contact; }
  private handleUnique(error: unknown) { if (error && typeof error === "object" && "code" in error && error.code === "P2002") throw new ConflictException({ code: "CUSTOMER_CONFLICT", message: "客户名称或客户代码已存在", details: [] }); }
}
