import { Injectable, UnprocessableEntityException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { AuditService } from "../../platform/audit/audit.service";
import type { CurrentUser } from "../../platform/auth/auth.service";
import { PrismaService } from "../../platform/database/prisma.service";
import { isFundSubject, isSubjectIdKey, normalizeSubjectKey, splitSubjectKey, type SummedAmount } from "./finance-three-statements";
import { formatUnits, toUnits } from "./money";

/**
 * 建账期初余额（财务 2026-09-24：「科目期初余额表」）。
 *
 * 为什么需要它：银行账户档案里只有**货币资金**的期初余额，其它科目没有 —— 报表只能把货币资金期初
 * 加进资产侧，「资产总计 = 负债和所有者权益总计」就永远差一个期初余额的差额
 * （内核会把差额显式返回并写进表尾，但那是「说明」不是「解决」）。财务录一次全科目的期初，
 * 勾稽才真正为 0。
 *
 * 三条口径：
 *   1. **整批替换**：界面按「建账日 + 币种」一张表录入，保存时整批替换这一组 ——
 *      逐行 upsert 会让「删掉一行」变成一个额外的删除动作，而财务的心智是「这张表就是我现在的期初」；
 *   2. **软删除后唯一键仍占位**（同月度管理费分摊）：替换时按 (as_of_date, subject_key, currency)
 *      upsert（把软删的那条**恢复**回来），既不会撞唯一索引，也不会出现「同一科目两条期初」；
 *   3. **不强制试算平衡**：财务可能分批录。借贷不平衡时接口照收，但响应把差额带回去，
 *      界面显著显示（报表那边也会因为差这个数而不平）—— 挡住录入只会让她以为系统坏了。
 */
export type OpeningBalanceRow = {
  subject_key: string;
  subject_label?: string;
  direction: string;
  amount: string;
  remark?: string;
};

export type OpeningBalanceInput = {
  as_of_date: string;
  currency?: string;
  rows: OpeningBalanceRow[];
};

/**
 * 报表取数要的期初行。
 *
 * `subjectId` 是科目主键（2026-11-11 R-1 / T3）：有它报表就按主键归集，科目改名不影响落行；
 * 为空（历史行归不上）时报表回退 `subjectKey` 文本匹配 —— 那条路在改名后会失配，但至少不丢行。
 */
export type OpeningBalanceEffectiveRow = {
  subjectKey: string;
  subjectId: string | null;
  direction: string;
  amount: string;
};

/**
 * 期初行的科目键 → 科目主键（2026-11-11 R-1 / T3）。
 *
 * 期初原本只有文本键 `subject_key`，是**唯一一张连科目外键都没有**的业务表：科目一改名，
 * 这一行就与主数据脱节，报表按名字匹配不上，金额静默消失（诊断 P0-2）。
 *
 * 判据与全站一致：**只有唯一同名才算解析成功**。
 *   - 键带分类（`资产类/银行存款`）→ 必须「同分类 + 同名称」，库层 `@@unique([category,name])`
 *     保证最多命中一个；查不到就是科目被改过名；
 *   - 键是裸名（`银行存款`，资金科目的老写法）→ 全表同名唯一才认，同名跨分类一律不猜。
 *
 * 解析不到**不猜测**：留空让报表回退文本匹配，并由调用方把清单回给财务。
 * 猜错等于把期初余额记到别的账上，而报表上看不出来。
 */
export function resolveOpeningSubjectIds(
  rows: ReadonlyArray<{ subjectKey: string }>,
  subjects: ReadonlyArray<{ id: string; category: string; name: string }>,
): Map<string, string> {
  const byName = new Map<string, Array<{ id: string; category: string; name: string }>>();
  for (const subject of subjects) byName.set(subject.name, [...(byName.get(subject.name) ?? []), subject]);
  const resolved = new Map<string, string>();
  for (const row of rows) {
    const key = normalizeSubjectKey(row.subjectKey);
    // 已经是 id 键的期初行（理论上不该出现，报表侧才用 id 键）原样跳过，不重复解析。
    if (isSubjectIdKey(key)) continue;
    const { category, name } = splitSubjectKey(key);
    const candidates = byName.get(name) ?? [];
    if (category) {
      const hit = candidates.find((subject) => subject.category === category);
      if (hit) resolved.set(key, hit.id);
      continue;
    }
    if (candidates.length === 1) resolved.set(key, candidates[0].id);
  }
  return resolved;
}

/** 期初余额行 → 报表要的「借贷累计」形状（与 `sumVoucherLines` 的返回值同型，可直接相加）。 */
export function openingBalancesToMap(rows: ReadonlyArray<{ subjectKey: string; direction: string; amount: { toString(): string } | string }>): Map<string, SummedAmount> {
  const summed = new Map<string, SummedAmount>();
  for (const row of rows) {
    const key = normalizeSubjectKey(row.subjectKey);
    const bucket = summed.get(key) ?? { debit: 0n, credit: 0n };
    const units = toUnits(typeof row.amount === "string" ? row.amount : row.amount.toString());
    if (row.direction === "debit") bucket.debit += units;
    else bucket.credit += units;
    summed.set(key, bucket);
  }
  return summed;
}

/** 期初余额的试算平衡（借/贷两侧合计），界面与接口都用它回话。 */
export function openingBalanceTotals(rows: ReadonlyArray<{ direction: string; amount: { toString(): string } | string }>): { debit: bigint; credit: bigint; difference: bigint; balanced: boolean } {
  let debit = 0n;
  let credit = 0n;
  for (const row of rows) {
    const units = toUnits(typeof row.amount === "string" ? row.amount : row.amount.toString());
    if (row.direction === "debit") debit += units;
    else credit += units;
  }
  return { debit, credit, difference: debit - credit, balanced: debit === credit };
}

/**
 * 出参用的试算平衡：金额一律**字符串十进制**。
 *
 * 不能直接把 `openingBalanceTotals` 的结果丢给控制器：它是 BigInt，而
 * `JSON.stringify(BigInt)` 会抛 `TypeError: Do not know how to serialize a BigInt` ——
 * **整个 `GET /finance/opening-balances` 500**（实测，2026-09-26）。字符串也是全站金额约定。
 */
export function openingBalanceTotalsPayload(rows: ReadonlyArray<{ direction: string; amount: { toString(): string } | string }>) {
  const totals = openingBalanceTotals(rows);
  return { debit: formatUnits(totals.debit), credit: formatUnits(totals.credit), difference: formatUnits(totals.difference), balanced: totals.balanced };
}

/** 把两张表（期初 + 凭证）按科目相加：同一科目两边都有时借贷分别累加，报表不必知道数据来自哪。 */
export function mergeBalances(base: ReadonlyMap<string, SummedAmount>, extra: ReadonlyMap<string, SummedAmount>): Map<string, SummedAmount> {
  const merged = new Map<string, SummedAmount>();
  for (const [key, value] of [...base, ...extra]) {
    const bucket = merged.get(key) ?? { debit: 0n, credit: 0n };
    merged.set(key, { debit: bucket.debit + value.debit, credit: bucket.credit + value.credit });
  }
  return merged;
}

@Injectable()
export class OpeningBalanceService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  /** 某一组（建账日 + 币种）的期初余额；不传日期时取**最近一次**的建账日。 */
  async list(filter: { asOfDate?: string; currency?: string } = {}) {
    const currency = (filter.currency?.trim() || "CNY").toUpperCase();
    const asOfDate = filter.asOfDate ? utcDate(filter.asOfDate) : await this.latestAsOfDate(currency);
    if (!asOfDate) return { as_of_date: null, currency, rows: [], totals: openingBalanceTotalsPayload([]) };
    const rows = await this.prisma.accountingOpeningBalance.findMany({
      where: { asOfDate, currency, deletedAt: null },
      orderBy: [{ subjectKey: "asc" }],
    });
    return { as_of_date: asOfDate.toISOString().slice(0, 10), currency, rows, totals: openingBalanceTotalsPayload(rows) };
  }

  /**
   * 整批替换一组期初余额（建账日 + 币种）。
   *
   * **事务内**完成三件事：软删掉这次没出现的旧行、把出现的行 upsert（含恢复软删行）、记审计。
   * 之所以要一起做：中途失败会让财务看到「一半是新的、一半是旧的」期初，而报表正好在那个时刻不平。
   */
  async replaceAll(input: OpeningBalanceInput, user: CurrentUser) {
    const asOfDate = utcDate(input.as_of_date);
    const currency = (input.currency?.trim() || "CNY").toUpperCase();
    const rows = (input.rows ?? []).map((row) => this.normalize(row, currency));
    // 同一科目在一张期初表里只能出现一次：唯一索引 (as_of_date, subject_key, currency) 不允许两条，
    // 撞上去就是一句数据库错误。这里先拦住并说清是哪几个科目（财务自己并一行即可）。
    const duplicated = [...new Set(rows.map((row) => row.subjectKey).filter((key, index, all) => all.indexOf(key) !== index))];
    if (duplicated.length) {
      throw this.invalid("OPENING_SUBJECT_DUPLICATED", `同一科目在一张期初表里只能出现一次：${duplicated.join("、")}（请把金额并成一行）`);
    }

    const result = await this.prisma.$transaction(async (tx) => {
      // 先把这一批科目键解析成科目主键（2026-11-11 R-1 / T3）。一次查库、按名称取候选，
      // 判据交给纯函数 `resolveOpeningSubjectIds`（唯一同名才认）。
      // 查不到**不报错**：历史科目可能被改过名，拦住录入只会让财务没法修账；
      // 留空让报表回退文本匹配，同时把清单回给界面提示。
      const names = [...new Set(rows.map((row) => splitSubjectKey(normalizeSubjectKey(row.subjectKey)).name))];
      const subjectRows = names.length
        ? await tx.accountingSubject.findMany({ where: { deletedAt: null, name: { in: names } }, select: { id: true, category: true, name: true } })
        : [];
      const subjectIdByKey = resolveOpeningSubjectIds(rows, subjectRows);

      const existing = await tx.accountingOpeningBalance.findMany({ where: { asOfDate, currency } });
      const keep = new Set(rows.map((row) => row.subjectKey));
      const removed = existing.filter((row) => !row.deletedAt && !keep.has(row.subjectKey));

      for (const row of removed) {
        await tx.accountingOpeningBalance.update({ where: { id: row.id }, data: { ...this.audit.softDelete(user) } });
      }
      for (const row of rows) {
        const subjectId = subjectIdByKey.get(normalizeSubjectKey(row.subjectKey)) ?? null;
        const current = existing.find((item) => item.subjectKey === row.subjectKey);
        if (current) {
          // 恢复 + 覆盖：唯一索引不区分软删，所以「删了再加同一科目」必须走这条更新而不是新插入。
          await tx.accountingOpeningBalance.update({
            where: { id: current.id },
            data: {
              subjectId, subjectLabel: row.subjectLabel, direction: row.direction,
              amount: new Prisma.Decimal(row.amount), remark: row.remark ?? null,
              deletedAt: null, deletedBy: null,
              ...this.audit.update(user),
            },
          });
        } else {
          await tx.accountingOpeningBalance.create({
            data: {
              asOfDate, currency, subjectId, subjectKey: row.subjectKey, subjectLabel: row.subjectLabel,
              direction: row.direction, amount: new Prisma.Decimal(row.amount), remark: row.remark ?? null,
              ...this.audit.create(user),
            },
          });
        }
      }
      return { removed: removed.length, saved: rows.length, unassigned: rows.map((row) => row.subjectKey).filter((key) => !subjectIdByKey.has(normalizeSubjectKey(key))) };
    });

    const totals = openingBalanceTotals(rows);
    await this.audit.record("opening_balance.replace", "opening_balance", user.id, undefined, {
      as_of_date: input.as_of_date.slice(0, 10), currency,
      saved: result.saved, removed: result.removed, unassigned: result.unassigned,
      debit: totals.debit.toString(), credit: totals.credit.toString(), balanced: totals.balanced,
    });
    return { as_of_date: input.as_of_date.slice(0, 10), currency, saved: result.saved, removed: result.removed, unassigned: result.unassigned, totals };
  }

  /** 报表取数用：某一币种**不晚于**期末的最近一次建账期初（没有就返回空）。 */
  async effectiveFor(currency: string, toDate: string): Promise<{ asOfDate: string; rows: OpeningBalanceEffectiveRow[] } | null> {
    const row = await this.prisma.accountingOpeningBalance.findFirst({
      where: { currency, deletedAt: null, asOfDate: { lte: utcDate(toDate) } },
      orderBy: { asOfDate: "desc" },
      select: { asOfDate: true },
    });
    if (!row) return null;
    const rows = await this.prisma.accountingOpeningBalance.findMany({
      where: { currency, deletedAt: null, asOfDate: row.asOfDate },
      select: { subjectKey: true, subjectId: true, direction: true, amount: true },
    });
    return { asOfDate: row.asOfDate.toISOString().slice(0, 10), rows: rows.map((item) => ({ ...item, amount: item.amount.toString() })) };
  }

  /**
   * 报表取数用（折算版本）：**每个币种**各自「不晚于期末的最近一次」建账期初。
   *
   * 为什么不能只问本币那一组：科目期初余额表是**按币种**存的（美元银行账户的期初录在 USD 那一组），
   * 折算时要把外币期初一起折成人民币；只读 CNY 那一组，美元期初就会凭空消失 ——
   * 而「资产 = 负债 + 权益」两侧同时少一个数，勾稽照样平，没人看得出来。
   *
   * 一次读回整张表（很小：币种数个建账日 × 科目数）而不是每币种一次查询：报表一个请求要问三个时点，
   * 逐币种逐时点查库既慢，又给了「几个时点用了不同口径」的机会。
   */
  async effectiveForAll(toDate: string): Promise<Array<{ currency: string; asOfDate: string; rows: OpeningBalanceEffectiveRow[] }>> {
    const all = await this.prisma.accountingOpeningBalance.findMany({
      where: { deletedAt: null, asOfDate: { lte: utcDate(toDate) } },
      select: { currency: true, asOfDate: true, subjectKey: true, subjectId: true, direction: true, amount: true },
    });
    const latest = new Map<string, string>();
    for (const row of all) {
      const date = row.asOfDate.toISOString().slice(0, 10);
      const current = latest.get(row.currency);
      if (!current || date > current) latest.set(row.currency, date);
    }
    return [...latest.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([currency, asOfDate]) => ({
        currency,
        asOfDate,
        rows: all
          .filter((row) => row.currency === currency && row.asOfDate.toISOString().slice(0, 10) === asOfDate)
          .map((row) => ({ subjectKey: row.subjectKey, subjectId: row.subjectId, direction: row.direction, amount: row.amount.toString() })),
      }));
  }

  private async latestAsOfDate(currency: string): Promise<Date | null> {
    const row = await this.prisma.accountingOpeningBalance.findFirst({
      where: { currency, deletedAt: null }, orderBy: { asOfDate: "desc" }, select: { asOfDate: true },
    });
    return row?.asOfDate ?? null;
  }

  /** 逐行校验并归一：方向只能是借/贷、金额必须是正数十进制、科目必填。 */
  private normalize(row: OpeningBalanceRow, currency: string) {
    const subjectKey = normalizeSubjectKey((row.subject_key ?? "").trim());
    if (!subjectKey) throw this.invalid("OPENING_SUBJECT_REQUIRED", "每一行都必须选择会计科目");
    if (!["debit", "credit"].includes(row.direction)) throw this.invalid("INVALID_OPENING_DIRECTION", `「${subjectKey}」的余额方向只能是借或贷`);
    let amount: Prisma.Decimal;
    try {
      amount = new Prisma.Decimal(row.amount);
      if (amount.lte(0)) throw new Error();
    } catch {
      throw this.invalid("INVALID_OPENING_AMOUNT", `「${subjectKey}」的期初金额必须是大于零的十进制数（方向由「借/贷」决定，不写负数）`);
    }
    const label = (row.subject_label ?? subjectKey).trim() || subjectKey;
    return { subjectKey, subjectLabel: label, direction: row.direction, amount: amount.toFixed(4), remark: row.remark?.trim() ?? null, currency };
  }

  private invalid(code: string, message: string) {
    return new UnprocessableEntityException({ code, message, details: [] });
  }
}

/** `YYYY-MM-DD` → UTC 零点（与 `@db.Date` 列的比较口径一致）；非法直接 422。 */
export function utcDate(value: string): Date {
  const text = (value ?? "").slice(0, 10);
  const date = new Date(`${text}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(date.valueOf())) {
    throw new UnprocessableEntityException({ code: "INVALID_AS_OF_DATE", message: "建账日期无效（应为 YYYY-MM-DD）", details: [] });
  }
  return date;
}

/** 供报表侧判断「期初里有没有货币资金」用（有的话就不再用银行账户期初兜底，避免重复计算）。 */
export function hasFundOpening(rows: ReadonlyArray<{ subjectKey: string }>): boolean {
  return rows.some((row) => isFundSubject(normalizeSubjectKey(row.subjectKey)));
}
