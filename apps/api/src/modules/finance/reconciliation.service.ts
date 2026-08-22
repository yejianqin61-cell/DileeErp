import { Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { AuditService } from "../../platform/audit/audit.service";
import type { CurrentUser } from "../../platform/auth/auth.service";
import { PrismaService } from "../../platform/database/prisma.service";
import { ReceivableAdjustmentService } from "./receivable-adjustment.service";

export type ReconciliationInput = { order_no: string; period_start: string; period_end: string; external_balance: string; currency: string; attachment?: unknown[]; remark?: string };

@Injectable()
export class ReconciliationService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly adjustments: ReceivableAdjustmentService) {}

  async list(orderNo?: string, customerId?: string, status?: string) {
    return this.prisma.receivableReconciliation.findMany({ where: { deletedAt: null, ...(orderNo ? { orderNo } : {}), ...(customerId ? { customerId } : {}), ...(status ? { status } : {}) }, orderBy: { createdAt: "desc" } });
  }

  async get(id: string) {
    const row = await this.prisma.receivableReconciliation.findFirst({ where: { id, deletedAt: null } });
    if (!row) throw this.notFound("RECONCILIATION_NOT_FOUND", "应收对账不存在");
    return row;
  }

  async create(input: ReconciliationInput, user: CurrentUser) {
    const order = await this.prisma.salesOrder.findFirst({ where: { orderNo: input.order_no, deletedAt: null } });
    if (!order) throw this.notFound("SALES_ORDER_NOT_FOUND", "订单不存在");
    const periodStart = this.date(input.period_start, "INVALID_RECONCILIATION_PERIOD");
    const periodEnd = this.date(input.period_end, "INVALID_RECONCILIATION_PERIOD");
    if (periodStart > periodEnd) throw this.invalid("INVALID_RECONCILIATION_PERIOD", "对账开始日期不能晚于结束日期");
    const external = this.decimal(input.external_balance, "INVALID_EXTERNAL_BALANCE");
    const snapshot = await this.snapshot(input.order_no, periodStart, periodEnd, input.currency);
    const difference = snapshot.systemBalance.minus(external);
    const status = difference.eq(0) ? "matched" : "difference";
    const row = await this.prisma.receivableReconciliation.create({ data: {
      reconciliationNo: this.number("REC"), orderNo: input.order_no, salesOrderId: order.id, customerId: order.customerId,
      periodStart, periodEnd, receivableAmountSnapshot: snapshot.receivable, paymentAmountSnapshot: snapshot.paid,
      adjustmentAmountSnapshot: snapshot.adjustmentNet, systemBalance: snapshot.systemBalance, externalBalance: external,
      difference, currency: input.currency, status, attachment: (input.attachment ?? []) as Prisma.InputJsonValue, remark: input.remark, ...this.audit.create(user),
    } });
    await this.audit.recordWithOrderNo("receivable_reconciliation.create", "receivable_reconciliation", row.orderNo, user.id, row.id, { reconciliation_no: row.reconciliationNo, status, difference: difference.toString() });
    return row;
  }

  async resolve(id: string, resolutionRemark: string, user: CurrentUser) {
    if (!resolutionRemark?.trim()) throw this.invalid("RESOLUTION_REMARK_REQUIRED", "解决对账差异必须填写说明");
    const current = await this.get(id);
    if (current.status !== "difference") throw this.invalid("RECONCILIATION_NOT_RESOLVABLE", "只有存在差异的对账可以标记解决");
    const row = await this.prisma.receivableReconciliation.update({ where: { id }, data: { status: "resolved", resolutionRemark: resolutionRemark.trim(), ...this.audit.update(user) } });
    await this.audit.recordWithOrderNo("receivable_reconciliation.resolve", "receivable_reconciliation", row.orderNo, user.id, id, { resolution_remark: resolutionRemark.trim(), difference: row.difference.toString() });
    return row;
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

  private async snapshot(orderNo: string, from: Date, to: Date, currency: string) {
    const endExclusive = new Date(to.getTime() + 24 * 60 * 60 * 1000);
    const [sources, payments, adjustments] = await Promise.all([
      this.prisma.receivableSource.findMany({ where: { orderNo, currency, deletedAt: null, createdAt: { gte: from, lt: endExclusive }, status: { not: "cancelled" } } }),
      this.prisma.customerPayment.findMany({ where: { orderNo, currency, deletedAt: null, paymentDate: { gte: from, lte: to }, status: { in: ["posted", "unallocated"] } } }),
      this.prisma.receivableAdjustment.findMany({ where: { orderNo, currency, deletedAt: null, adjustmentDate: { gte: from, lte: to }, status: "posted" } }),
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
