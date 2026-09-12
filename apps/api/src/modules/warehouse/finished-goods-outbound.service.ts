import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { AuditService } from "../../platform/audit/audit.service";
import type { CurrentUser } from "../../platform/auth/auth.service";
import { PrismaService } from "../../platform/database/prisma.service";
import { InventoryService } from "../../platform/inventory/inventory.service";

type OutboundInput = { sales_order_id: string; production_order_id: string; quantity: string; idempotency_key?: string; risk_reason?: string; remark?: string; attachment?: unknown[] };
type ReturnInput = { sales_order_id: string; production_order_id: string; quantity: string; return_date: string; destination: "finished_goods" | "defective_goods"; reason: string; idempotency_key?: string; remark?: string; attachment?: unknown[] };
// 与销售单 DTO 的结算方式枚举同源（sales-orders.controller.ts SETTLEMENT_METHODS）。
const SETTLEMENT_METHOD_LABELS: Record<string, string> = { tt: "T/T 电汇", letter_of_credit: "信用证 L/C", cash: "现金", monthly: "月结", other: "其他" };

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
    // 口径（客户确认）：成品出库只允许整批出库，不支持部分出库 —— 数量必须等于当前成品可用量。
    if (!quantity.eq(balance)) throw this.fullBatchRequired(balance, quantity);
    const planned = refs.sales.quantity;
    const posted = await this.postedOutboundQuantity(refs.production.id);
    if (posted.plus(quantity).gt(planned) && !input.risk_reason?.trim()) throw new UnprocessableEntityException({ code: "OUTBOUND_PLAN_EXCEEDED_REASON_REQUIRED", message: "出库累计超过订单计划量，必须填写风险原因", details: [{ planned_quantity: planned.toString(), posted_quantity: posted.toString() }] });
    const row = await this.prisma.finishedGoodsOutbound.create({ data: { outboundNo: this.number("FGO"), orderNo: refs.sales.orderNo, salesOrderId: refs.sales.id, productionOrderId: refs.production.id, unitId: refs.production.unitId, productNameSnapshot: refs.sales.productName, productSpecificationSnapshot: refs.sales.productSpec, quantity, riskReason: input.risk_reason, attachment: (input.attachment ?? []) as Prisma.InputJsonValue, idempotencyKey: input.idempotency_key?.trim() || `draft:${randomUUID()}`, remark: input.remark, ...this.audit.create(user) } });
    await this.audit.record("finished_goods_outbound.create", "finished_goods_outbound", user.id, row.id, { order_no: row.orderNo, quantity: quantity.toString(), risk_reason: row.riskReason });
    return row;
  }

  /** 出库通知列表（销售通知仓库发货）：默认按待处理在前排序。 */
  async listOutboundNotices(orderNo?: string, status?: string) {
    const rows = await this.prisma.finishedGoodsOutboundNotice.findMany({
      where: { deletedAt: null, ...(orderNo ? { orderNo } : {}), ...(status ? { status } : { status: { not: "cancelled" } }) },
      include: {
        salesOrder: { select: { currency: true, unitPrice: true, settlementUnitPrice: true, receivableAmount: true, customer: { select: { name: true } } } },
        unit: { select: { name: true } },
        outbound: { select: { id: true, outboundNo: true, status: true, quantity: true } },
      },
      orderBy: [{ status: "asc" }, { notifiedAt: "asc" }],
    });
    return rows;
  }

  /**
   * 按出库通知生成成品出库单（整批）：数量固定取通知数量，不允许仓库改数量。
   * 出库单过账后会自动生成应收来源（通知财务收款）并把通知置为 completed。
   */
  async createOutboundFromNotice(id: string, user: CurrentUser) {
    const notice = await this.prisma.finishedGoodsOutboundNotice.findFirst({ where: { id, deletedAt: null }, include: { salesOrder: true, productionOrder: true, unit: true } });
    if (!notice) throw this.notFound("OUTBOUND_NOTICE_NOT_FOUND", "出库通知不存在");
    if (notice.status !== "pending") throw this.invalid("OUTBOUND_NOTICE_NOT_PENDING", `该出库通知不能生成出库单（当前状态：${notice.status}）`);
    const balance = await this.inventory.finishedGoodsBalance(this.prisma, notice.productionOrderId, notice.unitId, "finished_goods");
    // 整批出库同样适用于通知链路：通知数量必须等于当前成品可用量。
    // 通知之后又入库了新批次（或客户退货回仓）时，通知数量已经过期 —— 让销售取消后重新通知，
    // 而不是悄悄发出一张比实物少的出库单。
    if (!notice.noticeQuantity.eq(balance)) throw this.noticeStale(notice.noticeQuantity, balance);
    const row = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM production_orders WHERE id = ${notice.productionOrderId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM finished_goods_outbound_notices WHERE id = ${id}::uuid FOR UPDATE`;
      const locked = await tx.finishedGoodsOutboundNotice.findFirst({ where: { id, deletedAt: null } });
      if (!locked || locked.status !== "pending") throw this.invalid("OUTBOUND_NOTICE_NOT_PENDING", "该出库通知已被其他操作处理，请刷新后重试");
      const currentBalance = await this.inventory.finishedGoodsBalance(tx, locked.productionOrderId, locked.unitId, "finished_goods");
      if (!locked.noticeQuantity.eq(currentBalance)) throw this.noticeStale(locked.noticeQuantity, currentBalance);
      const created = await tx.finishedGoodsOutbound.create({ data: { outboundNo: this.number("FGO"), orderNo: locked.orderNo, salesOrderId: locked.salesOrderId, productionOrderId: locked.productionOrderId, unitId: locked.unitId, productNameSnapshot: locked.productNameSnapshot, productSpecificationSnapshot: locked.productSpecificationSnapshot, quantity: locked.noticeQuantity, idempotencyKey: `notice:${locked.id}`, remark: `出库通知 ${locked.noticeNo}`, ...this.audit.create(user) } });
      await tx.finishedGoodsOutboundNotice.update({ where: { id: locked.id }, data: { status: "outbound_created", outboundId: created.id, version: { increment: 1 }, ...this.audit.update(user) } });
      return created;
    });
    await this.audit.record("finished_goods_outbound.create_from_notice", "finished_goods_outbound", user.id, row.id, { order_no: row.orderNo, notice_id: notice.id, notice_no: notice.noticeNo, quantity: row.quantity.toString() });
    return row;
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
      await tx.finishedGoodsOutboundNotice.updateMany({ where: { outboundId: id, deletedAt: null }, data: { status: "pending", outboundId: null, version: { increment: 1 }, ...this.audit.update(user) } });
      return cancelled;
    });
    await this.audit.record("finished_goods_outbound.cancel", "finished_goods_outbound", user.id, id, { order_no: row.orderNo, reason: reason.trim() });
    return row;
  }

  async postOutbound(id: string, user: CurrentUser) {
    const current = await this.prisma.finishedGoodsOutbound.findFirst({ where: { id, deletedAt: null } });
    if (!current) throw this.notFound("FINISHED_GOODS_OUTBOUND_NOT_FOUND", "成品出库单不存在");
    if (current.status !== "draft") throw this.invalid("FINISHED_GOODS_OUTBOUND_NOT_POSTABLE", "只有草稿出库单可以过账");
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM production_orders WHERE id = ${current.productionOrderId}::uuid FOR UPDATE`;
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
      if (postedQuantity.plus(current.quantity).gt(sales.quantity) && !current.riskReason?.trim()) throw new UnprocessableEntityException({ code: "OUTBOUND_PLAN_EXCEEDED_REASON_REQUIRED", message: "出库累计超过订单计划量，必须填写风险原因", details: [{ planned_quantity: sales.quantity.toString(), posted_quantity: postedQuantity.toString() }] });
      const posted = await tx.finishedGoodsOutbound.update({ where: { id }, data: { status: "posted", idempotencyKey: `post:${id}`, ...this.audit.update(user) } });
      await tx.inventoryFact.create({ data: { finishedGoodsOutboundId: id, unitId: current.unitId, inventoryCategory: "finished_goods", quantityDelta: current.quantity.negated(), sourceType: "finished_goods_outbound", sourceId: id, orderNo: current.orderNo, productionOrderId: current.productionOrderId, productNameSnapshot: current.productNameSnapshot, productSpecificationSnapshot: current.productSpecificationSnapshot, createdBy: user.id } });
      await tx.receivableSource.create({ data: { sourceNo: `AR-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomUUID().slice(0, 8).toUpperCase()}`, orderNo: current.orderNo, salesOrderId: current.salesOrderId, outboundId: id, customerId: sales.customerId, quantity: current.quantity, unit: sales.unit, unitPrice: settlementPrice, taxRate: sales.taxRate, amount: settlementPrice.mul(current.quantity), currency: sales.currency, status: "draft", signedAtSnapshot: current.signedAt, remark: this.settlementRemark(sales, settlementPrice), ...this.audit.create(user) } });
      // 出库过账 = 通知财务收款：应收来源草稿已生成，同时把来源出库通知置为 completed。
      await tx.finishedGoodsOutboundNotice.updateMany({ where: { outboundId: id, deletedAt: null, status: { in: ["pending", "outbound_created"] } }, data: { status: "completed", version: { increment: 1 }, ...this.audit.update(user) } });
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
    const row = await this.prisma.finishedGoodsOutbound.update({ where: { id }, data: { status: "shipped", ...(input.shipment_date ? { shipmentDate } : {}), ...(input.carrier === undefined ? {} : { carrier: input.carrier }), ...(input.tracking_no === undefined ? {} : { trackingNo: input.tracking_no }), ...(input.packing_list_no === undefined ? {} : { packingListNo: input.packing_list_no }), ...(input.invoice_no === undefined ? {} : { invoiceNo: input.invoice_no }), ...(input.attachment === undefined ? {} : { attachment: input.attachment as Prisma.InputJsonValue }), ...this.audit.update(user) } });
    await this.audit.record("finished_goods_outbound.shipping_update", "finished_goods_outbound", user.id, id, { order_no: row.orderNo });
    return row;
  }

  async signOutbound(id: string, input: { signed_at: string; signature_reference?: string; attachment?: unknown[] }, user: CurrentUser) {
    const current = await this.requireOutbound(id);
    if (!["shipped", "signed"].includes(current.status)) throw this.invalid("INVALID_OUTBOUND_SIGN_STATE", "只有已发货出库单可以登记签收");
    const signedAt = new Date(input.signed_at);
    if (Number.isNaN(signedAt.valueOf())) throw this.invalid("INVALID_SIGNED_AT", "签收时间无效");
    if (current.shipmentDate && signedAt < current.shipmentDate) throw this.invalid("SIGNATURE_BEFORE_SHIPMENT", "签收时间不能早于发货日期");
    const row = await this.prisma.finishedGoodsOutbound.update({ where: { id }, data: { status: "signed", signedAt, ...(input.signature_reference === undefined ? {} : { signatureReference: input.signature_reference }), ...(input.attachment === undefined ? {} : { attachment: input.attachment as Prisma.InputJsonValue }), ...this.audit.update(user) } });
    await this.audit.record("finished_goods_outbound.sign", "finished_goods_outbound", user.id, id, { order_no: row.orderNo, signed_at: signedAt.toISOString() });
    return row;
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
      // 冲销后货回到成品库存：把来源出库通知退回待处理，仓库可以重新生成出库单。
      await tx.finishedGoodsOutboundNotice.updateMany({ where: { outboundId: id, deletedAt: null }, data: { status: "pending", outboundId: null, version: { increment: 1 }, ...this.audit.update(user) } });
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
  private decimal(value: string, code: string) { try { const result = new Prisma.Decimal(value); if (result.lte(0)) throw new Error(); return result; } catch { throw new UnprocessableEntityException({ code, message: "数量必须是大于零的十进制数", details: [] }); } }
  private date(value: string, code: string) { const result = new Date(`${value}T00:00:00.000Z`); if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(result.valueOf())) throw new UnprocessableEntityException({ code, message: "日期无效", details: [] }); return result; }
  private number(prefix: string) { return `${prefix}-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomUUID().slice(0, 8).toUpperCase()}`; }
  private exceeded(code: string, available: Prisma.Decimal) { return new UnprocessableEntityException({ code, message: "成品库存不足", details: [{ available_quantity: available.toString() }] }); }
  /** 整批出库：出库数量必须等于当前成品可用量（不支持部分出库）。 */
  private fullBatchRequired(available: Prisma.Decimal, requested: Prisma.Decimal) {
    return new UnprocessableEntityException({
      code: "FINISHED_GOODS_OUTBOUND_MUST_BE_FULL_BATCH",
      message: "成品出库必须整批出库：出库数量必须等于当前成品可用量，不支持部分出库",
      details: [{ available_quantity: available.toString(), requested_quantity: requested.toString() }],
    });
  }

  /** 出库通知数量与当前库存不一致（通知后又入库/退货回仓）：让销售重新通知，不要悄悄少发。 */
  private noticeStale(noticeQuantity: Prisma.Decimal, available: Prisma.Decimal) {
    return new UnprocessableEntityException({
      code: "OUTBOUND_NOTICE_QUANTITY_STALE",
      message: `出库通知数量（${noticeQuantity.toString()}）与当前成品可用量（${available.toString()}）不一致：通知之后库存发生了变化，请让销售取消该通知并按最新可用量重新通知仓库（整批出库）`,
      details: [{ notice_quantity: noticeQuantity.toString(), available_quantity: available.toString() }],
    });
  }

  /**
   * 应收单价：销售单填了「应收金额」时按 应收金额 ÷ 订单数量 折算（整单出库时应收总额与销售填写一致），
   * 否则退回「结算币价」，再退回销售单价。
   */
  private receivableUnitPrice(sales: { quantity: Prisma.Decimal; receivableAmount: Prisma.Decimal | null; settlementUnitPrice: Prisma.Decimal | null; unitPrice: Prisma.Decimal | null } | null) {
    if (!sales) return null;
    if (sales.receivableAmount && sales.receivableAmount.gt(0) && sales.quantity.gt(0)) return sales.receivableAmount.div(sales.quantity);
    return sales.settlementUnitPrice ?? sales.unitPrice;
  }

  /** 把结算口径写进应收来源备注，财务不用回到销售单也能看到结算方式与本币金额。 */
  private settlementRemark(sales: { settlementMethod: string | null; localCurrencyAmount: Prisma.Decimal | null; receivableAmount: Prisma.Decimal | null }, unitPrice: Prisma.Decimal) {
    const parts = [`结算单价 ${unitPrice.toFixed(4)}`];
    if (sales.settlementMethod) parts.push(`结算方式 ${SETTLEMENT_METHOD_LABELS[sales.settlementMethod] ?? sales.settlementMethod}`);
    if (sales.localCurrencyAmount) parts.push(`本币金额 ${sales.localCurrencyAmount.toString()}`);
    if (sales.receivableAmount) parts.push(`销售单应收 ${sales.receivableAmount.toString()}`);
    return parts.join("；");
  }
  private notFound(code: string, message: string) { return new NotFoundException({ code, message, details: [] }); }
  private invalid(code: string, message: string) { return new UnprocessableEntityException({ code, message, details: [] }); }
}
