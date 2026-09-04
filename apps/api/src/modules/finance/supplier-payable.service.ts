import { Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { AuditService } from "../../platform/audit/audit.service";
import type { CurrentUser } from "../../platform/auth/auth.service";
import { PrismaService } from "../../platform/database/prisma.service";
import { sourceType } from "./supplier-payable.domain";

type SourceType = "raw_material_inbound" | "purchase_receipt" | "outsource_receipt";
export type PayableEntryInput = { source_type: SourceType; source_id: string; amount?: string; amount_reason?: string; confirmation_date?: string; attachment?: unknown[]; remark?: string };

@Injectable()
export class SupplierPayableService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  async list(orderNo?: string, supplierId?: string, status?: string) {
    return this.prisma.supplierPayableEntry.findMany({ where: { deletedAt: null, ...(orderNo ? { orderNo } : {}), ...(supplierId ? { supplierId } : {}), ...(status ? { status } : {}) }, include: { allocations: { where: { deletedAt: null } } }, orderBy: { createdAt: "desc" } });
  }

  async get(id: string) {
    const row = await this.prisma.supplierPayableEntry.findFirst({ where: { id, deletedAt: null }, include: { allocations: { where: { deletedAt: null }, include: { payment: true } }, payableSource: true, outsourcePayableSource: true } });
    if (!row) throw this.notFound("SUPPLIER_PAYABLE_NOT_FOUND", "应付确认不存在");
    return row;
  }

  async createFromSource(input: PayableEntryInput, user: CurrentUser) {
    sourceType(input.source_type);
    const refs = await this.source(input.source_type, input.source_id);
    const existing = input.source_type === "raw_material_inbound"
      ? await this.prisma.supplierPayableEntry.findUnique({ where: { payableSourceId: input.source_id } })
      : input.source_type === "purchase_receipt"
        ? await this.prisma.supplierPayableEntry.findUnique({ where: { payableSourceId: input.source_id } })
      : await this.prisma.supplierPayableEntry.findUnique({ where: { outsourcePayableSourceId: input.source_id } });
    if (existing && !existing.deletedAt) return existing;
    const amount = input.amount ? this.decimal(input.amount, "INVALID_PAYABLE_AMOUNT") : refs.amount;
    if (!amount.eq(refs.amount) && !input.amount_reason?.trim()) throw this.invalid("PAYABLE_AMOUNT_REASON_REQUIRED", "覆盖应付金额必须填写原因");
    const row = await this.prisma.supplierPayableEntry.create({ data: {
      payableNo: this.number("AP"), orderNo: refs.orderNo, supplierId: refs.supplierId, sourceType: input.source_type,
      payableSourceId: ["raw_material_inbound", "purchase_receipt"].includes(input.source_type) ? input.source_id : undefined,
      outsourcePayableSourceId: input.source_type === "outsource_receipt" ? input.source_id : undefined,
      sourceNoSnapshot: refs.sourceNo, quantity: refs.quantity, unitPrice: refs.unitPrice, taxRate: refs.taxRate,
      amount, currency: refs.currency, confirmationDate: input.confirmation_date ? this.date(input.confirmation_date) : new Date(),
      attachment: (input.attachment ?? []) as Prisma.InputJsonValue, remark: input.remark, ...this.audit.create(user),
    } });
    await this.audit.recordWithOrderNo("supplier_payable.create", "supplier_payable_entry", row.orderNo, user.id, row.id, { payable_no: row.payableNo, source_type: row.sourceType, source_id: input.source_id, amount: row.amount.toString() });
    return row;
  }

  async confirm(id: string, user: CurrentUser) {
    const row = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM supplier_payable_entries WHERE id = ${id}::uuid FOR UPDATE`;
      const current = await tx.supplierPayableEntry.findFirst({ where: { id, deletedAt: null } });
      if (!current) throw this.notFound("SUPPLIER_PAYABLE_NOT_FOUND", "应付确认不存在");
      if (current.status !== "draft") throw this.invalid("SUPPLIER_PAYABLE_NOT_CONFIRMABLE", "只有草稿应付可以确认");
      return tx.supplierPayableEntry.update({ where: { id }, data: { status: "confirmed", ...this.audit.update(user) } });
    });
    await this.audit.recordWithOrderNo("supplier_payable.confirm", "supplier_payable_entry", row.orderNo, user.id, id, { payable_no: row.payableNo });
    return row;
  }

  async updateDraft(id: string, input: { amount?: string; confirmation_date?: string; remark?: string }, user: CurrentUser) {
    const current = await this.get(id);
    if (current.status !== "draft") throw this.invalid("SUPPLIER_PAYABLE_NOT_EDITABLE", "只有草稿应付可以编辑");
    const amount = input.amount === undefined ? current.amount : this.decimal(input.amount, "INVALID_PAYABLE_AMOUNT");
    const row = await this.prisma.supplierPayableEntry.update({ where: { id }, data: { amount, confirmationDate: input.confirmation_date ? this.date(input.confirmation_date) : current.confirmationDate, remark: input.remark ?? current.remark, ...this.audit.update(user) } });
    await this.audit.recordWithOrderNo("supplier_payable.update", "supplier_payable_entry", row.orderNo, user.id, id, { amount: row.amount.toString() });
    return row;
  }

  async reverse(id: string, reason: string, user: CurrentUser) {
    if (!reason?.trim()) throw this.invalid("REVERSAL_REASON_REQUIRED", "冲销必须填写原因");
    const current = await this.get(id);
    if (!["confirmed", "partially_paid", "paid"].includes(current.status)) throw this.invalid("SUPPLIER_PAYABLE_NOT_REVERSIBLE", "当前应付不可冲销");
    if (current.allocations.some((allocation) => allocation.status === "active" && allocation.payment.status === "posted")) throw this.invalid("SUPPLIER_PAYABLE_HAS_ALLOCATIONS", "应付存在有效付款核销，必须先冲销付款");
    const row = await this.prisma.supplierPayableEntry.update({ where: { id }, data: { status: "reversed", remark: `${current.remark ?? ""}\n冲销：${reason.trim()}`, ...this.audit.update(user) } });
    await this.audit.recordWithOrderNo("supplier_payable.reverse", "supplier_payable_entry", row.orderNo, user.id, id, { reason: reason.trim() });
    return row;
  }

  async allocationBalance(id: string, client: PrismaService | Prisma.TransactionClient = this.prisma) {
    const entry = await client.supplierPayableEntry.findFirst({ where: { id, deletedAt: null } });
    if (!entry) throw this.notFound("SUPPLIER_PAYABLE_NOT_FOUND", "应付确认不存在");
    const result = await client.supplierPaymentAllocation.aggregate({ where: { payableEntryId: id, deletedAt: null, status: "active", payment: { status: "posted" } }, _sum: { amount: true } });
    const allocated = new Prisma.Decimal(result._sum.amount ?? 0);
    return { entry, allocated, available: entry.amount.minus(allocated) };
  }

  async refreshStatus(client: Prisma.TransactionClient, id: string, user: CurrentUser) {
    const { entry, available } = await this.allocationBalance(id, client);
    if (["reversed", "voided"].includes(entry.status)) return entry;
    const next = available.eq(0) ? "paid" : available.lt(entry.amount) ? "partially_paid" : "confirmed";
    return client.supplierPayableEntry.update({ where: { id }, data: { status: next, ...this.audit.update(user) } });
  }

  async orderSummary(orderNo: string) {
    const entries = await this.prisma.supplierPayableEntry.findMany({ where: { orderNo, deletedAt: null }, include: { allocations: { where: { deletedAt: null, status: "active" }, include: { payment: true } } } });
    const amount = entries.filter((entry) => entry.status !== "reversed").reduce((sum, entry) => sum.plus(entry.amount), new Prisma.Decimal(0));
    const allocated = entries.reduce((sum, entry) => sum.plus(entry.allocations.filter((allocation) => allocation.payment.status === "posted").reduce((inner, allocation) => inner.plus(allocation.amount), new Prisma.Decimal(0))), new Prisma.Decimal(0));
    return { order_no: orderNo, payable_entry_count: entries.length, payable_amount: amount.toString(), allocated_amount: allocated.toString(), outstanding_amount: amount.minus(allocated).toString(), status: amount.eq(0) || allocated.eq(0) ? "unpaid" : allocated.gte(amount) ? "paid" : "partially_paid" };
  }

  private async source(type: SourceType, id: string) {
    if (type === "raw_material_inbound" || type === "purchase_receipt") {
      const row = await this.prisma.payableSource.findFirst({ where: { id, status: { not: "voided" }, OR: [{ rawMaterialInbound: { deletedAt: null } }, { purchaseReceipt: { deletedAt: null } }] }, include: { rawMaterialInbound: true, purchaseReceipt: true } });
      if (!row) throw this.notFound("PAYABLE_SOURCE_NOT_FOUND", "原料入库应付来源不存在或已作废");
      const extensionData = (row.purchaseReceipt?.extensionData ?? {}) as { batch_sequence?: number };
      return { orderNo: row.orderNo, supplierId: row.supplierId, sourceNo: row.rawMaterialInbound?.inboundNo ?? row.purchaseReceipt?.receiptNo ?? row.id, batchSequence: extensionData.batch_sequence ?? null, quantity: row.quantity, unitPrice: row.unitPrice, taxRate: row.taxRate, amount: row.amount, currency: row.currency };
    }
    const row = await this.prisma.outsourcePayableSource.findFirst({ where: { id, status: { not: "voided" } }, include: { logisticsBatch: true, outsourceReceipt: true } });
    if (!row) throw this.notFound("PAYABLE_SOURCE_NOT_FOUND", "外加工应付来源不存在或已作废");
    return { orderNo: row.orderNo, supplierId: row.supplierId, sourceNo: `${row.logisticsBatch.batchNo}/${row.outsourceReceipt.id.slice(0, 8)}`, quantity: row.quantity, unitPrice: row.unitPrice, taxRate: row.taxRate, amount: row.amount, currency: row.currency };
  }

  private decimal(value: string, code: string) { try { const result = new Prisma.Decimal(value); if (result.lte(0)) throw new Error(); return result; } catch { throw this.invalid(code, "金额必须是大于零的十进制数"); } }
  private date(value: string) { const result = new Date(`${value}T00:00:00.000Z`); if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(result.valueOf())) throw this.invalid("INVALID_CONFIRMATION_DATE", "确认日期无效"); return result; }
  private number(prefix: string) { return `${prefix}-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomUUID().slice(0, 8).toUpperCase()}`; }
  private notFound(code: string, message: string) { return new NotFoundException({ code, message, details: [] }); }
  private invalid(code: string, message: string) { return new UnprocessableEntityException({ code, message, details: [] }); }
}
