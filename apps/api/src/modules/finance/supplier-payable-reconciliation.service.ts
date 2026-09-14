import { Injectable, NotFoundException, UnprocessableEntityException, Optional } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { AuditService } from "../../platform/audit/audit.service";
import type { CurrentUser } from "../../platform/auth/auth.service";
import { CurrencyService } from "../../platform/currency/currency.service";
import { PrismaService } from "../../platform/database/prisma.service";

const STATUS_LABELS: Record<string, string> = { pending: "待处理", matched: "已对平", difference: "有差异", resolved: "差异已处理" };

@Injectable()
export class SupplierPayableReconciliationService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, @Optional() private readonly currencies?: CurrencyService) {}

  async list(supplierId?: string, orderNo?: string, status?: string) {
    return this.prisma.supplierPayableReconciliation.findMany({
      where: { deletedAt: null, ...(supplierId ? { supplierId } : {}), ...(orderNo ? { orderNo } : {}), ...(status ? { status } : {}) },
      include: { supplier: true, purchaseOrder: { select: { purchaseOrderNo: true } } },
      orderBy: { createdAt: "desc" },
    });
  }

  /** 对账详情：快照字段 + 该供应商/期间内的应付条目（含待确认草稿）与仍待接收的来源。 */
  async get(id: string) {
    const row = await this.prisma.supplierPayableReconciliation.findFirst({ where: { id, deletedAt: null }, include: { supplier: true, purchaseOrder: { select: { purchaseOrderNo: true } } } });
    if (!row) throw this.notFound("RECONCILIATION_NOT_FOUND", "应付对账不存在");
    const [entries, payableSources, outsourceSources] = await Promise.all([
      this.prisma.supplierPayableEntry.findMany({
        where: { ...this.entryScope(row), status: { in: ["draft", "confirmed", "partially_paid", "paid"] } },
        select: { id: true, payableNo: true, sourceType: true, sourceNoSnapshot: true, orderNo: true, quantity: true, amount: true, currency: true, status: true, confirmationDate: true, purchaseOrderId: true },
        orderBy: { createdAt: "asc" },
      }),
      this.prisma.payableSource.findMany({ where: { supplierId: row.supplierId, currency: row.currency, status: "pending_finance", createdAt: { gte: row.periodStart, lte: new Date(row.periodEnd.getTime() + 86400000) }, ...(row.orderNo ? { orderNo: row.orderNo } : {}), ...(row.purchaseOrderId ? { purchaseOrderId: row.purchaseOrderId } : {}) }, select: { id: true, orderNo: true, quantity: true, amount: true, currency: true, purchaseReceipt: { select: { receiptNo: true } }, rawMaterialInbound: { select: { inboundNo: true } } } }),
      this.prisma.outsourcePayableSource.findMany({ where: { supplierId: row.supplierId, currency: row.currency, status: "pending_finance", createdAt: { gte: row.periodStart, lte: new Date(row.periodEnd.getTime() + 86400000) }, ...(row.orderNo ? { orderNo: row.orderNo } : {}), ...(row.purchaseOrderId ? { purchaseOrderId: row.purchaseOrderId } : {}) }, select: { id: true, orderNo: true, quantity: true, amount: true, currency: true, outsourceReceipt: { select: { id: true } } } }),
    ]);
    const draft = entries.filter((entry) => entry.status === "draft");
    const draftAmount = draft.reduce((sum, entry) => sum.plus(entry.amount), new Prisma.Decimal(0));
    return {
      ...row,
      status_label: STATUS_LABELS[row.status] ?? row.status,
      details: {
        payable_entries: entries,
        draft_entries: draft,
        entry_count: entries.length,
        draft_count: draft.length,
        draft_amount: draftAmount.toFixed(4),
        can_confirm_payables: this.canConfirmPayables(row.status) && draft.length > 0,
        pending_sources: [...payableSources.map((source) => ({ ...source, source_type: "purchase_or_inbound", source_no: source.rawMaterialInbound?.inboundNo ?? source.purchaseReceipt?.receiptNo ?? source.id })), ...outsourceSources.map((source) => ({ ...source, source_type: "outsource_receipt", source_no: source.outsourceReceipt?.id ?? source.id }))],
      },
    };
  }

  async create(input: { supplier_id: string; order_no?: string; purchase_order_id?: string; period_start: string; period_end: string; external_balance: string; currency: string; attachment?: unknown[]; remark?: string }, user: CurrentUser) {
    await this.currencies?.assertSupported(input.currency, "应付对账币种");
    const start = this.date(input.period_start); const end = this.date(input.period_end); if (start > end) throw this.invalid("INVALID_RECONCILIATION_PERIOD", "对账开始日期不能晚于结束日期");
    const supplier = await this.prisma.supplier.findFirst({ where: { id: input.supplier_id, deletedAt: null }, select: { id: true } }); if (!supplier) throw this.notFound("SUPPLIER_NOT_FOUND", "供应商不存在");
    const scope = { supplierId: supplier.id, currency: input.currency, orderNo: input.order_no?.trim() || undefined, purchaseOrderId: input.purchase_order_id?.trim() || undefined };
    const entries = await this.prisma.supplierPayableEntry.findMany({ where: { ...this.entryScope({ ...scope, periodStart: start, periodEnd: end }), status: { in: ["confirmed", "partially_paid", "paid"] } } });
    const entryIds = entries.map((entry) => entry.id);
    const payments = entryIds.length ? await this.prisma.supplierPayment.findMany({ where: { supplierId: supplier.id, currency: input.currency, deletedAt: null, paymentDate: { gte: start, lte: end }, status: "posted" }, include: { allocations: { where: { payableEntryId: { in: entryIds }, deletedAt: null, status: "active" } } } }) : [];
    const payable = entries.reduce((sum, row) => sum.plus(row.amount), new Prisma.Decimal(0));
    // Reconcile allocated amounts only; an unallocated payment must not reduce a supplier/order balance.
    const paid = payments.reduce((sum, payment) => sum.plus(payment.allocations.reduce((inner, allocation) => inner.plus(allocation.amount), new Prisma.Decimal(0))), new Prisma.Decimal(0));
    const external = this.decimal(input.external_balance); const difference = payable.minus(paid).minus(external);
    const row = await this.prisma.supplierPayableReconciliation.create({ data: { reconciliationNo: this.number(), orderNo: scope.orderNo, purchaseOrderId: scope.purchaseOrderId, supplierId: supplier.id, periodStart: start, periodEnd: end, payableAmountSnapshot: payable, paymentAmountSnapshot: paid, adjustmentAmountSnapshot: 0, systemBalance: payable.minus(paid), externalBalance: external, difference, currency: input.currency, status: difference.eq(0) ? "matched" : "difference", attachment: (input.attachment ?? []) as Prisma.InputJsonValue, remark: input.remark, ...this.audit.create(user) } });
    if (row.orderNo) await this.audit.recordWithOrderNo("supplier_payable_reconciliation.create", "supplier_payable_reconciliation", row.orderNo, user.id, row.id, { difference: difference.toString() });
    else await this.audit.record("supplier_payable_reconciliation.create", "supplier_payable_reconciliation", user.id, row.id, { difference: difference.toString() });
    return row;
  }

  async resolve(id: string, remark: string, user: CurrentUser) {
    if (!remark?.trim()) throw this.invalid("RESOLUTION_REMARK_REQUIRED", "解决对账差异必须填写说明");
    const row = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM supplier_payable_reconciliations WHERE id = ${id}::uuid FOR UPDATE`;
      const current = await tx.supplierPayableReconciliation.findFirst({ where: { id, deletedAt: null } });
      if (!current) throw this.notFound("RECONCILIATION_NOT_FOUND", "应付对账不存在");
      if (current.status !== "difference") throw this.invalid("RECONCILIATION_NOT_RESOLVABLE", "只有存在差异的应付对账可以处理");
      return tx.supplierPayableReconciliation.update({ where: { id }, data: { status: "resolved", resolutionRemark: remark.trim(), ...this.audit.update(user) } });
    });
    await this.audit.record("supplier_payable_reconciliation.resolve", "supplier_payable_reconciliation", user.id, id, { remark: remark.trim() });
    return row;
  }

  /**
   * 对账完成后批量确认该对账范围内的草稿应付：一次事务、逐条行锁。
   *
   * 业务顺序与应收侧一致：先对账、再确认应付。仍有未处理差异（difference）时拒绝，
   * 否则会把没核对清楚的金额直接记成生效负债。来源已作废（voided）的草稿会被跳过并回报，
   * 因为「上游冲销后不得确认」是既定规则（SupplierPayableService.confirm 同口径）。
   */
  async confirmPayables(id: string, user: CurrentUser) {
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM supplier_payable_reconciliations WHERE id = ${id}::uuid FOR UPDATE`;
      const current = await tx.supplierPayableReconciliation.findFirst({ where: { id, deletedAt: null } });
      if (!current) throw this.notFound("RECONCILIATION_NOT_FOUND", "应付对账不存在");
      if (!this.canConfirmPayables(current.status)) throw this.invalid("RECONCILIATION_NOT_COMPLETED", `对账尚未完成（当前：${STATUS_LABELS[current.status] ?? current.status}），请先处理差异`);
      const drafts = await tx.supplierPayableEntry.findMany({
        where: { ...this.entryScope(current), status: "draft" },
        select: { id: true, payableNo: true, orderNo: true, amount: true, currency: true, payableSource: { select: { status: true } }, outsourcePayableSource: { select: { status: true } } },
        orderBy: { createdAt: "asc" },
      });
      const confirmed: typeof drafts = [];
      const skipped: Array<{ id: string; payable_no: string; reason: string }> = [];
      for (const draft of drafts) {
        if (draft.payableSource?.status === "voided" || draft.outsourcePayableSource?.status === "voided") {
          skipped.push({ id: draft.id, payable_no: draft.payableNo, reason: "来源已作废" });
          continue;
        }
        await tx.$queryRaw`SELECT id FROM supplier_payable_entries WHERE id = ${draft.id}::uuid FOR UPDATE`;
        await tx.supplierPayableEntry.update({ where: { id: draft.id }, data: { status: "confirmed", ...this.audit.update(user) } });
        confirmed.push(draft);
      }
      return { current, confirmed, skipped };
    });
    const confirmedAmount = result.confirmed.reduce((sum, entry) => sum.plus(entry.amount), new Prisma.Decimal(0));
    await this.audit.record("supplier_payable_reconciliation.confirm_payables", "supplier_payable_reconciliation", user.id, id, {
      reconciliation_no: result.current.reconciliationNo,
      supplier_id: result.current.supplierId,
      confirmed_count: result.confirmed.length,
      confirmed_amount: confirmedAmount.toFixed(4),
      skipped: result.skipped,
    });
    return {
      reconciliation_id: id,
      status: result.current.status,
      confirmed_count: result.confirmed.length,
      confirmed_amount: confirmedAmount.toFixed(4),
      skipped_count: result.skipped.length,
      skipped: result.skipped,
      entries: result.confirmed.map((entry) => ({ id: entry.id, payable_no: entry.payableNo, order_no: entry.orderNo, amount: entry.amount.toFixed(4), currency: entry.currency, status: "confirmed" })),
    };
  }

  /** 对账范围：供应商 + 币种 + 期间，可选收窄到订单/采购单。create / get / confirmPayables 必须完全一致。 */
  private entryScope(row: { supplierId: string; currency: string; orderNo: string | null | undefined; purchaseOrderId: string | null | undefined; periodStart: Date; periodEnd: Date }) {
    return {
      supplierId: row.supplierId,
      currency: row.currency,
      deletedAt: null,
      confirmationDate: { gte: row.periodStart, lte: row.periodEnd },
      ...(row.orderNo ? { orderNo: row.orderNo } : {}),
      ...(row.purchaseOrderId ? { purchaseOrderId: row.purchaseOrderId } : {}),
    };
  }

  private canConfirmPayables(status: string) { return status === "matched" || status === "resolved"; }

  private date(value: string) { const date = new Date(`${value}T00:00:00.000Z`); if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(date.valueOf())) throw this.invalid("INVALID_RECONCILIATION_PERIOD", "日期无效"); return date; }
  private decimal(value: string) { try { const n = new Prisma.Decimal(value); if (n.lt(0)) throw new Error(); return n; } catch { throw this.invalid("INVALID_EXTERNAL_BALANCE", "外部余额必须是有效的非负十进制数"); } }
  private number() { return `APREC-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomUUID().slice(0, 8).toUpperCase()}`; }
  private notFound(code: string, message: string) { return new NotFoundException({ code, message, details: [] }); }
  private invalid(code: string, message: string) { return new UnprocessableEntityException({ code, message, details: [] }); }
}
