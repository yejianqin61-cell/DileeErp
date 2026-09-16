import { Injectable, NotFoundException, UnprocessableEntityException, Optional } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { AuditService } from "../../platform/audit/audit.service";
import type { CurrentUser } from "../../platform/auth/auth.service";
import { CurrencyService } from "../../platform/currency/currency.service";
import { PrismaService } from "../../platform/database/prisma.service";
import { requireActiveBank } from "./bank-selection";
import { CashFlowService } from "./cash-flow.service";
import { ReceivableAdjustmentService } from "./receivable-adjustment.service";
import { receivableInReconciliationScope } from "./receivable.domain";
import { RECEIVABLE_CONFIRM_ITEM_KEYS } from "./cash-flow-catalog";

/**
 * 应收对账输入。
 *
 * 对账主键是「客户 + 期间」：`customer_id` 必填、`order_no` 可选（填了就把对账范围收窄到该订单）；
 * 只给 `order_no` 时客户由销售单反查，兼容 2026-09-14 之前按订单建对账的老调用方。
 */
export type ReconciliationInput = { order_no?: string; customer_id?: string; period_start: string; period_end: string; external_balance: string; currency: string; bank_id?: string; cash_flow_item_id?: string; attachment?: unknown[]; remark?: string };

const STATUS_LABELS: Record<string, string> = { pending: "待处理", matched: "已对平", difference: "有差异", resolved: "差异已处理" };

/**
 * 一行对账的流转摘要（2026-09-16 起，与应付侧 `flow` 对称）。
 *
 * 为什么列表也要算：对账单行上要能直接看到「覆盖多少条应收、其中多少条待确认」以及
 * 「这批货对应哪些订单、什么产品/规格」，并且只在该确认的时候才给「一键确认应收」按钮
 * （范围内没有草稿时那个按钮点了也只是空转）。
 */
type ReconciliationFlow = {
  entry_count: number;
  draft_count: number;
  draft_amount: string;
  can_confirm_receivables: boolean;
  order_nos: string[];
  product_names: string[];
  product_specifications: string[];
};

@Injectable()
export class ReconciliationService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly adjustments: ReceivableAdjustmentService, private readonly cashFlow: CashFlowService, @Optional() private readonly currencies?: CurrencyService) {}

  /**
   * 对账列表。
   *
   * 2026-09-16：每行带上 `flow`（覆盖多少条应收、其中多少条待确认、覆盖哪些订单与产品），
   * 与应付对账列表同一套写法 —— 列表行上就能看到「这批货对的是什么、下一步能不能一键确认」。
   */
  async list(orderNo?: string, customerId?: string, status?: string) {
    const rows = await this.prisma.receivableReconciliation.findMany({
      where: { deletedAt: null, ...(orderNo ? { orderNo } : {}), ...(customerId ? { customerId } : {}), ...(status ? { status } : {}) },
      include: { customer: { select: { id: true, name: true, customerCode: true } }, bank: { select: { id: true, bankName: true, accountNumber: true } } },
      orderBy: { createdAt: "desc" },
    });
    const flows = await this.flows(rows);
    return rows.map((row) => ({ ...row, flow: flows.get(row.id) ?? this.emptyFlow() }));
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
      // 详情也带 flow：列表与详情用同一份摘要（订单号 / 产品名称 / 规格型号），
      // 前端不必为「详情里显示什么」再维护一套口径。
      flow: this.summarize(entries, row.status),
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
    // 收支项目建单时就校验并落库：确认应收要按它把货款归到某个项目上，报表才能按项目统计。
    const cashFlowItem = await this.cashFlow.requireItem(input.cash_flow_item_id, "收支项目不存在或已停用，请在「收支管理 → 收支项目」里确认");
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
      difference, currency: input.currency, bankId: input.bank_id || undefined, cashFlowItemId: cashFlowItem?.id, status, attachment: (input.attachment ?? []) as Prisma.InputJsonValue, remark: input.remark, ...this.audit.create(user),
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
   * 确认即记账：把本次确认的金额作为**收入流水**写进收支流水，落到对账单的银行账户上
   * （用户要求：「一旦确认应收，金额就要进入对应的账户」）。
   *
   * 为什么必须等对账完成：业务顺序是「先对账、再确认应收」。有未处理差异时批量确认会把
   * 还没核对清楚的金额直接记成生效应收，因此 `difference` 状态一律拒绝。
   * 逐条行锁与单条确认（ReceivableService.confirm）保持一致，避免与收款核销并发时状态错乱。
   *
   * `override`：确认时补/改银行账户与收支项目（历史对账单可能没填）。给了就**回写**到对账单上，
   * 让「单子上写的」与「实际记账用的」永远一致 —— 否则账记在 A 银行、单子上写着 B 银行，
   * 对账时根本查不出这笔钱去哪了。
   */
  async confirmReceivables(id: string, user: CurrentUser, override: { bank_id?: string | null; cash_flow_item_id?: string | null } = {}) {
    // **先进校验、后进事务**：如果等事务提交完才发现银行非法，应收已经被确认、流水却没写，
    // 账面上凭空少一笔钱，比直接拒绝糟得多（确认与记账必须同生共死）。
    if (override.bank_id) await requireActiveBank(this.prisma, override.bank_id, "回款银行不存在或已停用");
    if (override.cash_flow_item_id) await this.cashFlow.requireItem(override.cash_flow_item_id, "收支项目不存在或已停用，请在「收支管理 → 收支项目」里确认");
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM receivable_reconciliations WHERE id = ${id}::uuid FOR UPDATE`;
      const current = await tx.receivableReconciliation.findFirst({ where: { id, deletedAt: null }, include: { customer: { select: { id: true, name: true, customerCode: true } } } });
      if (!current) throw this.notFound("RECONCILIATION_NOT_FOUND", "应收对账不存在");
      if (!this.canConfirmReceivables(current.status)) throw this.invalid("RECONCILIATION_NOT_COMPLETED", `对账尚未完成（当前：${STATUS_LABELS[current.status] ?? current.status}），请先处理差异`);
      const scope = this.scopeWhere(current);
      const endExclusive = this.endExclusive(current.periodEnd);
      const drafts = await tx.receivableSource.findMany({
        where: { ...scope, deletedAt: null, status: "draft", createdAt: { gte: current.periodStart, lt: endExclusive } },
        select: { id: true, sourceNo: true, orderNo: true, amount: true, currency: true },
        orderBy: { createdAt: "asc" },
      });
      for (const draft of drafts) {
        await tx.$queryRaw`SELECT id FROM receivable_sources WHERE id = ${draft.id}::uuid FOR UPDATE`;
        await tx.receivableSource.update({ where: { id: draft.id }, data: { status: "confirmed", ...this.audit.update(user) } });
      }
      // 银行/项目在事务外校验会拿到未加锁的状态；这里的取值规则与「不传则用单子上的」一致。
      const bankId = override.bank_id === undefined ? current.bankId : (override.bank_id || null);
      const cashFlowItemId = override.cash_flow_item_id === undefined ? current.cashFlowItemId : (override.cash_flow_item_id || null);
      if (bankId !== current.bankId || cashFlowItemId !== current.cashFlowItemId) {
        await tx.receivableReconciliation.update({ where: { id }, data: { bankId, cashFlowItemId, ...this.audit.update(user) } });
      }
      return { current, drafts, bankId, cashFlowItemId };
    });
    const confirmedAmount = result.drafts.reduce((sum, draft) => sum.plus(draft.amount), new Prisma.Decimal(0));
    // 确认即记账：金额进对账单指定的银行账户。没有银行账户时流水照样写（收支事实不能丢），
    // 但它不属于任何账户，因此不进任何账户余额 —— 用 bank_missing 明确告诉界面提示财务。
    const cashFlow = await this.cashFlow.recordConfirmation({
      sourceType: "receivable_reconciliation",
      sourceId: id,
      documentNo: result.current.reconciliationNo,
      entryDate: this.today(),
      amount: confirmedAmount,
      currency: result.current.currency,
      counterpartyName: result.current.customer?.name ?? result.current.customerId,
      direction: "income",
      itemKeys: RECEIVABLE_CONFIRM_ITEM_KEYS,
      itemId: result.cashFlowItemId,
      bankId: result.bankId,
      remark: `应收对账确认（${result.drafts.length} 条）`,
    }, user);
    await this.audit.record("receivable_reconciliation.confirm_receivables", "receivable_reconciliation", user.id, id, {
      reconciliation_no: result.current.reconciliationNo,
      customer_id: result.current.customerId,
      confirmed_count: result.drafts.length,
      confirmed_amount: confirmedAmount.toFixed(4),
      bank_id: result.bankId,
      cash_flow_entry_id: cashFlow?.id ?? null,
      source_nos: result.drafts.map((draft) => draft.sourceNo),
    });
    return {
      reconciliation_id: id,
      status: result.current.status,
      confirmed_count: result.drafts.length,
      confirmed_amount: confirmedAmount.toFixed(4),
      currency: result.current.currency,
      bank_id: result.bankId,
      cash_flow_item_id: result.cashFlowItemId,
      cash_flow_entry_id: cashFlow?.id ?? null,
      /** 没指定银行账户：钱记进了收支流水，但不会体现在任何银行余额里，界面必须提示。 */
      bank_missing: !result.bankId,
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

  /**
   * 一次取回多张对账范围内的应收条目 → 逐行摘要。
   *
   * 与应付侧同一套写法：一次 `findMany`（OR 精确复刻各行范围）后在内存里用
   * `receivableInReconciliationScope` 过滤，避免每行一次 N+1，也保证与快照/批量确认同口径。
   */
  private async flows(rows: Array<{ id: string; status: string; customerId: string; orderNo: string | null; currency: string; periodStart: Date; periodEnd: Date }>) {
    const map = new Map<string, ReconciliationFlow>();
    if (!rows.length) return map;
    const entries = (await this.prisma.receivableSource.findMany({
      where: { OR: rows.map((row) => ({ ...this.scopeWhere(row), currency: row.currency, deletedAt: null, status: { not: "cancelled" }, createdAt: { gte: row.periodStart, lt: this.endExclusive(row.periodEnd) } })) },
      include: { outbound: { select: { productNameSnapshot: true, productSpecificationSnapshot: true } } },
      orderBy: { createdAt: "asc" },
    })) as Array<{ id: string; orderNo: string; customerId: string; currency: string; createdAt: Date; amount: Prisma.Decimal; status: string; outbound?: { productNameSnapshot: string | null; productSpecificationSnapshot: string | null } | null }>;
    for (const row of rows) {
      map.set(row.id, this.summarize(entries.filter((entry) => receivableInReconciliationScope(entry, row)), row.status));
    }
    return map;
  }

  /** 一组应收条目 → 流转摘要（覆盖条数、待确认、订单号、产品名称与规格型号）。 */
  private summarize(entries: Array<{ orderNo: string | null; amount: Prisma.Decimal; status: string; outbound?: { productNameSnapshot: string | null; productSpecificationSnapshot: string | null } | null }>, status: string): ReconciliationFlow {
    const drafts = entries.filter((entry) => entry.status === "draft");
    const draftAmount = drafts.reduce((sum, entry) => sum.plus(entry.amount), new Prisma.Decimal(0));
    return {
      entry_count: entries.length,
      draft_count: drafts.length,
      draft_amount: draftAmount.toFixed(4),
      can_confirm_receivables: this.canConfirmReceivables(status) && drafts.length > 0,
      order_nos: [...new Set(entries.map((entry) => entry.orderNo).filter((value): value is string => Boolean(value)))],
      product_names: [...new Set(entries.map((entry) => entry.outbound?.productNameSnapshot).filter((value): value is string => Boolean(value)))],
      product_specifications: [...new Set(entries.map((entry) => entry.outbound?.productSpecificationSnapshot).filter((value): value is string => Boolean(value)))],
    };
  }

  private emptyFlow(): ReconciliationFlow {
    return { entry_count: 0, draft_count: 0, draft_amount: "0.0000", can_confirm_receivables: false, order_nos: [], product_names: [], product_specifications: [] };
  }

  /** 期间右端：含结束日整天（对账期间是日期，业务事实的时间戳带时分秒）。 */
  private endExclusive(periodEnd: Date) { return new Date(periodEnd.getTime() + 24 * 60 * 60 * 1000); }

  /** 纳入对账的应收条目：期间内、非取消，附带已核销/未收余额（列表与详情共用一个口径）。 */
  private async entries(row: { orderNo: string | null; customerId: string; periodStart: Date; periodEnd: Date; currency: string }) {
    const rows = await this.prisma.receivableSource.findMany({
      where: { ...this.scopeWhere(row), currency: row.currency, deletedAt: null, status: { not: "cancelled" }, createdAt: { gte: row.periodStart, lt: this.endExclusive(row.periodEnd) } },
      include: {
        customer: { select: { id: true, name: true, customerCode: true } },
        outbound: { select: { outboundNo: true, status: true, productNameSnapshot: true, productSpecificationSnapshot: true, signedAt: true, shipmentDate: true } },
        allocations: { where: { deletedAt: null, status: "active" }, include: { payment: { select: { id: true, paymentNo: true, status: true, paymentDate: true } } } },
      },
      orderBy: { createdAt: "asc" },
    });
    return rows.map((source) => {
      const allocated = source.allocations.filter((item) => item.payment?.status === "posted").reduce((sum, item) => sum.plus(item.amount), new Prisma.Decimal(0));
      // 产品名称/规格型号与「成品出库条目」列表同一口径（出库快照），对账详情据此展示「这批货是什么」。
      return { ...source, product_name: source.outbound?.productNameSnapshot ?? null, product_specification: source.outbound?.productSpecificationSnapshot ?? null, allocated_amount: allocated.toFixed(4), outstanding_amount: source.amount.minus(allocated).toFixed(4) };
    });
  }

  private async snapshot(scope: { orderNo?: string; customerId: string }, from: Date, to: Date, currency: string) {
    const endExclusive = this.endExclusive(to);
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
  /** 确认发生的日期（记账日）：取当天的 UTC 零点，让流水日期与「今天」在库里可比较、可复现。 */
  private today() { return new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`); }
  private date(value: string, code: string) { const result = new Date(`${value}T00:00:00.000Z`); if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(result.valueOf())) throw this.invalid(code, "日期无效"); return result; }
  private number(prefix: string) { return `${prefix}-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomUUID().slice(0, 8).toUpperCase()}`; }
  private notFound(code: string, message: string) { return new NotFoundException({ code, message, details: [] }); }
  private invalid(code: string, message: string) { return new UnprocessableEntityException({ code, message, details: [] }); }
}
