import { Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { AuditService } from "../../platform/audit/audit.service";
import type { CurrentUser } from "../../platform/auth/auth.service";
import { PrismaService } from "../../platform/database/prisma.service";

@Injectable()
export class SupplierPayableReconciliationService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}
  async list(supplierId?: string, orderNo?: string, status?: string) { return this.prisma.supplierPayableReconciliation.findMany({ where: { deletedAt: null, ...(supplierId ? { supplierId } : {}), ...(orderNo ? { orderNo } : {}), ...(status ? { status } : {}) }, include: { supplier: true, purchaseOrder: { select: { purchaseOrderNo: true } } }, orderBy: { createdAt: "desc" } }); }
  async create(input: { supplier_id: string; order_no?: string; purchase_order_id?: string; period_start: string; period_end: string; external_balance: string; currency: string; remark?: string }, user: CurrentUser) {
    const start = this.date(input.period_start); const end = this.date(input.period_end); if (start > end) throw this.invalid("INVALID_RECONCILIATION_PERIOD", "对账开始日期不能晚于结束日期");
    const supplier = await this.prisma.supplier.findFirst({ where: { id: input.supplier_id, deletedAt: null } }); if (!supplier) throw this.notFound("SUPPLIER_NOT_FOUND", "供应商不存在");
    const where = { supplierId: supplier.id, currency: input.currency, deletedAt: null, status: { in: ["confirmed", "partially_paid", "paid"] }, confirmationDate: { gte: start, lte: end }, ...(input.order_no ? { orderNo: input.order_no } : {}), ...(input.purchase_order_id ? { purchaseOrderId: input.purchase_order_id } : {}) };
    const entries = await this.prisma.supplierPayableEntry.findMany({ where });
    const entryIds = entries.map((entry) => entry.id);
    const payments = entryIds.length ? await this.prisma.supplierPayment.findMany({ where: { supplierId: supplier.id, currency: input.currency, deletedAt: null, paymentDate: { gte: start, lte: end }, status: "posted" }, include: { allocations: { where: { payableEntryId: { in: entryIds }, deletedAt: null, status: "active" } } } }) : [];
    const payable = entries.reduce((sum, row) => sum.plus(row.amount), new Prisma.Decimal(0));
    // Reconcile allocated amounts only; an unallocated payment must not reduce a supplier/order balance.
    const paid = payments.reduce((sum, payment) => sum.plus(payment.allocations.reduce((inner, allocation) => inner.plus(allocation.amount), new Prisma.Decimal(0))), new Prisma.Decimal(0));
    const external = this.decimal(input.external_balance); const difference = payable.minus(paid).minus(external);
    const row = await this.prisma.supplierPayableReconciliation.create({ data: { reconciliationNo: `APREC-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomUUID().slice(0, 8).toUpperCase()}`, orderNo: input.order_no, purchaseOrderId: input.purchase_order_id, supplierId: supplier.id, periodStart: start, periodEnd: end, payableAmountSnapshot: payable, paymentAmountSnapshot: paid, adjustmentAmountSnapshot: 0, systemBalance: payable.minus(paid), externalBalance: external, difference, currency: input.currency, status: difference.eq(0) ? "matched" : "difference", remark: input.remark, ...this.audit.create(user) } });
    if (row.orderNo) await this.audit.recordWithOrderNo("supplier_payable_reconciliation.create", "supplier_payable_reconciliation", row.orderNo, user.id, row.id, { difference: difference.toString() });
    else await this.audit.record("supplier_payable_reconciliation.create", "supplier_payable_reconciliation", user.id, row.id, { difference: difference.toString() });
    return row;
  }
  async resolve(id: string, remark: string, user: CurrentUser) { if (!remark?.trim()) throw this.invalid("RESOLUTION_REMARK_REQUIRED", "解决对账差异必须填写说明"); const current = await this.prisma.supplierPayableReconciliation.findFirst({ where: { id, deletedAt: null } }); if (!current) throw this.notFound("RECONCILIATION_NOT_FOUND", "应付对账不存在"); if (current.status !== "difference") throw this.invalid("RECONCILIATION_NOT_RESOLVABLE", "只有存在差异的应付对账可以处理"); return this.prisma.supplierPayableReconciliation.update({ where: { id }, data: { status: "resolved", resolutionRemark: remark.trim(), ...this.audit.update(user) } }); }
  private date(value: string) { const date = new Date(`${value}T00:00:00.000Z`); if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(date.valueOf())) throw this.invalid("INVALID_RECONCILIATION_PERIOD", "日期无效"); return date; }
  private decimal(value: string) { try { const n = new Prisma.Decimal(value); if (n.lt(0)) throw new Error(); return n; } catch { throw this.invalid("INVALID_EXTERNAL_BALANCE", "外部余额必须是有效的非负十进制数"); } }
  private notFound(code: string, message: string) { return new NotFoundException({ code, message, details: [] }); }
  private invalid(code: string, message: string) { return new UnprocessableEntityException({ code, message, details: [] }); }
}
