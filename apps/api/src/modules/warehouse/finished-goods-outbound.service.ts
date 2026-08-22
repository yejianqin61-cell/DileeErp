import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { AuditService } from "../../platform/audit/audit.service";
import type { CurrentUser } from "../../platform/auth/auth.service";
import { PrismaService } from "../../platform/database/prisma.service";
import { InventoryService } from "../../platform/inventory/inventory.service";

type OutboundInput = { sales_order_id: string; production_order_id: string; quantity: string; idempotency_key?: string; risk_reason?: string; remark?: string; attachment?: unknown[] };
type ReturnInput = { sales_order_id: string; production_order_id: string; quantity: string; return_date: string; destination: "finished_goods" | "defective_goods"; reason: string; idempotency_key?: string; remark?: string; attachment?: unknown[] };

@Injectable()
export class FinishedGoodsOutboundService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly inventory: InventoryService) {}

  async listOutbounds(orderNo?: string) { return this.prisma.finishedGoodsOutbound.findMany({ where: { deletedAt: null, ...(orderNo ? { orderNo } : {}) }, include: { inventoryFacts: true }, orderBy: { createdAt: "desc" } }); }
  async listReturns(orderNo?: string) { return this.prisma.customerReturn.findMany({ where: { deletedAt: null, ...(orderNo ? { orderNo } : {}) }, include: { inventoryFacts: true }, orderBy: { createdAt: "desc" } }); }

  async createOutbound(input: OutboundInput, user: CurrentUser) {
    const refs = await this.references(input.sales_order_id, input.production_order_id);
    const quantity = this.decimal(input.quantity, "INVALID_FINISHED_GOODS_OUTBOUND_QUANTITY");
    const balance = await this.inventory.finishedGoodsBalance(this.prisma, refs.production.id, refs.production.unitId, "finished_goods");
    if (quantity.gt(balance)) throw this.exceeded("FINISHED_GOODS_OUTBOUND_INVENTORY_INSUFFICIENT", balance);
    const planned = refs.sales.quantity;
    const posted = await this.postedOutboundQuantity(refs.production.id);
    if (posted.plus(quantity).gt(planned) && !input.risk_reason?.trim()) throw new UnprocessableEntityException({ code: "OUTBOUND_PLAN_EXCEEDED_REASON_REQUIRED", message: "出库累计超过订单计划量，必须填写风险原因", details: [{ planned_quantity: planned.toString(), posted_quantity: posted.toString() }] });
    const row = await this.prisma.finishedGoodsOutbound.create({ data: { outboundNo: this.number("FGO"), orderNo: refs.sales.orderNo, salesOrderId: refs.sales.id, productionOrderId: refs.production.id, unitId: refs.production.unitId, productNameSnapshot: refs.sales.productName, productSpecificationSnapshot: refs.sales.productSpec, quantity, riskReason: input.risk_reason, attachment: (input.attachment ?? []) as Prisma.InputJsonValue, idempotencyKey: input.idempotency_key?.trim() || `draft:${randomUUID()}`, remark: input.remark, ...this.audit.create(user) } });
    await this.audit.record("finished_goods_outbound.create", "finished_goods_outbound", user.id, row.id, { order_no: row.orderNo, quantity: quantity.toString(), risk_reason: row.riskReason });
    return row;
  }

  async postOutbound(id: string, user: CurrentUser) {
    const current = await this.prisma.finishedGoodsOutbound.findFirst({ where: { id, deletedAt: null } });
    if (!current) throw this.notFound("FINISHED_GOODS_OUTBOUND_NOT_FOUND", "成品出库单不存在");
    if (current.status !== "draft") throw this.invalid("FINISHED_GOODS_OUTBOUND_NOT_POSTABLE", "只有草稿出库单可以过账");
    const result = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.inventoryFact.findFirst({ where: { finishedGoodsOutboundId: id, sourceType: "finished_goods_outbound" } });
      if (existing) throw this.invalid("FINISHED_GOODS_OUTBOUND_ALREADY_POSTED", "成品出库单已过账");
      const balance = await this.inventory.finishedGoodsBalance(tx, current.productionOrderId, current.unitId, "finished_goods");
      if (current.quantity.gt(balance)) throw this.exceeded("FINISHED_GOODS_OUTBOUND_INVENTORY_INSUFFICIENT", balance);
      const posted = await tx.finishedGoodsOutbound.update({ where: { id }, data: { status: "posted", idempotencyKey: `post:${id}`, ...this.audit.update(user) } });
      await tx.inventoryFact.create({ data: { finishedGoodsOutboundId: id, unitId: current.unitId, inventoryCategory: "finished_goods", quantityDelta: current.quantity.negated(), sourceType: "finished_goods_outbound", sourceId: id, orderNo: current.orderNo, productionOrderId: current.productionOrderId, productNameSnapshot: current.productNameSnapshot, productSpecificationSnapshot: current.productSpecificationSnapshot, createdBy: user.id } });
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
      const existing = await tx.inventoryFact.findFirst({ where: { finishedGoodsOutboundId: id, sourceType: "finished_goods_outbound_reversal" } });
      if (existing) throw this.invalid("FINISHED_GOODS_OUTBOUND_ALREADY_REVERSED", "成品出库单已冲销");
      const updated = await tx.finishedGoodsOutbound.update({ where: { id }, data: { status: "reversed", remark: `${current.remark ?? ""}\n冲销：${reason}`, ...this.audit.update(user) } });
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
  private notFound(code: string, message: string) { return new NotFoundException({ code, message, details: [] }); }
  private invalid(code: string, message: string) { return new UnprocessableEntityException({ code, message, details: [] }); }
}
