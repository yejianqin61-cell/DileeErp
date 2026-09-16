import { Injectable, NotFoundException, UnprocessableEntityException, Optional } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { AuditService } from "../../platform/audit/audit.service";
import type { CurrentUser } from "../../platform/auth/auth.service";
import { CurrencyService } from "../../platform/currency/currency.service";
import { PrismaService } from "../../platform/database/prisma.service";
import { bankBalance, emptyBankBalanceParts, type BankBalanceParts } from "./bank-balance.domain";

export type BankInput = {
  bank_code: string;
  bank_name: string;
  account_name: string;
  account_number: string;
  currency: string;
  swift_code?: string;
  /** 建账期初余额（非负十进制字符串）。 */
  opening_balance?: string;
  remark?: string;
};

/**
 * 一个账户的余额明细。
 *
 * 拆成 5 个数字而不是只给一个余额：财务要能对账 ——「期初多少、收了多少、付了多少、互转进了多少」，
 * 只给一个净额的话，余额对不上时完全没法定位是哪一段出了错。
 */
export type BankBalanceRow = {
  id: string;
  bank_code: string;
  bank_name: string;
  account_name: string;
  account_number: string;
  currency: string;
  is_active: boolean;
  opening_balance: string;
  cash_in: string;
  cash_out: string;
  transfer_in: string;
  transfer_out: string;
  balance: string;
  cash_flow_count: number;
};

@Injectable()
export class BankService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Optional() private readonly currencies?: CurrencyService,
  ) {}

  async list() {
    return this.prisma.bank.findMany({
      where: { deletedAt: null },
      orderBy: [{ isActive: "desc" }, { bankCode: "asc" }],
    });
  }

  async get(id: string) {
    const row = await this.prisma.bank.findFirst({ where: { id, deletedAt: null } });
    if (!row) throw this.notFound("BANK_NOT_FOUND", "银行账户不存在");
    return row;
  }

  /**
   * 每个账户的余额明细（期初 + 收 − 付 + 转入 − 转出）。
   *
   * 三个查询，不做 N+1：一次取账户、一次 `groupBy` 把全部账户的收支按「账户 + 方向」汇总、
   * 一次取全部生效互转。账户数是几十个量级，互转是低频单据，内存里归并完全够用。
   *
   * `asOf` 之后填的是**日期上限**（含当天）：财务对账时经常要问「上月底余额是多少」。
   */
  async balances(asOf?: string): Promise<BankBalanceRow[]> {
    const banks = await this.prisma.bank.findMany({ where: { deletedAt: null }, orderBy: [{ isActive: "desc" }, { bankCode: "asc" }] });
    if (banks.length === 0) return [];
    const ids = banks.map((bank) => bank.id);
    const until = asOf ? this.dayEnd(asOf) : undefined;
    const [grouped, transfers, counts] = await Promise.all([
      this.prisma.cashFlowEntry.groupBy({
        by: ["bankId", "direction"],
        where: { deletedAt: null, status: "posted", bankId: { in: ids }, ...(until ? { entryDate: { lte: until } } : {}) },
        _sum: { amount: true },
      }),
      this.prisma.bankTransfer.findMany({
        where: { deletedAt: null, status: "posted", ...(until ? { transferDate: { lte: until } } : {}), OR: [{ fromBankId: { in: ids } }, { toBankId: { in: ids } }] },
        select: { fromBankId: true, fromAmount: true, toBankId: true, toAmount: true },
      }),
      this.prisma.cashFlowEntry.groupBy({ by: ["bankId"], where: { deletedAt: null, status: "posted", bankId: { in: ids }, ...(until ? { entryDate: { lte: until } } : {}) }, _count: { _all: true } }),
    ]);
    const parts = new Map<string, BankBalanceParts & { cashFlowCount: number }>();
    for (const id of ids) parts.set(id, { ...emptyBankBalanceParts(), cashFlowCount: 0 });
    for (const row of grouped as Array<{ bankId: string | null; direction: string; _sum: { amount: Prisma.Decimal | null } }>) {
      if (!row.bankId) continue;
      const current = parts.get(row.bankId);
      if (!current) continue;
      const amount = row._sum.amount ?? new Prisma.Decimal(0);
      if (row.direction === "income") current.cashIn = current.cashIn.plus(amount);
      else current.cashOut = current.cashOut.plus(amount);
    }
    for (const row of counts as Array<{ bankId: string | null; _count: { _all: number } }>) {
      if (!row.bankId) continue;
      const current = parts.get(row.bankId);
      if (current) current.cashFlowCount = row._count._all;
    }
    for (const row of transfers) {
      const from = parts.get(row.fromBankId);
      if (from) from.transferOut = from.transferOut.plus(row.fromAmount);
      const to = parts.get(row.toBankId);
      if (to) to.transferIn = to.transferIn.plus(row.toAmount);
    }
    return banks.map((bank) => {
      const current = parts.get(bank.id) ?? { ...emptyBankBalanceParts(), cashFlowCount: 0 };
      const { cashFlowCount, ...rest } = current;
      const balance = bankBalance(bank.openingBalance, rest);
      return {
        id: bank.id,
        bank_code: bank.bankCode,
        bank_name: bank.bankName,
        account_name: bank.accountName,
        account_number: bank.accountNumber,
        currency: bank.currency,
        is_active: bank.isActive,
        opening_balance: balance.opening.toFixed(4),
        cash_in: balance.cashIn.toFixed(4),
        cash_out: balance.cashOut.toFixed(4),
        transfer_in: balance.transferIn.toFixed(4),
        transfer_out: balance.transferOut.toFixed(4),
        balance: balance.balance.toFixed(4),
        cash_flow_count: cashFlowCount,
      };
    });
  }

  /** 单个账户的余额明细（没有账户时按「不存在」处理，避免返回一个看起来正常的 0）。 */
  async balanceOf(id: string, asOf?: string) {
    await this.get(id);
    const rows = await this.balances(asOf);
    const row = rows.find((item) => item.id === id);
    if (!row) throw this.notFound("BANK_NOT_FOUND", "银行账户不存在");
    return row;
  }

  async create(input: BankInput, user: CurrentUser) {
    await this.currencies?.assertSupported(input.currency, "银行币种");
    const bankCode = input.bank_code.trim();
    const bankName = input.bank_name.trim();
    const accountName = input.account_name.trim();
    const accountNumber = input.account_number.trim();
    if (!bankCode || !bankName || !accountName || !accountNumber) {
      throw this.invalid("BANK_FIELDS_REQUIRED", "银行编码、银行名称、账户名称、账号均必填");
    }
    const existing = await this.prisma.bank.findFirst({ where: { bankCode, deletedAt: null } });
    if (existing) throw this.invalid("BANK_CODE_EXISTS", `银行编码 ${bankCode} 已存在`);
    const row = await this.prisma.bank.create({
      data: {
        bankCode, bankName, accountName, accountNumber,
        currency: input.currency, swiftCode: input.swift_code?.trim() || undefined,
        openingBalance: this.opening(input.opening_balance), remark: input.remark, ...this.audit.create(user),
      },
    });
    await this.audit.record("bank.create", "bank", user.id, row.id, { bank_code: row.bankCode, bank_name: row.bankName });
    return row;
  }

  async update(id: string, input: Partial<BankInput>, user: CurrentUser) {
    const current = await this.get(id);
    const data: Record<string, unknown> = {};
    if (input.bank_code !== undefined && input.bank_code.trim() !== current.bankCode) {
      const existing = await this.prisma.bank.findFirst({ where: { bankCode: input.bank_code.trim(), deletedAt: null, id: { not: id } } });
      if (existing) throw this.invalid("BANK_CODE_EXISTS", `银行编码 ${input.bank_code.trim()} 已存在`);
      data.bankCode = input.bank_code.trim();
    }
    if (input.bank_name !== undefined) data.bankName = input.bank_name.trim();
    if (input.account_name !== undefined) data.accountName = input.account_name.trim();
    if (input.account_number !== undefined) data.accountNumber = input.account_number.trim();
    if (input.currency !== undefined) {
      await this.currencies?.assertSupported(input.currency, "银行币种");
      data.currency = input.currency;
    }
    if (input.swift_code !== undefined) data.swiftCode = input.swift_code.trim() || null;
    if (input.opening_balance !== undefined) data.openingBalance = this.opening(input.opening_balance);
    if (input.remark !== undefined) data.remark = input.remark;
    const row = await this.prisma.bank.update({ where: { id }, data: { ...data, ...this.audit.update(user) } });
    await this.audit.record("bank.update", "bank", user.id, id, { bank_code: row.bankCode });
    return row;
  }

  async toggleActive(id: string, isActive: boolean, user: CurrentUser) {
    const current = await this.get(id);
    const row = await this.prisma.bank.update({ where: { id }, data: { isActive, ...this.audit.update(user) } });
    await this.audit.record(isActive ? "bank.enable" : "bank.disable", "bank", user.id, id, { bank_code: row.bankCode });
    return row;
  }

  async remove(id: string, user: CurrentUser) {
    await this.get(id);
    const row = await this.prisma.bank.update({ where: { id }, data: { deletedAt: new Date(), deletedBy: user.id, ...this.audit.update(user) } });
    await this.audit.record("bank.delete", "bank", user.id, id, { bank_code: row.bankCode });
    return row;
  }

  private notFound(code: string, message: string) { return new NotFoundException({ code, message, details: [] }); }
  private invalid(code: string, message: string) { return new UnprocessableEntityException({ code, message, details: [] }); }

  /**
   * 期初余额：允许 0，不允许负数与 NaN。
   *
   * 为什么不允许负期初：负数期初只可能来自两种业务 —— 透支或历史错误。透支需要额度与利息科目，
   * 本系统没有；历史错误应该在录入时改对，而不是留一个负的起点让余额永远带上一个说不清的数。
   * 真要表示「信用卡/透支户」，先按 0 建账、把欠款当支出录进来，账面才是可解释的。
   */
  private opening(value: string | undefined): Prisma.Decimal {
    if (value === undefined) return new Prisma.Decimal(0);
    try {
      const amount = new Prisma.Decimal(value === "" ? 0 : value);
      if (amount.lt(0) || !amount.isFinite()) throw new Error("negative");
      return amount;
    } catch {
      throw this.invalid("INVALID_OPENING_BALANCE", "期初余额必须是有效的非负十进制数");
    }
  }

  /** `asOf`（YYYY-MM-DD）→ 当天 23:59:59.999，让「截至当天」包含当天录入的流水。 */
  private dayEnd(value: string): Date {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw this.invalid("INVALID_AS_OF_DATE", "截止日期格式必须是 YYYY-MM-DD");
    const date = new Date(`${value}T23:59:59.999Z`);
    if (Number.isNaN(date.valueOf())) throw this.invalid("INVALID_AS_OF_DATE", "截止日期无效");
    return date;
  }
}