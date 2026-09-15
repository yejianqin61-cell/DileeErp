import { Injectable, NotFoundException, UnprocessableEntityException, Optional } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { AuditService } from "../../platform/audit/audit.service";
import type { CurrentUser } from "../../platform/auth/auth.service";
import { CurrencyService } from "../../platform/currency/currency.service";
import { PrismaService } from "../../platform/database/prisma.service";
import { receivableAmountFor, receivableUnitPrice, settlementRemark } from "../warehouse/finished-goods-settlement";
import { coveringReceivableReconciliation } from "./receivable.domain";

@Injectable()
export class ReceivableService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, @Optional() private readonly currencies?: CurrencyService) {}

  /**
   * 应收来源列表。
   *
   * 财务页面按「成品出库条目」展示，必须能一眼看到客户名称、出库单号和未收余额：
   * 只给 UUID 的列表对账时根本没法核对（宪法/规格：列表以订单号、来源编号、客户名称展示，UUID 仅作内部关联键）。
   *
   * 2026-09-16：每条再带上**覆盖它的对账单**（`reconciliation`）。为什么由服务端算：对账范围是
   * 「订单号（填了才收窄）或客户 + 币种 + 期间」，前端自己推一遍必然与服务端漂移
   * （与应付侧 `coveringPayableReconciliation` 同一处理）。用途是「待创建对账」只列**没被覆盖**的草稿，
   * 已被覆盖的要显式说明它进了哪张对账单 —— 否则用户会以为这条应收「没流转过去」。
   */
  async list(orderNo?: string, customerId?: string, status?: string) {
    const rows = await this.prisma.receivableSource.findMany({
      where: { deletedAt: null, ...(orderNo ? { orderNo } : {}), ...(customerId ? { customerId } : {}), ...(status ? { status } : {}) },
      include: {
        customer: { select: { id: true, name: true, customerCode: true } },
        outbound: { select: { outboundNo: true, status: true, productNameSnapshot: true, productSpecificationSnapshot: true, signedAt: true, shipmentDate: true } },
        allocations: { where: { deletedAt: null }, include: { payment: { select: { id: true, paymentNo: true, status: true, paymentDate: true } } } },
      },
      orderBy: { createdAt: "desc" },
    });
    const customerIds = [...new Set(rows.map((row) => row.customerId))];
    // 两种对账都要找出来：按客户建的（customerId 命中）与按订单建的（orderNo 命中）。
    // 只按 customerId 查会漏掉「对账的客户 ≠ 条目上带的客户」这种数据不一致的历史行，
    // 而按订单匹配本来就不看客户；OR 查询一并覆盖，代价只是多带一个索引条件。
    const orderNos = [...new Set(rows.map((row) => row.orderNo).filter((value): value is string => Boolean(value)))];
    const scopes = customerIds.length
      ? await this.prisma.receivableReconciliation.findMany({
        where: { deletedAt: null, OR: [{ customerId: { in: customerIds } }, ...(orderNos.length ? [{ orderNo: { in: orderNos } }] : [])] },
        select: { id: true, reconciliationNo: true, status: true, customerId: true, orderNo: true, currency: true, periodStart: true, periodEnd: true },
        orderBy: { createdAt: "desc" },
      })
      : [];
    return rows.map((row) => {
      const allocated = row.allocations.filter((item) => item.status === "active" && item.payment?.status === "posted").reduce((sum, item) => sum.plus(item.amount), new Prisma.Decimal(0));
      const covering = coveringReceivableReconciliation(row, scopes);
      return {
        ...row,
        customer_name: row.customer?.name ?? null,
        customer_code: row.customer?.customerCode ?? null,
        outbound_no: row.outbound?.outboundNo ?? null,
        product_name: row.outbound?.productNameSnapshot ?? null,
        product_specification: row.outbound?.productSpecificationSnapshot ?? null,
        allocated_amount: allocated.toFixed(4),
        outstanding_amount: row.amount.minus(allocated).toFixed(4),
        reconciliation: covering ? { id: covering.id, reconciliation_no: covering.reconciliationNo, status: covering.status, period_start: covering.periodStart, period_end: covering.periodEnd } : null,
      };
    });
  }
  async get(id: string) {
    const row = await this.prisma.receivableSource.findFirst({
      where: { id, deletedAt: null },
      include: {
        customer: { select: { id: true, name: true, customerCode: true } },
        allocations: { where: { deletedAt: null }, include: { payment: { select: { id: true, paymentNo: true, status: true, paymentDate: true, amount: true, currency: true } } } },
        outbound: {
          include: {
            productionOrder: {
              include: {
                finishedGoodsInspections: {
                  include: { qcRecords: true, finishedGoodsInbounds: true },
                  orderBy: { createdAt: "asc" },
                },
              },
            },
          },
        },
      },
    });
    if (!row) throw this.notFound("RECEIVABLE_SOURCE_NOT_FOUND", "应收来源不存在");
    const allocated = row.allocations.filter((item) => item.status === "active" && item.payment?.status === "posted").reduce((sum, item) => sum.plus(item.amount), new Prisma.Decimal(0));
    return { ...row, allocated_amount: allocated.toFixed(4), outstanding_amount: row.amount.minus(allocated).toFixed(4) };
  }

  async createFromOutbound(outboundId: string, input: { amount?: string; amount_reason?: string; due_date?: string; remark?: string }, user: CurrentUser) {
    const row = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM finished_goods_outbounds WHERE id = ${outboundId}::uuid FOR UPDATE`;
      const outbound = await tx.finishedGoodsOutbound.findFirst({ where: { id: outboundId, deletedAt: null, status: { in: ["posted", "shipped", "signed"] } }, include: { salesOrder: true } });
      if (!outbound) throw this.notFound("OUTBOUND_NOT_RECEIVABLE", "出库不存在或尚未过账");
      const existing = await tx.receivableSource.findUnique({ where: { outboundId } });
      if (existing) {
        if (!existing.deletedAt) return existing;
        return tx.receivableSource.update({ where: { id: existing.id }, data: { deletedAt: null, deletedBy: null, ...this.audit.update(user) } });
      }
      // 与出库过账共用同一计价口径（应收金额/结算币价/销售单价），避免两条路径给出不同金额。
      const unitPrice = receivableUnitPrice(outbound.salesOrder);
      const amount = input.amount ?? (unitPrice ? receivableAmountFor(outbound.salesOrder, unitPrice, outbound.quantity).toFixed(4) : undefined);
      // 与出库过账同一口径：金额必须大于 0（"0.0000" 是字符串/Decimal(0) 对象，都是真值，不能只看空）。
      const positive = (() => { try { const value = amount === undefined ? null : new Prisma.Decimal(amount); return value && value.gt(0) ? value : null; } catch { return null; } })();
      if (!positive) throw new UnprocessableEntityException({ code: "RECEIVABLE_AMOUNT_REQUIRED", message: "应收金额必须大于 0：销售单没有有效单价，请填写应收金额", details: [] });
      if (!input.amount_reason?.trim() && !unitPrice) throw new UnprocessableEntityException({ code: "RECEIVABLE_AMOUNT_REASON_REQUIRED", message: "手工确认金额必须填写原因", details: [] });
      return tx.receivableSource.create({ data: { sourceNo: this.number("AR"), orderNo: outbound.orderNo, salesOrderId: outbound.salesOrderId, outboundId: outbound.id, customerId: outbound.salesOrder.customerId, quantity: outbound.quantity, unit: outbound.salesOrder.unit, unitPrice, taxRate: outbound.salesOrder.taxRate, amount: positive, currency: outbound.salesOrder.currency, amountReason: input.amount_reason, dueDate: input.due_date ? this.date(input.due_date) : undefined, signedAtSnapshot: outbound.signedAt, remark: input.remark ?? (unitPrice ? settlementRemark(outbound.salesOrder, unitPrice, outbound.quantity) : undefined), ...this.audit.create(user) } });
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

  /**
   * 按订单号批量确认该订单下所有草稿应收（解决「同一订单多次出库 → 逐条确认」的重复操作）。
   * 幂等：只确认状态为 draft 的条目，已确认/已取消的自动跳过。
   */
  async batchConfirmByOrder(orderNo: string, user: CurrentUser) {
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM receivable_sources WHERE order_no = ${orderNo} AND deleted_at IS NULL AND status = 'draft' FOR UPDATE`;
      const drafts = await tx.receivableSource.findMany({
        where: { orderNo, deletedAt: null, status: "draft" },
        select: { id: true, sourceNo: true },
      });
      if (!drafts.length) throw this.notFound("NO_DRAFT_RECEIVABLES", `订单 ${orderNo} 没有草稿应收条目`);
      const ids = drafts.map((item) => item.id);
      await tx.receivableSource.updateMany({
        where: { id: { in: ids }, deletedAt: null, status: "draft" },
        data: { status: "confirmed", ...this.audit.update(user) },
      });
      return { orderNo, count: drafts.length, ids };
    });
    for (const id of result.ids) {
      await this.audit.record("receivable_source.confirm", "receivable_source", user.id, id, { order_no: result.orderNo, batch: true });
    }
    return result;
  }
  /**
   * 编辑草稿应收来源：金额、到期日、金额原因、**币种**、备注。
   *
   * 币种默认由销售订单带出（createFromOutbound），草稿期间允许改成实际结算币种；
   * 一旦确认/收款核销，收款币种必须与来源币种一致（CustomerPaymentService.post 会逐条校验），因此改完要同步收款单。
   */
  async updateDraft(id: string, input: { amount?: string; due_date?: string; amount_reason?: string; currency?: string; remark?: string }, user: CurrentUser) {
    if (input.currency !== undefined) await this.currencies?.assertSupported(input.currency, "应收币种");
    const row = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM receivable_sources WHERE id = ${id}::uuid FOR UPDATE`;
      const current = await tx.receivableSource.findFirst({ where: { id, deletedAt: null } });
      if (!current) throw this.notFound("RECEIVABLE_SOURCE_NOT_FOUND", "应收来源不存在");
      if (current.status !== "draft") throw this.invalid("RECEIVABLE_SOURCE_NOT_EDITABLE", "只有草稿应收来源可以编辑");
      let amount = current.amount;
      if (input.amount !== undefined) {
        try { amount = new Prisma.Decimal(input.amount); if (amount.lte(0)) throw new Error(); } catch { throw this.invalid("INVALID_RECEIVABLE_AMOUNT", "应收金额必须是大于零的十进制数"); }
      }
      return tx.receivableSource.update({ where: { id }, data: { amount, dueDate: input.due_date ? this.date(input.due_date) : current.dueDate, amountReason: input.amount_reason ?? current.amountReason, currency: input.currency ?? current.currency, remark: input.remark ?? current.remark, ...this.audit.update(user) } });
    });
    await this.audit.record("receivable_source.update", "receivable_source", user.id, id, { order_no: row.orderNo, amount: row.amount.toString() });
    return row;
  }

  async reopen(id: string, reason: string, user: CurrentUser) {
    if (!reason?.trim()) throw new UnprocessableEntityException({ code: "CORRECTION_REASON_REQUIRED", message: "回退草稿必须填写原因", details: [] });
    const row = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM receivable_sources WHERE id = ${id}::uuid FOR UPDATE`;
      const current = await tx.receivableSource.findFirst({ where: { id, deletedAt: null }, include: { allocations: { where: { deletedAt: null, status: "active" }, include: { payment: true } } } });
      if (!current) throw this.notFound("RECEIVABLE_SOURCE_NOT_FOUND", "应收来源不存在");
      if (current.status !== "confirmed") throw this.invalid("RECEIVABLE_SOURCE_NOT_REOPENABLE", "只有未发生收款的已确认应收来源可以回退草稿");
      if (current.allocations.some((allocation) => allocation.payment.status === "posted")) throw this.invalid("RECEIVABLE_SOURCE_HAS_ALLOCATIONS", "应收来源存在有效收款核销，必须先冲销收款");
      return tx.receivableSource.update({ where: { id }, data: { status: "draft", remark: `${current.remark ?? ""}\n回退草稿：${reason.trim()}`, ...this.audit.update(user) } });
    });
    await this.audit.record("receivable_source.reopen", "receivable_source", user.id, id, { order_no: row.orderNo, reason: reason.trim(), from: "confirmed", to: "draft" });
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
  async impactPreview(id: string) {
    const row = await this.get(id);
    const allocated = row.allocations.reduce((sum, item) => sum.plus(item.amount), new Prisma.Decimal(0));
    const inspections = row.outbound.productionOrder?.finishedGoodsInspections ?? [];
    return {
      source_id: id,
      order_no: row.orderNo,
      status: row.status,
      amount: row.amount.toString(),
      allocated_amount: allocated.toString(),
      unallocated_amount: row.amount.minus(allocated).toString(),
      allocation_count: row.allocations.length,
      source_trace: {
        outbound: { id: row.outbound.id, outbound_no: row.outbound.outboundNo, status: row.outbound.status },
        qc_records: inspections.flatMap((submission) => submission.qcRecords.map((qc) => ({ id: qc.id, qc_no: qc.qcNo, conclusion: qc.conclusion, status: qc.status }))),
        finished_goods_inbounds: inspections.flatMap((submission) => submission.finishedGoodsInbounds.map((inbound) => ({ id: inbound.id, inbound_no: inbound.inboundNo, status: inbound.status, quantity: inbound.quantity.toString() }))),
      },
    };
  }
  async orderSummary(orderNo: string) { const rows = await this.prisma.receivableSource.findMany({ where: { orderNo, deletedAt: null }, include: { allocations: { where: { deletedAt: null, status: "active" }, include: { payment: true } } } }); const amount = rows.reduce((sum, row) => sum.plus(row.amount), new Prisma.Decimal(0)); const allocated = rows.reduce((sum, row) => sum.plus(row.allocations.filter((item) => item.payment.status === "posted").reduce((inner, item) => inner.plus(item.amount), new Prisma.Decimal(0))), new Prisma.Decimal(0)); return { order_no: orderNo, source_count: rows.length, receivable_amount: amount.toString(), allocated_amount: allocated.toString(), outstanding_amount: amount.minus(allocated).toString() }; }
  async allocationBalance(id: string, client: PrismaService | Prisma.TransactionClient = this.prisma) { const source = await client.receivableSource.findFirst({ where: { id, deletedAt: null } }); if (!source) throw this.notFound("RECEIVABLE_SOURCE_NOT_FOUND", "应收来源不存在"); const result = await client.receivableAllocation.aggregate({ where: { receivableSourceId: id, deletedAt: null, status: "active", payment: { status: "posted" } }, _sum: { amount: true } }); return { source, allocated: new Prisma.Decimal(result._sum.amount ?? 0), available: source.amount.minus(result._sum.amount ?? 0) }; }
  async refreshStatus(client: Prisma.TransactionClient, id: string, user: CurrentUser) { const { source, available } = await this.allocationBalance(id, client); const next = available.eq(0) ? "paid" : available.lt(source.amount) ? "partially_paid" : "confirmed"; return client.receivableSource.update({ where: { id }, data: { status: next, ...this.audit.update(user) } }); }
  private number(prefix: string) { return `${prefix}-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomUUID().slice(0, 8).toUpperCase()}`; }
  private date(value: string) { const date = new Date(`${value}T00:00:00.000Z`); if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(date.valueOf())) throw new UnprocessableEntityException({ code: "INVALID_DUE_DATE", message: "到期日无效", details: [] }); return date; }
  private notFound(code: string, message: string) { return new NotFoundException({ code, message, details: [] }); }
  private invalid(code: string, message: string) { return new UnprocessableEntityException({ code, message, details: [] }); }
}