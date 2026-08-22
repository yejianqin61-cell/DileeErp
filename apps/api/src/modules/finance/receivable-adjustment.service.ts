import { Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { AuditService } from "../../platform/audit/audit.service";
import type { CurrentUser } from "../../platform/auth/auth.service";
import { PrismaService } from "../../platform/database/prisma.service";

const TYPES = new Set(["refund", "red_credit", "discount", "bad_debt", "correction"]);
const EFFECTS = new Set(["increase", "decrease"]);

export type ReceivableAdjustmentInput = {
  order_no?: string;
  customer_id?: string;
  receivable_source_id?: string;
  adjustment_type: string;
  effect: string;
  amount: string;
  currency: string;
  reason: string;
  adjustment_date: string;
  attachment?: unknown[];
  remark?: string;
};

@Injectable()
export class ReceivableAdjustmentService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  async list(orderNo?: string, customerId?: string, status?: string) {
    return this.prisma.receivableAdjustment.findMany({
      where: { deletedAt: null, ...(orderNo ? { orderNo } : {}), ...(customerId ? { customerId } : {}), ...(status ? { status } : {}) },
      include: { receivableSource: true },
      orderBy: { createdAt: "desc" },
    });
  }

  async get(id: string) {
    const row = await this.prisma.receivableAdjustment.findFirst({ where: { id, deletedAt: null }, include: { receivableSource: true } });
    if (!row) throw this.notFound("RECEIVABLE_ADJUSTMENT_NOT_FOUND", "应收调整不存在");
    return row;
  }

  async create(input: ReceivableAdjustmentInput, user: CurrentUser) {
    const amount = this.decimal(input.amount, "INVALID_ADJUSTMENT_AMOUNT");
    if (!TYPES.has(input.adjustment_type)) throw this.invalid("INVALID_ADJUSTMENT_TYPE", "调整类型无效");
    if (!EFFECTS.has(input.effect)) throw this.invalid("INVALID_ADJUSTMENT_EFFECT", "调整方向无效");
    if (!input.reason?.trim()) throw this.invalid("ADJUSTMENT_REASON_REQUIRED", "调整原因必填");
    const date = this.date(input.adjustment_date);
    const source = input.receivable_source_id
      ? await this.prisma.receivableSource.findFirst({ where: { id: input.receivable_source_id, deletedAt: null } })
      : null;
    if (input.receivable_source_id && !source) throw this.notFound("RECEIVABLE_SOURCE_NOT_FOUND", "应收来源不存在");
    const orderNo = input.order_no ?? source?.orderNo;
    if (!orderNo) throw this.invalid("ORDER_NO_REQUIRED", "调整必须关联订单号或应收来源");
    const order = await this.prisma.salesOrder.findFirst({ where: { orderNo, deletedAt: null } });
    if (!order && !source) throw this.notFound("SALES_ORDER_NOT_FOUND", "订单不存在");
    const customerId = input.customer_id ?? source?.customerId ?? order?.customerId;
    if (!customerId) throw this.invalid("CUSTOMER_REQUIRED", "调整必须关联客户");
    if (source && (source.orderNo !== orderNo || source.customerId !== customerId || source.currency !== input.currency)) {
      throw this.invalid("ADJUSTMENT_REFERENCE_MISMATCH", "应收来源与订单、客户或币种不一致");
    }
    if (order && order.customerId !== customerId) throw this.invalid("ADJUSTMENT_CUSTOMER_MISMATCH", "订单与客户不一致");
    const row = await this.prisma.receivableAdjustment.create({
      data: {
        adjustmentNo: this.number("ADJ"), orderNo, salesOrderId: source?.salesOrderId ?? order?.id, customerId,
        receivableSourceId: source?.id, adjustmentType: input.adjustment_type, effect: input.effect, amount,
        currency: input.currency, reason: input.reason.trim(), adjustmentDate: date, attachment: (input.attachment ?? []) as Prisma.InputJsonValue,
        remark: input.remark, ...this.audit.create(user),
      },
    });
    await this.audit.recordWithOrderNo("receivable_adjustment.create", "receivable_adjustment", row.orderNo, user.id, row.id, { adjustment_no: row.adjustmentNo, amount: row.amount.toString(), effect: row.effect });
    return row;
  }

  async post(id: string, user: CurrentUser) {
    const current = await this.get(id);
    if (current.status !== "draft") throw this.invalid("RECEIVABLE_ADJUSTMENT_NOT_POSTABLE", "只有草稿调整可以过账");
    const result = await this.prisma.$transaction(async (tx) => {
      if (current.receivableSourceId && current.effect === "decrease") {
        const available = await this.sourceNetOutstanding(tx, current.receivableSourceId);
        if (current.amount.gt(available)) throw new UnprocessableEntityException({ code: "ADJUSTMENT_EXCEEDS_BALANCE", message: "调整金额超过应收未收余额", details: [{ available_amount: available.toString() }] });
      }
      return tx.receivableAdjustment.update({ where: { id }, data: { status: "posted", ...this.audit.update(user) } });
    });
    await this.audit.recordWithOrderNo("receivable_adjustment.post", "receivable_adjustment", result.orderNo, user.id, id, { amount: result.amount.toString(), effect: result.effect });
    return result;
  }

  async reverse(id: string, reason: string, user: CurrentUser) {
    if (!reason?.trim()) throw this.invalid("REVERSAL_REASON_REQUIRED", "冲销必须填写原因");
    const current = await this.get(id);
    if (current.status !== "posted") throw this.invalid("RECEIVABLE_ADJUSTMENT_NOT_REVERSIBLE", "只有已过账调整可以冲销");
    const result = await this.prisma.receivableAdjustment.update({ where: { id }, data: { status: "reversed", remark: `${current.remark ?? ""}\n冲销：${reason.trim()}`, ...this.audit.update(user) } });
    await this.audit.recordWithOrderNo("receivable_adjustment.reverse", "receivable_adjustment", result.orderNo, user.id, id, { reason: reason.trim() });
    return result;
  }

  async orderNetSummary(orderNo: string) {
    const [sources, adjustments] = await Promise.all([
      this.prisma.receivableSource.findMany({ where: { orderNo, deletedAt: null }, include: { allocations: { where: { deletedAt: null, status: "active" }, include: { payment: true } } } }),
      this.prisma.receivableAdjustment.findMany({ where: { orderNo, deletedAt: null, status: "posted" } }),
    ]);
    const receivable = sources.reduce((sum, row) => sum.plus(row.amount), new Prisma.Decimal(0));
    const paid = sources.reduce((sum, row) => sum.plus(row.allocations.filter((item) => item.payment.status === "posted").reduce((inner, item) => inner.plus(item.amount), new Prisma.Decimal(0))), new Prisma.Decimal(0));
    const increases = adjustments.filter((row) => row.effect === "increase").reduce((sum, row) => sum.plus(row.amount), new Prisma.Decimal(0));
    const decreases = adjustments.filter((row) => row.effect === "decrease").reduce((sum, row) => sum.plus(row.amount), new Prisma.Decimal(0));
    const net = receivable.plus(increases).minus(decreases);
    return { order_no: orderNo, receivable_amount: receivable.toString(), paid_amount: paid.toString(), adjustment_increase: increases.toString(), adjustment_decrease: decreases.toString(), receivable_net_amount: net.toString(), outstanding_amount: net.minus(paid).toString(), posted_adjustment_count: adjustments.length };
  }

  private async sourceNetOutstanding(client: Prisma.TransactionClient, sourceId: string) {
    const source = await client.receivableSource.findFirst({ where: { id: sourceId, deletedAt: null } });
    if (!source) throw this.notFound("RECEIVABLE_SOURCE_NOT_FOUND", "应收来源不存在");
    const [allocations, adjustments] = await Promise.all([
      client.receivableAllocation.aggregate({ where: { receivableSourceId: sourceId, deletedAt: null, status: "active", payment: { status: "posted" } }, _sum: { amount: true } }),
      client.receivableAdjustment.findMany({ where: { receivableSourceId: sourceId, deletedAt: null, status: "posted" }, select: { effect: true, amount: true } }),
    ]);
    const increases = adjustments.filter((row) => row.effect === "increase").reduce((sum, row) => sum.plus(row.amount), new Prisma.Decimal(0));
    const decreases = adjustments.filter((row) => row.effect === "decrease").reduce((sum, row) => sum.plus(row.amount), new Prisma.Decimal(0));
    return source.amount.plus(increases).minus(decreases).minus(allocations._sum.amount ?? 0);
  }

  private decimal(value: string, code: string) { try { const result = new Prisma.Decimal(value); if (result.lte(0)) throw new Error(); return result; } catch { throw this.invalid(code, "金额必须是大于零的十进制数"); } }
  private date(value: string) { const result = new Date(`${value}T00:00:00.000Z`); if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(result.valueOf())) throw this.invalid("INVALID_ADJUSTMENT_DATE", "调整日期无效"); return result; }
  private number(prefix: string) { return `${prefix}-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomUUID().slice(0, 8).toUpperCase()}`; }
  private notFound(code: string, message: string) { return new NotFoundException({ code, message, details: [] }); }
  private invalid(code: string, message: string) { return new UnprocessableEntityException({ code, message, details: [] }); }
}
