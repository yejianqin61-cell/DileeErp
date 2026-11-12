import { Injectable, UnprocessableEntityException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { AuditService } from "../../platform/audit/audit.service";
import type { CurrentUser } from "../../platform/auth/auth.service";
import { PrismaService } from "../../platform/database/prisma.service";
import { accountingSubjectKey } from "./accounting-subject-catalog";
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
 * 四条口径：
 *   1. **整批替换**：界面按「建账日 + 币种」一张表录入，保存时整批替换这一组 ——
 *      逐行 upsert 会让「删掉一行」变成一个额外的删除动作，而财务的心智是「这张表就是我现在的期初」；
 *   2. **软删除后唯一键仍占位**（同月度管理费分摊）：替换时按 (as_of_date, subject_key, currency)
 *      upsert（把软删的那条**恢复**回来），既不会撞唯一索引，也不会出现「同一科目两条期初」；
 *   3. **不强制试算平衡**：财务可能分批录。借贷不平衡时接口照收，但响应把差额带回去，
 *      界面显著显示（报表那边也会因为差这个数而不平）—— 挡住录入只会让她以为系统坏了；
 *   4. **写入校验科目必须存在**（2026-11-12 R-4）：期初是建账的起点，收下一笔不存在的科目，
 *      报表取数归不了行，这笔金额就静默消失 —— 所以整批 422，一行都不落库。同名跨分类只算
 *      「写得不够」，放行并进未归位清单；已停用的科目放行（历史账要用），只计数提示。
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

/** 期初行能对上的一个科目候选（422 时作为「可选科目」回给界面）。 */
export type OpeningSubjectOption = { id: string; category: string; name: string; isActive: boolean };

/** 一个对不上的期初科目：归一后的键 + 拆出的分类/名称 + 全表同名候选。 */
export type OpeningSubjectMiss = { subjectKey: string; category: string; name: string; candidates: OpeningSubjectOption[] };

/**
 * 期初行的科目键 → 科目主键（2026-11-11 R-1 / T3），并按写入校验分三档（2026-11-12 R-4 / T10）。
 *
 * 期初原本只有文本键 `subject_key`，是**唯一一张连科目外键都没有**的业务表：科目一改名，
 * 这一行就与主数据脱节，报表按名字匹配不上，金额静默消失（诊断 P0-2）。
 *
 * 判据与全站一致：**只有唯一同名才算解析成功**。
 *   - 键带分类（`资产类/银行存款`）→ 必须「同分类 + 同名称」，库层 `@@unique([category,name])`
 *     保证最多命中一个；
 *   - 键是裸名（`银行存款`，资金科目的老写法）→ 全表同名唯一才认，同名跨分类一律不猜。
 *
 * 但「解析不到」有两种，处理必须分开（R-4）——把它们合成一档就会拦错人或放过人：
 *   - **不存在**（带分类查不到同分类同名，或裸名全表无同名）→ 这是「写错了」。期初是建账的起点，
 *     收下一笔不存在的科目，报表取数时就归不了行，这笔金额会从报表上消失且不报错。
 *     调用方要 **422 拒绝**，并把可选科目回给财务；
 *   - **同名跨分类且没写分类** → 这是「写得不够」。留空让报表回退文本匹配，并进未归位清单
 *     （拦住「写得不够」等于让财务没法分批录历史账）。
 *
 * 已停用（`isActive: false`）是**第三种**，既不拦也不进未归位：它可能正是历史账上的科目，
 * 所以照常解析出主键（放行），只把清单回给调用方计数提示 —— 「停用」表示不再新用，
 * 不表示这笔历史期初不算数。
 *
 * 已删除（`deletedAt` 不为空）的科目由调用方查库时排除，因此在这里与「不存在」同档。
 */
export function resolveOpeningSubjects(
  rows: ReadonlyArray<{ subjectKey: string }>,
  subjects: ReadonlyArray<{ id: string; category: string; name: string; isActive?: boolean }>,
): { subjectIdByKey: Map<string, string>; unassigned: string[]; missing: OpeningSubjectMiss[]; disabled: string[] } {
  const byName = new Map<string, OpeningSubjectOption[]>();
  for (const subject of subjects) {
    const option: OpeningSubjectOption = { id: subject.id, category: subject.category, name: subject.name, isActive: subject.isActive !== false };
    byName.set(subject.name, [...(byName.get(subject.name) ?? []), option]);
  }
  const subjectIdByKey = new Map<string, string>();
  const unassigned: string[] = [];
  const missing: OpeningSubjectMiss[] = [];
  const disabled: string[] = [];
  for (const row of rows) {
    const key = normalizeSubjectKey(row.subjectKey);
    // 已经是 id 键的期初行（理论上不该出现，报表侧才用 id 键）原样跳过，不重复解析。
    if (isSubjectIdKey(key)) continue;
    const { category, name } = splitSubjectKey(key);
    const candidates = byName.get(name) ?? [];
    if (category) {
      const hit = candidates.find((subject) => subject.category === category);
      if (!hit) { missing.push({ subjectKey: key, category, name, candidates }); continue; }
      subjectIdByKey.set(key, hit.id);
      if (!hit.isActive) disabled.push(key);
      continue;
    }
    if (candidates.length === 0) { missing.push({ subjectKey: key, category: "", name, candidates }); continue; }
    if (candidates.length === 1) {
      subjectIdByKey.set(key, candidates[0].id);
      if (!candidates[0].isActive) disabled.push(key);
      continue;
    }
    unassigned.push(key);
  }
  return { subjectIdByKey, unassigned, missing, disabled };
}

/** 只取「键 → 主键」这条腿（T3 的入口；三档判据见 `resolveOpeningSubjects`）。 */
export function resolveOpeningSubjectIds(
  rows: ReadonlyArray<{ subjectKey: string }>,
  subjects: ReadonlyArray<{ id: string; category: string; name: string }>,
): Map<string, string> {
  return resolveOpeningSubjects(rows, subjects).subjectIdByKey;
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
   * **事务内**完成三件事：校验科目、软删掉这次没出现的旧行、把出现的行 upsert（含恢复软删行），
   * 再记审计。之所以要一起做：中途失败会让财务看到「一半是新的、一半是旧的」期初，
   * 而报表正好在那个时刻不平。
   *
   * 校验排在**任何写入之前**（2026-11-12 R-4 / T10）：写了不存在的科目就整批 422，
   * 这一组期初原样不动 —— 财务改完再存，不会因为一次笔误丢掉已经录好的旧行。
   * 判据见 `resolveOpeningSubjects`：不存在 → 拦；同名跨分类 → 放行进未归位；已停用 → 放行并计数。
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
      // 先把这一批科目键解析成科目主键（2026-11-11 R-1 / T3），判据交给纯函数
      // `resolveOpeningSubjects`（唯一同名才认）。查询只按这批行的名称取候选，科目表再大也只读几行。
      //
      // 解析不到**分两种**（2026-11-12 R-4 / T10）：科目不存在是「写错了」，这里 422 拦掉；
      // 同名跨分类没写分类是「写得不够」，留空放行、进未归位清单。
      // 拦住前者是必须的：期初是建账的起点，收下一笔不存在的科目，报表取数归不了行，
      // 这笔金额就从报表上消失且不报错（诊断 P0-2 的同一条失败形态）。
      // 查库过滤掉软删科目：已删除的科目与「不存在」同档；已停用的仍要查出来（放行但计数）。
      const names = [...new Set(rows.map((row) => splitSubjectKey(normalizeSubjectKey(row.subjectKey)).name))];
      const subjectRows = names.length
        ? await tx.accountingSubject.findMany({ where: { deletedAt: null, name: { in: names } }, select: { id: true, category: true, name: true, isActive: true } })
        : [];
      const subjects = resolveOpeningSubjects(rows, subjectRows);
      if (subjects.missing.length) {
        // 「可选科目」只列启用且未删除的：把停用/已删科目当可选项，等于把财务推回同一个坑。
        const available = await tx.accountingSubject.findMany({
          where: { deletedAt: null, isActive: true },
          select: { category: true, name: true },
          orderBy: [{ category: "asc" }, { name: "asc" }],
        });
        throw this.subjectNotFound(subjects.missing, available.map((subject) => accountingSubjectKey(subject.category, subject.name)));
      }
      const subjectIdByKey = subjects.subjectIdByKey;

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
      return { removed: removed.length, saved: rows.length, unassigned: subjects.unassigned, disabled: subjects.disabled };
    });

    const totals = openingBalanceTotals(rows);
    // 已停用的科目放行（它可能正是历史账上的科目），但提示里带出计数 ——
    // 财务才知道这一组期初里有科目已经不能在新单据上用了。
    const warnings = result.disabled.length
      ? [`${result.disabled.length} 个科目已停用（历史期初可能正挂在这些科目上，本次照常落库并保留科目主键）：${result.disabled.join("、")}`]
      : [];
    await this.audit.record("opening_balance.replace", "opening_balance", user.id, undefined, {
      as_of_date: input.as_of_date.slice(0, 10), currency,
      saved: result.saved, removed: result.removed, unassigned: result.unassigned, disabled_subjects: result.disabled,
      debit: totals.debit.toString(), credit: totals.credit.toString(), balanced: totals.balanced,
    });
    return { as_of_date: input.as_of_date.slice(0, 10), currency, saved: result.saved, removed: result.removed, unassigned: result.unassigned, disabled_subjects: result.disabled, warnings, totals };
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

  /**
   * 422：期初里写了会计科目表里没有的科目。
   *
   * 文案与 `details` 各管一头：文案让人一眼看到是哪个科目对不上、以及为什么必须拦；
   * `details` 给界面/导入脚本用 —— 对不上的键（连同名候选）与「现在能选的科目」，
   * 这就是改进计划 R-4 说的「给出可选项」。不存在的科目**不落库**：收下它，这笔金额
   * 会从报表上消失且不报错，而期初正是建账的起点。
   */
  private subjectNotFound(missing: OpeningSubjectMiss[], available: string[]) {
    const described = missing.map((item) => item.candidates.length
      ? `「${item.subjectKey}」（同名的是：${item.candidates.map((option) => accountingSubjectKey(option.category, option.name)).join("、")}）`
      : `「${item.subjectKey}」（科目表里没有同名科目）`);
    return this.invalid(
      "OPENING_SUBJECT_NOT_FOUND",
      `期初余额里有 ${missing.length} 个科目在会计科目表里不存在：${described.join("；")}。`
      + "期初是建账的起点 —— 收下一笔不存在的科目，报表取数时就归不了行，这笔金额会从报表上消失且不报错。"
      + "请先在「会计科目」里建好它，或改填系统里已有的科目再保存。",
      [{
        missing: missing.map((item) => ({
          subject_key: item.subjectKey,
          category: item.category || null,
          name: item.name,
          candidates: item.candidates.map((option) => ({ id: option.id, category: option.category, name: option.name, is_active: option.isActive })),
        })),
        available_subjects: available,
      }],
    );
  }

  private invalid(code: string, message: string, details: unknown[] = []) {
    return new UnprocessableEntityException({ code, message, details });
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
