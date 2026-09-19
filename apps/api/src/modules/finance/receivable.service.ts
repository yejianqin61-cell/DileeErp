import { Injectable, NotFoundException, UnprocessableEntityException, Optional } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { AuditService } from "../../platform/audit/audit.service";
import type { CurrentUser } from "../../platform/auth/auth.service";
import { CurrencyService } from "../../platform/currency/currency.service";
import { PrismaService } from "../../platform/database/prisma.service";
import { receivableAmountFor, receivableUnitPrice, settlementRemark } from "../warehouse/finished-goods-settlement";
import { coveringReceivableReconciliation } from "./receivable.domain";
import { matchesLedgerFilter, type LedgerFilter } from "./ledger-filter";
import { requireActiveBank } from "./bank-selection";
import { CashFlowService } from "./cash-flow.service";
import { RECEIVABLE_CONFIRM_SUBJECT_NAMES } from "./accounting-subject-catalog";

/**
 * 确认应收的三个入口（逐条 / 勾选批量 / 按对账单一键）共用同一组参数。
 *
 * `payment_nature` 是 2026-09-17 为老表「外汇一览表」加的口径（定金 / 货款 / 尾款 / 其他）：
 * 确认就是记账，钱的性质必须在这唯一一次录入口里问清楚，事后补标只能靠逐条改流水。
 * 传 `undefined` 表示「不动已有标注」（反复点确认不该把上次标的性质抹掉），
 * 传 `null` / 空串表示「清空」。
 */
type ConfirmReceivableOptions = { bank_id?: string | null; subject_id?: string | null; payment_nature?: string | null };

@Injectable()
export class ReceivableService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly cashFlow: CashFlowService, @Optional() private readonly currencies?: CurrencyService) {}

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
  /**
   * 应收台账列表。
   *
   * `filter`（可选）是「确认应收」页的筛选：收款情况 + 时间范围 + 关键字，见 `ledger-filter.ts`。
   * 时间范围用**创建日期**（= 成品出库过账生成这条来源的日期）：应收来源没有确认日期列
   * （确认与生成一般在同一天），而列表页的「待对账月份 / 出库日期」都是它 —— 口径保持一致。
   */
  async list(orderNo?: string, customerId?: string, status?: string, filter: LedgerFilter = {}) {
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
    }).filter((row) => matchesLedgerFilter({
      status: row.status,
      date: row.createdAt,
      search: [row.sourceNo, row.orderNo, row.customer_name, row.outbound_no, row.product_name, row.product_specification],
    }, filter));
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

  /**
   * 逐条确认应收 —— 确认即记账（用户要求：「一旦确认应收，金额就要进入对应的账户」）。
   *
   * 与「一键确认应收」（按对账单）的关系：**同一件事的两条入口**。
   * 按对账单确认写一条按对账单汇总的流水（对账单本身就是一张凭证）；
   * 逐条确认写一条只属于这条应收的流水。两条路径都靠 `recordConfirmation` 的
   * 「同来源只应有一条流水」保证不会重复记账 —— 一条应收一旦被确认就不再是草稿，
   * 另一个入口的查询条件（`status = draft`）自然不会再捞到它。
   *
   * `options.bank_id` / `options.subject_id` 允许空：没有银行账户时流水照写
   * （收支事实不能丢），响应里带 `bank_missing` 让界面明确提示。
   */
  async confirm(id: string, user: CurrentUser, options: ConfirmReceivableOptions = {}) {
    // 先进校验、后进事务：等事务提交完才发现银行非法，应收已经确认、流水却没写。
    if (options.bank_id) await requireActiveBank(this.prisma, options.bank_id, "入账银行不存在或已停用");
    if (options.subject_id) await this.cashFlow.requireSubject(options.subject_id, "会计科目不存在或已停用，请在「收支管理 → 会计科目」里确认");
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM receivable_sources WHERE id = ${id}::uuid FOR UPDATE`;
      const current = await tx.receivableSource.findFirst({ where: { id, deletedAt: null }, include: { customer: { select: { name: true } } } });
      if (!current) throw this.notFound("RECEIVABLE_SOURCE_NOT_FOUND", "应收来源不存在");
      if (current.status !== "draft") throw this.invalid("RECEIVABLE_SOURCE_NOT_CONFIRMABLE", "只有草稿应收来源可以确认");
      const updated = await tx.receivableSource.update({ where: { id }, data: { status: "confirmed", ...this.audit.update(user) } });
      // 客户名要从 current 拿：update 的返回值只有标量列，没有关联，用 row 会退化成客户 UUID。
      return { updated, customerName: current.customer?.name ?? current.customerId };
    });
    const row = result.updated;
    await this.audit.record("receivable_source.confirm", "receivable_source", user.id, id, { order_no: row.orderNo });
    const cashFlow = await this.cashFlow.recordConfirmation({
      sourceType: "receivable_source",
      sourceId: id,
      documentNo: row.sourceNo,
      entryDate: this.today(),
      amount: row.amount,
      currency: row.currency,
      counterpartyName: result.customerName,
      direction: "income",
      subjectNames: RECEIVABLE_CONFIRM_SUBJECT_NAMES,
      subjectId: options.subject_id,
      bankId: options.bank_id ?? null,
      // 订单号随单据一起落到流水上：外汇一览表要按订单把收款归集起来（定金在出货前就收到了，
      // 那条流水没有来源可挂，只能靠这个字段）。这里来源单据自己就知道订单号，不必财务手填。
      orderNo: row.orderNo,
      paymentNature: options.payment_nature,
      remark: `确认应收 ${row.sourceNo}`,
    }, user);
    return { ...row, cash_flow_entry_id: cashFlow?.id ?? null, bank_missing: !options.bank_id };
  }

  /**
   * 勾选批量确认应收 —— 界面「确认应收」页勾选多条 → 一次确认（与应付侧 `SupplierPayableService.batchConfirm`
   * 同一口径；用户要求「不要又是登记收款又是确认应收」）。
   *
   * 为什么需要：一个订单分批出库就是多条应收，逐条确认意味着同一笔货款要开 N 次弹窗、把入账银行填 N 遍。
   * 批量确认把「钱进哪个账户、归哪个项目」**只问一次**，记账仍然**每条应收写一条流水**
   * （每条都有自己的来源编号，合并成一条就再也追不回是哪张出库单的钱）。
   *
   * 幂等：只确认 `status = draft` 的条目。被另一个入口先确认掉的、已取消的计入 `skipped_count`，
   * 既不报错也不重复记账（重复记账＝同一个账户被进两次钱）。
   */
  async batchConfirm(ids: string[], user: CurrentUser, options: ConfirmReceivableOptions = {}) {
    if (!ids.length) throw this.invalid("RECEIVABLE_IDS_REQUIRED", "请先勾选要确认的应收条目");
    // 银行与项目整批只有一个，先校验一次即可（「先校验后进事务」在这里同样成立）。
    if (options.bank_id) await requireActiveBank(this.prisma, options.bank_id, "入账银行不存在或已停用");
    if (options.subject_id) await this.cashFlow.requireSubject(options.subject_id, "会计科目不存在或已停用，请在「收支管理 → 会计科目」里确认");
    const result = await this.prisma.$transaction(async (tx) => {
      // 逐条加锁：每条都要保证「读到草稿 → 改成已确认」之间不被另一个入口插进来
      // （单条确认、对账确认用的是同一把行锁，因此互相串行）。
      for (const id of ids) await tx.$queryRaw`SELECT id FROM receivable_sources WHERE id = ${id}::uuid FOR UPDATE`;
      const drafts = await tx.receivableSource.findMany({
        where: { id: { in: ids }, deletedAt: null, status: "draft" },
        select: { id: true, sourceNo: true, orderNo: true, amount: true, currency: true, customerId: true, customer: { select: { name: true } } },
      });
      if (!drafts.length) throw this.invalid("NO_DRAFT_RECEIVABLES", "勾选的条目里没有可确认的草稿应收");
      const updated = await tx.receivableSource.updateMany({
        where: { id: { in: drafts.map((draft) => draft.id) }, deletedAt: null, status: "draft" },
        data: { status: "confirmed", ...this.audit.update(user) },
      });
      // 行锁之下不可能少改：真少了说明有人绕过锁改了状态，宁可整批回滚也不要「界面说确认了、库里没确认」。
      if (updated.count !== drafts.length) throw this.invalid("RECEIVABLE_CONFIRM_CONFLICT", "勾选的应收已被其他操作改动，请刷新后重试");
      return { drafts, skipped: ids.length - drafts.length };
    });
    const cashFlowEntryIds: string[] = [];
    const totals = new Map<string, Prisma.Decimal>();
    for (const draft of result.drafts) {
      await this.audit.record("receivable_source.confirm", "receivable_source", user.id, draft.id, { order_no: draft.orderNo, batch: true });
      const entry = await this.cashFlow.recordConfirmation({
        sourceType: "receivable_source",
        sourceId: draft.id,
        documentNo: draft.sourceNo,
        entryDate: this.today(),
        amount: draft.amount,
        currency: draft.currency,
        counterpartyName: draft.customer?.name ?? draft.customerId,
        direction: "income",
        subjectNames: RECEIVABLE_CONFIRM_SUBJECT_NAMES,
        subjectId: options.subject_id,
        bankId: options.bank_id ?? null,
        // 逐条记账时订单号从这一条应收自己带过来（见 confirm 的同名注释）。
        orderNo: draft.orderNo,
        paymentNature: options.payment_nature,
        remark: `确认应收 ${draft.sourceNo}（勾选批量确认）`,
      }, user);
      if (entry) cashFlowEntryIds.push(entry.id);
      totals.set(draft.currency, (totals.get(draft.currency) ?? new Prisma.Decimal(0)).plus(draft.amount));
    }
    return {
      ids: result.drafts.map((draft) => draft.id),
      confirmed_count: result.drafts.length,
      skipped_count: result.skipped,
      // 合计**按币种分组**：跨币种相加得到一个没有意义的数（与财务报表「不跨币种相加」同一口径）。
      amounts: [...totals.entries()].map(([currency, amount]) => ({ currency, amount: amount.toFixed(4) })),
      cash_flow_entry_ids: cashFlowEntryIds,
      bank_missing: !options.bank_id,
    };
  }

  /**
   * 按订单号批量确认该订单下所有草稿应收（解决「同一订单多次出库 → 逐条确认」的重复操作）。
   * 幂等：只确认状态为 draft 的条目，已确认/已取消的自动跳过。
   *
   * 批量确认同样要记账：**每条应收写一条流水**（而不是合计一条）——
   * 批量确认没有「一张单据」可以挂，而每条应收都有来源编号，逐条记账才追得回去。
   *
   * 2026-09-16：界面上的按订单批量确认表已下线（改为勾选批量确认，勾选能在筛选后精确到某张订单），
   * 这个接口保留给外部调用方与历史脚本，记账口径与 `batchConfirm` 完全一致。
   */
  async batchConfirmByOrder(orderNo: string, user: CurrentUser, options: ConfirmReceivableOptions = {}) {
    if (options.bank_id) await requireActiveBank(this.prisma, options.bank_id, "入账银行不存在或已停用");
    if (options.subject_id) await this.cashFlow.requireSubject(options.subject_id, "会计科目不存在或已停用，请在「收支管理 → 会计科目」里确认");
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM receivable_sources WHERE order_no = ${orderNo} AND deleted_at IS NULL AND status = 'draft' FOR UPDATE`;
      const drafts = await tx.receivableSource.findMany({
        where: { orderNo, deletedAt: null, status: "draft" },
        select: { id: true, sourceNo: true, amount: true, currency: true, customerId: true, customer: { select: { name: true } } },
      });
      if (!drafts.length) throw this.notFound("NO_DRAFT_RECEIVABLES", `订单 ${orderNo} 没有草稿应收条目`);
      const ids = drafts.map((item) => item.id);
      await tx.receivableSource.updateMany({
        where: { id: { in: ids }, deletedAt: null, status: "draft" },
        data: { status: "confirmed", ...this.audit.update(user) },
      });
      return { orderNo, count: drafts.length, ids, drafts };
    });
    for (const id of result.ids) {
      await this.audit.record("receivable_source.confirm", "receivable_source", user.id, id, { order_no: result.orderNo, batch: true });
    }
    const cashFlowEntryIds: string[] = [];
    for (const draft of result.drafts) {
      const entry = await this.cashFlow.recordConfirmation({
        sourceType: "receivable_source",
        sourceId: draft.id,
        documentNo: draft.sourceNo,
        entryDate: this.today(),
        amount: draft.amount,
        currency: draft.currency,
        counterpartyName: draft.customer?.name ?? draft.customerId,
        direction: "income",
        subjectNames: RECEIVABLE_CONFIRM_SUBJECT_NAMES,
        subjectId: options.subject_id,
        bankId: options.bank_id ?? null,
        orderNo: result.orderNo,
        paymentNature: options.payment_nature,
        remark: `确认应收 ${draft.sourceNo}（订单 ${result.orderNo} 批量确认）`,
      }, user);
      if (entry) cashFlowEntryIds.push(entry.id);
    }
    return { orderNo: result.orderNo, count: result.count, ids: result.ids, cash_flow_entry_ids: cashFlowEntryIds, bank_missing: !options.bank_id };
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
  /** 确认发生的日期（记账日）：取当天的 UTC 零点，让流水日期与「今天」在库里可比较、可复现。 */
  private today() { return new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`); }
  private notFound(code: string, message: string) { return new NotFoundException({ code, message, details: [] }); }
  private invalid(code: string, message: string) { return new UnprocessableEntityException({ code, message, details: [] }); }
}