import { Injectable, NotFoundException, UnprocessableEntityException, Optional } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { AuditService } from "../../platform/audit/audit.service";
import type { CurrentUser } from "../../platform/auth/auth.service";
import { CurrencyService } from "../../platform/currency/currency.service";
import { PrismaService } from "../../platform/database/prisma.service";
import { requireActiveBank } from "./bank-selection";
import { paymentSubjectNames } from "./accounting-subject-catalog";
import { dominantDocumentSubject } from "./cash-flow.domain";
import { CashFlowService } from "./cash-flow.service";
import { coveringPayableReconciliation } from "./supplier-payable.domain";
import { SOURCE_PAYABLE, VoucherService } from "./voucher.service";
import { SupplierPayableService } from "./supplier-payable.service";

type PaymentInput = { supplier_id: string; order_no?: string; payment_date: string; amount: string; currency: string; payment_method: string; bank_reference?: string; payee_name?: string; bank_id?: string; subject_id?: string; attachment?: unknown[]; idempotency_key?: string; remark?: string };
type AllocationInput = { payable_entry_id: string; amount: string; remark?: string };

@Injectable()
export class SupplierPaymentService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly payable: SupplierPayableService, private readonly cashFlow: CashFlowService, @Optional() private readonly currencies?: CurrencyService, @Optional() private readonly vouchers?: VoucherService) {}

  /** 挂账用的凭证服务（销账时要问「这批应付挂过账没有」；DI 漏了就炸，不许静默按老口径记成本）。 */
  private get accruals(): VoucherService {
    if (!this.vouchers) throw new Error("VoucherService 未注入：付款销账必须能判断挂账（见 finance.module.ts 的 providers）");
    return this.vouchers;
  }

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
    // 会计科目建单时就校验并落库：表单里填过的东西不能在过账前丢掉（过账时仍可临时覆盖）。
    const subject = await this.cashFlow.requireSubject(input.subject_id, "会计科目不存在或已停用，请在「收支管理 → 会计科目」里确认");
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
    const row = await this.prisma.supplierPayment.create({ data: { paymentNo: this.number("SPAY"), idempotencyKey: replayKey, supplierId: supplier.id, orderNo: input.order_no, bankId: input.bank_id, subjectId: subject?.id, paymentDate: this.date(input.payment_date), amount, currency: input.currency, paymentMethod: input.payment_method, bankReference: input.bank_reference, payeeName: input.payee_name, attachment: (input.attachment ?? []) as Prisma.InputJsonValue, remark: input.remark, ...this.audit.create(user) } });
    await this.audit.record("supplier_payment.create", "supplier_payment", user.id, row.id, { order_no: row.orderNo, amount: row.amount.toString() });
    return row;
  }

  /**
   * 过账并核销。
   *
   * `subjectId`：过账时人工选定的会计科目（可选）。默认按本次付款**金额最大**的应付来源
   * 自动归类（采购 / 外加工 / 其他应付）；财务明确选了就以选择为准，选了不存在的项目会 422。
   */
  async post(id: string, allocations: AllocationInput[], user: CurrentUser, subjectId?: string | null) {
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
      // 会计科目按**金额最大**的那类来源选定（其余来源在备注里体现）。
      const sourceAmounts = new Map<string, Prisma.Decimal>();
      /**
       * 「收支类目」的取数（2026-10-13）：每条被核销的单据**自己填的科目**（没有则取覆盖它的对账单科目）。
       *
       * 与应付台账的显示链（条目 > 覆盖它的对账单 > 按来源的候选链）**逐字对齐** ——
       * 报表上写着「房租费」而台账写着「管理费用」这种事，只有财务对账时才会发现。
       */
      const settledDocuments: Array<{ amount: Prisma.Decimal; subjectId: string | null }> = [];
      // 覆盖本次核销条目的对账单（一次查全，循环里按范围纯函数匹配）。
      const coverages = await tx.supplierPayableReconciliation.findMany({
        where: { deletedAt: null, supplierId: lockedPayment.supplierId },
        select: { id: true, reconciliationNo: true, status: true, supplierId: true, currency: true, orderNo: true, purchaseOrderId: true, periodStart: true, periodEnd: true, subjectId: true },
      });
      for (const item of items) {
        const amount = this.decimal(item.amount, "INVALID_ALLOCATION_AMOUNT");
        await tx.$queryRaw`SELECT id FROM supplier_payable_entries WHERE id = ${item.payable_entry_id}::uuid FOR UPDATE`;
        const balance = await this.payable.allocationBalance(item.payable_entry_id, tx);
        if (balance.entry.supplierId !== lockedPayment.supplierId || balance.entry.currency !== lockedPayment.currency || (lockedPayment.orderNo && balance.entry.orderNo !== lockedPayment.orderNo)) throw this.invalid("ALLOCATION_REFERENCE_MISMATCH", "供应商、币种或订单与应付不一致");
        if (!["confirmed", "partially_paid"].includes(balance.entry.status)) throw this.invalid("SUPPLIER_PAYABLE_NOT_ALLOCATABLE", "应付尚未确认或已关闭");
        if (amount.gt(balance.available)) throw new UnprocessableEntityException({ code: "PAYABLE_ALLOCATION_EXCEEDED", message: "核销金额超过应付未核销余额", details: [{ available_amount: balance.available.toString() }] });
        total = total.plus(amount);
        sourceAmounts.set(balance.entry.sourceType, (sourceAmounts.get(balance.entry.sourceType) ?? new Prisma.Decimal(0)).plus(amount));
        settledDocuments.push({
          amount,
          subjectId: balance.entry.subjectId ?? coveringPayableReconciliation(balance.entry, coverages)?.subjectId ?? null,
        });
        await tx.supplierPaymentAllocation.create({ data: { paymentId: id, payableEntryId: balance.entry.id, orderNo: balance.entry.orderNo, amount, currency: lockedPayment.currency, remark: item.remark, ...this.audit.create(user) } });
      }
      if (total.gt(lockedPayment.amount)) throw new UnprocessableEntityException({ code: "PAYMENT_ALLOCATION_EXCEEDED", message: "核销金额超过付款金额", details: [{ available_amount: lockedPayment.amount.minus(total).toString() }] });
      const payment = await tx.supplierPayment.update({ where: { id }, data: { status: "posted", ...this.audit.update(user) } });
      for (const item of items) await this.payable.refreshStatus(tx, item.payable_entry_id, user);
      return { payment, sourceAmounts, settledDocuments, supplierName: lockedPayment.supplier?.name ?? null, bankLabel: lockedPayment.bank ? `${lockedPayment.bank.bankName}${lockedPayment.bank.accountNumber}` : null, bank: lockedPayment.bank ?? null };
    });
    await this.audit.record("supplier_payment.post", "supplier_payment", user.id, id, { order_no: result.payment.orderNo, allocation_count: items.length });
    // 过账即写收支流水：项目按本次付款金额最大的应付来源选定（采购 / 外加工 / 其他），
    // 字典里候选一个都不存在时由 CashFlowService 显式报错，不会静默丢掉这笔支出。
    const dominant = [...result.sourceAmounts.entries()].sort((left, right) => right[1].minus(left[1]).toNumber())[0]?.[0] ?? "other";
    // **销账**：钱真的付了，这条流水才写现金。对方科目取决于「这批应付有没有先挂过账」
    // （两步口径见 `voucher.service.ts` 的 createAccrual / accruedSourceIds）：
    //   - 挂过账 → 借 `应付账款`（成本已经在挂账时记过，这里再借一次成本就是成本翻倍）；
    //   - 没挂过账（历史数据、当年「确认即记账」的应付）→ 仍按老口径借成本/存货，历史不动。
    // 只要有一条来源没挂账，就按老口径（不猜）：混着两种口径的付款本来就说不清借方是谁。
    const allocatedIds = items.map((item) => item.payable_entry_id);
    const accrued = await this.accruals.accruedSourceIds(SOURCE_PAYABLE, allocatedIds);
    const allAccrued = allocatedIds.length > 0 && allocatedIds.every((payableId) => accrued.has(payableId));
    const settled: readonly string[] = allAccrued
      ? ["应付账款"]
      : paymentSubjectNames(dominant);
    /** 条目自己写的科目（金额最大那条；没有则取覆盖它的对账单）。 */
    const documentSubjectId = dominantDocumentSubject(result.settledDocuments);
    /** 单据上人工选的科目（过账时临时选 > 建单时填在付款单上）。 */
    const explicitSubjectId = subjectId ?? result.payment.subjectId ?? null;
    /**
     * **借方科目**（会被记成凭证业务分录的那个）的优先级，2026-10-16 补了第 3 条：
     *   1. 过账时临时选；2. 建单时填在付款单上；3. **未挂账时取条目自己写的科目**；
     *   4. 都没有才按来源类型的候选链（`settled`）。
     *
     * 为什么第 3 条必须存在：资金搬运（其他应付的科目填了「库存现金（备用金）」这类资金科目）
     * **不挂账**（见 `voucher.service.ts` 的 `createAccrual`），于是「借方」只能从条目自己身上取 ——
     * 否则备用金取现的凭证会被写成「借 管理费用 / 贷 银行存款」，用户看到的就是
     * 「该笔凭证的会计科目没法正常显示」。已挂账的付款不适用（成本在挂账时记过，借方只能是应付账款）。
     */
    const mainSubjectId = allAccrued ? null : (explicitSubjectId ?? documentSubjectId ?? null);
    await this.cashFlow.autoCreateFromPayment({
      paymentNo: result.payment.paymentNo, paymentDate: result.payment.paymentDate, amount: result.payment.amount, currency: result.payment.currency,
      counterpartyName: result.payment.payeeName ?? result.supplierName ?? result.payment.supplierId,
      direction: "expense",
      settlementMethod: result.bankLabel ? `${result.payment.paymentMethod}--${result.bankLabel}` : result.payment.paymentMethod,
      // 银行信息一并带上：① bankId 是**银行余额**的依据（单据上选了银行就必须落到流水上）；
      // ② 按账号匹配「结算账户」字典，收支明细表才看得到具体账户。
      bankId: result.payment.bankId ?? null,
      settlementAccountHint: result.bank ? { bankName: result.bank.bankName, accountNumber: result.bank.accountNumber } : null,
      sourceType: "supplier_payment", sourceId: result.payment.id,
      subjectNames: settled,
      // 借方：已挂账 → 应付账款（`mainSubjectId` 为 null，交给候选链）；否则人工选的优先于条目自己的科目。
      subjectId: mainSubjectId,
      /**
       * 收支类目（2026-10-13）：这笔钱算什么 —— 人工在单据上选的科目优先，其次本次核销**单据**上写的
       * 科目（金额最大的那条），都没有才退回按来源类型的候选链。
       * 注意它**不参与记账**：主科目才是拿来生成凭证的那个（已挂账的付款必须是「应付账款」）。
       */
      categorySubjectId: explicitSubjectId ?? documentSubjectId,
      categorySubjectNames: paymentSubjectNames(dominant),
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
  async updateDraft(id: string, input: { amount?: string; payment_date?: string; payment_method?: string; currency?: string; bank_id?: string | null; subject_id?: string | null; remark?: string }, user: CurrentUser) {
    if (input.currency !== undefined) await this.currencies?.assertSupported(input.currency, "付款币种");
    if (input.bank_id) await requireActiveBank(this.prisma, input.bank_id, "支付银行不存在或已停用");
    const subject = input.subject_id === undefined ? undefined : await this.cashFlow.requireSubject(input.subject_id, "会计科目不存在或已停用，请在「收支管理 → 会计科目」里确认");
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM supplier_payments WHERE id = ${id}::uuid FOR UPDATE`;
      const current = await tx.supplierPayment.findFirst({ where: { id, deletedAt: null } });
      if (!current) throw this.notFound("SUPPLIER_PAYMENT_NOT_FOUND", "供应商付款不存在");
      if (current.status !== "draft") throw this.invalid("SUPPLIER_PAYMENT_NOT_EDITABLE", "只有草稿付款可以编辑");
      const amount = input.amount === undefined ? current.amount : this.decimal(input.amount, "INVALID_SUPPLIER_PAYMENT_AMOUNT");
      // bank_id 传 null / 空串 = 清空支付银行；undefined = 不改。
      const bankId = input.bank_id === undefined ? current.bankId : (input.bank_id || null);
      const subjectId = input.subject_id === undefined ? current.subjectId : (subject?.id ?? null);
      return tx.supplierPayment.update({ where: { id }, data: { amount, paymentDate: input.payment_date ? this.date(input.payment_date) : current.paymentDate, paymentMethod: input.payment_method ?? current.paymentMethod, currency: input.currency ?? current.currency, bankId, subjectId, remark: input.remark ?? current.remark, ...this.audit.update(user) } });
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