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
import { SupplierPayableService } from "./supplier-payable.service";

type PaymentInput = { supplier_id: string; order_no?: string; payment_date: string; amount: string; currency: string; payment_method: string; bank_reference?: string; payee_name?: string; bank_id?: string; attachment?: unknown[]; idempotency_key?: string; remark?: string };
type AllocationInput = { payable_entry_id: string; amount: string; remark?: string };

@Injectable()
export class SupplierPaymentService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly payable: SupplierPayableService, private readonly cashFlow: CashFlowService, @Optional() private readonly currencies?: CurrencyService) {}

  async list(orderNo?: string, supplierId?: string, status?: string) {
    const rows = await this.prisma.supplierPayment.findMany({
      where: { deletedAt: null, ...(orderNo ? { orderNo } : {}), ...(supplierId ? { supplierId } : {}), ...(status ? { status } : {}) },
      include: { supplier: { select: { id: true, name: true, supplierCode: true } }, bank: { select: { id: true, bankName: true, accountNumber: true } }, allocations: { where: { deletedAt: null }, include: { payableEntry: true } } },
      orderBy: { createdAt: "desc" },
    });
    return rows.map((row) => ({
      ...row,
      supplier_name: row.supplier?.name ?? null,
      supplier_code: row.supplier?.supplierCode ?? null,
      allocated_amount: row.allocations.filter((item) => item.status === "active").reduce((sum, item) => sum.plus(item.amount), new Prisma.Decimal(0)).toFixed(4),
    }));
  }

  async get(id: string) {
    const row = await this.prisma.supplierPayment.findFirst({ where: { id, deletedAt: null }, include: { supplier: { select: { id: true, name: true, supplierCode: true } }, bank: { select: { id: true, bankName: true, accountNumber: true } }, allocations: { where: { deletedAt: null }, include: { payableEntry: true } } } });
    if (!row) throw this.notFound("SUPPLIER_PAYMENT_NOT_FOUND", "供应商付款不存在");
    return row;
  }

  async create(input: PaymentInput, user: CurrentUser) {
    await this.currencies?.assertSupported(input.currency, "付款币种");
    const amount = this.decimal(input.amount, "INVALID_SUPPLIER_PAYMENT_AMOUNT");
    const supplier = await this.prisma.supplier.findFirst({ where: { id: input.supplier_id, deletedAt: null, isActive: true } });
    if (!supplier) throw this.notFound("SUPPLIER_NOT_FOUND", "供应商不存在或已停用");
    // 支付银行来自银行账户池：停用/已删除的账户不能被选中（外键拦不住「停用」）。
    await requireActiveBank(this.prisma, input.bank_id, "支付银行不存在或已停用");
    const replayKey = input.idempotency_key?.trim() || null;
    // 与收款侧同一约定：同一次提交（网络重试、双击）必须命中同一张草稿付款单。
    if (replayKey) {
      const replayed = await this.prisma.supplierPayment.findFirst({ where: { idempotencyKey: replayKey, deletedAt: null } });
      if (replayed) return replayed;
    }
    // 重复草稿守卫：同供应商 + 同订单 + 同金额 + 同币种的草稿付款单没有业务意义。
    const duplicateDraft = await this.prisma.supplierPayment.findFirst({
      where: { supplierId: supplier.id, orderNo: input.order_no ?? null, amount, currency: input.currency, status: "draft", deletedAt: null },
    });
    if (duplicateDraft) throw new UnprocessableEntityException({ code: "SUPPLIER_PAYMENT_DRAFT_EXISTS", message: `已存在相同供应商/订单/金额的草稿付款单 ${duplicateDraft.paymentNo}，请直接编辑或过账它，避免重复登记`, details: [{ payment_id: duplicateDraft.id, payment_no: duplicateDraft.paymentNo }] });
    const row = await this.prisma.supplierPayment.create({ data: { paymentNo: this.number("SPAY"), idempotencyKey: replayKey, supplierId: supplier.id, orderNo: input.order_no, bankId: input.bank_id, paymentDate: this.date(input.payment_date), amount, currency: input.currency, paymentMethod: input.payment_method, bankReference: input.bank_reference, payeeName: input.payee_name, attachment: (input.attachment ?? []) as Prisma.InputJsonValue, remark: input.remark, ...this.audit.create(user) } });
    await this.audit.record("supplier_payment.create", "supplier_payment", user.id, row.id, { order_no: row.orderNo, amount: row.amount.toString() });
    return row;
  }

  /**
   * 过账并核销。
   *
   * `cashFlowItemId`：过账时人工选定的收支项目（可选）。默认按本次付款**金额最大**的应付来源
   * 自动归类（采购 / 外加工 / 其他应付）；财务明确选了就以选择为准，选了不存在的项目会 422。
   */
  async post(id: string, allocations: AllocationInput[], user: CurrentUser, cashFlowItemId?: string | null) {
    const items = allocations ?? [];
    if (items.length === 0) throw this.invalid("PAYMENT_ALLOCATION_REQUIRED", "付款过账至少需要核销一条有效应付");
    if (new Set(items.map((item) => item.payable_entry_id)).size !== items.length) throw this.invalid("DUPLICATE_PAYMENT_ALLOCATION", "同一付款不得重复核销同一应付");
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM supplier_payments WHERE id = ${id}::uuid FOR UPDATE`;
      // 供应商名称与银行要一起取出来：写收支流水时对方名称不能退化成 UUID，
      // 结算方式要按老表格式带出「转账--农业银行5706」。
      const lockedPayment = await tx.supplierPayment.findFirst({ where: { id, deletedAt: null }, include: { supplier: { select: { name: true } }, bank: { select: { bankName: true, accountNumber: true } } } });
      if (!lockedPayment || lockedPayment.status !== "draft") throw this.invalid("SUPPLIER_PAYMENT_NOT_POSTABLE", "只有草稿付款可以过账");
      let total = new Prisma.Decimal(0);
      // 按来源类型累计本次付款的金额：一笔付款可能同时核销采购、外加工与其他应付，
      // 收支项目按**金额最大**的那类来源选定（其余来源在备注里体现）。
      const sourceAmounts = new Map<string, Prisma.Decimal>();
      for (const item of items) {
        const amount = this.decimal(item.amount, "INVALID_ALLOCATION_AMOUNT");
        await tx.$queryRaw`SELECT id FROM supplier_payable_entries WHERE id = ${item.payable_entry_id}::uuid FOR UPDATE`;
        const balance = await this.payable.allocationBalance(item.payable_entry_id, tx);
        if (balance.entry.supplierId !== lockedPayment.supplierId || balance.entry.currency !== lockedPayment.currency || (lockedPayment.orderNo && balance.entry.orderNo !== lockedPayment.orderNo)) throw this.invalid("ALLOCATION_REFERENCE_MISMATCH", "供应商、币种或订单与应付不一致");
        if (!["confirmed", "partially_paid"].includes(balance.entry.status)) throw this.invalid("SUPPLIER_PAYABLE_NOT_ALLOCATABLE", "应付尚未确认或已关闭");
        if (amount.gt(balance.available)) throw new UnprocessableEntityException({ code: "PAYABLE_ALLOCATION_EXCEEDED", message: "核销金额超过应付未核销余额", details: [{ available_amount: balance.available.toString() }] });
        total = total.plus(amount);
        sourceAmounts.set(balance.entry.sourceType, (sourceAmounts.get(balance.entry.sourceType) ?? new Prisma.Decimal(0)).plus(amount));
        await tx.supplierPaymentAllocation.create({ data: { paymentId: id, payableEntryId: balance.entry.id, orderNo: balance.entry.orderNo, amount, currency: lockedPayment.currency, remark: item.remark, ...this.audit.create(user) } });
      }
      if (total.gt(lockedPayment.amount)) throw new UnprocessableEntityException({ code: "PAYMENT_ALLOCATION_EXCEEDED", message: "核销金额超过付款金额", details: [{ available_amount: lockedPayment.amount.minus(total).toString() }] });
      const payment = await tx.supplierPayment.update({ where: { id }, data: { status: "posted", ...this.audit.update(user) } });
      for (const item of items) await this.payable.refreshStatus(tx, item.payable_entry_id, user);
      return { payment, sourceAmounts, supplierName: lockedPayment.supplier?.name ?? null, bankLabel: lockedPayment.bank ? `${lockedPayment.bank.bankName}${lockedPayment.bank.accountNumber}` : null, bank: lockedPayment.bank ?? null };
    });
    await this.audit.record("supplier_payment.post", "supplier_payment", user.id, id, { order_no: result.payment.orderNo, allocation_count: items.length });
    // 过账即写收支流水：项目按本次付款金额最大的应付来源选定（采购 / 外加工 / 其他），
    // 字典里候选一个都不存在时由 CashFlowService 显式报错，不会静默丢掉这笔支出。
    const dominant = [...result.sourceAmounts.entries()].sort((left, right) => right[1].minus(left[1]).toNumber())[0]?.[0] ?? "other";
    await this.cashFlow.autoCreateFromPayment({
      paymentNo: result.payment.paymentNo, paymentDate: result.payment.paymentDate, amount: result.payment.amount, currency: result.payment.currency,
      counterpartyName: result.payment.payeeName ?? result.supplierName ?? result.payment.supplierId,
      direction: "expense",
      settlementMethod: result.bankLabel ? `${result.payment.paymentMethod}--${result.bankLabel}` : result.payment.paymentMethod,
      // 银行信息一并带上：收支流水按账号匹配「结算账户」字典，收支明细表才看得到具体账户。
      settlementAccountHint: result.bank ? { bankName: result.bank.bankName, accountNumber: result.bank.accountNumber } : null,
      sourceType: "supplier_payment", sourceId: result.payment.id,
      itemKeys: paymentItemKeys(dominant),
      itemId: cashFlowItemId ?? null,
      remark: result.payment.remark ?? undefined,
    }, user);
    return result.payment;
  }

  /**
   * 编辑草稿付款：金额、日期、方式、**币种**、**支付银行**、备注。
   *
   * 草稿还没核销任何应付（核销是过账时才写的），所以改币种不会与已核销记录冲突；
   * 过账时仍逐条校验供应商/币种/订单一致（ALLOCATION_REFERENCE_MISMATCH）。
   */
  async updateDraft(id: string, input: { amount?: string; payment_date?: string; payment_method?: string; currency?: string; bank_id?: string | null; remark?: string }, user: CurrentUser) {
    if (input.currency !== undefined) await this.currencies?.assertSupported(input.currency, "付款币种");
    if (input.bank_id) await requireActiveBank(this.prisma, input.bank_id, "支付银行不存在或已停用");
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM supplier_payments WHERE id = ${id}::uuid FOR UPDATE`;
      const current = await tx.supplierPayment.findFirst({ where: { id, deletedAt: null } });
      if (!current) throw this.notFound("SUPPLIER_PAYMENT_NOT_FOUND", "供应商付款不存在");
      if (current.status !== "draft") throw this.invalid("SUPPLIER_PAYMENT_NOT_EDITABLE", "只有草稿付款可以编辑");
      const amount = input.amount === undefined ? current.amount : this.decimal(input.amount, "INVALID_SUPPLIER_PAYMENT_AMOUNT");
      // bank_id 传 null / 空串 = 清空支付银行；undefined = 不改。
      const bankId = input.bank_id === undefined ? current.bankId : (input.bank_id || null);
      return tx.supplierPayment.update({ where: { id }, data: { amount, paymentDate: input.payment_date ? this.date(input.payment_date) : current.paymentDate, paymentMethod: input.payment_method ?? current.paymentMethod, currency: input.currency ?? current.currency, bankId, remark: input.remark ?? current.remark, ...this.audit.update(user) } });
    });
  }

  async reverse(id: string, reason: string, user: CurrentUser) {
    if (!reason?.trim()) throw this.invalid("REVERSAL_REASON_REQUIRED", "冲销必须填写原因");
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM supplier_payments WHERE id = ${id}::uuid FOR UPDATE`;
      const current = await tx.supplierPayment.findFirst({ where: { id, deletedAt: null }, include: { allocations: { where: { deletedAt: null, status: "active" } } } });
      if (!current) throw this.notFound("SUPPLIER_PAYMENT_NOT_FOUND", "供应商付款不存在");
      if (current.status !== "posted") throw this.invalid("SUPPLIER_PAYMENT_NOT_REVERSIBLE", "当前付款不可冲销");
      await tx.supplierPaymentAllocation.updateMany({ where: { paymentId: id, deletedAt: null, status: "active" }, data: { status: "reversed", ...this.audit.update(user) } });
      const payment = await tx.supplierPayment.update({ where: { id }, data: { status: "reversed", remark: `${current.remark ?? ""}\n冲销：${reason.trim()}`, ...this.audit.update(user) } });
      for (const allocation of current.allocations) await this.payable.refreshStatus(tx, allocation.payableEntryId, user);
      return payment;
    });
    await this.audit.record("supplier_payment.reverse", "supplier_payment", user.id, id, { order_no: result.orderNo, reason: reason.trim() });
    // 冲销要回冲收支流水：钱并没有真的付出去，流水里不能一直留着这笔支出（原实现只写过账不处理冲销）。
    await this.cashFlow.autoReverseFromPayment("supplier_payment", id, `供应商付款冲销：${reason.trim()}`, user);
    return result;
  }

  async orderSummary(orderNo: string) {
    const entries = await this.prisma.supplierPayableEntry.findMany({ where: { orderNo, deletedAt: null }, include: { allocations: { where: { deletedAt: null, status: "active" }, include: { payment: true } } } });
    const payments = await this.prisma.supplierPayment.findMany({ where: { orderNo, deletedAt: null, status: "posted" } });
    const payable = entries.filter((entry) => entry.status !== "reversed").reduce((sum, entry) => sum.plus(entry.amount), new Prisma.Decimal(0));
    const paid = entries.reduce((sum, entry) => sum.plus(entry.allocations.filter((allocation) => allocation.payment.status === "posted").reduce((inner, allocation) => inner.plus(allocation.amount), new Prisma.Decimal(0))), new Prisma.Decimal(0));
    return { order_no: orderNo, payable_amount: payable.toString(), paid_amount: paid.toString(), outstanding_amount: payable.minus(paid).toString(), payable_entry_count: entries.length, payment_count: payments.length, status: payable.eq(0) || paid.eq(0) ? "unpaid" : paid.gte(payable) ? "paid" : "partially_paid" };
  }

  private decimal(value: string, code: string) { try { const result = new Prisma.Decimal(value); if (result.lte(0)) throw new Error(); return result; } catch { throw this.invalid(code, "金额必须是大于零的十进制数"); } }
  private date(value: string) { const result = new Date(`${value}T00:00:00.000Z`); if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(result.valueOf())) throw this.invalid("INVALID_PAYMENT_DATE", "付款日期无效"); return result; }
  private number(prefix: string) { return `${prefix}-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomUUID().slice(0, 8).toUpperCase()}`; }
  private notFound(code: string, message: string) { return new NotFoundException({ code, message, details: [] }); }
  private invalid(code: string, message: string) { return new UnprocessableEntityException({ code, message, details: [] }); }
}