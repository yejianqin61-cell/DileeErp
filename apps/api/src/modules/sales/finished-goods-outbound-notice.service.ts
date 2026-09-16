import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { AuditService } from "../../platform/audit/audit.service";
import type { CurrentUser } from "../../platform/auth/auth.service";
import { PrismaService } from "../../platform/database/prisma.service";
import { parseQuantity } from "../../platform/database/quantity";
import { InventoryService } from "../../platform/inventory/inventory.service";

/**
 * 成品出库通知（销售侧）。
 *
 * 业务口径（与仓库确认）：
 * - 成品入库后由销售「通知仓库出库」，把成品寄给客户；打开销售订单能看到成品入库/出库情况。
 * - 出库通知按**生产单**发起（出库单也是按生产单建的）。
 * - 可出库量 = 已过账成品入库 − 已过账/已发出/已签收出库 − 待出库的未完成通知量；
 * - 销售可以**分批通知**（2026-09-16 需求）：不传 notice_quantity 时通知数量取当时全部可出库量
 *   （整批，保持原行为），传了就只通知这一部分，余量以后可以再通知一次；仓库侧再按通知分批实际出库。
 *   数量只对单个生产单有意义，所以传数量时必须同时指定 production_order_id。
 * - 重复点击「通知出库」不会重复建单：可出库量已被待办通知占用后会返回明确的 422。
 */
type NoticeInput = { production_order_id?: string; notice_quantity?: string; remark?: string; idempotency_key?: string };

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
      // 本单合计（按产品+单位分行）：销售页在明细行上方直接显示「全部成品 / 已出库 / 未出库」。
      totals: this.totalsOf(rows.map((row) => ({ product_name: row.product_name, unit: row.unit ?? "", inbound_quantity: row.inbound_quantity, outbound_quantity: row.outbound_quantity }))),
      production_orders: rows,
    };
  }

  /**
   * 销售模块的成品出库总览：按「产品 + 单位」分行给出 全部成品数 / 已出库数 / 未出库数。
   *
   * 为什么不给一个跨产品的总计：系统里不同销售单的单位并不统一（把 / kg / 套），
   * 把它们相加得到的是一个没有业务含义的数，还会让「未出库」看起来像能一起发货。
   * 所有非取消销售单下的非取消生产单都算在内（含尚未入库/尚未出库的）。
   */
  async overview() {
    const productionOrders = await this.prisma.productionOrder.findMany({
      where: { deletedAt: null, NOT: { status: "cancelled" }, salesOrder: { deletedAt: null, NOT: { status: "cancelled" } } },
      select: { id: true, unit: { select: { name: true } }, salesOrder: { select: { productName: true, unit: true } } },
      orderBy: { createdAt: "asc" },
    });
    if (!productionOrders.length) return { production_order_count: 0, groups: [] };
    const ids = productionOrders.map((production) => production.id);
    // 两条 groupBy 拿到全部生产单的入库/出库合计，避免按生产单逐条聚合（生产单一多就是 N+1）。
    const [inbound, outbound] = await Promise.all([
      this.prisma.finishedGoodsInbound.groupBy({ by: ["productionOrderId"], where: { deletedAt: null, status: "posted", productionOrderId: { in: ids } }, _sum: { quantity: true } }),
      this.prisma.finishedGoodsOutbound.groupBy({ by: ["productionOrderId"], where: { deletedAt: null, status: { in: ["posted", "shipped", "signed"] }, productionOrderId: { in: ids } }, _sum: { quantity: true } }),
    ]);
    const inboundBy = new Map(inbound.map((row) => [row.productionOrderId, new Prisma.Decimal(row._sum.quantity ?? 0)]));
    const outboundBy = new Map(outbound.map((row) => [row.productionOrderId, new Prisma.Decimal(row._sum.quantity ?? 0)]));
    const groups = new Map<string, { product_name: string; unit: string; inbound: Prisma.Decimal; outbound: Prisma.Decimal; productionOrders: number }>();
    for (const production of productionOrders) {
      const productName = production.salesOrder?.productName ?? "";
      const unit = production.unit?.name ?? production.salesOrder?.unit ?? "";
      // 分组键用 NUL 连接：产品名里出现空格/斜杠时不会和单位名串到一起。
      const key = `${productName}\u0000${unit}`;
      const group = groups.get(key) ?? { product_name: productName, unit, inbound: new Prisma.Decimal(0), outbound: new Prisma.Decimal(0), productionOrders: 0 };
      group.inbound = group.inbound.plus(inboundBy.get(production.id) ?? 0);
      group.outbound = group.outbound.plus(outboundBy.get(production.id) ?? 0);
      group.productionOrders += 1;
      groups.set(key, group);
    }
    return { production_order_count: productionOrders.length, groups: [...groups.values()].map((group) => this.totalsRow(group.product_name, group.unit, group.inbound, group.outbound, group.productionOrders)) };
  }

  /** 通知仓库出库：不传 production_order_id 时对「所有可出库的生产单」各建一张整批通知。 */
  async createNotices(salesOrderId: string, input: NoticeInput, user: CurrentUser) {
    const order = await this.requireOrder(salesOrderId);
    // 分批通知：数量只对「一个生产单」有意义（不指定生产单时一次会建多张通知，
    // 把同一个数量套到每个批次上用户无法预期），所以按数量通知必须先指定生产单。
    const requested = input.notice_quantity?.trim()
      ? parseQuantity(input.notice_quantity, "INVALID_OUTBOUND_NOTICE_QUANTITY", "通知数量必须是大于 0 的十进制数（最多 4 位小数）")
      : null;
    if (requested && !input.production_order_id) throw new UnprocessableEntityException({ code: "OUTBOUND_NOTICE_QUANTITY_REQUIRES_PRODUCTION_ORDER", message: "按数量通知出库必须指定生产单：不指定时会对该销售单每个可出库批次各建一张通知", details: [] });
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
          // 分批通知：没传数量就整批（保持原行为）；传了就必须 ≤ 当前可出库量，
          // 超过时明确报 422 而不是静默截断（截断会让销售以为整批都通知了，余量悄悄留在手里）。
          const noticeQuantity = requested ?? quantities.available;
          if (noticeQuantity.gt(quantities.available)) {
            throw new UnprocessableEntityException({ code: "OUTBOUND_NOTICE_QUANTITY_EXCEEDED", message: "本次通知数量超过当前可出库量", details: [{ available_quantity: quantities.available.toString(), requested_quantity: noticeQuantity.toString() }] });
          }
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
              noticeQuantity,
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
    // 只要还有在途草稿就先不收：作废通知会让草稿变成「来源已取消但仍可过账」的悬空单。
    const drafts = await this.prisma.finishedGoodsOutbound.count({ where: { outboundNoticeId: notice.id, deletedAt: null, status: "draft" } });
    if (drafts > 0) throw new UnprocessableEntityException({ code: "OUTBOUND_NOTICE_NOT_CANCELLABLE", message: "该通知还有未过账的出库单草稿：请先在仓库取消草稿，再取消通知", details: [{ status: notice.status, draft_count: drafts }] });
    // 带状态条件的更新：与「按通知建出库单」并发时不能把 outbound_created 覆盖成 cancelled。
    const updated = await this.prisma.$transaction(async (tx) => {
      const marked = await tx.finishedGoodsOutboundNotice.updateMany({ where: { id: notice.id, status: { in: ["pending", "partially_outbound"] }, deletedAt: null }, data: { status: "cancelled", remark: `${notice.remark ?? ""}\n取消：${reason.trim()}`, version: { increment: 1 }, ...this.audit.update(user) } });
      if (marked.count !== 1) throw new UnprocessableEntityException({ code: "OUTBOUND_NOTICE_NOT_CANCELLABLE", message: "该出库通知已被其他操作处理（可能仓库刚建了出库单），请刷新后重试", details: [] });
      return tx.finishedGoodsOutboundNotice.findFirst({ where: { id: notice.id } });
    });
    await this.audit.record("finished_goods_outbound_notice.cancel", "finished_goods_outbound_notice", user.id, notice.id, { order_no: notice.orderNo, reason: reason.trim(), previous_status: notice.status });
    return updated;
  }

  /**
   * 「全部成品数 / 已出库数 / 未出库数」三个数字的唯一算法（销售单合计与模块总览共用）。
   *
   * 口径（与用户确认）：全部 = 累计已过账成品入库；已出库 = 累计已过账/已发出/已签收出库；
   * 未出库 = 全部 − 已出库，也就是「还在成品仓里的」。
   * 客户退货回仓会让实际库存高于「入库 − 出库」，但退货不是「未出库的成品」，
   * 所以这里严格按差额算，只对负值做下限保护（出库不会超过当时库存，出现负数说明数据异常，
   * 显示负数会比显示 0 更容易被当成系统错误）。
   */
  private unshippedQuantity(inbound: Prisma.Decimal, outbound: Prisma.Decimal) {
    const value = new Prisma.Decimal(inbound).minus(outbound);
    return value.lt(0) ? new Prisma.Decimal(0) : value;
  }

  private totalsRow(productName: string, unit: string, inbound: Prisma.Decimal, outbound: Prisma.Decimal, productionOrders: number) {
    return {
      product_name: productName,
      unit,
      inbound_quantity: inbound.toString(),
      outbound_quantity: outbound.toString(),
      unshipped_quantity: this.unshippedQuantity(inbound, outbound).toString(),
      production_order_count: productionOrders,
    };
  }

  /** 把明细行（按生产单拆）折成「产品+单位」的合计行（生产单数=该组下的明细行数）。 */
  private totalsOf(rows: Array<{ product_name: string; unit: string; inbound_quantity: string; outbound_quantity: string }>) {
    const groups = new Map<string, { product_name: string; unit: string; inbound: Prisma.Decimal; outbound: Prisma.Decimal; productionOrders: number }>();
    for (const row of rows) {
      const key = `${row.product_name}\u0000${row.unit}`;
      const group = groups.get(key) ?? { product_name: row.product_name, unit: row.unit, inbound: new Prisma.Decimal(0), outbound: new Prisma.Decimal(0), productionOrders: 0 };
      group.inbound = group.inbound.plus(row.inbound_quantity);
      group.outbound = group.outbound.plus(row.outbound_quantity);
      group.productionOrders += 1;
      groups.set(key, group);
    }
    return [...groups.values()].map((group) => this.totalsRow(group.product_name, group.unit, group.inbound, group.outbound, group.productionOrders));
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
