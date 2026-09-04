import { Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { AuditService } from "../../platform/audit/audit.service";
import type { CurrentUser } from "../../platform/auth/auth.service";
import { PrismaService } from "../../platform/database/prisma.service";

@Injectable()
export class ReceivableService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  async list(orderNo?: string, customerId?: string, status?: string) { return this.prisma.receivableSource.findMany({ where: { deletedAt: null, ...(orderNo ? { orderNo } : {}), ...(customerId ? { customerId } : {}), ...(status ? { status } : {}) }, include: { allocations: { where: { deletedAt: null } } }, orderBy: { createdAt: "desc" } }); }
  async get(id: string) { const row = await this.prisma.receivableSource.findFirst({ where: { id, deletedAt: null }, include: { allocations: { where: { deletedAt: null } }, outbound: true } }); if (!row) throw this.notFound("RECEIVABLE_SOURCE_NOT_FOUND", "应收来源不存在"); return row; }

  async createFromOutbound(outboundId: string, input: { amount?: string; amount_reason?: string; due_date?: string; remark?: string }, user: CurrentUser) {
    const row = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM finished_goods_outbounds WHERE id = ${outboundId}::uuid FOR UPDATE`;
      const outbound = await tx.finishedGoodsOutbound.findFirst({ where: { id: outboundId, deletedAt: null, status: { in: ["posted", "shipped", "signed"] } }, include: { salesOrder: true } });
      if (!outbound) throw this.notFound("OUTBOUND_NOT_RECEIVABLE", "出库不存在或尚未过账");
      const existing = await tx.receivableSource.findUnique({ where: { outboundId } });
      if (existing) return existing;
      const unitPrice = outbound.salesOrder.unitPrice;
      const amount = input.amount ?? (unitPrice ? new Prisma.Decimal(outbound.quantity).mul(unitPrice).toFixed(4) : undefined);
      if (!amount) throw new UnprocessableEntityException({ code: "RECEIVABLE_AMOUNT_REQUIRED", message: "销售单没有单价，必须填写应收金额和原因", details: [] });
      if (!input.amount_reason?.trim() && !unitPrice) throw new UnprocessableEntityException({ code: "RECEIVABLE_AMOUNT_REASON_REQUIRED", message: "手工确认金额必须填写原因", details: [] });
      return tx.receivableSource.create({ data: { sourceNo: this.number("AR"), orderNo: outbound.orderNo, salesOrderId: outbound.salesOrderId, outboundId: outbound.id, customerId: outbound.salesOrder.customerId, quantity: outbound.quantity, unit: outbound.salesOrder.unit, unitPrice, taxRate: outbound.salesOrder.taxRate, amount, currency: outbound.salesOrder.currency, amountReason: input.amount_reason, dueDate: input.due_date ? this.date(input.due_date) : undefined, signedAtSnapshot: outbound.signedAt, remark: input.remark, ...this.audit.create(user) } });
    });
    await this.audit.record("receivable_source.create", "receivable_source", user.id, row.id, { order_no: row.orderNo, outbound_id: outboundId, amount: row.amount.toString() });
    return row;
  }

  async confirm(id: string, user: CurrentUser) {
    const row = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM receivable_sources WHERE id = ${id}::uuid FOR UPDATE`;
      const current = await tx.receivableSource.findFirst({ where: { id, deletedAt: null } });
      if (!current) throw this.notFound("RECEIVABLE_SOURCE_NOT_FOUND", "应收来源不存在");
      if (current.status !== "draft") throw this.invalid("RECEIVABLE_SOURCE_NOT_CONFIRMABLE", "只有草稿应收来源可以确认");
      return tx.receivableSource.update({ where: { id }, data: { status: "confirmed", ...this.audit.update(user) } });
    });
    await this.audit.record("receivable_source.confirm", "receivable_source", user.id, id, { order_no: row.orderNo });
    return row;
  }
  async updateDraft(id: string, input: { amount?: string; due_date?: string; amount_reason?: string; remark?: string }, user: CurrentUser) {
    const row = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM receivable_sources WHERE id = ${id}::uuid FOR UPDATE`;
      const current = await tx.receivableSource.findFirst({ where: { id, deletedAt: null } });
      if (!current) throw this.notFound("RECEIVABLE_SOURCE_NOT_FOUND", "应收来源不存在");
      if (current.status !== "draft") throw this.invalid("RECEIVABLE_SOURCE_NOT_EDITABLE", "只有草稿应收来源可以编辑");
      let amount = current.amount;
      if (input.amount !== undefined) {
        try { amount = new Prisma.Decimal(input.amount); if (amount.lte(0)) throw new Error(); } catch { throw this.invalid("INVALID_RECEIVABLE_AMOUNT", "应收金额必须是大于零的十进制数"); }
      }
      return tx.receivableSource.update({ where: { id }, data: { amount, dueDate: input.due_date ? this.date(input.due_date) : current.dueDate, amountReason: input.amount_reason ?? current.amountReason, remark: input.remark ?? current.remark, ...this.audit.update(user) } });
    });
    await this.audit.record("receivable_source.update", "receivable_source", user.id, id, { order_no: row.orderNo, amount: row.amount.toString() });
    return row;
  }
  async cancel(id: string, reason: string, user: CurrentUser) {
    if (!reason?.trim()) throw new UnprocessableEntityException({ code: "CANCELLATION_REASON_REQUIRED", message: "取消必须填写原因", details: [] });
    const row = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM receivable_sources WHERE id = ${id}::uuid FOR UPDATE`;
      const current = await tx.receivableSource.findFirst({ where: { id, deletedAt: null }, include: { allocations: { where: { deletedAt: null, status: "active" }, include: { payment: true } } } });
      if (!current) throw this.notFound("RECEIVABLE_SOURCE_NOT_FOUND", "应收来源不存在");
      if (["paid", "closed"].includes(current.status)) throw this.invalid("RECEIVABLE_SOURCE_NOT_CANCELLABLE", "已收清应收来源不可取消");
      if (current.allocations.some((allocation) => allocation.payment.status === "posted")) throw this.invalid("RECEIVABLE_SOURCE_HAS_ALLOCATIONS", "应收来源存在有效收款核销，必须先冲销收款");
      return tx.receivableSource.update({ where: { id }, data: { status: "cancelled", remark: `${current.remark ?? ""}\n取消：${reason.trim()}`, ...this.audit.update(user) } });
    });
    await this.audit.record("receivable_source.cancel", "receivable_source", user.id, id, { order_no: row.orderNo, reason });
    return row;
  }
  async impactPreview(id: string) { const row = await this.get(id); const allocated = row.allocations.reduce((sum, item) => sum.plus(item.amount), new Prisma.Decimal(0)); return { source_id: id, order_no: row.orderNo, status: row.status, amount: row.amount.toString(), allocated_amount: allocated.toString(), unallocated_amount: row.amount.minus(allocated).toString(), allocation_count: row.allocations.length }; }
  async orderSummary(orderNo: string) { const rows = await this.prisma.receivableSource.findMany({ where: { orderNo, deletedAt: null }, include: { allocations: { where: { deletedAt: null, status: "active" }, include: { payment: true } } } }); const amount = rows.reduce((sum, row) => sum.plus(row.amount), new Prisma.Decimal(0)); const allocated = rows.reduce((sum, row) => sum.plus(row.allocations.filter((item) => item.payment.status === "posted").reduce((inner, item) => inner.plus(item.amount), new Prisma.Decimal(0))), new Prisma.Decimal(0)); return { order_no: orderNo, source_count: rows.length, receivable_amount: amount.toString(), allocated_amount: allocated.toString(), outstanding_amount: amount.minus(allocated).toString() }; }
  async allocationBalance(id: string, client: PrismaService | Prisma.TransactionClient = this.prisma) { const source = await client.receivableSource.findFirst({ where: { id, deletedAt: null } }); if (!source) throw this.notFound("RECEIVABLE_SOURCE_NOT_FOUND", "应收来源不存在"); const result = await client.receivableAllocation.aggregate({ where: { receivableSourceId: id, deletedAt: null, status: "active", payment: { status: "posted" } }, _sum: { amount: true } }); return { source, allocated: new Prisma.Decimal(result._sum.amount ?? 0), available: source.amount.minus(result._sum.amount ?? 0) }; }
  async refreshStatus(client: Prisma.TransactionClient, id: string, user: CurrentUser) { const { source, available } = await this.allocationBalance(id, client); const next = available.eq(0) ? "paid" : available.lt(source.amount) ? "partially_paid" : "confirmed"; return client.receivableSource.update({ where: { id }, data: { status: next, ...this.audit.update(user) } }); }
  private number(prefix: string) { return `${prefix}-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomUUID().slice(0, 8).toUpperCase()}`; }
  private date(value: string) { const date = new Date(`${value}T00:00:00.000Z`); if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(date.valueOf())) throw new UnprocessableEntityException({ code: "INVALID_DUE_DATE", message: "到期日无效", details: [] }); return date; }
  private notFound(code: string, message: string) { return new NotFoundException({ code, message, details: [] }); }
  private invalid(code: string, message: string) { return new UnprocessableEntityException({ code, message, details: [] }); }
}
