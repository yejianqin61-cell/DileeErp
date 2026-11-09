import { Injectable } from "@nestjs/common";
import { Optional } from "@nestjs/common";
import { PrismaService } from "../../platform/database/prisma.service";
import { beijingDateTime } from "../../platform/time/beijing-time";
import { ExchangeRateService, monthOf, previousMonth, resolveRateOf, resolvedPeriodOf, type RateBook } from "./exchange-rate.service";
import { convertUnits, formatUnits, LOCAL_RATE_UNITS, toUnits } from "./money";
import { OpeningBalanceService, hasFundOpening, mergeBalances, openingBalancesToMap } from "./opening-balance.service";
import { accountingSubjectKey } from "./accounting-subject-catalog";
import {
  buildBalanceSheet,
  buildCashFlowStatement,
  buildIncomeStatement,
  debitBalance,
  isFundSubject,
  isSubjectIdKey,
  normalizeSubjectKey,
  splitSubjectKey,
  subjectIdKeyOf,
  subjectKeyOfLine,
  sumVoucherLines,
  type BalanceSheetResult,
  type CashFlowResult,
  type IncomeStatementResult,
  type StatementVoucher,
  type StatementVoucherLine,
  type SubjectRef,
  type SubjectRefs,
  type SummedAmount,
  type UnmappedSubject,
} from "./finance-three-statements";

/**
 * 三大报表的**取数**（只读，不改任何数据）。
 *
 * 口径（设计文档 `docs/design/finance-three-statements-2026-09-24.md` §4）：
 *   - 只取 `status = posted` 的凭证：草稿没生效，已红冲的原凭证由红冲件（反向分录）抵消 ——
 *     两者都进表会让金额算两遍；
 *   - **一次把「到期末为止」的全部已过账凭证取回来，再在内存里按期间切片**：
 *     资产负债表要期末/年初两个时点、利润表与现金流量表要本期/上期两个区间，一共四个切片。
 *     分四次查库既慢，又给了「四个切片用了不同口径」的机会 —— 那是最难查的一类报表 bug；
 *   - **折算**：报表一次只出一种币种（默认本币 CNY）。非本币的凭证**按期末汇率逐行折成人民币**
 *     再进内核（折算点选在「分录」这一层：内核、版式、勾稽全都不用知道汇率的存再 —— 它们只看见人民币分录）。
 *     三个时点各用自己那个月的汇率：期末存量与本期流量用**期末月**、年初存量用**上年 12 月**、
 *     期初现金与上期流量用**上期期末月**；某月没维护就回退到「不晚于它的最近一个月」并在表尾写明，
 *     一条汇率都没有的币种**不静默丢弃**：进表尾的「未折算」缺口（`StatementGap.unconverted`）。
 *     只对**本币（CNY）报表**折算：报表币种换成外币时，「1 外币 = X 人民币」这套汇率方向就反了，
 *     强行折算会出一张自己都解释不了的表 —— 那种情况退回「不跨币种相加 + 表尾说明」。
 *
 * 期初余额有两个来源，**优先用「科目期初余额表」**（财务 2026-09-24 已确认要做，见设计文档 §8.5）：
 *   - 表里有记录 → 期初 = 建账期初，凭证只取**建账日之后**的（两边不重复计算，勾稽才真正为 0）；
 *   - 表里没有记录 → 退回**银行账户档案的期初余额**兜底（它只有货币资金）：只加资产侧时勾稽会差
 *     这一个数，内核把差额显式返回，我们不掩盖它。
 */

const LOCAL_CURRENCY = "CNY";

export type StatementFilter = {
  from?: string;
  to?: string;
  currency?: string;
};

/** 报表要报出来的缺口（全部进表尾，一条都不许静默丢掉）。 */
export type StatementGap = {
  /** 本期已生效、但还没生成凭证的收支流水（钱动了、账上没记）。 */
  entriesWithoutVoucher: number;
  /** 本期草稿凭证张数（没进表）。 */
  draftVouchers: number;
  /** 本期**已折算并入本表**的其它币种凭证张数（各自用了哪个月的汇率）。 */
  otherCurrencies: Array<{ currency: string; count: number; period: string }>;
  /**
   * **有外币凭证/期初、但一条汇率都没维护**，因此这部分**没有**折进本表的币种。
   *
   * 必须报出来：折算的反面就是「静默丢钱」—— 少了一个币种的钱，勾稽会因为两侧都少而照样平，
   * 财务看不出任何异常。
   */
  unconverted: Array<{ currency: string; vouchers: number; opening: boolean }>;
};

/** 一次取数（四个切片共用同一批凭证）。 */
type VoucherSlice = {
  /** 期末为止的余额（含期末当天）。 */
  balancesTo: Map<string, SummedAmount>;
  /** 年初（上年 12-31）为止的余额。 */
  balancesYearStart: Map<string, SummedAmount>;
  /** 本期的凭证（按凭证分组，现金流量表要配对资金分录与业务分录）。 */
  periodVouchers: StatementVoucher[];
  /** 上期的凭证。 */
  previousVouchers: StatementVoucher[];
  /** 本期、本期之前（用于算期初现金）的分录。 */
  periodLines: StatementVoucherLine[];
  beforeFromLines: StatementVoucherLine[];
  /**
   * 科目 id 归集索引（2026-11-09 R3-2）：`@id:<uuid>` → 分类/名称。
   *
   * 期初余额表只存 `subject_key`（`分类/名称`），凭证行优先用 `subject_id`；取数时就地
   * 把期初行的 label 键解析成 id 键（唯一同名才解析），两套键在 `mergeBalances` 里才加得到一起。
   */
  subjectRefs: SubjectRefs;
  /** 银行账户档案的期初余额合计（按报表币种）；有科目期初余额表时只算「期初里没含货币资金」的兜底。 */
  moneyOpening: bigint;
  /** 期初现金（建账期初 + 建账日到本期期初之间的资金类净额）。 */
  cashOpening: bigint;
  /** 汇率变动对现金的影响（行次 32）：期末资金 − 期初资金 − 本期资金净流量。 */
  exchangeEffect: bigint;
  /** 实际用到的建账日期（有科目期初余额表时非空）；null = 退回银行账户期初兜底。 */
  openingAsOfDate: string | null;
  period: { from: string; to: string };
  previousPeriod: { from: string; to: string };
  yearStart: string;
  gap: StatementGap;
};

export type BalanceSheetReport = {
  currency: string;
  period: { to: string; yearStart: string };
  /** 实际用到的建账日期（null = 还没有科目期初余额表，货币资金用的是银行账户期初兜底）。 */
  openingAsOfDate: string | null;
  current: BalanceSheetResult;
  yearStartResult: BalanceSheetResult;
  gap: StatementGap;
};

export type IncomeStatementReport = {
  currency: string;
  period: { from: string; to: string };
  previousPeriod: { from: string; to: string };
  current: IncomeStatementResult;
  previous: IncomeStatementResult;
  gap: StatementGap;
};

export type CashFlowReport = {
  currency: string;
  period: { from: string; to: string };
  previousPeriod: { from: string; to: string };
  current: CashFlowResult;
  previous: CashFlowResult;
  /** 期初现金（与资产负债表「货币资金」的期初同源，模板勾稽①）。 */
  cashOpening: bigint;
  gap: StatementGap;
};

@Injectable()
export class FinanceThreeStatementsService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly openings?: OpeningBalanceService,
    @Optional() private readonly exchangeRates?: ExchangeRateService,
  ) {}

  async balanceSheet(filter: StatementFilter): Promise<BalanceSheetReport> {
    const slice = await this.slice(filter);
    return {
      currency: this.currencyOf(filter),
      period: { to: slice.period.to, yearStart: slice.yearStart },
      openingAsOfDate: slice.openingAsOfDate,
      current: buildBalanceSheet({ balances: slice.balancesTo, opening: { money: slice.moneyOpening }, subjectRefs: slice.subjectRefs }),
      // 年初余额：同一批凭证切到上年 12-31；期初余额对两个时点都成立（它发生在建账日之前）。
      yearStartResult: buildBalanceSheet({ balances: slice.balancesYearStart, opening: { money: slice.moneyOpening }, subjectRefs: slice.subjectRefs }),
      gap: slice.gap,
    };
  }

  async incomeStatement(filter: StatementFilter): Promise<IncomeStatementReport> {
    const slice = await this.slice(filter);
    return {
      currency: this.currencyOf(filter),
      period: slice.period,
      previousPeriod: slice.previousPeriod,
      current: buildIncomeStatement(sumVoucherLines(slice.periodLines), slice.subjectRefs),
      previous: buildIncomeStatement(sumVoucherLines(slice.previousVouchers.flatMap((voucher) => voucher.lines)), slice.subjectRefs),
      gap: slice.gap,
    };
  }

  async cashFlowStatement(filter: StatementFilter): Promise<CashFlowReport> {
    const slice = await this.slice(filter);
    // 期初现金已经在切片里算好（建账期初 + 期初之前的资金类净额；没有期初表时是银行期初兜底）。
    return {
      currency: this.currencyOf(filter),
      period: slice.period,
      previousPeriod: slice.previousPeriod,
      current: buildCashFlowStatement({ vouchers: slice.periodVouchers, cashOpening: slice.cashOpening, exchangeEffect: slice.exchangeEffect, subjectRefs: slice.subjectRefs }),
      previous: buildCashFlowStatement({ vouchers: slice.previousVouchers, cashOpening: 0n, subjectRefs: slice.subjectRefs }),
      cashOpening: slice.cashOpening,
      gap: slice.gap,
    };
  }

  /** 未归位的科目清单（利润表与资产负债表的缺口口径不同，页面上按表显示）。 */
  unmappedText(unmapped: readonly UnmappedSubject[]): string[] {
    return unmapped.map((item) => `${item.subjectKey}：${item.balance}`);
  }

  // ------------------------------------------------------------------ 取数

  private currencyOf(filter: StatementFilter): string {
    return (filter.currency?.trim() || LOCAL_CURRENCY).toUpperCase();
  }

  /** 期间默认：本月（北京时间）。 */
  private periodOf(filter: StatementFilter): { from: string; to: string } {
    const today = beijingDateTime(new Date()).slice(0, 10);
    const to = filter.to?.slice(0, 10) || today;
    const from = filter.from?.slice(0, 10) || `${to.slice(0, 7)}-01`;
    return { from, to };
  }

  private async slice(filter: StatementFilter): Promise<VoucherSlice> {
    const currency = this.currencyOf(filter);
    const period = this.periodOf(filter);
    const previousPeriod = previousPeriodOf(period);
    const yearStart = `${Number(period.to.slice(0, 4)) - 1}-12-31`;

    const rows = await this.prisma.voucher.findMany({
      /**
       * **红字凭证不进报表**（2026-11-09）。
       *
       * 红冲的实现是「原凭证置 reversed + 另开一张 posted 红字凭证」；报表只取 posted 时，
       * 原凭证被排除、红字被计入，于是每次红冲都让相关科目留下**单边反向余额**
       * （诊断 P1-1；生产库 3 张 posted 红字凭证合计反向虚增 12,061.20）。
       *
       * 口径：红冲对 = 原凭证作废 + 红字作废，两者都不进报表（红字只在凭证清单里留痕）。
       * 这样原凭证与红字同时被排除，任何长度的红冲链都净为 0；未被红冲的 posted 凭证照常计入。
       */
      where: { status: "posted", deletedAt: null, sourceType: { not: "voucher" }, voucherDate: { lte: utcDate(period.to) } },
      select: {
        id: true,
        voucherDate: true,
        currency: true,
        sourceType: true,
        sourceId: true,
        lines: { select: { subjectKey: true, subjectId: true, direction: true, amount: true }, orderBy: { lineNo: "asc" } },
      },
      orderBy: [{ voucherDate: "asc" }, { voucherNo: "asc" }],
    });

    const dateText = (value: Date) => beijingDateTime(value).slice(0, 10);
    const inRange = (date: string, range: { from: string; to: string }) => date >= range.from && date <= range.to;

    /**
     * 期初余额：**全币种**一次读回（建账日 ≤ 期末的最近一次/每币种）—— 折算要把外币期初一起折进来，
     * 只读本币那一组会让「美元银行账户的期初」凭空消失，而报表两侧都少，勾稽照样平。
     */
    const openingGroups = await this.openings?.effectiveForAll(period.to) ?? [];
    const localGroup = openingGroups.find((group) => group.currency === currency) ?? null;
    // 有科目期初时，凭证只取**建账日之后**的：建账日之前的余额已经包含在期初里，再取一遍就是算两遍。
    // 按**币种**各自的建账日判断：不同币种的期初表可以是不同的建账日（各录各的），
    // 用一个日期去卡所有币种，会把「美元期初已经含了 1–3 月」的凭证又算一遍。
    const asOfByCurrency = new Map(openingGroups.map((group) => [group.currency, group.asOfDate]));
    const afterOpening = (voucher: (typeof rows)[number]) => dateText(voucher.voucherDate) > (asOfByCurrency.get(voucher.currency) ?? "");

    /**
     * 科目 id 归集索引（2026-11-09 R3-2，契约 C）：凭证行有 `subject_id` 就按 id 归集，
     * 为空（历史回填没命中的行）才回退 `subject_label` 文本。
     *
     * 索引只装**查得到的 id**：`subject_id` 指向已被硬删的科目时，一律回退 label（不猜、不丢）。
     * 期初余额表只存 `subject_key`，这里同时按 `(分类,名称)` 唯一同名把它解析成 id 键，
     * 否则「期初是 label 键、凭证是 id 键」会变成两个桶 —— 报表不会翻倍，但期初那一截会漏。
     */
    const lineSubjectIds = [...new Set(rows
      .flatMap((voucher) => voucher.lines.map((line) => line.subjectId))
      .filter((subjectId): subjectId is string => Boolean(subjectId)))];
    const openingLabelRefs = new Map<string, SubjectRef>();
    for (const group of openingGroups) {
      for (const row of group.rows) {
        const normalized = normalizeSubjectKey(row.subjectKey);
        if (isSubjectIdKey(normalized)) continue;
        const ref = splitSubjectKey(normalized);
        // 裸名且不是资金科目（分类为空）的期初行判不出分类：保留原 label 键，不做解析。
        if (!ref.category) continue;
        openingLabelRefs.set(normalized, ref);
      }
    }
    const openingNames = [...new Set([...openingLabelRefs.values()].map((ref) => ref.name))];
    const needSubjectLookup = lineSubjectIds.length > 0 || openingNames.length > 0;
    const subjectRows = needSubjectLookup
      ? await this.prisma.accountingSubject.findMany({
        where: {
          deletedAt: null,
          OR: [
            ...(lineSubjectIds.length ? [{ id: { in: lineSubjectIds } }] : []),
            ...(openingNames.length ? [{ name: { in: openingNames } }] : []),
          ],
        },
        select: { id: true, category: true, name: true },
      })
      : [];
    const subjectIdByLabel = new Map(subjectRows.map((subject) => [accountingSubjectKey(subject.category, subject.name), subject.id]));
    const subjectRefs: Map<string, SubjectRef> = new Map(subjectRows.map((subject) => [subjectIdKeyOf(subject.id), { category: subject.category, name: subject.name }]));
    /** 期初行的 `分类/名称` 键 → 归集键（唯一同名命中的才用 id 键；否则保留 label 键）。 */
    const canonicalOpeningKey = (rawKey: string): string => {
      const normalized = normalizeSubjectKey(rawKey);
      if (isSubjectIdKey(normalized)) return normalized;
      const ref = splitSubjectKey(normalized);
      if (!ref.category) return normalized;
      const subjectId = subjectIdByLabel.get(accountingSubjectKey(ref.category, ref.name));
      return subjectId ? subjectIdKeyOf(subjectId) : normalized;
    };

    /**
     * 来源收支流水的「收支类目」（业务科目）：现金流量表落行**优先用它**（2026-11-04 用户报障）。
     *
     * 为什么必须在这里取：已挂账的付款，付款凭证的业务分录是「应付账款」，
     * 照分录科目落行会把专利费/推广费/房租全算成「购买商品、接受劳务支付的现金」。
     * 收支类目（`cash_flow_entries.category_subject_id`）才是单据上选的那个科目，
     * 与应付台账、利润表同口径；没有类目（手工凭证、老数据）时内核会退回分录科目。
     *
     * 只查 `source_type = cash_flow_entry` 的凭证：手工凭证没有来源、挂账凭证没有资金分录，都不进现金流量表。
     */
    const cashFlowSourceIds = [...new Set(rows
      .filter((voucher) => voucher.sourceType === "cash_flow_entry" && voucher.sourceId)
      .map((voucher) => voucher.sourceId as string))];
    const categoryByEntryId = new Map<string, { category: string; name: string }>();
    if (cashFlowSourceIds.length) {
      const entries = await this.prisma.cashFlowEntry.findMany({
        where: { id: { in: cashFlowSourceIds }, deletedAt: null },
        select: { id: true, categorySubject: { select: { category: true, name: true } } },
      });
      for (const entry of entries) if (entry.categorySubject) categoryByEntryId.set(entry.id, entry.categorySubject);
    }
    const categoryOf = (voucher: (typeof rows)[number]) =>
      voucher.sourceType === "cash_flow_entry" && voucher.sourceId ? categoryByEntryId.get(voucher.sourceId) ?? null : null;

    const faceLines = (voucher: (typeof rows)[number]): StatementVoucherLine[] =>
      voucher.lines.map((line) => ({
        subjectKey: line.subjectKey,
        // 只有索引里查得到的 id 才交给内核（否则会变成一个永远解析不到分类/名称的孤儿键）。
        subjectId: line.subjectId && subjectRefs.has(subjectIdKeyOf(line.subjectId)) ? line.subjectId : null,
        direction: line.direction,
        amount: line.amount.toString(),
      }));

    // 汇率：只对**本币报表**折算（见类注释最后一段）。
    const book: RateBook = currency === LOCAL_CURRENCY && this.exchangeRates ? await this.exchangeRates.rateBook() : new Map();
    const months = { closing: monthOf(period.to), previous: monthOf(previousPeriod.to), yearStart: monthOf(yearStart) };

    // 折算不了（一条汇率都没有）的币种：必须进表尾 —— 折算的反面就是静默丢钱。
    const unconvertedCodes = new Set<string>();
    const unconvertedOpening = new Set<string>();
    const periodForeignRows = new Map<string, number>();
    const convertedRows = new Map<string, number>();

    /**
     * 一条凭证在某个月份口径下的**人民币分录**；折不了返回 `null`（调用方不许当成空数组）。
     *
     * 折算点选在分录这一层是有意的：内核、版式、勾稽都只看见人民币分录，不需要知道汇率的存在 ——
     * 否则「资产负债表按期末汇率、利润表按期间汇率」这类口径会渗进每一行匹配逻辑里。
     */
    const cache = new Map<string, StatementVoucherLine[] | null>();
    const linesAt = (voucher: (typeof rows)[number], month: string): StatementVoucherLine[] | null => {
      if (voucher.currency === currency) return faceLines(voucher);
      const key = `${voucher.id}|${month}`;
      const hit = cache.get(key);
      if (hit !== undefined) return hit;
      const rate = currency === LOCAL_CURRENCY ? resolveRateOf(book, voucher.currency, month) : null;
      let computed: StatementVoucherLine[] | null = null;
      if (rate === null) {
        unconvertedCodes.add(voucher.currency);
      } else {
        computed = faceLines(voucher).map((line) => ({ ...line, amount: formatUnits(convertUnits(toUnits(line.amount), rate)) }));
      }
      cache.set(key, computed);
      return computed;
    };

    /**
     * 期初余额表在某个汇率口径下的人民币余额（本币那一组原样，外币那一组逐行折）。
     *
     * 每一行的 label 键先经 `canonicalOpeningKey` 解析成与凭证一致的归集键（唯一同名 → id 键），
     * 这样「期初 1000 + 凭证 200」是**相加**而不是两个互不认识的桶（不翻倍、不漏）。
     */
    const openingMapAt = (month: string): Map<string, SummedAmount> => {
      let merged = new Map<string, SummedAmount>();
      const foreignLines: StatementVoucherLine[] = [];
      for (const group of openingGroups) {
        const canonicalRows = group.rows.map((row) => ({ ...row, subjectKey: canonicalOpeningKey(row.subjectKey) }));
        if (group.currency === currency) {
          merged = mergeBalances(merged, openingBalancesToMap(canonicalRows));
          continue;
        }
        // 非本币报表不折算（汇率方向反了）：只取本币那一组 —— 与折算前的老口径一致。
        if (currency !== LOCAL_CURRENCY) continue;
        const rate = resolveRateOf(book, group.currency, month);
        if (rate === null) {
          unconvertedOpening.add(group.currency);
          continue;
        }
        for (const row of canonicalRows) {
          foreignLines.push({ subjectKey: row.subjectKey, direction: row.direction, amount: formatUnits(convertUnits(toUnits(row.amount), rate)) });
        }
      }
      return foreignLines.length ? mergeBalances(merged, sumVoucherLines(foreignLines)) : merged;
    };

    const openingMapTo = openingMapAt(months.closing);
    const openingMapYearStart = openingMapAt(months.yearStart);
    const openingMapPrevious = openingMapAt(months.previous);

    // 凭证的取数集合：本币报表取**全部**币种（外币逐条折算；折不了的当场进缺口），其它报表只取本币。
    const usedRows = currency === LOCAL_CURRENCY ? rows : rows.filter((voucher) => voucher.currency === currency);

    const balancesAt = (cutoff: string, month: string, openingMap: Map<string, SummedAmount>) => {
      const fromVouchers = sumVoucherLines(usedRows
        .filter((voucher) => dateText(voucher.voucherDate) <= cutoff && afterOpening(voucher))
        .flatMap((voucher) => linesAt(voucher, month) ?? []));
      return openingMap.size ? mergeBalances(fromVouchers, openingMap) : fromVouchers;
    };

    const balancesTo = balancesAt(period.to, months.closing, openingMapTo);
    const balancesYearStart = balancesAt(yearStart, months.yearStart, openingMapYearStart);

    // 期间切片也按各自的汇率口径折：本期流量用期末月、上期流量用上期期末月（口径写在类注释里）。
    const periodRows = usedRows.filter((voucher) => afterOpening(voucher) && inRange(dateText(voucher.voucherDate), period));
    const previousRows = usedRows.filter((voucher) => afterOpening(voucher) && inRange(dateText(voucher.voucherDate), previousPeriod));
    const statementVouchers = (subset: typeof usedRows, month: string): StatementVoucher[] =>
      subset.flatMap((voucher) => {
        const lines = linesAt(voucher, month);
        return lines ? [{ id: voucher.id, lines, categorySubject: categoryOf(voucher) }] : [];
      });
    const periodVouchers = statementVouchers(periodRows, months.closing);
    const previousVouchers = statementVouchers(previousRows, months.previous);

    // 银行账户期初：只在**没有本币科目期初余额表（或那张表里没有货币资金）**时兜底
    // （有的话它已经含在期初里，再加一遍就是重复计算）。
    const moneyOpening = !localGroup || !hasFundOpening(localGroup.rows) ? await this.moneyOpening(currency) : 0n;

    // 本期其它币种：已折算的记「用了哪个月的汇率」，折不了的进「未折算」缺口（两者互斥）。
    for (const voucher of rows) {
      if (voucher.currency === currency) continue;
      if (!inRange(dateText(voucher.voucherDate), period)) continue;
      periodForeignRows.set(voucher.currency, (periodForeignRows.get(voucher.currency) ?? 0) + 1);
      if (linesAt(voucher, months.closing) !== null) {
        convertedRows.set(voucher.currency, (convertedRows.get(voucher.currency) ?? 0) + 1);
      }
    }

    const fundPart = (balances: ReadonlyMap<string, SummedAmount>) => {
      let total = 0n;
      for (const [subjectKey, summed] of balances) if (isFundSubject(subjectKey, subjectRefs)) total += debitBalance(summed);
      return total;
    };
    const fundMovement = (subset: typeof usedRows, month: string) => {
      let total = 0n;
      for (const voucher of subset) {
        for (const line of linesAt(voucher, month) ?? []) {
          if (!isFundSubject(subjectKeyOfLine(line), subjectRefs)) continue;
          const units = toUnits(line.amount);
          total += line.direction === "debit" ? units : -units;
        }
      }
      return total;
    };

    // 期初现金（现金流量表）= 银行账户期初兜底 + 期初里的资金类部分 + 建账日到本期期初之间的资金类净额；
    // **别漏了期初里的资金类部分** —— 漏了会让「期初现金」变成 0，而期末余额一路跟着错（模板勾稽①就是这么查出来的）。
    // 外币部分按期初汇率（上期期末月）折算：期初现金和本期流量用的汇率不同，差额正是行次 32 要解释的东西。
    const beforeFromLines = usedRows
      .filter((voucher) => dateText(voucher.voucherDate) < period.from && afterOpening(voucher))
      .flatMap((voucher) => linesAt(voucher, months.previous) ?? []);
    let cashOpening = moneyOpening + fundPart(openingMapPrevious) + fundPart(sumVoucherLines(beforeFromLines));

    // 汇率变动对现金的影响（行次 32）：期末资金 − 期初资金 − 本期资金净流量。
    // 三者口径必须一致地含上银行账户期初兜底（否则本币报表也会凭空多出一行 32）。
    const closingFunds = fundPart(balancesTo) + moneyOpening;
    const exchangeEffect = closingFunds - cashOpening - fundMovement(periodRows, months.closing);

    return {
      balancesTo,
      balancesYearStart,
      periodVouchers,
      previousVouchers,
      periodLines: periodVouchers.flatMap((voucher) => voucher.lines),
      beforeFromLines,
      subjectRefs,
      moneyOpening,
      cashOpening,
      exchangeEffect,
      openingAsOfDate: localGroup?.asOfDate ?? null,
      period,
      previousPeriod,
      yearStart,
      gap: {
        entriesWithoutVoucher: (await this.entriesWithoutVoucher(period, currency)).length,
        draftVouchers: await this.prisma.voucher.count({
          where: { status: "draft", deletedAt: null, currency, voucherDate: { gte: utcDate(period.from), lte: utcDate(period.to) } },
        }),
        otherCurrencies: [...convertedRows.entries()]
          .map(([code, count]) => ({ currency: code, count, period: resolvedPeriodOf(book, code, months.closing) ?? months.closing }))
          .sort((left, right) => left.currency.localeCompare(right.currency)),
        unconverted: [...unconvertedCodes]
          .map((code) => ({ currency: code, vouchers: periodForeignRows.get(code) ?? 0, opening: unconvertedOpening.has(code) }))
          .sort((left, right) => left.currency.localeCompare(right.currency)),
      },
    };
  }

  /** 银行账户档案的期初余额合计（按币种）。 */
  private async moneyOpening(currency: string): Promise<bigint> {
    const banks = await this.prisma.bank.findMany({ where: { deletedAt: null, currency }, select: { openingBalance: true } });
    return banks.reduce((total, bank) => total + toUnits(bank.openingBalance.toString()), 0n);
  }

  /**
   * 本期已生效、但**还没有凭证**的收支流水。
   *
   * 为什么必须报出来：确认应收/应付会自动写一条流水，而凭证要财务在「凭证管理」里点「生成凭证」。
   * 没生成的流水在报表里是**完全不存在的钱**（三大报表取的是凭证），不提示的话，
   * 财务看到的是「这个月怎么什么都没发生」。
   */
  private async entriesWithoutVoucher(period: { from: string; to: string }, currency: string) {
    const entries = await this.prisma.cashFlowEntry.findMany({
      where: { status: "posted", deletedAt: null, currency, entryDate: { gte: utcDate(period.from), lte: utcDate(period.to) } },
      select: { id: true },
    });
    if (!entries.length) return [];
    const vouchers = await this.prisma.voucher.findMany({
      where: { sourceType: "cash_flow_entry", sourceId: { in: entries.map((entry) => entry.id) }, deletedAt: null, status: { not: "reversed" } },
      select: { sourceId: true },
    });
    const generated = new Set(vouchers.map((voucher) => voucher.sourceId));
    return entries.filter((entry) => !generated.has(entry.id));
  }
}

/**
 * 上期期间。
 *
 * 口径（跟财务的月度报表习惯对齐）：
 *   - 本期是**整月**（1 号到该月最后一天）→ 上期 = **上一个自然月**（8 月对 7 月，天数不一样也要对）；
 *   - 本期不是整月（自定义期间、半月等）→ 上期 = 紧邻之前、**等长**的一段。
 *
 * 为什么不能一律按等长天数：9 月（30 天）按等长会变成 8/2–8/31，财务对不上「上月」这个数；
 * 而 3 月（31 天）按等长会变成 1/29–2/28，那就更不像上期了。
 */
export function previousPeriodOf(period: { from: string; to: string }): { from: string; to: string } {
  const [year, month, day] = period.from.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day === 1 && period.to === `${period.from.slice(0, 7)}-${String(lastDay).padStart(2, "0")}`) {
    const previousMonth = new Date(Date.UTC(year, month - 2, 1));
    const previousYear = previousMonth.getUTCFullYear();
    const previousMonthNumber = previousMonth.getUTCMonth() + 1;
    const previousLastDay = new Date(Date.UTC(previousYear, previousMonthNumber, 0)).getUTCDate();
    return {
      from: `${previousYear}-${String(previousMonthNumber).padStart(2, "0")}-01`,
      to: `${previousYear}-${String(previousMonthNumber).padStart(2, "0")}-${String(previousLastDay).padStart(2, "0")}`,
    };
  }
  const from = utcDate(period.from);
  const to = utcDate(period.to);
  const days = Math.round((to.valueOf() - from.valueOf()) / 86_400_000) + 1;
  const previousTo = new Date(from.valueOf() - 86_400_000);
  const previousFrom = new Date(previousTo.valueOf() - (days - 1) * 86_400_000);
  return { from: previousFrom.toISOString().slice(0, 10), to: previousTo.toISOString().slice(0, 10) };
}

/** `YYYY-MM-DD` → UTC 零点（与 `@db.Date` 列的比较口径一致）。 */
export function utcDate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

/** 供表尾与预览共用的「未归位科目」文案。 */
export function unmappedNotes(unmapped: readonly UnmappedSubject[], label = "未归入任何报表行的科目"): string[] {
  if (!unmapped.length) return [];
  return [`${label}：${unmapped.map((item) => `${item.subjectKey}（${item.balance}）`).join("、")}`];
}
