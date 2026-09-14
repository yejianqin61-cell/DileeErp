import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { AuditService } from "../../platform/audit/audit.service";
import type { CurrentUser } from "../../platform/auth/auth.service";
import { PrismaService } from "../../platform/database/prisma.service";
import { parseQuantity } from "../../platform/database/quantity";
import { InventoryService } from "../../platform/inventory/inventory.service";
import { receivableAmountFor, receivableUnitPrice, settlementRemark, type SettlementSalesOrder } from "./finished-goods-settlement";

type OutboundInput = { sales_order_id: string; production_order_id: string; quantity: string; idempotency_key?: string; risk_reason?: string; remark?: string; attachment?: unknown[] };
type ReturnInput = { sales_order_id: string; production_order_id: string; quantity: string; return_date: string; destination: "finished_goods" | "defective_goods"; reason: string; idempotency_key?: string; remark?: string; attachment?: unknown[] };

@Injectable()
export class FinishedGoodsOutboundService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly inventory: InventoryService) {}

  async listOutbounds(orderNo?: string) { return this.prisma.finishedGoodsOutbound.findMany({ where: { deletedAt: null, ...(orderNo ? { orderNo } : {}) }, include: { inventoryFacts: true, unit: { select: { name: true } }, salesOrder: { select: { orderNo: true, currency: true, unitPrice: true, settlementUnitPrice: true, receivableAmount: true, customer: { select: { name: true } } } }, outboundNotice: { select: { id: true, noticeNo: true, status: true } } }, orderBy: { createdAt: "desc" } }); }
  async listReturns(orderNo?: string) { return this.prisma.customerReturn.findMany({ where: { deletedAt: null, ...(orderNo ? { orderNo } : {}) }, include: { inventoryFacts: true }, orderBy: { createdAt: "desc" } }); }
  async getOutbound(id: string) { const row = await this.prisma.finishedGoodsOutbound.findFirst({ where: { id, deletedAt: null }, include: { inventoryFacts: true, unit: { select: { name: true } }, salesOrder: { select: { orderNo: true, currency: true, unitPrice: true, settlementUnitPrice: true, receivableAmount: true, customer: { select: { name: true } } } }, outboundNotice: { select: { id: true, noticeNo: true, status: true, noticeQuantity: true } } } }); if (!row) throw this.notFound("FINISHED_GOODS_OUTBOUND_NOT_FOUND", "成品出库单不存在"); return row; }
  async getReturn(id: string) { const row = await this.prisma.customerReturn.findFirst({ where: { id, deletedAt: null }, include: { inventoryFacts: true } }); if (!row) throw this.notFound("CUSTOMER_RETURN_NOT_FOUND", "客户退货单不存在"); return row; }

  async createOutbound(input: OutboundInput, user: CurrentUser) {
    const refs = await this.references(input.sales_order_id, input.production_order_id);
    const quantity = this.decimal(input.quantity, "INVALID_FINISHED_GOODS_OUTBOUND_QUANTITY");
    const balance = await this.inventory.finishedGoodsBalance(this.prisma, refs.production.id, refs.production.unitId, "finished_goods");
    // 口径（客户确认）：支持分批出库 —— 单张出库单数量只要不超过当前成品可用量即可，剩余库存可再出库。
    if (quantity.gt(balance)) throw this.exceeded("FINISHED_GOODS_OUTBOUND_INVENTORY_INSUFFICIENT", balance);
    // 待办通知占用的量必须留给通知链路：手工出库把被通知占住的货吃掉后，
    // 仓库按通知建的草稿过账时才发现库存不足，就会变成「通知不能取消、草稿不能过账」的死结。
    await this.assertNoticeReservationAvailable(refs.production.id, quantity, balance);
    const planned = refs.sales.quantity;
    const posted = await this.postedOutboundQuantity(refs.production.id);
    if (posted.plus(quantity).gt(planned) && !input.risk_reason?.trim()) throw new UnprocessableEntityException({ code: "OUTBOUND_PLAN_EXCEEDED_REASON_REQUIRED", message: "出库累计超过订单计划量，必须填写风险原因", details: [{ planned_quantity: planned.toString(), posted_quantity: posted.toString() }] });
    // 幂等重放：同一个 key 再提交一次必须返回同一张出库单（而不是建出第二张）。
    const replayKey = input.idempotency_key?.trim();
    if (replayKey) { const replayed = await this.prisma.finishedGoodsOutbound.findFirst({ where: { idempotencyKey: replayKey, deletedAt: null } }); if (replayed) return replayed; }
    const row = await this.prisma.finishedGoodsOutbound.create({ data: { outboundNo: this.number("FGO"), orderNo: refs.sales.orderNo, salesOrderId: refs.sales.id, productionOrderId: refs.production.id, unitId: refs.production.unitId, productNameSnapshot: refs.sales.productName, productSpecificationSnapshot: refs.sales.productSpec, quantity, riskReason: input.risk_reason, attachment: (input.attachment ?? []) as Prisma.InputJsonValue, idempotencyKey: replayKey || `draft:${randomUUID()}`, remark: input.remark, ...this.audit.create(user) } });
    await this.audit.record("finished_goods_outbound.create", "finished_goods_outbound", user.id, row.id, { order_no: row.orderNo, quantity: quantity.toString(), risk_reason: row.riskReason });
    return row;
  }

  /** 出库通知列表（销售通知仓库发货）：默认按待处理在前排序，并给出剩余可出库量。 */
  async listOutboundNotices(orderNo?: string, status?: string) {
    const rows = await this.prisma.finishedGoodsOutboundNotice.findMany({
      where: { deletedAt: null, ...(orderNo ? { orderNo } : {}), ...(status ? { status } : { status: { not: "cancelled" } }) },
      include: {
        salesOrder: { select: { currency: true, unitPrice: true, settlementUnitPrice: true, receivableAmount: true, customer: { select: { name: true } } } },
        unit: { select: { name: true } },
        // 一张通知可以对应多张出库单（分批出库）。
        outbounds: { where: { deletedAt: null }, select: { id: true, outboundNo: true, status: true, quantity: true }, orderBy: { createdAt: "asc" } },
      },
      orderBy: [{ status: "asc" }, { notifiedAt: "asc" }],
    });
    return rows.map((notice) => {
      const drafts = notice.outbounds.filter((outbound) => outbound.status === "draft");
      const draftQuantity = drafts.reduce((total, outbound) => total.plus(outbound.quantity), new Prisma.Decimal(0));
      const remaining = notice.noticeQuantity.minus(notice.shippedQuantity).minus(draftQuantity);
      return {
        ...notice,
        remaining_quantity: (remaining.lt(0) ? new Prisma.Decimal(0) : remaining).toString(),
        draft_quantity: draftQuantity.toString(),
        outbound_summary: notice.outbounds.map((outbound) => `${outbound.outboundNo}（${outbound.status} ${outbound.quantity.toString()}）`).join("、"),
      };
    });
  }

  /**
   * 按出库通知生成成品出库单：支持分批 —— 不传 quantity 时按剩余量建单，
   * 也可以只出一部分（数量必须 ≤ 通知剩余量）。出库过账后自动生成应收来源（通知财务收款）。
   */
  async createOutboundFromNotice(id: string, input: { quantity?: string; idempotency_key?: string }, user: CurrentUser) {
    const notice = await this.prisma.finishedGoodsOutboundNotice.findFirst({ where: { id, deletedAt: null }, include: { salesOrder: true, productionOrder: true, unit: true } });
    if (!notice) throw this.notFound("OUTBOUND_NOTICE_NOT_FOUND", "出库通知不存在");
    if (["completed", "cancelled"].includes(notice.status)) throw this.invalid("OUTBOUND_NOTICE_NOT_PENDING", `该出库通知不能生成出库单（当前状态：${notice.status}）`);
    // 幂等键由调用方（仓库页面）随请求带来：同一次提交重试必须命中同一张出库单。
    // 没有 key 时只能用随机后缀，等价于不做幂等 —— 所以前端一定要传。
    const replayKey = input.idempotency_key?.trim() ? `notice:${id}:${input.idempotency_key.trim()}` : null;
    if (replayKey) { const replayed = await this.prisma.finishedGoodsOutbound.findFirst({ where: { idempotencyKey: replayKey, deletedAt: null } }); if (replayed) return replayed; }
    const row = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM production_orders WHERE id = ${notice.productionOrderId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM finished_goods_outbound_notices WHERE id = ${id}::uuid FOR UPDATE`;
      const locked = await tx.finishedGoodsOutboundNotice.findFirst({ where: { id, deletedAt: null } });
      if (!locked || ["completed", "cancelled"].includes(locked.status)) throw this.invalid("OUTBOUND_NOTICE_NOT_PENDING", "该出库通知已被其他操作处理，请刷新后重试");
      const remaining = await this.noticeRemaining(tx, locked);
      const quantity = input.quantity?.trim() ? this.decimal(input.quantity, "INVALID_FINISHED_GOODS_OUTBOUND_QUANTITY") : remaining;
      if (quantity.lte(0)) throw this.invalid("OUTBOUND_NOTICE_NOTHING_TO_SHIP", "该出库通知已经发完，没有剩余可出库数量");
      if (quantity.gt(remaining)) throw new UnprocessableEntityException({ code: "OUTBOUND_NOTICE_QUANTITY_EXCEEDED", message: "本次出库数量超过该通知的剩余量", details: [{ remaining_quantity: remaining.toString(), requested_quantity: quantity.toString() }] });
      const balance = await this.inventory.finishedGoodsBalance(tx, locked.productionOrderId, locked.unitId, "finished_goods");
      if (quantity.gt(balance)) throw this.exceeded("FINISHED_GOODS_OUTBOUND_INVENTORY_INSUFFICIENT", balance);
      // 若本次出库后累计超过订单计划量，自动带上可追溯的风险原因（草稿没有填原因的地方，
      // 否则仓库会因为「必须填写风险原因」而永远过不了账）。
      const sales = await tx.salesOrder.findUnique({ where: { id: locked.salesOrderId }, select: { quantity: true } });
      const posted = await tx.finishedGoodsOutbound.aggregate({ where: { productionOrderId: locked.productionOrderId, deletedAt: null, status: { in: ["posted", "shipped", "signed"] } }, _sum: { quantity: true } });
      const overPlan = Boolean(sales) && new Prisma.Decimal(posted._sum.quantity ?? 0).plus(quantity).gt(sales!.quantity);
      const created = await tx.finishedGoodsOutbound.create({ data: { outboundNo: this.number("FGO"), orderNo: locked.orderNo, salesOrderId: locked.salesOrderId, productionOrderId: locked.productionOrderId, outboundNoticeId: locked.id, unitId: locked.unitId, productNameSnapshot: locked.productNameSnapshot, productSpecificationSnapshot: locked.productSpecificationSnapshot, quantity, riskReason: overPlan ? `按销售出库通知 ${locked.noticeNo} 出库：累计出库超过订单计划量（含超产或客户退货回仓）` : null, idempotencyKey: replayKey ?? `notice:${locked.id}:${randomUUID()}`, remark: `出库通知 ${locked.noticeNo}`, ...this.audit.create(user) } });
      await this.syncNoticeStatus(tx, locked.id, user);
      return created;
    });
    await this.audit.record("finished_goods_outbound.create_from_notice", "finished_goods_outbound", user.id, row.id, { order_no: row.orderNo, notice_id: notice.id, notice_no: notice.noticeNo, quantity: row.quantity.toString(), over_plan: Boolean(row.riskReason) });
    return row;
  }

  /** 通知的剩余可出库量 = 通知数量 − 已过账出库量 − 未过账草稿量。 */
  private async noticeRemaining(client: PrismaService | Prisma.TransactionClient, notice: { id: string; noticeQuantity: Prisma.Decimal; shippedQuantity: Prisma.Decimal }) {
    const drafts = await client.finishedGoodsOutbound.aggregate({ where: { outboundNoticeId: notice.id, deletedAt: null, status: "draft" }, _sum: { quantity: true } });
    const remaining = new Prisma.Decimal(notice.noticeQuantity).minus(notice.shippedQuantity).minus(drafts._sum.quantity ?? 0);
    return remaining.lt(0) ? new Prisma.Decimal(0) : remaining;
  }

  /**
   * 按通知下的出库单重新推导通知状态与已出库量（分批出库的核心）：
   *   已出库 = 已过账/已发出/已签收的合计；有草稿 → outbound_created；
   *   已出库达到通知量 → completed；部分出库 → partially_outbound；否则 pending。
   */
  private async syncNoticeStatus(client: PrismaService | Prisma.TransactionClient, noticeId: string, user: CurrentUser) {
    const notice = await client.finishedGoodsOutboundNotice.findFirst({ where: { id: noticeId }, select: { id: true, noticeQuantity: true, status: true } });
    if (!notice || notice.status === "cancelled") return;
    const [shipped, draft] = await Promise.all([
      client.finishedGoodsOutbound.aggregate({ where: { outboundNoticeId: noticeId, deletedAt: null, status: { in: ["posted", "shipped", "signed"] } }, _sum: { quantity: true } }),
      client.finishedGoodsOutbound.aggregate({ where: { outboundNoticeId: noticeId, deletedAt: null, status: "draft" }, _sum: { quantity: true } }),
    ]);
    const shippedQuantity = new Prisma.Decimal(shipped._sum.quantity ?? 0);
    const draftQuantity = new Prisma.Decimal(draft._sum.quantity ?? 0);
    const status = shippedQuantity.gte(notice.noticeQuantity) ? "completed" : draftQuantity.gt(0) ? "outbound_created" : shippedQuantity.gt(0) ? "partially_outbound" : "pending";
    await client.finishedGoodsOutboundNotice.update({ where: { id: noticeId }, data: { status, shippedQuantity, version: { increment: 1 }, ...this.audit.update(user) } });
  }

  /**
   * 取消尚未过账的成品出库单（草稿）。
   * 必须存在这条路径：出库通知建出库单之后，如果库存被其它操作改变导致过账必然失败，
   * 没有取消入口就会让「通知 + 出库单」永久卡死（通知不能取消、草稿不能过账也不能删）。
   * 取消时把来源通知退回 pending（并释放幂等键），仓库/销售可以重新走一遍。
   */
  async cancelOutbound(id: string, reason: string, user: CurrentUser) {
    if (!reason?.trim()) throw new UnprocessableEntityException({ code: "CANCELLATION_REASON_REQUIRED", message: "取消出库单必须填写原因", details: [] });
    const current = await this.requireOutbound(id);
    if (current.status !== "draft") throw this.invalid("FINISHED_GOODS_OUTBOUND_NOT_CANCELLABLE", "只有未过账的草稿出库单可以取消；已出库请使用冲销");
    const row = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM finished_goods_outbounds WHERE id = ${id}::uuid FOR UPDATE`;
      const locked = await tx.finishedGoodsOutbound.findFirst({ where: { id, deletedAt: null } });
      if (!locked || locked.status !== "draft") throw this.invalid("FINISHED_GOODS_OUTBOUND_NOT_CANCELLABLE", "该出库单已被其他操作处理，请刷新后重试");
      // 释放幂等键，允许同一张通知重新生成出库单。
      const cancelled = await tx.finishedGoodsOutbound.update({ where: { id }, data: { status: "cancelled", idempotencyKey: `cancelled:${id}`, remark: `${locked.remark ?? ""}\n取消：${reason.trim()}`, ...this.audit.update(user) } });
      // 按剩余出库单重新推导来源通知状态（草稿取消后剩余量会回来；分批出库时通知可能已部分出库）。
      if (locked.outboundNoticeId) await this.syncNoticeStatus(tx, locked.outboundNoticeId, user);
      return cancelled;
    });
    await this.audit.record("finished_goods_outbound.cancel", "finished_goods_outbound", user.id, id, { order_no: row.orderNo, reason: reason.trim() });
    return row;
  }

  async postOutbound(id: string, user: CurrentUser) {
    const found = await this.prisma.finishedGoodsOutbound.findFirst({ where: { id, deletedAt: null } });
    if (!found) throw this.notFound("FINISHED_GOODS_OUTBOUND_NOT_FOUND", "成品出库单不存在");
    if (found.status !== "draft") throw this.invalid("FINISHED_GOODS_OUTBOUND_NOT_POSTABLE", "只有草稿出库单可以过账");
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM production_orders WHERE id = ${found.productionOrderId}::uuid FOR UPDATE`;
      // 锁住出库单行并重读状态：否则「取消草稿」与「过账」并发时会出现丢失更新
      // （过账把 cancelled 覆盖成 posted，而通知已经被退回 pending，单据与通知不一致）。
      await tx.$queryRaw`SELECT id FROM finished_goods_outbounds WHERE id = ${id}::uuid FOR UPDATE`;
      const current = await tx.finishedGoodsOutbound.findFirst({ where: { id, deletedAt: null } });
      if (!current || current.status !== "draft") throw this.invalid("FINISHED_GOODS_OUTBOUND_NOT_POSTABLE", "该出库单已被其他操作处理（可能已取消或已过账），请刷新后重试");
      const existing = await tx.inventoryFact.findFirst({ where: { finishedGoodsOutboundId: id, sourceType: "finished_goods_outbound" } });
      if (existing) throw this.invalid("FINISHED_GOODS_OUTBOUND_ALREADY_POSTED", "成品出库单已过账");
      const balance = await this.inventory.finishedGoodsBalance(tx, current.productionOrderId, current.unitId, "finished_goods");
      if (current.quantity.gt(balance)) throw this.exceeded("FINISHED_GOODS_OUTBOUND_INVENTORY_INSUFFICIENT", balance);
      const sales = await tx.salesOrder.findUnique({ where: { id: current.salesOrderId } });
      // 应收计价：优先用销售单的「应收金额」按订单数量折算成单价（这样出库整单时应收总额
      // 与销售填写的应收金额一致，部分出库按比例），其次「结算币价」，最后销售单价。
      const settlementPrice = this.receivableUnitPrice(sales);
      if (!sales || !settlementPrice || settlementPrice.lte(0)) throw this.invalid("SALES_UNIT_PRICE_REQUIRED", "销售单缺少有效销售单价/结算币价/应收金额，不能生成应收并过账");
      const postedOutbound = await tx.finishedGoodsOutbound.aggregate({ where: { productionOrderId: current.productionOrderId, id: { not: id }, deletedAt: null, status: { in: ["posted", "shipped", "signed"] } }, _sum: { quantity: true } });
      const postedQuantity = new Prisma.Decimal(postedOutbound._sum.quantity ?? 0);
      // 超计划出库必须留下可追溯的原因。原来这里直接 422，而草稿没有编辑原因的地方，
      // 一旦「过账时才发现超计划」（例如退货回仓后再出库）单据就永远过不了账；
      // 现在改成：已有原因就沿用，没有就自动写入系统原因，保证单据可过账且原因可追溯。
      const overPlan = postedQuantity.plus(current.quantity).gt(sales.quantity);
      const riskReason = current.riskReason?.trim() || (overPlan ? `过账时判定累计出库超过订单计划量：计划 ${sales.quantity.toString()}，已出库 ${postedQuantity.toString()}，本单 ${current.quantity.toString()}（系统自动记录，请复核）` : null);
      const posted = await tx.finishedGoodsOutbound.update({ where: { id }, data: { status: "posted", riskReason, idempotencyKey: `post:${id}`, ...this.audit.update(user) } });
      await tx.inventoryFact.create({ data: { finishedGoodsOutboundId: id, unitId: current.unitId, inventoryCategory: "finished_goods", quantityDelta: current.quantity.negated(), sourceType: "finished_goods_outbound", sourceId: id, orderNo: current.orderNo, productionOrderId: current.productionOrderId, productNameSnapshot: current.productNameSnapshot, productSpecificationSnapshot: current.productSpecificationSnapshot, createdBy: user.id } });
      await tx.receivableSource.create({ data: { sourceNo: `AR-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomUUID().slice(0, 8).toUpperCase()}`, orderNo: current.orderNo, salesOrderId: current.salesOrderId, outboundId: id, customerId: sales.customerId, quantity: current.quantity, unit: sales.unit, unitPrice: settlementPrice, taxRate: sales.taxRate, amount: this.receivableAmountFor(sales, settlementPrice, current.quantity), currency: sales.currency, status: "draft", signedAtSnapshot: current.signedAt, remark: this.settlementRemark(sales, settlementPrice), ...this.audit.create(user) } });
      // 出库过账 = 通知财务收款：应收来源草稿已生成；来源通知按累计出库量重新推导状态
      //（分批出库时可能只是 partially_outbound，发完才 completed）。
      if (current.outboundNoticeId) await this.syncNoticeStatus(tx, current.outboundNoticeId, user);
      return posted;
    });
    await this.audit.record("finished_goods_outbound.post", "finished_goods_outbound", user.id, id, { order_no: result.orderNo, quantity: result.quantity.toString() });
    return result;
  }

  async updateShipping(id: string, input: { shipment_date?: string; carrier?: string; tracking_no?: string; packing_list_no?: string; invoice_no?: string; attachment?: unknown[] }, user: CurrentUser) {
    const current = await this.requireOutbound(id);
    if (!["posted", "shipped"].includes(current.status)) throw this.invalid("INVALID_OUTBOUND_SHIPPING_STATE", "只有已过账或已发货出库单可以维护发货资料");
    const shipmentDate = input.shipment_date ? this.date(input.shipment_date, "INVALID_SHIPMENT_DATE") : current.shipmentDate;
    if (current.signedAt && shipmentDate && shipmentDate > current.signedAt) throw this.invalid("SHIPMENT_AFTER_SIGNATURE", "发货日期不能晚于签收时间");
    const data: Prisma.FinishedGoodsOutboundUpdateManyMutationInput = { status: "shipped", ...(input.shipment_date ? { shipmentDate } : {}), ...(input.carrier === undefined ? {} : { carrier: input.carrier }), ...(input.tracking_no === undefined ? {} : { trackingNo: input.tracking_no }), ...(input.packing_list_no === undefined ? {} : { packingListNo: input.packing_list_no }), ...(input.invoice_no === undefined ? {} : { invoiceNo: input.invoice_no }), ...(input.attachment === undefined ? {} : { attachment: input.attachment as Prisma.InputJsonValue }), ...this.audit.update(user) };
    // 带状态条件更新：否则「冲销」与「维护发货」并发时，已冲销的出库单会被改回 shipped，
    // 出库量被重复计入、应收也会与实际不一致。
    await this.assertStatusTransition(id, ["posted", "shipped"], data, "INVALID_OUTBOUND_SHIPPING_STATE", "出库单状态已变化（可能被冲销），请刷新后重试");
    const row = await this.requireOutbound(id);
    await this.audit.record("finished_goods_outbound.shipping_update", "finished_goods_outbound", user.id, id, { order_no: row.orderNo });
    return row;
  }

  async signOutbound(id: string, input: { signed_at: string; signature_reference?: string; attachment?: unknown[] }, user: CurrentUser) {
    const current = await this.requireOutbound(id);
    if (!["shipped", "signed"].includes(current.status)) throw this.invalid("INVALID_OUTBOUND_SIGN_STATE", "只有已发货出库单可以登记签收");
    const signedAt = new Date(input.signed_at);
    if (Number.isNaN(signedAt.valueOf())) throw this.invalid("INVALID_SIGNED_AT", "签收时间无效");
    if (current.shipmentDate && signedAt < current.shipmentDate) throw this.invalid("SIGNATURE_BEFORE_SHIPMENT", "签收时间不能早于发货日期");
    const data: Prisma.FinishedGoodsOutboundUpdateManyMutationInput = { status: "signed", signedAt, ...(input.signature_reference === undefined ? {} : { signatureReference: input.signature_reference }), ...(input.attachment === undefined ? {} : { attachment: input.attachment as Prisma.InputJsonValue }), ...this.audit.update(user) };
    await this.assertStatusTransition(id, ["shipped", "signed"], data, "INVALID_OUTBOUND_SIGN_STATE", "出库单状态已变化（可能被冲销），请刷新后重试");
    const row = await this.requireOutbound(id);
    await this.audit.record("finished_goods_outbound.sign", "finished_goods_outbound", user.id, id, { order_no: row.orderNo, signed_at: signedAt.toISOString() });
    return row;
  }

  /** 带状态条件的更新（CAS）：影响行数不为 1 说明状态已被其它操作改变，直接 422。 */
  private async assertStatusTransition(id: string, allowed: string[], data: Prisma.FinishedGoodsOutboundUpdateManyMutationInput, code: string, message: string) {
    const marked = await this.prisma.finishedGoodsOutbound.updateMany({ where: { id, deletedAt: null, status: { in: allowed } }, data });
    if (marked.count !== 1) throw this.invalid(code, message);
  }

  async reverseOutbound(id: string, reason: string, user: CurrentUser) {
    if (!reason?.trim()) throw new UnprocessableEntityException({ code: "REVERSAL_REASON_REQUIRED", message: "冲销必须填写原因", details: [] });
    const current = await this.requireOutbound(id);
    if (!["posted", "shipped", "signed"].includes(current.status)) throw this.invalid("INVALID_OUTBOUND_REVERSAL_STATE", "当前出库单不可冲销");
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM production_orders WHERE id = ${current.productionOrderId}::uuid FOR UPDATE`;
      const existing = await tx.inventoryFact.findFirst({ where: { finishedGoodsOutboundId: id, sourceType: "finished_goods_outbound_reversal" } });
      if (existing) throw this.invalid("FINISHED_GOODS_OUTBOUND_ALREADY_REVERSED", "成品出库单已冲销");
      const receivable = await tx.receivableSource.findFirst({
        where: { outboundId: id, deletedAt: null },
        include: { allocations: { where: { deletedAt: null, status: "active" }, include: { payment: true } } },
      });
      if (receivable) {
        const hasPostedPayment = receivable.allocations.some((item) => item.payment.status === "posted");
        if (hasPostedPayment) throw new UnprocessableEntityException({ code: "OUTBOUND_REVERSAL_HAS_RECEIVABLE_PAYMENTS", message: "出库已存在有效收款核销，必须先冲销收款或完成应收调整", details: [{ receivable_source_id: receivable.id }] });
        if (receivable.status !== "draft") throw new UnprocessableEntityException({ code: "OUTBOUND_REVERSAL_HAS_RECEIVABLE", message: "出库已生成应收来源，必须先取消或回退应收来源", details: [{ receivable_source_id: receivable.id, status: receivable.status }] });
        await tx.receivableSource.update({ where: { id: receivable.id }, data: { status: "cancelled", remark: `${receivable.remark ?? ""}\n出库冲销自动取消：${reason.trim()}`, ...this.audit.update(user) } });
      }
      const updated = await tx.finishedGoodsOutbound.update({ where: { id }, data: { status: "reversed", remark: `${current.remark ?? ""}\n冲销：${reason}`, ...this.audit.update(user) } });
      // 冲销后货回到成品库存：来源通知按累计出库量重新推导（已出库量下降、剩余量回来，可再出库）。
      if (current.outboundNoticeId) await this.syncNoticeStatus(tx, current.outboundNoticeId, user);
      await tx.inventoryFact.create({ data: { finishedGoodsOutboundId: id, unitId: current.unitId, inventoryCategory: "finished_goods", quantityDelta: current.quantity, sourceType: "finished_goods_outbound_reversal", sourceId: id, orderNo: current.orderNo, productionOrderId: current.productionOrderId, productNameSnapshot: current.productNameSnapshot, productSpecificationSnapshot: current.productSpecificationSnapshot, createdBy: user.id } });
      return updated;
    });
    await this.audit.record("finished_goods_outbound.reverse", "finished_goods_outbound", user.id, id, { order_no: result.orderNo, reason });
    return result;
  }

  async createReturn(input: ReturnInput, user: CurrentUser) {
    const refs = await this.references(input.sales_order_id, input.production_order_id);
    const quantity = this.decimal(input.quantity, "INVALID_CUSTOMER_RETURN_QUANTITY");
    if (!input.reason?.trim()) throw new UnprocessableEntityException({ code: "CUSTOMER_RETURN_REASON_REQUIRED", message: "客户退货必须填写原因", details: [] });
    const row = await this.prisma.customerReturn.create({ data: { returnNo: this.number("FGR"), orderNo: refs.sales.orderNo, salesOrderId: refs.sales.id, productionOrderId: refs.production.id, unitId: refs.production.unitId, productNameSnapshot: refs.sales.productName, productSpecificationSnapshot: refs.sales.productSpec, quantity, returnDate: this.date(input.return_date, "INVALID_RETURN_DATE"), destination: input.destination, reason: input.reason, attachment: (input.attachment ?? []) as Prisma.InputJsonValue, idempotencyKey: input.idempotency_key?.trim() || `draft:${randomUUID()}`, remark: input.remark, ...this.audit.create(user) } });
    await this.audit.record("customer_return.create", "customer_return", user.id, row.id, { order_no: row.orderNo, quantity: quantity.toString(), destination: row.destination });
    return row;
  }

  async postReturn(id: string, user: CurrentUser) {
    const current = await this.prisma.customerReturn.findFirst({ where: { id, deletedAt: null } });
    if (!current) throw this.notFound("CUSTOMER_RETURN_NOT_FOUND", "客户退货单不存在");
    if (current.status !== "draft") throw this.invalid("CUSTOMER_RETURN_NOT_POSTABLE", "只有草稿客户退货单可以过账");
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM customer_returns WHERE id = ${id}::uuid FOR UPDATE`;
      const locked = await tx.customerReturn.findFirst({ where: { id, deletedAt: null }, select: { status: true } });
      if (!locked || locked.status !== "draft") throw this.invalid("CUSTOMER_RETURN_ALREADY_POSTED", "客户退货单已被其他操作处理");
      const existing = await tx.inventoryFact.findFirst({ where: { customerReturnId: id, sourceType: "finished_goods_customer_return" } });
      if (existing) throw this.invalid("CUSTOMER_RETURN_ALREADY_POSTED", "客户退货单已过账");
      const posted = await tx.customerReturn.update({ where: { id }, data: { status: "posted", idempotencyKey: `post:${id}`, ...this.audit.update(user) } });
      await tx.inventoryFact.create({ data: { customerReturnId: id, unitId: current.unitId, inventoryCategory: current.destination, quantityDelta: current.quantity, sourceType: "finished_goods_customer_return", sourceId: id, orderNo: current.orderNo, productionOrderId: current.productionOrderId, productNameSnapshot: current.productNameSnapshot, productSpecificationSnapshot: current.productSpecificationSnapshot, createdBy: user.id } });
      return posted;
    });
    await this.audit.record("customer_return.post", "customer_return", user.id, id, { order_no: result.orderNo, destination: result.destination, quantity: result.quantity.toString() });
    return result;
  }

  async reverseReturn(id: string, reason: string, user: CurrentUser) {
    if (!reason?.trim()) throw new UnprocessableEntityException({ code: "REVERSAL_REASON_REQUIRED", message: "冲销必须填写原因", details: [] });
    const current = await this.prisma.customerReturn.findFirst({ where: { id, deletedAt: null } });
    if (!current) throw this.notFound("CUSTOMER_RETURN_NOT_FOUND", "客户退货单不存在");
    if (current.status !== "posted") throw this.invalid("CUSTOMER_RETURN_NOT_REVERSIBLE", "只有已过账客户退货单可以冲销");
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM customer_returns WHERE id = ${id}::uuid FOR UPDATE`;
      const locked = await tx.customerReturn.findFirst({ where: { id, deletedAt: null }, select: { status: true } });
      if (!locked || locked.status !== "posted") throw this.invalid("CUSTOMER_RETURN_NOT_REVERSIBLE", "客户退货单已被其他操作处理");
      const balance = await this.inventory.finishedGoodsBalance(tx, current.productionOrderId, current.unitId, current.destination as "finished_goods" | "defective_goods");
      if (balance.minus(current.quantity).isNegative()) throw new UnprocessableEntityException({ code: "INVENTORY_INSUFFICIENT", message: "退货冲销会造成库存不足", details: [] });
      const updated = await tx.customerReturn.update({ where: { id }, data: { status: "reversed", remark: `${current.remark ?? ""}\n冲销：${reason}`, ...this.audit.update(user) } });
      await tx.inventoryFact.create({ data: { customerReturnId: id, unitId: current.unitId, inventoryCategory: current.destination, quantityDelta: current.quantity.negated(), sourceType: "finished_goods_customer_return_reversal", sourceId: id, orderNo: current.orderNo, productionOrderId: current.productionOrderId, productNameSnapshot: current.productNameSnapshot, productSpecificationSnapshot: current.productSpecificationSnapshot, createdBy: user.id } });
      return updated;
    });
    await this.audit.record("customer_return.reverse", "customer_return", user.id, id, { order_no: result.orderNo, reason });
    return result;
  }

  private async references(salesOrderId: string, productionOrderId: string) {
    const sales = await this.prisma.salesOrder.findFirst({ where: { id: salesOrderId, deletedAt: null } });
    const production = await this.prisma.productionOrder.findFirst({ where: { id: productionOrderId, deletedAt: null } });
    if (!sales || !production || production.salesOrderId !== sales.id || production.orderNo !== sales.orderNo) throw this.notFound("OUTBOUND_REFERENCE_NOT_FOUND", "销售单、生产单或订单号关联不存在");
    return { sales, production };
  }
  private async requireOutbound(id: string) { const row = await this.prisma.finishedGoodsOutbound.findFirst({ where: { id, deletedAt: null } }); if (!row) throw this.notFound("FINISHED_GOODS_OUTBOUND_NOT_FOUND", "成品出库单不存在"); return row; }
  private async postedOutboundQuantity(productionOrderId: string) { const result = await this.prisma.finishedGoodsOutbound.aggregate({ where: { productionOrderId, deletedAt: null, status: { in: ["posted", "shipped", "signed"] } }, _sum: { quantity: true } }); return new Prisma.Decimal(result._sum.quantity ?? 0); }
  private decimal(value: string, code: string) { return parseQuantity(value, code, "数量必须是大于零、最多 4 位小数的十进制数"); }
  private date(value: string, code: string) { const result = new Date(`${value}T00:00:00.000Z`); if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(result.valueOf())) throw new UnprocessableEntityException({ code, message: "日期无效", details: [] }); return result; }
  private number(prefix: string) { return `${prefix}-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomUUID().slice(0, 8).toUpperCase()}`; }
  private exceeded(code: string, available: Prisma.Decimal) { return new UnprocessableEntityException({ code, message: "成品库存不足", details: [{ available_quantity: available.toString() }] }); }

  /** 待办通知（未发完）占用的量：通知量 − 已出库量。 */
  private async openNoticePendingQuantity(client: PrismaService | Prisma.TransactionClient, productionOrderId: string) {
    const rows = await client.finishedGoodsOutboundNotice.findMany({ where: { productionOrderId, deletedAt: null, status: { in: ["pending", "outbound_created", "partially_outbound"] } }, select: { noticeNo: true, noticeQuantity: true, shippedQuantity: true } });
    return rows.reduce((summary, row) => {
      const open = new Prisma.Decimal(row.noticeQuantity).minus(row.shippedQuantity);
      return open.gt(0) ? { total: summary.total.plus(open), notices: [...summary.notices, `${row.noticeNo}（待出 ${open.toString()}）`] } : summary;
    }, { total: new Prisma.Decimal(0), notices: [] as string[] });
  }

  /**
   * 手工建单前把待办通知的预留量让出来。
   * 不检查的后果：手工单先把货出光，仓库按通知建的草稿过账时才发现库存不足，
   * 于是通知不能取消（那时已有草稿）、草稿不能过账，形成死结。
   * 报错里直接给出占用方，仓库不用去猜是哪个通知占着。
   */
  private async assertNoticeReservationAvailable(productionOrderId: string, quantity: Prisma.Decimal, balance: Prisma.Decimal, client: PrismaService | Prisma.TransactionClient = this.prisma) {
    const { total, notices } = await this.openNoticePendingQuantity(client, productionOrderId);
    if (total.lte(0)) return;
    const free = balance.minus(total);
    if (quantity.lte(free)) return;
    throw new UnprocessableEntityException({
      code: "FINISHED_GOODS_OUTBOUND_NOTICE_RESERVED",
      message: `成品可用量 ${balance.toString()} 中有 ${total.toString()} 已被待办出库通知占用（${notices.join("、")}）：请用【成品出库通知 → 生成出库单】按通知出库，或先让销售取消这些通知后再手工建单`,
      details: [{ available_quantity: balance.toString(), pending_notice_quantity: total.toString(), free_quantity: (free.lt(0) ? new Prisma.Decimal(0) : free).toString(), notices }],
    });
  }

  /** 出库通知的剩余量已被其它操作改变（例如库存变化/并行建单）：让仓库按最新剩余量重试。 */
  private noticeStale(noticeQuantity: Prisma.Decimal, reserved: Prisma.Decimal, balance: Prisma.Decimal) {
    return new UnprocessableEntityException({
      code: "OUTBOUND_NOTICE_QUANTITY_STALE",
      message: `出库通知数量（${noticeQuantity.toString()}）已与库存不一致（按其它待办通知扣减后可用 ${reserved.toString()}，成品可用量 ${balance.toString()}）：请让销售取消本通知（必要时一并取消其它待办通知）后按最新可用量重新通知`,
      details: [{ notice_quantity: noticeQuantity.toString(), reserved_quantity: reserved.toString(), available_quantity: balance.toString() }],
    });
  }

  /**
   * 应收单价：销售单填了「应收金额」时按 应收金额 ÷ 订单数量 折算（整单出库时应收总额与销售填写一致），
   * 否则退回「结算币价」，再退回销售单价。与财务手工补建应收共用同一实现（finished-goods-settlement.ts）。
   */
  private receivableUnitPrice(sales: SettlementSalesOrder | null) { return receivableUnitPrice(sales); }

  /** 应收金额：整单出库且填了应收金额时直接取应收金额，否则 单价 × 数量。 */
  private receivableAmountFor(sales: SettlementSalesOrder | null, unitPrice: Prisma.Decimal, quantity: Prisma.Decimal) { return receivableAmountFor(sales, unitPrice, quantity); }

  /** 把结算口径写进应收来源备注，财务不用回到销售单也能看到结算方式与本币金额。 */
  private settlementRemark(sales: SettlementSalesOrder | null, unitPrice: Prisma.Decimal) { return settlementRemark(sales, unitPrice); }
  private notFound(code: string, message: string) { return new NotFoundException({ code, message, details: [] }); }
  private invalid(code: string, message: string) { return new UnprocessableEntityException({ code, message, details: [] }); }
}
