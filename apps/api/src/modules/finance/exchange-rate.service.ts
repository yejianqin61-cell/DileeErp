import { Injectable, UnprocessableEntityException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { AuditService } from "../../platform/audit/audit.service";
import type { CurrentUser } from "../../platform/auth/auth.service";
import { PrismaService } from "../../platform/database/prisma.service";
import { formatRateUnits, toRateUnits } from "./money";

/**
 * 期末汇率（财务 2026-09-24：「1,3,4 都要」的第 ④ 件）。
 *
 * 为什么需要它：凭证上有 `currency` 却没有汇率，而三大报表是**人民币**报表 ——
 * 不折算就只能「按币种分列 + 表尾说明」，财务拿到的不是一张能对外报的表。
 *
 * 四条口径（与设计文档 §8.2 一致）：
 *   1. **按「期间 YYYY-MM」维护**，不是按记账日期：财务的心智是「9 月的汇率」，
 *      月底是 28/30/31 号不该影响取数；
 *   2. **整批替换一个期间**：界面上「某月一张表」，保存时整批替换该期间的**全部**币种 ——
 *      逐行 upsert 会让「删掉一行」变成额外的删除动作，而财务的心智里没有这一步；
 *   3. **软删除后唯一键仍占位**：(period, currency) upsert（把软删的那条恢复回来），
 *      既不会撞唯一索引，也不会出现「同一期间同一币种两条汇率」；
 *   4. **本币不录**：CNY 对自身恒为 1，录进来只会多一个「报表到底用哪条」的歧义 → 直接拒绝。
 *
 * 取数时**按「不晚于该期间的最近一条」回退**（9 月没维护就用 8 月的，并在表尾写明用了哪个月）：
 * 拿未来汇率去折过去的余额是错的，拿「没有汇率就不折算」又会静默丢钱 —— 回退 + 说明是唯一
 * 既不出错数、又不丢数的做法。
 */
export const LOCAL_CURRENCY = "CNY";

export type ExchangeRateRow = {
  currency: string;
  rate: string;
  remark?: string;
};

export type ExchangeRateInput = {
  period: string;
  rows: ExchangeRateRow[];
};

/** 汇率行（含软删除过滤后的库行）→ 取数用的「按币种分组、期间升序」索引。 */
export type RateBook = Map<string, Array<{ period: string; rate: bigint }>>;

/** `YYYY-MM-DD` / `YYYY-MM` → `YYYY-MM`（非法直接 422：期间是取数的主键，猜不得）。 */
export function monthOf(value: string): string {
  const text = (value ?? "").trim();
  const match = /^(\d{4})-(\d{2})(?:-\d{2})?$/.exec(text);
  const month = match?.[2] ?? "";
  if (!match || Number(month) < 1 || Number(month) > 12) {
    throw new UnprocessableEntityException({ code: "INVALID_RATE_PERIOD", message: "汇率期间无效（应为 YYYY-MM）", details: [] });
  }
  return `${match[1]}-${month}`;
}

/** 上一个自然月（本年 1 月 → 上年 12 月）。 */
export function previousMonth(month: string): string {
  const [year, value] = month.split("-");
  const index = Number(value);
  return index === 1 ? `${Number(year) - 1}-12` : `${year}-${String(index - 1).padStart(2, "0")}`;
}

/** 库行 → 取数索引（调用方保证已按期间升序）。 */
export function rateBookOf(rows: ReadonlyArray<{ currency: string; period: string; rate: { toString(): string } | string }>): RateBook {
  const book: RateBook = new Map();
  for (const row of rows) {
    const rate = toRateUnits(typeof row.rate === "string" ? row.rate : row.rate.toString());
    if (!rate) continue;
    const bucket = book.get(row.currency) ?? [];
    bucket.push({ period: row.period, rate });
    book.set(row.currency, bucket);
  }
  return book;
}

/**
 * 某币种在「不晚于 `asOfMonth`」的最近一条汇率；没有则 `null`（上层必须把「没折算」报进表尾）。
 *
 * 纯函数：报表取数要在一个请求里问三个时点（期末 / 期初 / 年初）× 若干个币种，
 * 每次都查库既慢又给了「三个时点用了不同口径」的机会 —— 一次读回、在这里解析。
 */
export function resolveRateOf(book: RateBook, currency: string, asOfMonth: string): bigint | null {
  let found: bigint | null = null;
  for (const entry of book.get(currency) ?? []) {
    if (entry.period <= asOfMonth) found = entry.rate;
  }
  return found;
}

/** 取数时**实际用到**的那条汇率的期间（表尾要写明「用的是 8 月的汇率」）。 */
export function resolvedPeriodOf(book: RateBook, currency: string, asOfMonth: string): string | null {
  let found: string | null = null;
  for (const entry of book.get(currency) ?? []) {
    if (entry.period <= asOfMonth) found = entry.period;
  }
  return found;
}

@Injectable()
export class ExchangeRateService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  /** 某一期间的汇率；不传期间时取**最近的**一个期间（表空则返回空表）。 */
  async list(filter: { period?: string } = {}) {
    const periods = await this.periods();
    const period = filter.period ? monthOf(filter.period) : periods[0] ?? monthOf(new Date().toISOString().slice(0, 10));
    const rows = await this.prisma.exchangeRate.findMany({
      where: { period, deletedAt: null },
      orderBy: [{ currency: "asc" }],
      select: { currency: true, rate: true, remark: true },
    });
    return {
      period,
      rows: rows.map((row) => ({ currency: row.currency, rate: formatRateUnits(toRateUnits(row.rate.toString()) ?? 0n), remark: row.remark ?? "" })),
      periods,
    };
  }

  /** 已维护过的期间（倒序，最近 24 个）：界面用它给出「哪几个月有汇率」。 */
  async periods(): Promise<string[]> {
    const rows = await this.prisma.exchangeRate.findMany({
      where: { deletedAt: null }, distinct: ["period"], orderBy: { period: "desc" }, select: { period: true }, take: 24,
    });
    return rows.map((row) => row.period);
  }

  /**
   * 整批替换某一期间的汇率。
   *
   * **事务内**完成三件事：软删掉这次没出现的旧行、把出现的行 upsert（含恢复软删行）、记审计。
   * 中途失败会让报表「一半是新汇率、一半是旧汇率」——而报表正好在那个时刻是按错汇率折出来的。
   */
  async replaceAll(input: ExchangeRateInput, user: CurrentUser) {
    const period = monthOf(input.period);
    const rows = (input.rows ?? []).map((row) => this.normalize(row));
    const duplicated = [...new Set(rows.map((row) => row.currency).filter((code, index, all) => all.indexOf(code) !== index))];
    if (duplicated.length) {
      throw this.invalid("EXCHANGE_RATE_DUPLICATED", `同一币种在一个期间只能有一条汇率：${duplicated.join("、")}（请删掉多余的一行）`);
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.exchangeRate.findMany({ where: { period } });
      const keep = new Set(rows.map((row) => row.currency));
      const removed = existing.filter((row) => !row.deletedAt && !keep.has(row.currency));

      for (const row of removed) {
        await tx.exchangeRate.update({ where: { id: row.id }, data: { ...this.audit.softDelete(user) } });
      }
      for (const row of rows) {
        const current = existing.find((item) => item.currency === row.currency);
        if (current) {
          // 恢复 + 覆盖：唯一索引不区分软删，所以「删了再加同一币种」必须走这条更新而不是新插入。
          await tx.exchangeRate.update({
            where: { id: current.id },
            data: { rate: new Prisma.Decimal(row.rate), remark: row.remark ?? null, deletedAt: null, deletedBy: null, ...this.audit.update(user) },
          });
        } else {
          await tx.exchangeRate.create({
            data: { period, currency: row.currency, rate: new Prisma.Decimal(row.rate), remark: row.remark ?? null, ...this.audit.create(user) },
          });
        }
      }
      return { removed: removed.length, saved: rows.length };
    });

    await this.audit.record("exchange_rate.replace", "exchange_rate", user.id, undefined, {
      period, saved: result.saved, removed: result.removed,
      currencies: rows.map((row) => `${row.currency}=${row.rate}`).join(","),
    });
    return { period, saved: result.saved, removed: result.removed, rows };
  }

  /** 报表取数用：全部汇率（按币种分组、期间升序）。表很小（每月几个币种），一次读回。 */
  async rateBook(): Promise<RateBook> {
    const rows = await this.prisma.exchangeRate.findMany({
      where: { deletedAt: null }, orderBy: [{ currency: "asc" }, { period: "asc" }], select: { currency: true, period: true, rate: true },
    });
    return rateBookOf(rows);
  }

  /** 逐行校验并归一：币种必填且不能是本币、汇率必须是大于零的十进制、最多 8 位小数。 */
  private normalize(row: ExchangeRateRow) {
    const currency = (row.currency ?? "").trim().toUpperCase();
    if (!currency) throw this.invalid("EXCHANGE_RATE_CURRENCY_REQUIRED", "每一行都必须填写币种");
    if (currency === LOCAL_CURRENCY) {
      throw this.invalid("LOCAL_CURRENCY_RATE", `本币 ${LOCAL_CURRENCY} 不需要汇率（对自身恒为 1，录进来只会让报表不知道该用哪条）`);
    }
    const rate = toRateUnits(row.rate);
    if (!rate) throw this.invalid("INVALID_RATE", `「${currency}」的汇率必须是大于零的十进制数（1 ${currency} = ? ${LOCAL_CURRENCY}，最多 8 位小数）`);
    return { currency, rate: formatRateUnits(rate), remark: row.remark?.trim() ?? null };
  }

  private invalid(code: string, message: string) {
    return new UnprocessableEntityException({ code, message, details: [] });
  }
}
