import { Injectable, NotFoundException, UnprocessableEntityException, Optional } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { AuditService } from "../../platform/audit/audit.service";
import type { CurrentUser } from "../../platform/auth/auth.service";
import { CurrencyService } from "../../platform/currency/currency.service";
import { nextSequenceCode } from "../../platform/database/daily-sequence-code";
import { PrismaService } from "../../platform/database/prisma.service";
import { accountingSubjectKey } from "./accounting-subject-catalog";
import { fundLineFor, reverseLines, voucherBalance, voucherLinesFor, voucherPeriodFor, voucherSummaryFor, type VoucherLineDraft } from "./voucher.domain";
import { VOUCHER_TEMPLATES, resolveVoucherTemplate, type ResolvedTemplateLine } from "./voucher-template";

/** 来源类型：收支流水；红冲凭证的来源是「被红冲的那张凭证」；**手工凭证没有来源**。 */
export const SOURCE_CASH_FLOW = "cash_flow_entry";
export const SOURCE_VOUCHER = "voucher";
export const SOURCE_MANUAL = "manual";
/** 挂账凭证的来源：一条应收来源 / 一条应付，各自最多一张挂账凭证（唯一键 (source_type, source_id) 兜底）。 */
export const SOURCE_RECEIVABLE = "receivable_source";
export const SOURCE_PAYABLE = "supplier_payable";

/**
 * 挂账时的「占用科目」：确认应收 = 借**应收账款**，确认应付 = 贷**应付账款**。
 *
 * 这是「确认 = 挂账」这条口径落地的地方（方案 `docs/design/finance-accrual-two-step-2026-09-24.md`）：
 * 确认那一刻钱还没到，所以借方不能是银行存款，只能是应收；等到登记收款/付款（销账）时，
 * 那条**现金**分录才是「借银行存款 / 贷应收账款」，钱与收入各记一次，不重不漏。
 */
export const ACCRUAL_SUBJECT_NAMES: Record<string, string> = {
  [SOURCE_RECEIVABLE]: "应收账款",
  [SOURCE_PAYABLE]: "应付账款",
};

const ENTRY_INCLUDE = {
  // 会计科目：凭证的业务分录科目直接取它（分类 = 科目类别，项目 = 科目名称），
  // 这就是 voucher.domain.ts 顶部预留的「接入正式科目表」——2026-09-17 已接入。
  subject: { select: { id: true, category: true, name: true } },
  settlementAccount: { select: { id: true, key: true, label: true } },
  // 银行账户：资金类分录要引用具体账户（见 voucher.domain.ts 的 fundLineFor）。
  bank: { select: { id: true, bankName: true, accountNumber: true, accountName: true } },
} as const;

/** 银行账户的显示名：与全站一致（银行名 + 账号），凭证纸上要能据此对上银行对账单。 */
export function bankAccountLabel(bank: { bankName: string; accountNumber: string } | null | undefined): string | null {
  if (!bank) return null;
  return `${bank.bankName}${bank.accountNumber}`;
}

const STATUS_LABELS: Record<string, string> = { draft: "草稿", posted: "已过账", reversed: "已红冲" };

export type VoucherLineInput = { direction: string; subject_key?: string; subject_label?: string; summary?: string; amount: string; bank_id?: string | null };

/**
 * 模板行 + **这张凭证自己的资金行信息**。
 *
 * 为什么资金行要在服务端拼：钱落在哪张卡上是这张凭证已有的事实（它由某条收支流水的 `bank_id` 生成），
 * 前端不该、也没法知道。套模板时把原资金行的科目与账户搬到新分录上，才不会出现
 * 「改了一次科目，银行存款明细账上的账户引用就没了」。
 */
export type VoucherTemplateLineResponse = ResolvedTemplateLine & { bank_id: string | null; bank_label: string | null };

/**
 * 记账凭证服务。
 *
 * 当前只从**收支流水**生成（用户口径：「凭证管理从收支流水中 fetch，每条收支条目都可以生成对应的条目」）。
 * 凭证是结构化记录，图片/PDF 只是渲染视图 —— 见 voucher.domain.ts 顶部的说明。
 */
@Injectable()
export class VoucherService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, @Optional() private readonly currencies?: CurrencyService) {}

  /** 凭证列表（默认全部；可按期间/状态过滤），带分录（含资金分录引用的银行账户）与来源流水号。 */
  async list(filter: { period?: string; status?: string } = {}) {
    const rows = await this.prisma.voucher.findMany({
      where: { deletedAt: null, ...(filter.period ? { period: filter.period } : {}), ...(filter.status ? { status: filter.status } : {}) },
      include: { lines: { orderBy: { lineNo: "asc" }, include: { bank: { select: { id: true, bankName: true, accountNumber: true } } } } },
      orderBy: [{ voucherDate: "desc" }, { voucherNo: "desc" }],
    });
    // 手工凭证的来源为空（`sourceId` 可空，见 20260924100000_voucher_manual_source）：
    // 只有「来源是收支流水/凭证」的那些行才有 id 可查，所以先滤掉空值再查。
    const entryIds = rows
      .filter((row) => row.sourceType === SOURCE_CASH_FLOW)
      .map((row) => row.sourceId)
      .filter((id): id is string => Boolean(id));
    const entries = entryIds.length
      ? await this.prisma.cashFlowEntry.findMany({ where: { id: { in: [...new Set(entryIds)] } }, select: { id: true, entryNo: true, status: true, direction: true, entryDate: true } })
      : [];
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    return rows.map((row) => ({
      ...row,
      status_label: STATUS_LABELS[row.status] ?? row.status,
      line_count: row.lines.length,
      source_entry: row.sourceType === SOURCE_CASH_FLOW && row.sourceId ? byId.get(row.sourceId) ?? null : null,
    }));
  }

  /** 凭证详情：含分录（含银行账户）、来源流水、（红冲产生的）被红冲凭证。 */
  async get(id: string) {
    const row = await this.prisma.voucher.findFirst({ where: { id, deletedAt: null }, include: { lines: { orderBy: { lineNo: "asc" }, include: { bank: { select: { id: true, bankName: true, accountNumber: true, accountName: true } } } } } });
    if (!row) throw this.notFound("VOUCHER_NOT_FOUND", "凭证不存在");
    // 手工凭证（sourceType = manual）的来源 id 是空的：跳过来源查询，界面上「来源」显示为「-」。
    const sourceEntry = row.sourceType === SOURCE_CASH_FLOW && row.sourceId
      ? await this.prisma.cashFlowEntry.findFirst({ where: { id: row.sourceId }, include: ENTRY_INCLUDE })
      : null;
    const counterpart = row.sourceType === SOURCE_VOUCHER && row.sourceId
      ? await this.prisma.voucher.findFirst({ where: { id: row.sourceId, deletedAt: null }, select: { id: true, voucherNo: true, status: true, summary: true } })
      : null;
    const reversalOf = row.status === "reversed"
      ? await this.prisma.voucher.findFirst({ where: { sourceType: SOURCE_VOUCHER, sourceId: row.id, deletedAt: null }, select: { id: true, voucherNo: true, status: true } })
      : null;
    return { ...row, status_label: STATUS_LABELS[row.status] ?? row.status, source_entry: sourceEntry, counterpart_voucher: counterpart, reversal_voucher: reversalOf };
  }

  /**
   * 由一条收支流水生成凭证（**幂等**：该流水已有凭证就返回原凭证）。
   *
   * 已冲销的流水不生成凭证 —— 钱没真的动过，生成凭证会污染账目。
   * 需要「按现在的流水重算」时用 `regenerate`（草稿才允许）。
   */
  async createFromCashFlowEntry(entryId: string, user: CurrentUser) {
    const entry = await this.prisma.cashFlowEntry.findFirst({ where: { id: entryId, deletedAt: null }, include: ENTRY_INCLUDE });
    if (!entry) throw this.notFound("CASH_FLOW_ENTRY_NOT_FOUND", "收支流水不存在");
    if (entry.status !== "posted") throw this.invalid("CASH_FLOW_ENTRY_NOT_VOUCHERABLE", "已冲销的收支流水不能生成凭证");
    const existing = await this.prisma.voucher.findFirst({ where: { sourceType: SOURCE_CASH_FLOW, sourceId: entry.id, deletedAt: null } });
    if (existing) return { ...(await this.get(existing.id)), replayed: true };  // 幂等命中：同一来源只挂一张账

    const draft = this.draftForEntry(entry);
    const amount = new Prisma.Decimal(entry.amount);
    const period = voucherPeriodFor(entry.entryDate);
    const row = await this.prisma.$transaction(async (tx) => {
      // 凭证号按「记-YYYYMM-####」在**期间内**顺延；并发撞号由 vouchers_voucher_no_key 兜底（唯一索引报错而非静默重号）。
      const siblings = await tx.voucher.findMany({ where: { voucherNo: { startsWith: `记-${period}-` } }, select: { voucherNo: true } });
      const voucherNo = nextSequenceCode(`记-${period}-`, siblings.map((item) => item.voucherNo));
      const created = await tx.voucher.create({
        data: {
          voucherNo, voucherDate: entry.entryDate, period, sourceType: SOURCE_CASH_FLOW, sourceId: entry.id,
          summary: voucherSummaryFor({ counterpartyName: entry.counterpartyName, subjectLabel: entry.subject?.name ?? "未分类", remark: entry.remark }),
          currency: entry.currency, debitTotal: amount, creditTotal: amount, status: "draft",
          ...this.audit.create(user),
        },
      });
      await tx.voucherLine.createMany({ data: draft.lines.map((line) => this.lineData(created.id, line, entry.id, user)) });
      return created;
    });
    await this.audit.record("voucher.create", "voucher", user.id, row.id, { voucher_no: row.voucherNo, source_type: SOURCE_CASH_FLOW, source_id: entry.id, amount: amount.toString(), bank_id: draft.bankId });
    return this.get(row.id);
  }

  /**
   * **手工新增凭证**（财务 2026-09-24：「1、3、4 都要」里的第 ① 件）。
   *
   * 为什么必须有这条路：凭证原先只能由收支流水生成，而折旧、摊销、工资计提、结转成本这些
   * **非现金分录根本没有流水**（钱没动），于是它们在系统里无处可录 —— 三大报表的
   * 「固定资产 / 累计折旧 / 应付职工薪酬 / 库存商品」等行永远填不上（设计文档 §2 的事实②）。
   *
   * 与「由流水生成」的区别只有来源：`source_type = manual`、`source_id = null`
   * （迁移 `20260924100000_voucher_manual_source` 把这一列放宽成可空；为什么不用「编一个随机 id」
   * 见那个迁移的注释）。其余一律同一套：凭证号 `记-YYYYMM-####` 在期间内顺延、借贷必须相等、
   * 科目来自科目表的快照、资金行可引用具体银行账户。
   *
   * 落库状态是**草稿**：与流水生成的凭证一致，财务核对后再过账（过账后不可改，只能红冲）。
   */
  async createManual(input: {
    voucher_date: string;
    currency?: string;
    summary?: string;
    remark?: string;
    lines: VoucherLineInput[];
  }, user: CurrentUser) {
    const voucherDate = this.dateOf(input.voucher_date);
    const currency = (input.currency ?? "CNY").trim().toUpperCase() || "CNY";
    await this.currencies?.assertSupported(currency, "凭证币种");
    const period = voucherPeriodFor(voucherDate);
    return this.createVoucher({
      voucherDate,
      currency,
      // 摘要留空时给一句能认出来的兜底（一张没有摘要的凭证在清单里等于没写）。
      summary: (input.summary ?? "").trim().slice(0, 500) || `手工凭证 ${period}`,
      remark: input.remark ?? null,
      lines: input.lines ?? [],
    }, { sourceType: SOURCE_MANUAL, sourceId: null }, user);
  }

  /**
   * **挂账凭证**（确认应收 / 确认应付那一步；用户 2026-09-24 已确认的口径）。
   *
   * 确认一个应收/应付时，钱还没动，所以这一张凭证**不能**有资金分录：
   *   - 确认应收 → 借 `应收账款` / 贷 收入类科目（默认主营业务收入）；
   *   - 确认应付 → 借 成本/存货类科目 / 贷 `应付账款`。
   * 现金流量表天然看不见它（没有资金分录的凭证本来就不进表），而资产负债表从此有了「应收账款 / 应付账款」。
   *
   * 收支两条线因此各自只记一次：挂账记权责（收入/成本与往来），销账（登记收款/付款）记现金
   * （借银行存款 / 贷应收账款）——「确认即记账」当年把两件事压成一件，等于钱还没到就先记了收款。
   *
   * 幂等靠唯一键 `(source_type, source_id)`：同一条应收被两个入口（逐条 / 批量 / 对账单）先后确认时，
   * 第二个入口拿到的是同一张凭证（`replayed = true`），不会挂两遍账 —— 挂两遍就是收入翻倍。
   */
  async createAccrual(input: {
    source_type: string;
    source_id: string;
    document_no: string;
    voucher_date: string | Date;
    currency?: string;
    amount: string | Prisma.Decimal;
    counterparty_name?: string | null;
    /** 对方科目候选链（收：主营业务收入…；付：主营业务成本…），按优先级取第一个存在的。 */
    contra_subject_names: readonly string[];
    /** 人工指定的对方科目（确认弹窗里选过就传）；给了但不存在显式 422，不静默换一个。 */
    contra_subject_id?: string | null;
    remark?: string;
  }, user: CurrentUser) {
    const accrualSubjectName = ACCRUAL_SUBJECT_NAMES[input.source_type];
    if (!accrualSubjectName) throw this.invalid("ACCRUAL_SOURCE_UNSUPPORTED", `不支持挂账的来源类型：${input.source_type}`);
    const amount = new Prisma.Decimal(input.amount ?? 0);
    // 金额为 0 的应收/应付不挂账（与 `recordConfirmation` 同一处理：0 元往来是噪音，不是账）。
    if (amount.lte(0)) return null;

    const existing = await this.prisma.voucher.findFirst({ where: { sourceType: input.source_type, sourceId: input.source_id, deletedAt: null } });
    if (existing) return { ...(await this.get(existing.id)), replayed: true };  // 幂等命中：同一来源只挂一张账

    const voucherDate = input.voucher_date instanceof Date ? input.voucher_date : this.dateOf(input.voucher_date);
    const currency = (input.currency ?? "CNY").trim().toUpperCase() || "CNY";
    await this.currencies?.assertSupported(currency, "凭证币种");
    const accrual = await this.subjectByName([accrualSubjectName], `挂账需要会计科目「${accrualSubjectName}」，请在「收支管理 → 会计科目」里补上`);
    const contra = input.contra_subject_id
      ? await this.subjectById(input.contra_subject_id, "挂账指定的对方科目不存在或已停用，请在「收支管理 → 会计科目」里确认")
      : await this.subjectByName(input.contra_subject_names, `挂账需要会计科目「${input.contra_subject_names.join("」或「")}」，请在「收支管理 → 会计科目」里补上`);
    const text = amount.toFixed(4);
    const isReceivable = input.source_type === SOURCE_RECEIVABLE;
    const counterparty = (input.counterparty_name ?? "").trim();
    // 返回值统一带上 `replayed`（false = 这次真的挂的账）：调用方要拿它写审计与界面提示，
    // 两条分支的形状必须一样，否则「幂等命中」那一支会在调用处变成 `undefined`。
    const created = await this.createVoucher({
      voucherDate,
      currency,
      summary: `${isReceivable ? "确认应收" : "确认应付"} ${input.document_no}${counterparty ? `（${counterparty}）` : ""} 挂账`,
      remark: input.remark ?? `挂账凭证：${input.document_no}（钱未动；收到/付出时在收付款登记里记现金）`,
      lines: isReceivable
        ? [
            { direction: "debit", subject_key: accrual.key, subject_label: accrual.label, amount: text, summary: `应收 ${input.document_no}` },
            { direction: "credit", subject_key: contra.key, subject_label: contra.label, amount: text },
          ]
        : [
            { direction: "debit", subject_key: contra.key, subject_label: contra.label, amount: text },
            { direction: "credit", subject_key: accrual.key, subject_label: accrual.label, amount: text, summary: `应付 ${input.document_no}` },
          ],
    }, { sourceType: input.source_type, sourceId: input.source_id }, user);
    return { ...created, replayed: false };
  }

  /**
   * 已挂账的来源 id（销账时用来判断「这条应收有没有先挂账」）。
   *
   * 销账那条现金分录的对方科目取决于它：**挂了账的**贷 `应收账款`（收入已经在挂账时记过），
   * **没挂账的**（历史数据、或当年「确认即记账」的那些）仍按老口径贷收入 —— 历史不动，
   * 否则同一笔钱会既记收入又挂在应收上，两边都错。
   */
  async accruedSourceIds(sourceType: string, sourceIds: readonly string[]): Promise<Set<string>> {
    const ids = [...new Set(sourceIds.filter(Boolean))];
    if (!ids.length) return new Set();
    const rows = await this.prisma.voucher.findMany({
      where: { sourceType, sourceId: { in: ids }, deletedAt: null, status: { not: "reversed" } },
      select: { sourceId: true },
    });
    return new Set(rows.map((row) => row.sourceId).filter((id): id is string => Boolean(id)));
  }

  /** 分录的科目必须来自科目表（快照 `分类/名称`）：按名称候选链取第一个存在的。 */
  private async subjectByName(names: readonly string[], message: string) {
    if (!names.length) throw this.invalid("VOUCHER_SUBJECT_REQUIRED", "挂账需要指定对方科目");
    const candidates = await this.prisma.accountingSubject.findMany({
      where: { name: { in: [...names] }, deletedAt: null, isActive: true },
      select: { category: true, name: true },
    });
    const found = names.map((name) => candidates.find((candidate) => candidate.name === name)).find((row): row is { category: string; name: string } => Boolean(row));
    if (!found) throw this.invalid("ACCOUNTING_SUBJECT_NOT_FOUND", message);
    return { key: accountingSubjectKey(found.category, found.name), label: found.name };
  }

  /** 人工选定的科目：不存在/已停用显式 422（挂账凭证的科目不能是凭空编出来的名字）。 */
  private async subjectById(id: string, message: string) {
    const found = await this.prisma.accountingSubject.findFirst({ where: { id, deletedAt: null, isActive: true }, select: { category: true, name: true } });
    if (!found) throw this.invalid("ACCOUNTING_SUBJECT_NOT_FOUND", message);
    return { key: accountingSubjectKey(found.category, found.name), label: found.name };
  }

  /**
   * 真正落库的那一段（手工凭证 / 挂账凭证共用）。
   *
   * 抽出来的理由：两条路只有「来源」和「科目怎么来」不同，其余（分录校验、借贷平衡、期间编号、
   * 银行账户存在性、审计）**必须逐字一致** —— 复制一份就会分叉成「手工凭证查银行、挂账凭证不查」这种
   * 只有出事故时才会发现的差别。
   */
  private async createVoucher(
    input: { voucherDate: Date; currency: string; summary: string; remark?: string | null; lines: VoucherLineInput[] },
    source: { sourceType: string; sourceId: string | null },
    user: CurrentUser,
  ) {
    if (!input.lines?.length) throw this.invalid("VOUCHER_LINE_REQUIRED", "凭证至少需要一条分录");
    const lines = this.normalizeLines(input.lines, input.currency);
    if (lines.length < 2) throw this.invalid("VOUCHER_LINE_REQUIRED", "凭证至少需要一条借方与一条贷方分录");
    await this.assertBanks(lines.map((line) => line.bank_id));
    const totals = { debit: this.sumBy(lines, "debit"), credit: this.sumBy(lines, "credit") };
    if (totals.debit.lte(0)) throw this.invalid("VOUCHER_AMOUNT_REQUIRED", "凭证金额必须大于零");
    if (!totals.debit.eq(totals.credit)) {
      throw this.invalid("VOUCHER_NOT_BALANCED", `借贷不平衡：借方 ${totals.debit.toString()} / 贷方 ${totals.credit.toString()}`);
    }
    const period = voucherPeriodFor(input.voucherDate);
    const row = await this.prisma.$transaction(async (tx) => {
      // 与「由流水生成」同一套编号规则：期间内顺延，唯一索引兜底并发。
      const siblings = await tx.voucher.findMany({ where: { voucherNo: { startsWith: `记-${period}-` } }, select: { voucherNo: true } });
      const voucherNo = nextSequenceCode(`记-${period}-`, siblings.map((item) => item.voucherNo));
      const created = await tx.voucher.create({
        data: {
          voucherNo, voucherDate: input.voucherDate, period, sourceType: source.sourceType, sourceId: source.sourceId,
          summary: input.summary, currency: input.currency, debitTotal: totals.debit, creditTotal: totals.credit, status: "draft",
          remark: (input.remark ?? null) || null,
          ...this.audit.create(user),
        },
      });
      await tx.voucherLine.createMany({ data: lines.map((line) => this.lineData(created.id, line, null, user)) });
      return created;
    });
    await this.audit.record("voucher.create", "voucher", user.id, row.id, {
      voucher_no: row.voucherNo, source_type: source.sourceType, source_id: source.sourceId,
      amount: totals.debit.toString(), line_count: lines.length,
    });
    return this.get(row.id);
  }

  /**
   * **重新生成**草稿凭证：按来源流水**现在的**内容重算整张凭证（摘要/分录/银行账户/金额/期间）。
   *
   * 为什么需要：生成之后流水还可能被改（补银行账户、改收支项目、改金额、改备注），
   * 而生成是幂等的 —— 不重新生成，凭证会一直停在旧口径上（尤其本次新增的「银行存款要带具体账户」，
   * 老凭证必须重算一次才带得上账户）。
   *
   * 边界（都是有意的）：
   *   - **只对草稿开放**：已过账的凭证是账务事实，只能红冲（`VOUCHER_NOT_REGENERABLE`）。
   *   - **只对「来源是收支流水」的凭证开放**：红冲凭证的内容由被红冲的凭证决定，重算没有意义。
   *   - **流水已冲销时拒绝**：钱没真的动过，不能生成/重算凭证（与 `createFromCashFlowEntry` 同一口径）。
   *   - **覆盖手工改动**：重新生成就是「按流水重来」，所以界面上必须先说清楚（见凭证页的确认弹窗）。
   */
  async regenerate(id: string, user: CurrentUser) {
    const current = await this.prisma.voucher.findFirst({ where: { id, deletedAt: null }, include: { lines: { orderBy: { lineNo: "asc" } } } });
    if (!current) throw this.notFound("VOUCHER_NOT_FOUND", "凭证不存在");
    if (current.status !== "draft") throw this.invalid("VOUCHER_NOT_REGENERABLE", "只有草稿凭证可以重新生成；已过账的凭证请先红冲");
    if (current.sourceType !== SOURCE_CASH_FLOW) throw this.invalid("VOUCHER_NOT_REGENERABLE", "红冲凭证不能重新生成（它的内容由被红冲的凭证决定）");
    // 手工凭证不进这条路（sourceId 为空）；这里显式挡住，顺带把类型收窄成 string。
    if (!current.sourceId) throw this.invalid("VOUCHER_NOT_REGENERABLE", "手工凭证没有来源流水，不能重新生成（直接编辑分录即可）");
    const entry = await this.prisma.cashFlowEntry.findFirst({ where: { id: current.sourceId, deletedAt: null }, include: ENTRY_INCLUDE });
    if (!entry) throw this.invalid("VOUCHER_SOURCE_MISSING", "来源收支流水已不存在，无法重新生成");
    if (entry.status !== "posted") throw this.invalid("CASH_FLOW_ENTRY_NOT_VOUCHERABLE", "来源收支流水已冲销，不能重新生成凭证");

    const draft = this.draftForEntry(entry);
    const amount = new Prisma.Decimal(entry.amount);
    const period = voucherPeriodFor(entry.entryDate);
    const summary = voucherSummaryFor({ counterpartyName: entry.counterpartyName, subjectLabel: entry.subject?.name ?? "未分类", remark: entry.remark });
    const row = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM vouchers WHERE id = ${id}::uuid FOR UPDATE`;
      const locked = await tx.voucher.findFirst({ where: { id, deletedAt: null } });
      if (!locked || locked.status !== "draft") throw this.invalid("VOUCHER_NOT_REGENERABLE", "凭证已被其他操作处理");
      await tx.voucherLine.deleteMany({ where: { voucherId: id } });
      await tx.voucherLine.createMany({ data: draft.lines.map((line) => this.lineData(id, line, entry.id, user)) });
      return tx.voucher.update({
        where: { id },
        data: { voucherDate: entry.entryDate, period, summary, currency: entry.currency, debitTotal: amount, creditTotal: amount, ...this.audit.update(user) },
      });
    });
    await this.audit.record("voucher.regenerate", "voucher", user.id, id, {
      voucher_no: row.voucherNo,
      source_id: entry.id,
      before: { summary: current.summary, debit_total: current.debitTotal.toString(), subjects: current.lines.map((line) => line.subjectLabel) },
      after: { summary: row.summary, debit_total: row.debitTotal.toString(), subjects: draft.lines.map((line) => line.subject_label) },
    });
    return { ...(await this.get(id)), regenerated: true };
  }

  /**
   * 记账凭证模板（财务 2026-09-20：「工资是这样的，但是现在都不能改」「原材料的也是要加上应交税费」）。
   *
   * 返回的是**已经落到本凭证上**的模板：科目从科目表解析（候选全落空时给建议名 + `subject_id: null`，
   * 见 `voucher-template.ts`），资金行带上本凭证现有的科目与银行账户。
   *
   * 为什么挂在凭证上而不是做一个全局清单接口：资金行要认这张凭证的账户；而且模板只有
   * 「编辑这张草稿」这一个使用场景，脱离凭证的清单没有意义。
   */
  async templates(id: string): Promise<Array<{ key: string; name: string; description: string; lines: VoucherTemplateLineResponse[] }>> {
    const current = await this.prisma.voucher.findFirst({
      where: { id, deletedAt: null },
      include: { lines: { orderBy: { lineNo: "asc" }, include: { bank: { select: { id: true, bankName: true, accountNumber: true } } } } },
    });
    if (!current) throw this.notFound("VOUCHER_NOT_FOUND", "凭证不存在");
    // 含已停用科目：停用科目仍「存在」，历史凭证上就是它；解析候选时优先启用中的（见 resolveTemplateSubject）。
    const subjects = await this.prisma.accountingSubject.findMany({ where: { deletedAt: null }, select: { id: true, category: true, name: true, isActive: true } });
    // 本凭证的资金行 = 引用了银行账户的那条；老凭证可能没有账户（历史数据），退化成「科目名是银行存款/库存现金」的那条。
    const fund = current.lines.find((line) => line.bankId !== null)
      ?? current.lines.find((line) => line.subjectLabel.startsWith("银行存款") || line.subjectLabel.startsWith("库存现金"))
      ?? null;
    const fundSubject = fund ? subjects.find((subject) => accountingSubjectKey(subject.category, subject.name) === fund.subjectKey) ?? null : null;
    return VOUCHER_TEMPLATES.map((template) => ({
      key: template.key,
      name: template.name,
      description: template.description,
      lines: resolveVoucherTemplate(template, subjects).map((line) => line.role === "fund" && fund
        ? {
            ...line,
            // 原资金行的科目优先于模板候选：它就是这张凭证现在用的科目（可能是「银行存款—农业银行5706」这种带账户的快照）。
            subject_id: fundSubject?.id ?? null,
            subject_key: fund.subjectKey,
            subject_label: fund.subjectLabel,
            bank_id: fund.bankId,
            bank_label: bankAccountLabel(fund.bank),
          }
        : { ...line, bank_id: null, bank_label: null }),
    }));
  }

  /**
   * 由一条收支流水算出「草稿内容」（新建与重新生成两处共用，避免两条路径算出不同口径）。
   */
  private draftForEntry(entry: { entryNo: string; entryDate: Date; counterpartyName: string; direction: string; amount: Prisma.Decimal; currency: string; settlementMethod: string | null; remark: string | null; subject: { category: string; name: string } | null; settlementAccount: { label: string } | null; bank: { id: string; bankName: string; accountNumber: string } | null }) {
    const bankLabel = bankAccountLabel(entry.bank);
    const lines = voucherLinesFor({
      entryNo: entry.entryNo,
      entryDate: entry.entryDate,
      counterpartyName: entry.counterpartyName,
      direction: entry.direction,
      amount: entry.amount,
      currency: entry.currency,
      // 科目编码用「分类/项目」（科目表没有唯一编码，两段拼起来才唯一）；
      // 科目名快照用科目名称本身，打印出来的凭证与财务那张科目表逐字对得上。
      subjectKey: entry.subject ? accountingSubjectKey(entry.subject.category, entry.subject.name) : "未分类",
      subjectLabel: entry.subject?.name ?? "未分类",
      settlementMethod: entry.settlementMethod,
      settlementAccountLabel: entry.settlementAccount?.label ?? null,
      remark: entry.remark,
      bankId: entry.bank?.id ?? null,
      bankLabel,
    });
    const fund = fundLineFor({ bankId: entry.bank?.id ?? null, bankLabel, settlementMethod: entry.settlementMethod, settlementAccountLabel: entry.settlementAccount?.label ?? null });
    return { lines, bankId: fund.bank_id };
  }

  /**
   * 编辑草稿凭证：摘要、备注，或整组分录。
   *
   * 允许改分录是刻意的：科目取自正式科目表，但**一张凭证的分录结构**（一借一贷 / 一借多贷 /
   * 多借多贷）由业务决定 —— 工资计提是「借应付职工薪酬，贷其他应付款 + 应交税费 + 银行存款」，
   * 原材料采购是「借原材料 + 应交税费，贷应付账款」，都不是两行能表达的（财务 2026-09-20 要求）。
   * 改完必须重新平衡（借=贷），否则 422。
   *
   * 分录可以逐行引用银行账户（`bank_id`）：手工改分录时行号会变，靠「按行号沿用原账户」
   * 会让账户引用落到别的行上；显式带上才是可靠的（省略时仍然按行号沿用，兼容旧调用方）。
   */
  async update(id: string, input: { summary?: string; remark?: string; lines?: VoucherLineInput[] }, user: CurrentUser) {
    const current = await this.prisma.voucher.findFirst({ where: { id, deletedAt: null }, include: { lines: { orderBy: { lineNo: "asc" } } } });
    if (!current) throw this.notFound("VOUCHER_NOT_FOUND", "凭证不存在");
    if (current.status !== "draft") throw this.invalid("VOUCHER_NOT_EDITABLE", "只有草稿凭证可以编辑；已过账的凭证请用红冲");
    const lines = input.lines ? this.normalizeLines(input.lines, current.currency) : null;
    if (lines) await this.assertBanks(lines.map((line) => line.bank_id));
    const totals = lines
      ? { debit: this.sumBy(lines, "debit"), credit: this.sumBy(lines, "credit") }
      : { debit: new Prisma.Decimal(current.debitTotal), credit: new Prisma.Decimal(current.creditTotal) };
    if (totals.debit.lte(0)) throw this.invalid("VOUCHER_AMOUNT_REQUIRED", "凭证金额必须大于零");
    if (!totals.debit.eq(totals.credit)) throw this.invalid("VOUCHER_NOT_BALANCED", `借贷不平衡：借方 ${totals.debit.toString()} / 贷方 ${totals.credit.toString()}`);

    const row = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM vouchers WHERE id = ${id}::uuid FOR UPDATE`;
      const locked = await tx.voucher.findFirst({ where: { id, deletedAt: null } });
      if (!locked || locked.status !== "draft") throw this.invalid("VOUCHER_NOT_EDITABLE", "凭证已被其他操作处理");
      if (lines) {
        // 银行账户引用：**显式给了就照它**（`null` 也算给了 —— 表示这一行不该挂账户），
        // 只在**完全没传** `bank_id` 时才按行号沿用原分录。这个区分是必须的：
        // 分录编辑器会在每行都带上 `bank_id`（业务行是 null），如果 null 也触发「按行号沿用」，
        // 那么在资金行前面插入一行之后，那张卡就会被挂到新插入的业务行上 ——
        // 银行存款明细账从此对不上银行对账单，而凭证上完全看不出来。
        const bankByLineNo = new Map(current.lines.map((line) => [line.lineNo, line.bankId]));
        await tx.voucherLine.deleteMany({ where: { voucherId: id } });
        await tx.voucherLine.createMany({ data: lines.map((line) => this.lineData(id, { ...line, bank_id: line.bank_id !== undefined ? line.bank_id : bankByLineNo.get(line.line_no) ?? null }, line.cash_flow_entry_id ?? null, user)) });
      }
      return tx.voucher.update({
        where: { id },
        data: { summary: input.summary?.trim() || locked.summary, remark: input.remark ?? locked.remark, debitTotal: totals.debit, creditTotal: totals.credit, ...this.audit.update(user) },
      });
    });
    await this.audit.record("voucher.update", "voucher", user.id, id, { voucher_no: row.voucherNo, line_edited: Boolean(lines) });
    return this.get(id);
  }

  /** 过账：草稿 → 已过账（此后不可改，只能红冲）。再次校验借贷平衡。 */
  async post(id: string, user: CurrentUser) {
    const row = await this.get(id);
    if (row.status !== "draft") throw this.invalid("VOUCHER_NOT_POSTABLE", "只有草稿凭证可以过账");
    const balance = voucherBalance(row.lines.map((line) => ({ direction: line.direction, amount: line.amount })));
    if (!balance.balanced) throw this.invalid("VOUCHER_NOT_BALANCED", "借贷不平衡，不能过账");
    const posted = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM vouchers WHERE id = ${id}::uuid FOR UPDATE`;
      const locked = await tx.voucher.findFirst({ where: { id, deletedAt: null } });
      if (!locked || locked.status !== "draft") throw this.invalid("VOUCHER_NOT_POSTABLE", "凭证已被其他操作处理");
      return tx.voucher.update({ where: { id }, data: { status: "posted", ...this.audit.update(user) } });
    });
    await this.audit.record("voucher.post", "voucher", user.id, id, { voucher_no: posted.voucherNo });
    return posted;
  }

  /** 删除：仅草稿（软删除，保留审计）。已过账的凭证不能消失。 */
  async remove(id: string, user: CurrentUser) {
    const current = await this.prisma.voucher.findFirst({ where: { id, deletedAt: null } });
    if (!current) throw this.notFound("VOUCHER_NOT_FOUND", "凭证不存在");
    if (current.status !== "draft") throw this.invalid("VOUCHER_NOT_DELETABLE", "只有草稿凭证可以删除；已过账的凭证请用红冲");
    const row = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM vouchers WHERE id = ${id}::uuid FOR UPDATE`;
      const locked = await tx.voucher.findFirst({ where: { id, deletedAt: null } });
      if (!locked || locked.status !== "draft") throw this.invalid("VOUCHER_NOT_DELETABLE", "凭证已被其他操作处理");
      return tx.voucher.update({ where: { id }, data: { ...this.audit.softDelete(user) } });
    });
    await this.audit.record("voucher.delete", "voucher", user.id, id, { voucher_no: row.voucherNo });
    return row;
  }

  /**
   * 红冲：把已过账凭证的借/贷对调，另开一张红字凭证，原凭证标为 reversed。
   *
   * 为什么不删原凭证：已过账的凭证是账务事实，删除会让账目无法追溯。红字凭证在同一事务里
   * **直接过账**（否则会出现「原凭证已红冲、但对冲凭证还没过账」的空档，账目不自洽）。
   */
  async reverse(id: string, reason: string, user: CurrentUser) {
    if (!reason?.trim()) throw this.invalid("REVERSAL_REASON_REQUIRED", "红冲必须填写原因");
    const current = await this.get(id);
    if (current.status !== "posted") throw this.invalid("VOUCHER_NOT_REVERSIBLE", "只有已过账的凭证可以红冲");
    const red = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM vouchers WHERE id = ${id}::uuid FOR UPDATE`;
      const locked = await tx.voucher.findFirst({ where: { id, deletedAt: null }, include: { lines: { orderBy: { lineNo: "asc" } } } });
      if (!locked || locked.status !== "posted") throw this.invalid("VOUCHER_NOT_REVERSIBLE", "凭证已被其他操作处理");
      const period = locked.period;
      const siblings = await tx.voucher.findMany({ where: { voucherNo: { startsWith: `记-${period}-` } }, select: { voucherNo: true } });
      const lines = reverseLines(locked.lines.map((line) => ({ direction: line.direction, subject_key: line.subjectKey, subject_label: line.subjectLabel, summary: line.summary, amount: line.amount, currency: line.currency, bank_id: line.bankId })));
      const created = await tx.voucher.create({
        data: {
          voucherNo: nextSequenceCode(`记-${period}-`, siblings.map((item) => item.voucherNo)),
          voucherDate: new Date(), period, sourceType: SOURCE_VOUCHER, sourceId: locked.id,
          summary: `红冲 ${locked.voucherNo}：${reason.trim()}`.slice(0, 500),
          currency: locked.currency, debitTotal: locked.creditTotal, creditTotal: locked.debitTotal, status: "posted",
          remark: reason.trim(),
          ...this.audit.create(user),
        },
      });
      await tx.voucherLine.createMany({ data: lines.map((line) => this.lineData(created.id, line, null, user)) });
      await tx.voucher.update({ where: { id }, data: { status: "reversed", ...this.audit.update(user) } });
      return created;
    });
    await this.audit.record("voucher.reverse", "voucher", user.id, id, { voucher_no: current.voucherNo, red_voucher_no: red.voucherNo, reason: reason.trim() });
    return this.get(red.id);
  }

  /** 分录落库形状（新建、编辑、重新生成、红冲四处共用，避免字段漂移）。 */
  private lineData(voucherId: string, line: VoucherLineDraft & { cash_flow_entry_id?: string | null }, entryId: string | null, user: CurrentUser) {
    return {
      voucherId, lineNo: line.line_no, direction: line.direction,
      subjectKey: line.subject_key, subjectLabel: line.subject_label, summary: line.summary,
      amount: new Prisma.Decimal(line.amount), currency: line.currency,
      cashFlowEntryId: line.cash_flow_entry_id ?? entryId,
      bankId: line.bank_id ?? null,
      ...this.audit.create(user),
    };
  }

  /** 编辑进来的分录：校验方向/金额/科目，并重排 line_no（顺序即借贷行的先后）。 */
  private normalizeLines(input: VoucherLineInput[], currency: string): Array<VoucherLineDraft & { cash_flow_entry_id: null }> {
    if (!input.length) throw this.invalid("VOUCHER_LINE_REQUIRED", "凭证至少需要一条分录");
    return input.map((line, index) => {
      if (!["debit", "credit"].includes(line.direction)) throw this.invalid("INVALID_VOUCHER_DIRECTION", "分录方向只能是借或贷");
      const label = (line.subject_label ?? line.subject_key ?? "").trim();
      if (!label) throw this.invalid("VOUCHER_SUBJECT_REQUIRED", "每条分录都必须填科目");
      let amount: Prisma.Decimal;
      try {
        amount = new Prisma.Decimal(line.amount);
        if (amount.lte(0)) throw new Error();
      } catch {
        throw this.invalid("INVALID_VOUCHER_AMOUNT", "分录金额必须是大于零的十进制数");
      }
      return {
        line_no: index + 1,
        direction: line.direction as "debit" | "credit",
        subject_key: (line.subject_key ?? label).trim(),
        subject_label: label,
        summary: (line.summary ?? "").slice(0, 500),
        amount: amount.toFixed(4),
        currency,
        // **保留 undefined**（不折叠成 null）：`update` 靠「undefined = 没传」来决定要不要按行号沿用
        // 原分录的银行账户。折叠成 null 会让这个区分消失（见 update 里的说明）。
        bank_id: line.bank_id,
        cash_flow_entry_id: null,
      };
    });
  }

  /**
   * 校验分录引用的银行账户。
   *
   * 为什么要单独查一遍：`voucher_lines.bank_id` 是指向 `banks` 的外键，前端传来一个不存在（或已删除）
   * 的 id 会让事务在提交时抛一个外键冲突 —— 用户看到的是一句数据库错误，而不是「这个账户不存在」。
   */
  private async assertBanks(bankIds: Array<string | null | undefined>): Promise<void> {
    const ids = [...new Set(bankIds.filter((id): id is string => Boolean(id)))];
    if (!ids.length) return;
    const found = await this.prisma.bank.findMany({ where: { id: { in: ids }, deletedAt: null }, select: { id: true } });
    const known = new Set(found.map((row) => row.id));
    const missing = ids.filter((id) => !known.has(id));
    if (missing.length) throw this.invalid("VOUCHER_BANK_NOT_FOUND", `分录引用的银行账户不存在或已删除：${missing.join("、")}`);
  }

  /** `YYYY-MM-DD` → UTC 零点（与 `@db.Date` 列的比较口径一致）；非法直接 422。 */
  private dateOf(value: string): Date {
    const text = (value ?? "").slice(0, 10);
    const date = new Date(`${text}T00:00:00.000Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(date.valueOf())) {
      throw this.invalid("INVALID_VOUCHER_DATE", "凭证日期无效（应为 YYYY-MM-DD）");
    }
    return date;
  }

  private sumBy(lines: Array<{ direction: string; amount: string }>, direction: string) {
    return lines.filter((line) => line.direction === direction).reduce((sum, line) => sum.plus(new Prisma.Decimal(line.amount)), new Prisma.Decimal(0));
  }

  private invalid(code: string, message: string) { return new UnprocessableEntityException({ code, message, details: [] }); }
  private notFound(code: string, message: string) { return new NotFoundException({ code, message, details: [] }); }
}
