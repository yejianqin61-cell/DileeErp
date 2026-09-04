import { Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { AuditService } from "../../platform/audit/audit.service";
import type { CurrentUser } from "../../platform/auth/auth.service";
import { PrismaService } from "../../platform/database/prisma.service";
import { SupplierPayableService } from "./supplier-payable.service";

type PaymentInput = { supplier_id: string; order_no?: string; payment_date: string; amount: string; currency: string; payment_method: string; bank_reference?: string; payee_name?: string; attachment?: unknown[]; remark?: string };
type AllocationInput = { payable_entry_id: string; amount: string; remark?: string };

@Injectable()
export class SupplierPaymentService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly payable: SupplierPayableService) {}

  async list(orderNo?: string, supplierId?: string, status?: string) {
    return this.prisma.supplierPayment.findMany({ where: { deletedAt: null, ...(orderNo ? { orderNo } : {}), ...(supplierId ? { supplierId } : {}), ...(status ? { status } : {}) }, include: { allocations: { where: { deletedAt: null }, include: { payableEntry: true } } }, orderBy: { createdAt: "desc" } });
  }

  async get(id: string) {
    const row = await this.prisma.supplierPayment.findFirst({ where: { id, deletedAt: null }, include: { allocations: { where: { deletedAt: null }, include: { payableEntry: true } } } });
    if (!row) throw this.notFound("SUPPLIER_PAYMENT_NOT_FOUND", "供应商付款不存在");
    return row;
  }

  async create(input: PaymentInput, user: CurrentUser) {
    const amount = this.decimal(input.amount, "INVALID_SUPPLIER_PAYMENT_AMOUNT");
    const supplier = await this.prisma.supplier.findFirst({ where: { id: input.supplier_id, deletedAt: null, isActive: true } });
    if (!supplier) throw this.notFound("SUPPLIER_NOT_FOUND", "供应商不存在或已停用");
    const row = await this.prisma.supplierPayment.create({ data: { paymentNo: this.number("SPAY"), supplierId: supplier.id, orderNo: input.order_no, paymentDate: this.date(input.payment_date), amount, currency: input.currency, paymentMethod: input.payment_method, bankReference: input.bank_reference, payeeName: input.payee_name, attachment: (input.attachment ?? []) as Prisma.InputJsonValue, remark: input.remark, ...this.audit.create(user) } });
    await this.audit.record("supplier_payment.create", "supplier_payment", user.id, row.id, { order_no: row.orderNo, amount: row.amount.toString() });
    return row;
  }

  async post(id: string, allocations: AllocationInput[], user: CurrentUser) {
    const items = allocations ?? [];
    if (items.length === 0) throw this.invalid("PAYMENT_ALLOCATION_REQUIRED", "付款过账至少需要核销一条有效应付");
    if (new Set(items.map((item) => item.payable_entry_id)).size !== items.length) throw this.invalid("DUPLICATE_PAYMENT_ALLOCATION", "同一付款不得重复核销同一应付");
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM supplier_payments WHERE id = ${id}::uuid FOR UPDATE`;
      const lockedPayment = await tx.supplierPayment.findFirst({ where: { id, deletedAt: null } });
      if (!lockedPayment || lockedPayment.status !== "draft") throw this.invalid("SUPPLIER_PAYMENT_NOT_POSTABLE", "只有草稿付款可以过账");
      let total = new Prisma.Decimal(0);
      for (const item of items) {
        const amount = this.decimal(item.amount, "INVALID_ALLOCATION_AMOUNT");
        await tx.$queryRaw`SELECT id FROM supplier_payable_entries WHERE id = ${item.payable_entry_id}::uuid FOR UPDATE`;
        const balance = await this.payable.allocationBalance(item.payable_entry_id, tx);
        if (balance.entry.supplierId !== lockedPayment.supplierId || balance.entry.currency !== lockedPayment.currency || (lockedPayment.orderNo && balance.entry.orderNo !== lockedPayment.orderNo)) throw this.invalid("ALLOCATION_REFERENCE_MISMATCH", "供应商、币种或订单与应付不一致");
        if (!["confirmed", "partially_paid"].includes(balance.entry.status)) throw this.invalid("SUPPLIER_PAYABLE_NOT_ALLOCATABLE", "应付尚未确认或已关闭");
        if (amount.gt(balance.available)) throw new UnprocessableEntityException({ code: "PAYABLE_ALLOCATION_EXCEEDED", message: "核销金额超过应付未核销余额", details: [{ available_amount: balance.available.toString() }] });
        total = total.plus(amount);
        await tx.supplierPaymentAllocation.create({ data: { paymentId: id, payableEntryId: balance.entry.id, orderNo: balance.entry.orderNo, amount, currency: lockedPayment.currency, remark: item.remark, ...this.audit.create(user) } });
      }
      if (total.gt(lockedPayment.amount)) throw new UnprocessableEntityException({ code: "PAYMENT_ALLOCATION_EXCEEDED", message: "核销金额超过付款金额", details: [{ available_amount: lockedPayment.amount.minus(total).toString() }] });
      const payment = await tx.supplierPayment.update({ where: { id }, data: { status: "posted", ...this.audit.update(user) } });
      for (const item of items) await this.payable.refreshStatus(tx, item.payable_entry_id, user);
      return payment;
    });
    await this.audit.record("supplier_payment.post", "supplier_payment", user.id, id, { order_no: result.orderNo, allocation_count: items.length });
    return result;
  }

  async updateDraft(id: string, input: { amount?: string; payment_date?: string; payment_method?: string; remark?: string }, user: CurrentUser) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM supplier_payments WHERE id = ${id}::uuid FOR UPDATE`;
      const current = await tx.supplierPayment.findFirst({ where: { id, deletedAt: null } });
      if (!current) throw this.notFound("SUPPLIER_PAYMENT_NOT_FOUND", "供应商付款不存在");
      if (current.status !== "draft") throw this.invalid("SUPPLIER_PAYMENT_NOT_EDITABLE", "只有草稿付款可以编辑");
      const amount = input.amount === undefined ? current.amount : this.decimal(input.amount, "INVALID_SUPPLIER_PAYMENT_AMOUNT");
      return tx.supplierPayment.update({ where: { id }, data: { amount, paymentDate: input.payment_date ? this.date(input.payment_date) : current.paymentDate, paymentMethod: input.payment_method ?? current.paymentMethod, remark: input.remark ?? current.remark, ...this.audit.update(user) } });
    });
  }

  async reverse(id: string, reason: string, user: CurrentUser) {
    if (!reason?.trim()) throw this.invalid("REVERSAL_REASON_REQUIRED", "冲销必须填写原因");
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM supplier_payments WHERE id = ${id}::uuid FOR UPDATE`;
      const current = await tx.supplierPayment.findFirst({ where: { id, deletedAt: null }, include: { allocations: { where: { deletedAt: null, status: "active" } } } });
      if (!current) throw this.notFound("SUPPLIER_PAYMENT_NOT_FOUND", "供应商付款不存在");
      if (current.status !== "posted") throw this.invalid("SUPPLIER_PAYMENT_NOT_REVERSIBLE", "当前付款不可冲销");
      await tx.supplierPaymentAllocation.updateMany({ where: { paymentId: id, deletedAt: null, status: "active" }, data: { status: "reversed", ...this.audit.update(user) } });
      const payment = await tx.supplierPayment.update({ where: { id }, data: { status: "reversed", remark: `${current.remark ?? ""}\n冲销：${reason.trim()}`, ...this.audit.update(user) } });
      for (const allocation of current.allocations) await this.payable.refreshStatus(tx, allocation.payableEntryId, user);
      return payment;
    });
    await this.audit.record("supplier_payment.reverse", "supplier_payment", user.id, id, { order_no: result.orderNo, reason: reason.trim() });
    return result;
  }

  async orderSummary(orderNo: string) {
    const entries = await this.prisma.supplierPayableEntry.findMany({ where: { orderNo, deletedAt: null }, include: { allocations: { where: { deletedAt: null, status: "active" }, include: { payment: true } } } });
    const payments = await this.prisma.supplierPayment.findMany({ where: { orderNo, deletedAt: null, status: "posted" } });
    const payable = entries.filter((entry) => entry.status !== "reversed").reduce((sum, entry) => sum.plus(entry.amount), new Prisma.Decimal(0));
    const paid = entries.reduce((sum, entry) => sum.plus(entry.allocations.filter((allocation) => allocation.payment.status === "posted").reduce((inner, allocation) => inner.plus(allocation.amount), new Prisma.Decimal(0))), new Prisma.Decimal(0));
    return { order_no: orderNo, payable_amount: payable.toString(), paid_amount: paid.toString(), outstanding_amount: payable.minus(paid).toString(), payable_entry_count: entries.length, payment_count: payments.length, status: payable.eq(0) || paid.eq(0) ? "unpaid" : paid.gte(payable) ? "paid" : "partially_paid" };
  }

  private decimal(value: string, code: string) { try { const result = new Prisma.Decimal(value); if (result.lte(0)) throw new Error(); return result; } catch { throw this.invalid(code, "金额必须是大于零的十进制数"); } }
  private date(value: string) { const result = new Date(`${value}T00:00:00.000Z`); if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(result.valueOf())) throw this.invalid("INVALID_PAYMENT_DATE", "付款日期无效"); return result; }
  private number(prefix: string) { return `${prefix}-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomUUID().slice(0, 8).toUpperCase()}`; }
  private notFound(code: string, message: string) { return new NotFoundException({ code, message, details: [] }); }
  private invalid(code: string, message: string) { return new UnprocessableEntityException({ code, message, details: [] }); }
}
