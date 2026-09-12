import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { AuditService } from "../../platform/audit/audit.service";
import type { CurrentUser } from "../../platform/auth/auth.service";
import { dailyCodePrefix, nextSequenceCode } from "../../platform/database/daily-sequence-code";
import { isUniqueConstraintViolationOn } from "../../platform/database/prisma-error";
import { PrismaService } from "../../platform/database/prisma.service";

// customer_code 可空：code_mode=auto 时由服务端生成（与物料/供应商一致）。
type CustomerInput = { customer_code?: string; name: string; country_region?: string; address?: string; payment_terms?: string; currency?: string; remark?: string };
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

  async create(input: CustomerInput & { code_mode?: string }, user: CurrentUser) {
    // 与物料/供应商一致：客户编码支持“自动生成 / 手动填写”，由调用方选择。
    const auto = input.code_mode === "auto";
    const manualCode = input.customer_code?.trim();
    if (!auto && !manualCode) throw new UnprocessableEntityException({ code: "CUSTOMER_CODE_REQUIRED", message: "手动编码模式必须填写客户编码", details: [] });
    // 自动编码是「读当天最大值 + 1 再写入」，两次并发可能算出同一个号。
    // 只在撞到**客户编码**唯一索引时重算重试（客户名称也是唯一的，撞名称重试没有意义）。
    for (let attempt = 1; ; attempt += 1) {
      const code = auto ? await this.nextCustomerCode() : (manualCode as string);
      try {
        const customer = await this.prisma.customer.create({ data: { customerCode: code, name: input.name, countryRegion: input.country_region, address: input.address, paymentTerms: input.payment_terms, currency: input.currency, remark: input.remark, ...this.audit.create(user) } });
        await this.audit.record("customer.create", "customer", user.id, customer.id, { customer_code: customer.customerCode, name: customer.name });
        return customer;
      } catch (error) {
        if (auto && attempt < 3 && isUniqueConstraintViolationOn(error, "customer_code")) continue;
        this.handleUnique(error);
        throw error;
      }
    }
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

  /** 自动编码：CUS-日期-序号（4 位补零），与物料/供应商同一套规则。 */
  private async nextCustomerCode() {
    const prefix = dailyCodePrefix("CUS");
    // 取当天全部同类编码再算数字后缀最大值：单条 orderBy desc 会被手工编码（CUS-…-ABC）带偏。
    const rows = await this.prisma.customer.findMany({ where: { customerCode: { startsWith: prefix } }, select: { customerCode: true } });
    return nextSequenceCode(prefix, rows.map((row) => row.customerCode));
  }
}
