import { Injectable, NotFoundException, UnprocessableEntityException, Optional } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { AuditService } from "../../platform/audit/audit.service";
import type { CurrentUser } from "../../platform/auth/auth.service";
import { CurrencyService } from "../../platform/currency/currency.service";
import { PrismaService } from "../../platform/database/prisma.service";
import { requireActiveBank } from "./bank-selection";
import { ReceivableAdjustmentService } from "./receivable-adjustment.service";

/**
 * 应收对账输入。
 *
 * 对账主键是「客户 + 期间」：`customer_id` 必填、`order_no` 可选（填了就把对账范围收窄到该订单）；
 * 只给 `order_no` 时客户由销售单反查，兼容 2026-09-14 之前按订单建对账的老调用方。
 */
export type ReconciliationInput = { order_no?: string; customer_id?: string; period_start: string; period_end: string; external_balance: string; currency: string; bank_id?: string; attachment?: unknown[]; remark?: string };

const STATUS_LABELS: Record<string, string> = { pending: "待处理", matched: "已对平", difference: "有差异", resolved: "差异已处理" };

@Injectable()
export class ReconciliationService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly adjustments: ReceivableAdjustmentService, @Optional() private readonly currencies?: CurrencyService) {}

  async list(orderNo?: string, customerId?: string, status?: string) {
    return this.prisma.receivableReconciliation.findMany({
      where: { deletedAt: null, ...(orderNo ? { orderNo } : {}), ...(customerId ? { customerId } : {}), ...(status ? { status } : {}) },
      include: { customer: { select: { id: true, name: true, customerCode: true } }, bank: { select: { id: true, bankName: true, accountNumber: true } } },
      orderBy: { createdAt: "desc" },
    });
  }

  /** 对账详情：对账快照字段 + 该客户/期间内纳入对账的应收条目（含待确认与已确认）。 */
  async get(id: string) {
    const row = await this.prisma.receivableReconciliation.findFirst({ where: { id, deletedAt: null }, include: { customer: { select: { id: true, name: true, customerCode: true } }, bank: { select: { id: true, bankName: true, accountNumber: true } } } });
    if (!row) throw this.notFound("RECONCILIATION_NOT_FOUND", "应收对账不存在");
    const entries = await this.entries(row);
    const draft = entries.filter((entry) => entry.status === "draft");
    return {
      ...row,
      status_label: STATUS_LABELS[row.status] ?? row.status,
      details: {
        entries,
        draft_entries: draft,
        entry_count: entries.length,
        draft_count: draft.length,
        draft_amount: draft.reduce((sum, entry) => sum.plus(entry.amount), new Prisma.Decimal(0)).toFixed(4),
        can_confirm_receivables: this.canConfirmReceivables(row.status) && draft.length > 0,
      },
    };
  }

  async create(input: ReconciliationInput, user: CurrentUser) {
    await this.currencies?.assertSupported(input.currency, "对账币种");
    // 回款银行来自银行账户池（财务 → 银行账户）：与应付对账同一套校验，停用/已删除的账户不能被选中。
    await requireActiveBank(this.prisma, input.bank_id, "回款银行不存在或已停用");
    const orderNo = input.order_no?.trim() || undefined;
    const order = orderNo ? await this.prisma.salesOrder.findFirst({ where: { orderNo, deletedAt: null } }) : null;
    if (orderNo && !order) throw this.notFound("SALES_ORDER_NOT_FOUND", "订单不存在");
    const customerId = order?.customerId ?? input.customer_id;
    if (!customerId) throw this.invalid("RECONCILIATION_CUSTOMER_REQUIRED", "对账必须指定客户（或给出可反查客户的订单号）");
    if (order && input.customer_id && order.customerId !== input.customer_id) throw this.invalid("RECONCILIATION_CUSTOMER_MISMATCH", "订单号与客户不匹配");
    const customer = await this.prisma.customer.findFirst({ where: { id: customerId, deletedAt: null }, select: { id: true } });
    if (!customer) throw this.notFound("CUSTOMER_NOT_FOUND", "客户不存在");
    const periodStart = this.date(input.period_start, "INVALID_RECONCILIATION_PERIOD");
    const periodEnd = this.date(input.period_end, "INVALID_RECONCILIATION_PERIOD");
    if (periodStart > periodEnd) throw this.invalid("INVALID_RECONCILIATION_PERIOD", "对账开始日期不能晚于结束日期");
    const external = this.decimal(input.external_balance, "INVALID_EXTERNAL_BALANCE");
    const scope = { orderNo, customerId };
    const snapshot = await this.snapshot(scope, periodStart, periodEnd, input.currency);
    const difference = snapshot.systemBalance.minus(external);
    const status = difference.eq(0) ? "matched" : "difference";
    const row = await this.prisma.receivableReconciliation.create({ data: {
      reconciliationNo: this.number("REC"), orderNo: orderNo ?? null, salesOrderId: order?.id ?? null, customerId,
      periodStart, periodEnd, receivableAmountSnapshot: snapshot.receivable, paymentAmountSnapshot: snapshot.paid,
      adjustmentAmountSnapshot: snapshot.adjustmentNet, systemBalance: snapshot.systemBalance, externalBalance: external,
      difference, currency: input.currency, bankId: input.bank_id || undefined, status, attachment: (input.attachment ?? []) as Prisma.InputJsonValue, remark: input.remark, ...this.audit.create(user),
    } });
    if (row.orderNo) await this.audit.recordWithOrderNo("receivable_reconciliation.create", "receivable_reconciliation", row.orderNo, user.id, row.id, { reconciliation_no: row.reconciliationNo, status, difference: difference.toString() });
    else await this.audit.record("receivable_reconciliation.create", "receivable_reconciliation", user.id, row.id, { reconciliation_no: row.reconciliationNo, customer_id: customerId, status, difference: difference.toString() });
    return row;
  }

  async resolve(id: string, resolutionRemark: string, user: CurrentUser) {
    if (!resolutionRemark?.trim()) throw this.invalid("RESOLUTION_REMARK_REQUIRED", "解决对账差异必须填写说明");
    const row = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM receivable_reconciliations WHERE id = ${id}::uuid FOR UPDATE`;
      const current = await tx.receivableReconciliation.findFirst({ where: { id, deletedAt: null } });
      if (!current) throw this.notFound("RECONCILIATION_NOT_FOUND", "应收对账不存在");
      if (current.status !== "difference") throw this.invalid("RECONCILIATION_NOT_RESOLVABLE", "只有存在差异的对账可以标记解决");
      return tx.receivableReconciliation.update({ where: { id }, data: { status: "resolved", resolutionRemark: resolutionRemark.trim(), ...this.audit.update(user) } });
    });
    if (row.orderNo) await this.audit.recordWithOrderNo("receivable_reconciliation.resolve", "receivable_reconciliation", row.orderNo, user.id, id, { resolution_remark: resolutionRemark.trim(), difference: row.difference.toString() });
    else await this.audit.record("receivable_reconciliation.resolve", "receivable_reconciliation", user.id, id, { resolution_remark: resolutionRemark.trim(), difference: row.difference.toString() });
    return row;
  }

  /**
   * 对账完成后批量确认该对账范围内的草稿应收：一次事务、逐条行锁。
   *
   * 为什么必须等对账完成：业务顺序是「先对账、再确认应收」。有未处理差异时批量确认会把
   * 还没核对清楚的金额直接记成生效应收，因此 `difference` 状态一律拒绝。
   * 逐条行锁与单条确认（ReceivableService.confirm）保持一致，避免与收款核销并发时状态错乱。
   */
  async confirmReceivables(id: string, user: CurrentUser) {
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM receivable_reconciliations WHERE id = ${id}::uuid FOR UPDATE`;
      const current = await tx.receivableReconciliation.findFirst({ where: { id, deletedAt: null }, include: { customer: { select: { id: true, name: true, customerCode: true } } } });
      if (!current) throw this.notFound("RECONCILIATION_NOT_FOUND", "应收对账不存在");
      if (!this.canConfirmReceivables(current.status)) throw this.invalid("RECONCILIATION_NOT_COMPLETED", `对账尚未完成（当前：${STATUS_LABELS[current.status] ?? current.status}），请先处理差异`);
      const scope = this.scopeWhere(current);
      const endExclusive = new Date(current.periodEnd.getTime() + 24 * 60 * 60 * 1000);
      const drafts = await tx.receivableSource.findMany({
        where: { ...scope, deletedAt: null, status: "draft", createdAt: { gte: current.periodStart, lt: endExclusive } },
        select: { id: true, sourceNo: true, orderNo: true, amount: true, currency: true },
        orderBy: { createdAt: "asc" },
      });
      for (const draft of drafts) {
        await tx.$queryRaw`SELECT id FROM receivable_sources WHERE id = ${draft.id}::uuid FOR UPDATE`;
        await tx.receivableSource.update({ where: { id: draft.id }, data: { status: "confirmed", ...this.audit.update(user) } });
      }
      return { current, drafts };
    });
    const confirmedAmount = result.drafts.reduce((sum, draft) => sum.plus(draft.amount), new Prisma.Decimal(0));
    await this.audit.record("receivable_reconciliation.confirm_receivables", "receivable_reconciliation", user.id, id, {
      reconciliation_no: result.current.reconciliationNo,
      customer_id: result.current.customerId,
      confirmed_count: result.drafts.length,
      confirmed_amount: confirmedAmount.toFixed(4),
      source_nos: result.drafts.map((draft) => draft.sourceNo),
    });
    return {
      reconciliation_id: id,
      status: result.current.status,
      confirmed_count: result.drafts.length,
      confirmed_amount: confirmedAmount.toFixed(4),
      entries: result.drafts.map((draft) => ({ id: draft.id, source_no: draft.sourceNo, order_no: draft.orderNo, amount: draft.amount.toFixed(4), currency: draft.currency, status: "confirmed" })),
    };
  }

  async orderClosePreview(orderNo: string) {
    const order = await this.prisma.salesOrder.findFirst({ where: { orderNo, deletedAt: null } });
    if (!order) throw this.notFound("SALES_ORDER_NOT_FOUND", "订单不存在");
    const [productionOrders, outbounds, reconciliations, adjustments, summary] = await Promise.all([
      this.prisma.productionOrder.findMany({ where: { orderNo, deletedAt: null }, select: { id: true, productionOrderNo: true, status: true, executionMode: true } }),
      this.prisma.finishedGoodsOutbound.findMany({ where: { orderNo, deletedAt: null, status: { in: ["posted", "shipped", "signed"] } }, select: { quantity: true, status: true } }),
      this.prisma.receivableReconciliation.count({ where: { orderNo, deletedAt: null, status: { in: ["pending", "difference"] } } }),
      this.prisma.receivableAdjustment.count({ where: { orderNo, deletedAt: null, status: "posted" } }),
      this.adjustments.orderNetSummary(orderNo),
    ]);
    const productionComplete = productionOrders.length > 0 && productionOrders.every((row) => ["completed", "closed"].includes(row.status));
    const outboundQuantity = outbounds.reduce((sum, row) => sum.plus(row.quantity), new Prisma.Decimal(0));
    const outboundComplete = outboundQuantity.gte(order.quantity);
    const blockers: Array<{ code: string; message: string; details?: unknown }> = [];
    if (!productionComplete) blockers.push({ code: "PRODUCTION_NOT_COMPLETE", message: "生产尚未全部完成", details: { production_orders: productionOrders } });
    if (!outboundComplete) blockers.push({ code: "OUTBOUND_NOT_COMPLETE", message: "成品尚未全部出库", details: { planned_quantity: order.quantity.toString(), outbound_quantity: outboundQuantity.toString() } });
    if (new Prisma.Decimal(summary.outstanding_amount).gt(0)) blockers.push({ code: "RECEIVABLE_OUTSTANDING", message: "应收尚未收清", details: { outstanding_amount: summary.outstanding_amount } });
    if (reconciliations > 0) blockers.push({ code: "UNRESOLVED_RECONCILIATION", message: "存在未处理对账差异", details: { count: reconciliations } });
    if (adjustments > 0) blockers.push({ code: "UNREVERSED_ADJUSTMENT", message: "存在未冲销财务调整", details: { count: adjustments } });
    return { order_no: orderNo, production_complete: productionComplete, outbound_complete: outboundComplete, receivable_net_amount: summary.receivable_net_amount, paid_amount: summary.paid_amount, outstanding_amount: summary.outstanding_amount, unresolved_reconciliation_count: reconciliations, unreversed_adjustment_count: adjustments, can_close: blockers.length === 0, blockers };
  }

  /** 对账范围：有订单号时收窄到该订单，否则按客户。与 create 的快照口径必须完全一致。 */
  private scopeWhere(row: { orderNo: string | null; customerId: string }) {
    return row.orderNo ? { orderNo: row.orderNo } : { customerId: row.customerId };
  }

  private canConfirmReceivables(status: string) { return status === "matched" || status === "resolved"; }

  /** 纳入对账的应收条目：期间内、非取消，附带已核销/未收余额（列表与详情共用一个口径）。 */
  private async entries(row: { orderNo: string | null; customerId: string; periodStart: Date; periodEnd: Date; currency: string }) {
    const endExclusive = new Date(row.periodEnd.getTime() + 24 * 60 * 60 * 1000);
    const rows = await this.prisma.receivableSource.findMany({
      where: { ...this.scopeWhere(row), currency: row.currency, deletedAt: null, status: { not: "cancelled" }, createdAt: { gte: row.periodStart, lt: endExclusive } },
      include: {
        customer: { select: { id: true, name: true, customerCode: true } },
        outbound: { select: { outboundNo: true, status: true, productNameSnapshot: true, productSpecificationSnapshot: true, signedAt: true, shipmentDate: true } },
        allocations: { where: { deletedAt: null, status: "active" }, include: { payment: { select: { id: true, paymentNo: true, status: true, paymentDate: true } } } },
      },
      orderBy: { createdAt: "asc" },
    });
    return rows.map((source) => {
      const allocated = source.allocations.filter((item) => item.payment?.status === "posted").reduce((sum, item) => sum.plus(item.amount), new Prisma.Decimal(0));
      return { ...source, allocated_amount: allocated.toFixed(4), outstanding_amount: source.amount.minus(allocated).toFixed(4) };
    });
  }

  private async snapshot(scope: { orderNo?: string; customerId: string }, from: Date, to: Date, currency: string) {
    const endExclusive = new Date(to.getTime() + 24 * 60 * 60 * 1000);
    const where = { ...this.scopeWhere({ orderNo: scope.orderNo ?? null, customerId: scope.customerId }), currency, deletedAt: null };
    const [sources, payments, adjustments] = await Promise.all([
      this.prisma.receivableSource.findMany({ where: { ...where, createdAt: { gte: from, lt: endExclusive }, status: { not: "cancelled" } } }),
      this.prisma.customerPayment.findMany({ where: { ...where, paymentDate: { gte: from, lte: to }, status: "posted" } }),
      this.prisma.receivableAdjustment.findMany({ where: { ...where, adjustmentDate: { gte: from, lte: to }, status: "posted" } }),
    ]);
    const receivable = sources.reduce((sum, row) => sum.plus(row.amount), new Prisma.Decimal(0));
    const paid = payments.reduce((sum, row) => sum.plus(row.amount), new Prisma.Decimal(0));
    const adjustmentNet = adjustments.reduce((sum, row) => sum.plus(row.effect === "increase" ? row.amount : row.amount.negated()), new Prisma.Decimal(0));
    return { receivable, paid, adjustmentNet, systemBalance: receivable.plus(adjustmentNet).minus(paid) };
  }

  private decimal(value: string, code: string) { try { const result = new Prisma.Decimal(value); if (result.lt(0)) throw new Error(); return result; } catch { throw this.invalid(code, "金额必须是有效的非负十进制数"); } }
  private date(value: string, code: string) { const result = new Date(`${value}T00:00:00.000Z`); if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(result.valueOf())) throw this.invalid(code, "日期无效"); return result; }
  private number(prefix: string) { return `${prefix}-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomUUID().slice(0, 8).toUpperCase()}`; }
  private notFound(code: string, message: string) { return new NotFoundException({ code, message, details: [] }); }
  private invalid(code: string, message: string) { return new UnprocessableEntityException({ code, message, details: [] }); }
}
