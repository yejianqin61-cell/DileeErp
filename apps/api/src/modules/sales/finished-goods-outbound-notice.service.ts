import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { AuditService } from "../../platform/audit/audit.service";
import type { CurrentUser } from "../../platform/auth/auth.service";
import { PrismaService } from "../../platform/database/prisma.service";
import { InventoryService } from "../../platform/inventory/inventory.service";

/**
 * 成品出库通知（销售侧）。
 *
 * 业务口径（与仓库确认）：
 * - 成品入库后由销售「通知仓库出库」，把成品寄给客户；打开销售订单能看到成品入库/出库情况。
 * - 出库通知按**生产单**发起（出库单也是按生产单建的），一张通知对应一批（整批）可出库量。
 * - 可出库量 = 已过账成品入库 − 已过账/已发出/已签收出库 − 待出库的未完成通知量；
 *   通知数量固定等于当时可出库量（整批），仓库据此建出库单，不支持部分出库。
 * - 重复点击「通知出库」不会重复建单：可出库量已被待办通知占用后会返回明确的 422。
 */
type NoticeInput = { production_order_id?: string; remark?: string; idempotency_key?: string };

@Injectable()
export class FinishedGoodsOutboundNoticeService {
  constructor(private readonly prisma: PrismaService, private readonly inventory: InventoryService, private readonly audit: AuditService) {}

  /** 销售订单的成品入库/出库/待通知情况（按生产单拆分），供销售订单详情页展示。 */
  async summary(salesOrderId: string) {
    const order = await this.requireOrder(salesOrderId);
    const productionOrders = await this.prisma.productionOrder.findMany({
      where: { salesOrderId, deletedAt: null, NOT: { status: "cancelled" } },
      include: { unit: true, executionLocation: true },
      orderBy: { createdAt: "asc" },
    });
    const rows = [];
    for (const production of productionOrders) {
      const quantities = await this.productionQuantities(production.id, production.unitId);
      rows.push({
        production_order_id: production.id,
        production_order_no: production.productionOrderNo,
        production_status: production.status,
        execution_mode: production.executionMode,
        execution_location: production.executionLocation?.name ?? null,
        product_name: order.productName,
        product_specification: production.productSpecification ?? order.productSpec,
        unit_id: production.unitId,
        unit: production.unit?.name ?? null,
        planned_quantity: production.plannedQuantity.toString(),
        inbound_quantity: quantities.inbound.toString(),
        outbound_quantity: quantities.outbound.toString(),
        pending_notice_quantity: quantities.pendingNotice.toString(),
        available_quantity: quantities.available.toString(),
        notices: await this.listNoticesForProductionOrder(production.id),
      });
    }
    return {
      sales_order_id: order.id,
      order_no: order.orderNo,
      customer: order.customer?.name ?? null,
      product_name: order.productName,
      product_specification: order.productSpec,
      order_quantity: order.quantity.toString(),
      unit: order.unit,
      settlement_unit_price: order.settlementUnitPrice?.toString() ?? null,
      receivable_amount: order.receivableAmount?.toString() ?? null,
      settlement_method: order.settlementMethod ?? null,
      local_currency_amount: order.localCurrencyAmount?.toString() ?? null,
      production_orders: rows,
    };
  }

  /** 通知仓库出库：不传 production_order_id 时对「所有可出库的生产单」各建一张整批通知。 */
  async createNotices(salesOrderId: string, input: NoticeInput, user: CurrentUser) {
    const order = await this.requireOrder(salesOrderId);
    const idempotencyKey = input.idempotency_key?.trim();
    if (idempotencyKey) {
      // 存储键是「客户端键:生产单ID」（一张通知一个生产单）。重放必须**精确**匹配这些键，
      // 并且限定在本销售单内：用 startsWith 前缀匹配会跨单串号（键本身含冒号时更会误配）。
      const productionOrders = await this.prisma.productionOrder.findMany({ where: { salesOrderId, deletedAt: null }, select: { id: true } });
      const candidates = productionOrders.map((production) => `${idempotencyKey}:${production.id}`);
      const existing = candidates.length
        ? await this.prisma.finishedGoodsOutboundNotice.findMany({ where: { salesOrderId, deletedAt: null, idempotencyKey: { in: candidates } } })
        : [];
      if (existing.length) return existing;
    }
    if (input.production_order_id) {
      const owned = await this.prisma.productionOrder.findFirst({ where: { id: input.production_order_id, salesOrderId, deletedAt: null } });
      if (!owned) throw new UnprocessableEntityException({ code: "OUTBOUND_NOTICE_PRODUCTION_ORDER_MISMATCH", message: "该生产单不属于这张销售单，不能对它发出库通知", details: [{ production_order_id: input.production_order_id }] });
    }
    const targets = await this.notifiableProductionOrders(salesOrderId, input.production_order_id);
    if (!targets.length) throw this.nothingToNotify(input.production_order_id);
    const created = [];
    for (const target of targets) {
      try {
        const notice = await this.prisma.$transaction(async (tx) => {
          // 与「建出库单/过账」抢同一把锁（生产单行）：避免同一批被通知两次或数量被并发改动。
          await tx.$queryRaw`SELECT id FROM production_orders WHERE id = ${target.productionOrderId}::uuid FOR UPDATE`;
          const locked = await tx.productionOrder.findFirst({ where: { id: target.productionOrderId, deletedAt: null }, include: { unit: true } });
          if (!locked) throw new NotFoundException({ code: "PRODUCTION_ORDER_NOT_FOUND", message: "生产单不存在", details: [] });
          const quantities = await this.productionQuantities(target.productionOrderId, locked.unitId, tx);
          if (quantities.available.lte(0)) throw this.nothingToNotify(target.productionOrderId);
          const row = await tx.finishedGoodsOutboundNotice.create({
            data: {
              noticeNo: this.number("OGN"),
              orderNo: order.orderNo,
              salesOrderId: order.id,
              productionOrderId: target.productionOrderId,
              customerId: order.customerId,
              productNameSnapshot: order.productName,
              productSpecificationSnapshot: locked.productSpecification ?? order.productSpec,
              unitId: locked.unitId,
              unitNameSnapshot: locked.unit?.name ?? order.unit,
              inboundQuantity: quantities.inbound,
              outboundQuantity: quantities.outbound,
              noticeQuantity: quantities.available,
              status: "pending",
              notifiedAt: new Date(),
              notifiedBy: user.id,
              remark: input.remark,
              idempotencyKey: idempotencyKey ? `${idempotencyKey}:${target.productionOrderId}` : `notice:${target.productionOrderId}:${randomUUID()}`,
              ...this.audit.create(user),
            },
          });
          return row;
        });
        await this.audit.record("finished_goods_outbound_notice.create", "finished_goods_outbound_notice", user.id, notice.id, { order_no: notice.orderNo, production_order_id: notice.productionOrderId, notice_quantity: notice.noticeQuantity.toString() });
        created.push(notice);
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "P2002") {
          throw new ConflictException({ code: "OUTBOUND_NOTICE_CONFLICT", message: "该生产单的可出库成品已通知（可能刚刚被其他人通知过），请刷新后查看", details: [] });
        }
        throw error;
      }
    }
    return created;
  }

  /**
   * 取消尚未发完的通知。
   * 三种情形的处理不同：
   *   * pending：直接作废，剩余量立刻释放；
   *   * partially_outbound（已部分出库）：允许取消**剩余**部分——已过账的出库单与已生成的应收不受影响，
   *     只是把「通知量 − 已出库量」的占用释放掉。少这条路径时，客户取消尾单会让剩余量永久占用可出库额度，
   *     既不能再通知也关不掉，只能凭空过账一笔并不存在的发货再冲销；
   *   * outbound_created / completed / 有在途草稿：必须先处理出库单（取消草稿或冲销），否则会出现
   *     「通知已作废但草稿仍可过账」的悬空单。
   */
  async cancelNotice(salesOrderId: string, noticeId: string, reason: string, user: CurrentUser) {
    if (!reason?.trim()) throw new UnprocessableEntityException({ code: "CANCELLATION_REASON_REQUIRED", message: "取消出库通知必须填写原因", details: [] });
    const notice = await this.prisma.finishedGoodsOutboundNotice.findFirst({ where: { id: noticeId, salesOrderId, deletedAt: null } });
    if (!notice) throw new NotFoundException({ code: "OUTBOUND_NOTICE_NOT_FOUND", message: "出库通知不存在", details: [] });
    if (notice.status === "cancelled") return notice;
    if (notice.status === "outbound_created" || notice.status === "completed") throw new UnprocessableEntityException({ code: "OUTBOUND_NOTICE_NOT_CANCELLABLE", message: "仓库已按该通知建出库单：请先在仓库取消（未过账）或冲销（已过账）出库单，再取消通知", details: [{ status: notice.status }] });
    if (notice.status === "partially_outbound") {
      const drafts = await this.prisma.finishedGoodsOutbound.count({ where: { outboundNoticeId: notice.id, deletedAt: null, status: "draft" } });
      if (drafts > 0) throw new UnprocessableEntityException({ code: "OUTBOUND_NOTICE_NOT_CANCELLABLE", message: "该通知还有未过账的出库单草稿：请先在仓库取消草稿，再取消剩余通知量", details: [{ status: notice.status, draft_count: drafts }] });
    }
    // 带状态条件的更新：与「按通知建出库单」并发时不能把 outbound_created 覆盖成 cancelled。
    const updated = await this.prisma.$transaction(async (tx) => {
      const marked = await tx.finishedGoodsOutboundNotice.updateMany({ where: { id: notice.id, status: { in: ["pending", "partially_outbound"] }, deletedAt: null }, data: { status: "cancelled", remark: `${notice.remark ?? ""}\n取消：${reason.trim()}`, version: { increment: 1 }, ...this.audit.update(user) } });
      if (marked.count !== 1) throw new UnprocessableEntityException({ code: "OUTBOUND_NOTICE_NOT_CANCELLABLE", message: "该出库通知已被其他操作处理（可能仓库刚建了出库单），请刷新后重试", details: [] });
      return tx.finishedGoodsOutboundNotice.findFirst({ where: { id: notice.id } });
    });
    await this.audit.record("finished_goods_outbound_notice.cancel", "finished_goods_outbound_notice", user.id, notice.id, { order_no: notice.orderNo, reason: reason.trim(), previous_status: notice.status });
    return updated;
  }

  private async requireOrder(salesOrderId: string) {
    const order = await this.prisma.salesOrder.findFirst({ where: { id: salesOrderId, deletedAt: null }, include: { customer: { select: { id: true, name: true } } } });
    if (!order) throw new NotFoundException({ code: "SALES_ORDER_NOT_FOUND", message: "销售单不存在", details: [] });
    return order;
  }

  /** 有可出库量的生产单（未指定时取全部）。 */
  private async notifiableProductionOrders(salesOrderId: string, productionOrderId?: string) {
    const productionOrders = await this.prisma.productionOrder.findMany({ where: { salesOrderId, deletedAt: null, NOT: { status: "cancelled" }, ...(productionOrderId ? { id: productionOrderId } : {}) }, orderBy: { createdAt: "asc" } });
    const rows = [];
    for (const production of productionOrders) {
      const quantities = await this.productionQuantities(production.id, production.unitId);
      if (quantities.available.gt(0)) rows.push({ productionOrderId: production.id, available: quantities.available });
    }
    return rows;
  }

  /** 已入库 / 已出库 / 待办通知 / 可出库。
   *  可出库取**库存事实余额**（= 入库 − 出库 + 客户退货回到成品仓的部分）再扣掉待办通知的
   *  **未出库部分**（通知量 − 已出库量）；分批出库后已出库的部分不再占用额度。 */
  private async productionQuantities(productionOrderId: string, unitId: string, client: PrismaService | Prisma.TransactionClient = this.prisma) {
    const [inbound, outbound, openNotices, balance] = await Promise.all([
      client.finishedGoodsInbound.aggregate({ where: { productionOrderId, deletedAt: null, status: "posted" }, _sum: { quantity: true } }),
      client.finishedGoodsOutbound.aggregate({ where: { productionOrderId, deletedAt: null, status: { in: ["posted", "shipped", "signed"] } }, _sum: { quantity: true } }),
      client.finishedGoodsOutboundNotice.findMany({ where: { productionOrderId, deletedAt: null, status: { in: ["pending", "outbound_created", "partially_outbound"] } }, select: { noticeQuantity: true, shippedQuantity: true } }),
      this.inventory.finishedGoodsBalance(client, productionOrderId, unitId, "finished_goods"),
    ]);
    const inboundQuantity = new Prisma.Decimal(inbound._sum.quantity ?? 0);
    const outboundQuantity = new Prisma.Decimal(outbound._sum.quantity ?? 0);
    const pendingNoticeQuantity = openNotices.reduce((total, notice) => {
      const open = new Prisma.Decimal(notice.noticeQuantity).minus(notice.shippedQuantity);
      return open.gt(0) ? total.plus(open) : total;
    }, new Prisma.Decimal(0));
    const available = new Prisma.Decimal(balance).minus(pendingNoticeQuantity);
    return { inbound: inboundQuantity, outbound: outboundQuantity, pendingNotice: pendingNoticeQuantity, available: available.lt(0) ? new Prisma.Decimal(0) : available };
  }

  private async listNoticesForProductionOrder(productionOrderId: string) {
    const notices = await this.prisma.finishedGoodsOutboundNotice.findMany({ where: { productionOrderId, deletedAt: null }, include: { outbounds: { where: { deletedAt: null }, select: { id: true, outboundNo: true, status: true, quantity: true }, orderBy: { createdAt: "asc" } } }, orderBy: { notifiedAt: "desc" } });
    return notices.map((notice) => ({
      id: notice.id,
      notice_no: notice.noticeNo,
      notice_quantity: notice.noticeQuantity.toString(),
      shipped_quantity: notice.shippedQuantity.toString(),
      remaining_quantity: new Prisma.Decimal(notice.noticeQuantity).minus(notice.shippedQuantity).toString(),
      status: notice.status,
      notified_at: notice.notifiedAt.toISOString(),
      remark: notice.remark,
      outbound_nos: notice.outbounds.map((outbound) => outbound.outboundNo),
      outbound_statuses: notice.outbounds.map((outbound) => outbound.status),
    }));
  }

  private nothingToNotify(productionOrderId?: string) {
    return new UnprocessableEntityException({
      code: "OUTBOUND_NOTICE_NOTHING_TO_NOTIFY",
      message: productionOrderId
        ? "该生产单没有可通知出库的成品：需要先完成成品入库，且扣除已出库与待仓库建单的通知量后会大于 0（若都已通知，请到仓库页生成出库单）"
        : "该销售订单没有可通知出库的成品：请先在生产单完成成品入库，再通知仓库出库",
      details: [],
    });
  }

  private number(prefix: string) { return `${prefix}-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomUUID().slice(0, 8).toUpperCase()}`; }
}
