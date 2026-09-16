import { Injectable, NotFoundException, UnprocessableEntityException, Optional } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { AuditService } from "../../platform/audit/audit.service";
import type { CurrentUser } from "../../platform/auth/auth.service";
import { CurrencyService } from "../../platform/currency/currency.service";
import { PrismaService } from "../../platform/database/prisma.service";
import { requireActiveBank } from "./bank-selection";
import { paymentItemKeys } from "./cash-flow-catalog";
import { CashFlowService } from "./cash-flow.service";
import { ReceivableService } from "./receivable.service";

type PaymentInput = { customer_id: string; order_no?: string; payment_date: string; amount: string; currency: string; payment_method: string; bank_reference?: string; payer_name?: string; bank_id?: string; cash_flow_item_id?: string; attachment?: unknown[]; idempotency_key?: string; remark?: string };
type Allocation = { receivable_source_id: string; amount: string };

@Injectable()
export class CustomerPaymentService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly receivable: ReceivableService, private readonly cashFlow: CashFlowService, @Optional() private readonly currencies?: CurrencyService) {}

  /** 收款列表：带上客户名称与被核销的应收来源编号，否则财务只看得到一串 UUID。 */
  async list(orderNo?: string, customerId?: string) {
    const rows = await this.prisma.customerPayment.findMany({
      where: { deletedAt: null, ...(orderNo ? { orderNo } : {}), ...(customerId ? { customerId } : {}) },
      include: {
        customer: { select: { id: true, name: true, customerCode: true } },
        bank: { select: { id: true, bankName: true, accountNumber: true } },
        allocations: { where: { deletedAt: null }, include: { receivableSource: { select: { id: true, sourceNo: true, orderNo: true, amount: true, currency: true, status: true } } } },
      },
      orderBy: { createdAt: "desc" },
    });
    return rows.map((row) => ({
      ...row,
      customer_name: row.customer?.name ?? null,
      customer_code: row.customer?.customerCode ?? null,
      allocated_amount: row.allocations.filter((item) => item.status === "active").reduce((sum, item) => sum.plus(item.amount), new Prisma.Decimal(0)).toFixed(4),
    }));
  }
  async get(id: string) { const row = await this.prisma.customerPayment.findFirst({ where: { id, deletedAt: null }, include: { customer: { select: { id: true, name: true, customerCode: true } }, bank: { select: { id: true, bankName: true, accountNumber: true } }, allocations: { where: { deletedAt: null }, include: { receivableSource: { select: { id: true, sourceNo: true, orderNo: true, amount: true, currency: true, status: true } } } } } }); if (!row) throw this.notFound("CUSTOMER_PAYMENT_NOT_FOUND", "收款不存在"); return row; }
  async create(input: PaymentInput, user: CurrentUser) {
    await this.currencies?.assertSupported(input.currency, "收款币种");
    const amount = this.decimal(input.amount, "INVALID_PAYMENT_AMOUNT");
    const customer = await this.prisma.customer.findFirst({ where: { id: input.customer_id, deletedAt: null } });
    if (!customer) throw this.notFound("CUSTOMER_NOT_FOUND", "客户不存在");
    // 到账银行来自银行账户池：停用/已删除的账户不能收款，必须在这里挡住（外键拦不住「停用」）。
    await requireActiveBank(this.prisma, input.bank_id, "到账银行不存在或已停用");
    // 收支项目在**建单时**就校验并落库：表单里填过的东西不能在过账前丢掉（过账时仍可临时覆盖）。
    const cashFlowItem = await this.cashFlow.requireItem(input.cash_flow_item_id, "收支项目不存在或已停用，请在「收支管理 → 收支项目」里确认");
    const replayKey = input.idempotency_key?.trim() || null;
    // 幂等重放：同一次提交（网络重试、双击、浏览器重发）必须命中同一张草稿，而不是再建一张。
    if (replayKey) {
      const replayed = await this.prisma.customerPayment.findFirst({ where: { idempotencyKey: replayKey, deletedAt: null } });
      if (replayed) return replayed;
    }
    // 重复草稿守卫：同客户 + 同订单 + 同金额 + 同币种的**草稿**没有业务意义（真实的分批收款会先把前一张过账核销，
    // 过账后它就不再是 draft），因此这里不会挡住合法的分批收款场景。
    const duplicateDraft = await this.prisma.customerPayment.findFirst({
      where: { customerId: customer.id, orderNo: input.order_no ?? null, amount, currency: input.currency, status: "draft", deletedAt: null },
    });
    if (duplicateDraft) throw new UnprocessableEntityException({ code: "CUSTOMER_PAYMENT_DRAFT_EXISTS", message: `已存在相同客户/订单/金额的草稿收款单 ${duplicateDraft.paymentNo}，请直接编辑或过账它，避免重复登记`, details: [{ payment_id: duplicateDraft.id, payment_no: duplicateDraft.paymentNo }] });
    const row = await this.prisma.customerPayment.create({ data: { paymentNo: this.number("PAY"), idempotencyKey: replayKey, customerId: customer.id, orderNo: input.order_no, bankId: input.bank_id, cashFlowItemId: cashFlowItem?.id, paymentDate: this.date(input.payment_date), amount, currency: input.currency, paymentMethod: input.payment_method, bankReference: input.bank_reference, payerName: input.payer_name, attachment: (input.attachment ?? []) as Prisma.InputJsonValue, remark: input.remark, ...this.audit.create(user) } });
    await this.audit.record("customer_payment.create", "customer_payment", user.id, row.id, { order_no: row.orderNo, amount: row.amount.toString() });
    return row;
  }

  /**
   * 过账并核销。
   *
   * `cashFlowItemId`：过账时人工选定的收支项目（可选）。默认按来源自动归类为「货款」；
   * 财务明确选了就以选择为准，选了不存在的项目会 422，不会静默改成别的项目。
   */
  async post(id: string, allocations: Allocation[], user: CurrentUser, cashFlowItemId?: string | null) {
    const current = await this.prisma.customerPayment.findFirst({ where: { id, deletedAt: null } });
    if (!current) throw this.notFound("CUSTOMER_PAYMENT_NOT_FOUND", "收款不存在");
    if (current.status !== "draft") throw this.invalid("CUSTOMER_PAYMENT_NOT_POSTABLE", "只有草稿收款可以过账");
    if (!allocations?.length) throw this.invalid("PAYMENT_ALLOCATION_REQUIRED", "收款过账至少需要核销一条有效应收");
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM customer_payments WHERE id = ${id}::uuid FOR UPDATE`;
      const lockedPayment = await tx.customerPayment.findFirst({ where: { id, deletedAt: null }, include: { customer: { select: { name: true } }, bank: { select: { bankName: true, accountNumber: true } } } });
      if (!lockedPayment || lockedPayment.status !== "draft") throw this.invalid("CUSTOMER_PAYMENT_NOT_POSTABLE", "只有草稿收款可以过账");
      const existing = await tx.receivableAllocation.count({ where: { paymentId: id, deletedAt: null } });
      if (existing) throw this.invalid("CUSTOMER_PAYMENT_ALREADY_POSTED", "收款已存在核销分配");
      let total = new Prisma.Decimal(0);
      for (const allocation of allocations ?? []) {
        const amount = this.decimal(allocation.amount, "INVALID_ALLOCATION_AMOUNT");
        await tx.$queryRaw`SELECT id FROM receivable_sources WHERE id = ${allocation.receivable_source_id}::uuid FOR UPDATE`;
        const { source, available } = await this.receivable.allocationBalance(allocation.receivable_source_id, tx);
        if (source.customerId !== lockedPayment.customerId || source.currency !== lockedPayment.currency) throw this.invalid("ALLOCATION_REFERENCE_MISMATCH", "客户或币种与应收来源不一致");
        if (!["confirmed", "partially_paid"].includes(source.status)) throw this.invalid("RECEIVABLE_SOURCE_NOT_ALLOCATABLE", "应收来源尚未确认或已关闭");
        if (amount.gt(available)) throw this.exceeded("RECEIVABLE_ALLOCATION_EXCEEDED", available);
        total = total.plus(amount);
        await tx.receivableAllocation.create({ data: { paymentId: id, receivableSourceId: source.id, amount, currency: current.currency, ...this.audit.create(user) } });
      }
      if (total.gt(lockedPayment.amount)) throw this.exceeded("PAYMENT_ALLOCATION_EXCEEDED", lockedPayment.amount);
      const payment = await tx.customerPayment.update({ where: { id }, data: { status: "posted", ...this.audit.update(user) } });
      for (const allocation of allocations ?? []) await this.receivable.refreshStatus(tx, allocation.receivable_source_id, user);
      return { payment, customerName: lockedPayment.customer?.name ?? null, bankLabel: lockedPayment.bank ? `${lockedPayment.bank.bankName}${lockedPayment.bank.accountNumber}` : null, bank: lockedPayment.bank ?? null };
    });
    await this.audit.record("customer_payment.post", "customer_payment", user.id, id, { order_no: result.payment.orderNo, allocation_count: allocations?.length ?? 0 });
    // 过账即写收支流水：对方名称优先取付款人，其次客户名称，最后才退化成 id（不能一上来就是 UUID）。
    await this.cashFlow.autoCreateFromPayment({
      paymentNo: result.payment.paymentNo, paymentDate: result.payment.paymentDate, amount: result.payment.amount, currency: result.payment.currency,
      counterpartyName: result.payment.payerName ?? result.customerName ?? result.payment.customerId,
      direction: "income",
      // 结算方式按老表格式带出「转账--农业银行5706」，与供应商付款侧写法一致。
      settlementMethod: result.bankLabel ? `${result.payment.paymentMethod}--${result.bankLabel}` : result.payment.paymentMethod,
      settlementAccountId: null,
      // 到账银行一并带给收支流水：① bankId 是**银行余额**的依据（单据上选了银行就必须落到流水上）；
      // ② 按账号匹配「结算账户」字典，收支明细才看得到钱进了哪个账户（匹配不上就不硬编，留给人工）。
      bankId: result.payment.bankId ?? null,
      settlementAccountHint: result.bank ? { bankName: result.bank.bankName, accountNumber: result.bank.accountNumber } : null,
      sourceType: "customer_payment", sourceId: result.payment.id,
      itemKeys: paymentItemKeys("customer_payment"),
      // 过账时临时选的项目优先；没选就用建单时填在收款单上的项目；都没有则按来源自动归类。
      itemId: cashFlowItemId ?? result.payment.cashFlowItemId ?? null,
      remark: result.payment.remark ?? undefined,
    }, user);
    return result.payment;
  }

  /**
   * 编辑草稿收款：金额、日期、方式、**币种**、**到账银行**、备注。
   *
   * 币种可以改：草稿还没核销任何应收（核销是过账时才写的），所以此刻改币种不会有「已核销的应收币种对不上」的问题；
   * 过账时仍会逐条校验 `source.currency === payment.currency`（ALLOCATION_REFERENCE_MISMATCH），双重保险。
   */
  async updateDraft(id: string, input: { amount?: string; payment_date?: string; payment_method?: string; currency?: string; bank_id?: string | null; cash_flow_item_id?: string | null; remark?: string }, user: CurrentUser) {
    if (input.currency !== undefined) await this.currencies?.assertSupported(input.currency, "收款币种");
    if (input.bank_id) await requireActiveBank(this.prisma, input.bank_id, "到账银行不存在或已停用");
    const cashFlowItem = input.cash_flow_item_id === undefined ? undefined : await this.cashFlow.requireItem(input.cash_flow_item_id, "收支项目不存在或已停用，请在「收支管理 → 收支项目」里确认");
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM customer_payments WHERE id = ${id}::uuid FOR UPDATE`;
      const current = await tx.customerPayment.findFirst({ where: { id, deletedAt: null } });
      if (!current) throw this.notFound("CUSTOMER_PAYMENT_NOT_FOUND", "收款不存在");
      if (current.status !== "draft") throw this.invalid("CUSTOMER_PAYMENT_NOT_EDITABLE", "只有草稿收款可以编辑");
      const amount = input.amount === undefined ? current.amount : this.decimal(input.amount, "INVALID_PAYMENT_AMOUNT");
      // bank_id 传 null / 空串表示「清空到账银行」，传 undefined 表示「不改」——否则一旦选过银行就再也去不掉。
      const bankId = input.bank_id === undefined ? current.bankId : (input.bank_id || null);
      const cashFlowItemId = input.cash_flow_item_id === undefined ? current.cashFlowItemId : (cashFlowItem?.id ?? null);
      return tx.customerPayment.update({ where: { id }, data: { amount, paymentDate: input.payment_date ? this.date(input.payment_date) : current.paymentDate, paymentMethod: input.payment_method ?? current.paymentMethod, currency: input.currency ?? current.currency, bankId, cashFlowItemId, remark: input.remark ?? current.remark, ...this.audit.update(user) } });
    });
  }

  async reverse(id: string, reason: string, user: CurrentUser) { if (!reason?.trim()) throw new UnprocessableEntityException({ code: "REVERSAL_REASON_REQUIRED", message: "冲销必须填写原因", details: [] }); const current = await this.prisma.customerPayment.findFirst({ where: { id, deletedAt: null }, include: { allocations: { where: { deletedAt: null, status: "active" } } } }); if (!current) throw this.notFound("CUSTOMER_PAYMENT_NOT_FOUND", "收款不存在"); if (current.status === "reversed" || current.status === "draft") throw this.invalid("CUSTOMER_PAYMENT_NOT_REVERSIBLE", "当前收款不可冲销"); const result = await this.prisma.$transaction(async (tx) => { await tx.$queryRaw`SELECT id FROM customer_payments WHERE id = ${id}::uuid FOR UPDATE`; const locked = await tx.customerPayment.findFirst({ where: { id, deletedAt: null }, include: { allocations: { where: { deletedAt: null, status: "active" } } } }); if (!locked || locked.status === "reversed" || locked.status === "draft") throw this.invalid("CUSTOMER_PAYMENT_NOT_REVERSIBLE", "收款已被其他操作处理"); for (const sourceId of [...new Set(locked.allocations.map((allocation) => allocation.receivableSourceId))].sort()) await tx.$queryRaw`SELECT id FROM receivable_sources WHERE id = ${sourceId}::uuid FOR UPDATE`; await tx.receivableAllocation.updateMany({ where: { paymentId: id, status: "active", deletedAt: null }, data: { status: "reversed", ...this.audit.update(user) } }); const payment = await tx.customerPayment.update({ where: { id }, data: { status: "reversed", remark: `${locked.remark ?? ""}\n冲销：${reason}`, ...this.audit.update(user) } }); for (const allocation of locked.allocations) await this.receivable.refreshStatus(tx, allocation.receivableSourceId, user); return payment; }); await this.audit.record("customer_payment.reverse", "customer_payment", user.id, id, { order_no: result.orderNo, reason }); await this.cashFlow.autoReverseFromPayment("customer_payment", id, `收款冲销：${reason}`, user); return result; }
  async orderSummary(orderNo: string) { const sources = await this.prisma.receivableSource.findMany({ where: { orderNo, deletedAt: null }, include: { allocations: { where: { deletedAt: null, status: "active" }, include: { payment: true } } } }); const amount = sources.reduce((sum, source) => sum.plus(source.amount), new Prisma.Decimal(0)); const allocated = sources.reduce((sum, source) => sum.plus(source.allocations.filter((item) => item.payment.status === "posted").reduce((inner, item) => inner.plus(item.amount), new Prisma.Decimal(0))), new Prisma.Decimal(0)); return { order_no: orderNo, source_count: sources.length, receivable_amount: amount.toString(), allocated_amount: allocated.toString(), outstanding_amount: amount.minus(allocated).toString(), status: amount.gt(0) && allocated.gte(amount) ? "paid" : allocated.gt(0) ? "partially_paid" : "unpaid" }; }
  private decimal(value: string, code: string) { try { const result = new Prisma.Decimal(value); if (result.lte(0)) throw new Error(); return result; } catch { throw new UnprocessableEntityException({ code, message: "金额必须是大于零的十进制数", details: [] }); } }
  private date(value: string) { const result = new Date(`${value}T00:00:00.000Z`); if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(result.valueOf())) throw new UnprocessableEntityException({ code: "INVALID_PAYMENT_DATE", message: "收款日期无效", details: [] }); return result; }
  private number(prefix: string) { return `${prefix}-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomUUID().slice(0, 8).toUpperCase()}`; }
  private notFound(code: string, message: string) { return new NotFoundException({ code, message, details: [] }); }
  private invalid(code: string, message: string) { return new UnprocessableEntityException({ code, message, details: [] }); }
  private exceeded(code: string, available: Prisma.Decimal) { return new UnprocessableEntityException({ code, message: "核销金额超过可用余额", details: [{ available_amount: available.toString() }] }); }
}