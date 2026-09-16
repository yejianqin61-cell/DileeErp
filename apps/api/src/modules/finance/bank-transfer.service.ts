import { Injectable, NotFoundException, Optional, UnprocessableEntityException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { AuditService } from "../../platform/audit/audit.service";
import type { CurrentUser } from "../../platform/auth/auth.service";
import { CurrencyService } from "../../platform/currency/currency.service";
import { PrismaService } from "../../platform/database/prisma.service";
import { transferAmounts } from "./bank-balance.domain";
import { BankService } from "./bank.service";

/**
 * 银行余额互转（财务 → 银行余额互转）。
 *
 * 同一个银行池里两个账户之间的划转。**不写收支流水**：互转既不是收入也不是支出，
 * 记成「A 支出 + B 收入」会让收支汇总表凭空多出一笔收入与一笔支出。资金确实动了，
 * 但它动在账户之间，因此只在 `BankService.balances()` 里参与（转出方 −、转入方 +）。
 *
 * 表单要的四项（本方账户 / 本方币种 / 对方账户 / 对方币种）在服务端逐项校验：
 *   - 两个账户都必须存在、未删除、**未停用**（与收付款选银行同一套 `requireActiveBank` 口径）；
 *   - 不能自己转给自己（库层也有 CHECK 兜底）；
 *   - 币种必须与所选账户的币种一致 —— 账户在本系统里只对应一个币种，
 *     允许「人民币户转出美元」会让余额变成一笔算不清的混币账；
 *   - 同币种两边金额必须相等，跨币种必须显式给出实际到账数（见 `transferAmounts`）。
 */
export type BankTransferInput = {
  transfer_date: string;
  from_bank_id: string;
  from_currency?: string;
  to_bank_id: string;
  to_currency?: string;
  from_amount: string;
  /** 跨币种时必填（实际到账数）；同币种留空即等于本方金额。 */
  to_amount?: string;
  remark?: string;
};

const TRANSFER_INCLUDE = {
  fromBank: { select: { id: true, bankCode: true, bankName: true, accountNumber: true, currency: true } },
  toBank: { select: { id: true, bankCode: true, bankName: true, accountNumber: true, currency: true } },
} as const;

@Injectable()
export class BankTransferService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly banks: BankService,
    @Optional() private readonly currencies?: CurrencyService,
  ) {}

  async list(filter: { from?: string; to?: string; bankId?: string } = {}) {
    const range = this.range(filter.from, filter.to);
    return this.prisma.bankTransfer.findMany({
      where: {
        deletedAt: null,
        ...(range ? { transferDate: range } : {}),
        ...(filter.bankId ? { OR: [{ fromBankId: filter.bankId }, { toBankId: filter.bankId }] } : {}),
      },
      include: TRANSFER_INCLUDE,
      orderBy: [{ transferDate: "desc" }, { createdAt: "desc" }],
    });
  }

  async get(id: string) {
    const row = await this.prisma.bankTransfer.findFirst({ where: { id, deletedAt: null }, include: TRANSFER_INCLUDE });
    if (!row) throw this.notFound("BANK_TRANSFER_NOT_FOUND", "银行互转记录不存在");
    return row;
  }

  async create(input: BankTransferInput, user: CurrentUser) {
    const from = await this.requireBank(input.from_bank_id, "转出账户不存在或已停用");
    const to = await this.requireBank(input.to_bank_id, "转入账户不存在或已停用");
    if (from.id === to.id) throw this.invalid("TRANSFER_SAME_BANK", "转出与转入不能是同一个账户");
    // 币种：默认取账户币种；显式传了就必须与账户一致（否则这笔钱到底算什么币种没有答案）。
    const fromCurrency = this.currency(input.from_currency, from.currency, "转出账户");
    const toCurrency = this.currency(input.to_currency, to.currency, "转入账户");
    await this.currencies?.assertSupported(fromCurrency, "转出币种");
    await this.currencies?.assertSupported(toCurrency, "转入币种");
    const amounts = transferAmounts({ fromAmount: input.from_amount, toAmount: input.to_amount, fromCurrency, toCurrency });
    if (!amounts.ok) throw this.amountError(amounts.code);
    const row = await this.prisma.bankTransfer.create({
      data: {
        transferNo: this.number(),
        transferDate: this.date(input.transfer_date),
        fromBankId: from.id,
        fromCurrency,
        toBankId: to.id,
        toCurrency,
        fromAmount: amounts.value.fromAmount,
        toAmount: amounts.value.toAmount,
        exchangeRate: amounts.value.exchangeRate,
        status: "posted",
        remark: input.remark,
        ...this.audit.create(user),
      },
      include: TRANSFER_INCLUDE,
    });
    await this.audit.record("bank_transfer.create", "bank_transfer", user.id, row.id, {
      transfer_no: row.transferNo,
      from_bank_id: from.id,
      to_bank_id: to.id,
      from_amount: row.fromAmount.toString(),
      to_amount: row.toAmount.toString(),
      from_currency: fromCurrency,
      to_currency: toCurrency,
    });
    // 余额提示：转出会不会把账户转成负数。**只提示不拦截** —— 期初余额可能还没录、
    // 银行到账也有时间差，硬拦会挡住真实业务；但财务必须在界面上看到这件事。
    const balances = await this.banks.balances();
    const source = balances.find((item) => item.id === from.id);
    const sourceAfter = source ? new Prisma.Decimal(source.balance).minus(row.fromAmount) : null;
    return {
      transfer: row,
      source_balance_before: source?.balance ?? null,
      source_balance_after: sourceAfter?.toFixed(4) ?? null,
      insufficient_balance: sourceAfter ? sourceAfter.lt(0) : false,
    };
  }

  /** 冲销：保留整行（已发生的资金动作不能凭空消失），置 `reversed` 后不再计入余额。 */
  async reverse(id: string, reason: string, user: CurrentUser) {
    if (!reason?.trim()) throw this.invalid("REVERSAL_REASON_REQUIRED", "冲销必须填写原因");
    const row = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM bank_transfers WHERE id = ${id}::uuid FOR UPDATE`;
      const current = await tx.bankTransfer.findFirst({ where: { id, deletedAt: null } });
      if (!current) throw this.notFound("BANK_TRANSFER_NOT_FOUND", "银行互转记录不存在");
      if (current.status !== "posted") throw this.invalid("BANK_TRANSFER_NOT_REVERSIBLE", "只有生效中的互转可以冲销");
      return tx.bankTransfer.update({ where: { id }, data: { status: "reversed", reversalReason: reason.trim(), ...this.audit.update(user) }, include: TRANSFER_INCLUDE });
    });
    await this.audit.record("bank_transfer.reverse", "bank_transfer", user.id, id, { transfer_no: row.transferNo, reason: reason.trim() });
    return row;
  }

  /** 账户必须存在、未删除、未停用；返回值带上币种，用于币种一致性校验。 */
  private async requireBank(id: string, message: string) {
    const bankId = id?.trim();
    if (!bankId) throw this.invalid("BANK_REQUIRED", "本方账户与对方账户都必填");
    const bank = await this.prisma.bank.findFirst({ where: { id: bankId, deletedAt: null, isActive: true }, select: { id: true, currency: true } });
    if (!bank) throw this.notFound("BANK_NOT_FOUND", message);
    return bank;
  }

  private currency(given: string | undefined, accountCurrency: string, label: string) {
    const value = given?.trim() || accountCurrency;
    if (value !== accountCurrency) throw this.invalid("TRANSFER_CURRENCY_MISMATCH", `${label}的币种必须是 ${accountCurrency}（账户币种），不能改成 ${value}`);
    return value;
  }

  private amountError(code: string) {
    if (code === "SAME_CURRENCY_AMOUNT_MISMATCH") return this.invalid(code, "同币种互转的两边金额必须相等，否则这笔差额没有科目可以承载");
    return this.invalid("INVALID_TRANSFER_AMOUNT", "互转金额必须是大于零的十进制数");
  }

  private range(from?: string, to?: string) {
    if (!from && !to) return undefined;
    const range: { gte?: Date; lte?: Date } = {};
    if (from) range.gte = this.dateOnly(from);
    if (to) range.lte = this.dateOnly(to);
    if (range.gte && range.lte && range.gte > range.lte) throw this.invalid("INVALID_TRANSFER_RANGE", "开始日期不能晚于结束日期");
    return range;
  }

  private dateOnly(value: string) {
    const date = new Date(`${value}T00:00:00.000Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(date.valueOf())) throw this.invalid("INVALID_TRANSFER_DATE", "日期格式必须是 YYYY-MM-DD");
    return date;
  }

  private date(value: string) { return this.dateOnly(value); }
  private number() { return `BTR-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomUUID().slice(0, 8).toUpperCase()}`; }
  private notFound(code: string, message: string) { return new NotFoundException({ code, message, details: [] }); }
  private invalid(code: string, message: string) { return new UnprocessableEntityException({ code, message, details: [] }); }
}
