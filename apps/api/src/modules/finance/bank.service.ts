import { Injectable, NotFoundException, UnprocessableEntityException, Optional } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { AuditService } from "../../platform/audit/audit.service";
import type { CurrentUser } from "../../platform/auth/auth.service";
import { CurrencyService } from "../../platform/currency/currency.service";
import { PrismaService } from "../../platform/database/prisma.service";

export type BankInput = {
  bank_code: string;
  bank_name: string;
  account_name: string;
  account_number: string;
  currency: string;
  swift_code?: string;
  remark?: string;
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
        remark: input.remark, ...this.audit.create(user),
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
}