import { Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { AuditService } from "../../platform/audit/audit.service";
import type { CurrentUser } from "../../platform/auth/auth.service";
import { PrismaService } from "../../platform/database/prisma.service";
import { ReceivableService } from "./receivable.service";

type PaymentInput = { customer_id: string; order_no?: string; payment_date: string; amount: string; currency: string; payment_method: string; bank_reference?: string; payer_name?: string; attachment?: unknown[]; remark?: string };
type Allocation = { receivable_source_id: string; amount: string };

@Injectable()
export class CustomerPaymentService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly receivable: ReceivableService) {}

  async list(orderNo?: string, customerId?: string) { return this.prisma.customerPayment.findMany({ where: { deletedAt: null, ...(orderNo ? { orderNo } : {}), ...(customerId ? { customerId } : {}) }, include: { allocations: { where: { deletedAt: null } } }, orderBy: { createdAt: "desc" } }); }
  async get(id: string) { const row = await this.prisma.customerPayment.findFirst({ where: { id, deletedAt: null }, include: { allocations: { where: { deletedAt: null } } } }); if (!row) throw this.notFound("CUSTOMER_PAYMENT_NOT_FOUND", "收款不存在"); return row; }
  async create(input: PaymentInput, user: CurrentUser) { const amount = this.decimal(input.amount, "INVALID_PAYMENT_AMOUNT"); const customer = await this.prisma.customer.findFirst({ where: { id: input.customer_id, deletedAt: null } }); if (!customer) throw this.notFound("CUSTOMER_NOT_FOUND", "客户不存在"); const row = await this.prisma.customerPayment.create({ data: { paymentNo: this.number("PAY"), customerId: customer.id, orderNo: input.order_no, paymentDate: this.date(input.payment_date), amount, currency: input.currency, paymentMethod: input.payment_method, bankReference: input.bank_reference, payerName: input.payer_name, attachment: (input.attachment ?? []) as Prisma.InputJsonValue, remark: input.remark, ...this.audit.create(user) } }); await this.audit.record("customer_payment.create", "customer_payment", user.id, row.id, { order_no: row.orderNo, amount: row.amount.toString() }); return row; }

  async post(id: string, allocations: Allocation[], user: CurrentUser) {
    const current = await this.prisma.customerPayment.findFirst({ where: { id, deletedAt: null } });
    if (!current) throw this.notFound("CUSTOMER_PAYMENT_NOT_FOUND", "收款不存在");
    if (current.status !== "draft") throw this.invalid("CUSTOMER_PAYMENT_NOT_POSTABLE", "只有草稿收款可以过账");
    if (!allocations?.length) throw this.invalid("PAYMENT_ALLOCATION_REQUIRED", "收款过账至少需要核销一条有效应收");
    const result = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.receivableAllocation.count({ where: { paymentId: id, deletedAt: null } });
      if (existing) throw this.invalid("CUSTOMER_PAYMENT_ALREADY_POSTED", "收款已存在核销分配");
      let total = new Prisma.Decimal(0);
      for (const allocation of allocations ?? []) {
        const amount = this.decimal(allocation.amount, "INVALID_ALLOCATION_AMOUNT");
        const { source, available } = await this.receivable.allocationBalance(allocation.receivable_source_id, tx);
        if (source.customerId !== current.customerId || source.currency !== current.currency) throw this.invalid("ALLOCATION_REFERENCE_MISMATCH", "客户或币种与应收来源不一致");
        if (!["confirmed", "partially_paid"].includes(source.status)) throw this.invalid("RECEIVABLE_SOURCE_NOT_ALLOCATABLE", "应收来源尚未确认或已关闭");
        if (amount.gt(available)) throw this.exceeded("RECEIVABLE_ALLOCATION_EXCEEDED", available);
        total = total.plus(amount);
        await tx.receivableAllocation.create({ data: { paymentId: id, receivableSourceId: source.id, amount, currency: current.currency, ...this.audit.create(user) } });
      }
      if (total.gt(current.amount)) throw this.exceeded("PAYMENT_ALLOCATION_EXCEEDED", current.amount);
      const payment = await tx.customerPayment.update({ where: { id }, data: { status: "posted", ...this.audit.update(user) } });
      for (const allocation of allocations ?? []) await this.receivable.refreshStatus(tx, allocation.receivable_source_id, user);
      return payment;
    });
    await this.audit.record("customer_payment.post", "customer_payment", user.id, id, { order_no: result.orderNo, allocation_count: allocations?.length ?? 0 }); return result;
  }

  async updateDraft(id: string, input: { amount?: string; payment_date?: string; payment_method?: string; remark?: string }, user: CurrentUser) {
    const current = await this.get(id);
    if (current.status !== "draft") throw this.invalid("CUSTOMER_PAYMENT_NOT_EDITABLE", "只有草稿收款可以编辑");
    const amount = input.amount === undefined ? current.amount : this.decimal(input.amount, "INVALID_PAYMENT_AMOUNT");
    return this.prisma.customerPayment.update({ where: { id }, data: { amount, paymentDate: input.payment_date ? this.date(input.payment_date) : current.paymentDate, paymentMethod: input.payment_method ?? current.paymentMethod, remark: input.remark ?? current.remark, ...this.audit.update(user) } });
  }

  async reverse(id: string, reason: string, user: CurrentUser) { if (!reason?.trim()) throw new UnprocessableEntityException({ code: "REVERSAL_REASON_REQUIRED", message: "冲销必须填写原因", details: [] }); const current = await this.prisma.customerPayment.findFirst({ where: { id, deletedAt: null }, include: { allocations: { where: { deletedAt: null, status: "active" } } } }); if (!current) throw this.notFound("CUSTOMER_PAYMENT_NOT_FOUND", "收款不存在"); if (current.status === "reversed" || current.status === "draft") throw this.invalid("CUSTOMER_PAYMENT_NOT_REVERSIBLE", "当前收款不可冲销"); const result = await this.prisma.$transaction(async (tx) => { await tx.receivableAllocation.updateMany({ where: { paymentId: id, status: "active", deletedAt: null }, data: { status: "reversed", ...this.audit.update(user) } }); const payment = await tx.customerPayment.update({ where: { id }, data: { status: "reversed", remark: `${current.remark ?? ""}\n冲销：${reason}`, ...this.audit.update(user) } }); for (const allocation of current.allocations) await this.receivable.refreshStatus(tx, allocation.receivableSourceId, user); return payment; }); await this.audit.record("customer_payment.reverse", "customer_payment", user.id, id, { order_no: result.orderNo, reason }); return result; }
  async orderSummary(orderNo: string) { const sources = await this.prisma.receivableSource.findMany({ where: { orderNo, deletedAt: null }, include: { allocations: { where: { deletedAt: null, status: "active" }, include: { payment: true } } } }); const amount = sources.reduce((sum, source) => sum.plus(source.amount), new Prisma.Decimal(0)); const allocated = sources.reduce((sum, source) => sum.plus(source.allocations.filter((item) => item.payment.status === "posted").reduce((inner, item) => inner.plus(item.amount), new Prisma.Decimal(0))), new Prisma.Decimal(0)); return { order_no: orderNo, source_count: sources.length, receivable_amount: amount.toString(), allocated_amount: allocated.toString(), outstanding_amount: amount.minus(allocated).toString(), status: amount.gt(0) && allocated.gte(amount) ? "paid" : allocated.gt(0) ? "partially_paid" : "unpaid" }; }
  private decimal(value: string, code: string) { try { const result = new Prisma.Decimal(value); if (result.lte(0)) throw new Error(); return result; } catch { throw new UnprocessableEntityException({ code, message: "金额必须是大于零的十进制数", details: [] }); } }
  private date(value: string) { const result = new Date(`${value}T00:00:00.000Z`); if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(result.valueOf())) throw new UnprocessableEntityException({ code: "INVALID_PAYMENT_DATE", message: "收款日期无效", details: [] }); return result; }
  private number(prefix: string) { return `${prefix}-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomUUID().slice(0, 8).toUpperCase()}`; }
  private notFound(code: string, message: string) { return new NotFoundException({ code, message, details: [] }); }
  private invalid(code: string, message: string) { return new UnprocessableEntityException({ code, message, details: [] }); }
  private exceeded(code: string, available: Prisma.Decimal) { return new UnprocessableEntityException({ code, message: "核销金额超过可用余额", details: [{ available_amount: available.toString() }] }); }
}
