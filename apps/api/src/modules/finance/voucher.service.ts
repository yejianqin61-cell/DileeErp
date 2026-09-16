import { Injectable, NotFoundException, UnprocessableEntityException, Optional } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { AuditService } from "../../platform/audit/audit.service";
import type { CurrentUser } from "../../platform/auth/auth.service";
import { CurrencyService } from "../../platform/currency/currency.service";
import { nextSequenceCode } from "../../platform/database/daily-sequence-code";
import { PrismaService } from "../../platform/database/prisma.service";
import { fundLineFor, reverseLines, voucherBalance, voucherLinesFor, voucherPeriodFor, voucherSummaryFor, type VoucherLineDraft } from "./voucher.domain";

/** 来源类型：收支流水；红冲凭证的来源是「被红冲的那张凭证」。 */
const SOURCE_CASH_FLOW = "cash_flow_entry";
const SOURCE_VOUCHER = "voucher";

const ENTRY_INCLUDE = {
  item: { select: { id: true, key: true, label: true } },
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

export type VoucherLineInput = { direction: string; subject_key?: string; subject_label?: string; summary?: string; amount: string };

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
    const entryIds = rows.filter((row) => row.sourceType === SOURCE_CASH_FLOW).map((row) => row.sourceId);
    const entries = entryIds.length
      ? await this.prisma.cashFlowEntry.findMany({ where: { id: { in: [...new Set(entryIds)] } }, select: { id: true, entryNo: true, status: true, direction: true, entryDate: true } })
      : [];
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    return rows.map((row) => ({
      ...row,
      status_label: STATUS_LABELS[row.status] ?? row.status,
      line_count: row.lines.length,
      source_entry: row.sourceType === SOURCE_CASH_FLOW ? byId.get(row.sourceId) ?? null : null,
    }));
  }

  /** 凭证详情：含分录（含银行账户）、来源流水、（红冲产生的）被红冲凭证。 */
  async get(id: string) {
    const row = await this.prisma.voucher.findFirst({ where: { id, deletedAt: null }, include: { lines: { orderBy: { lineNo: "asc" }, include: { bank: { select: { id: true, bankName: true, accountNumber: true, accountName: true } } } } } });
    if (!row) throw this.notFound("VOUCHER_NOT_FOUND", "凭证不存在");
    const sourceEntry = row.sourceType === SOURCE_CASH_FLOW
      ? await this.prisma.cashFlowEntry.findFirst({ where: { id: row.sourceId }, include: ENTRY_INCLUDE })
      : null;
    const counterpart = row.sourceType === SOURCE_VOUCHER
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
    if (existing) return { ...(await this.get(existing.id)), replayed: true };

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
          summary: voucherSummaryFor({ counterpartyName: entry.counterpartyName, itemLabel: entry.item?.label ?? "未分类", remark: entry.remark }),
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
    const entry = await this.prisma.cashFlowEntry.findFirst({ where: { id: current.sourceId, deletedAt: null }, include: ENTRY_INCLUDE });
    if (!entry) throw this.invalid("VOUCHER_SOURCE_MISSING", "来源收支流水已不存在，无法重新生成");
    if (entry.status !== "posted") throw this.invalid("CASH_FLOW_ENTRY_NOT_VOUCHERABLE", "来源收支流水已冲销，不能重新生成凭证");

    const draft = this.draftForEntry(entry);
    const amount = new Prisma.Decimal(entry.amount);
    const period = voucherPeriodFor(entry.entryDate);
    const summary = voucherSummaryFor({ counterpartyName: entry.counterpartyName, itemLabel: entry.item?.label ?? "未分类", remark: entry.remark });
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

  /** 由一条收支流水算出「草稿内容」（新建与重新生成两处共用，避免两条路径算出不同口径）。 */
  private draftForEntry(entry: { entryNo: string; entryDate: Date; counterpartyName: string; direction: string; amount: Prisma.Decimal; currency: string; settlementMethod: string | null; remark: string | null; item: { key: string; label: string } | null; settlementAccount: { label: string } | null; bank: { id: string; bankName: string; accountNumber: string } | null }) {
    const bankLabel = bankAccountLabel(entry.bank);
    const lines = voucherLinesFor({
      entryNo: entry.entryNo,
      entryDate: entry.entryDate,
      counterpartyName: entry.counterpartyName,
      direction: entry.direction,
      amount: entry.amount,
      currency: entry.currency,
      itemKey: entry.item?.key ?? "未分类",
      itemLabel: entry.item?.label ?? "未分类",
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
   * 允许改分录是刻意的：科目当前取自收支项目字典（不是正式科目表），财务需要能手工把科目改成
   * 自己账套里的名字。改完必须重新平衡（借=贷），否则 422。
   */
  async update(id: string, input: { summary?: string; remark?: string; lines?: VoucherLineInput[] }, user: CurrentUser) {
    const current = await this.prisma.voucher.findFirst({ where: { id, deletedAt: null }, include: { lines: { orderBy: { lineNo: "asc" } } } });
    if (!current) throw this.notFound("VOUCHER_NOT_FOUND", "凭证不存在");
    if (current.status !== "draft") throw this.invalid("VOUCHER_NOT_EDITABLE", "只有草稿凭证可以编辑；已过账的凭证请用红冲");
    const lines = input.lines ? this.normalizeLines(input.lines, current.currency) : null;
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
        // 银行账户引用按行号沿用原分录：手工编辑只改科目/金额，不该把「这笔钱在哪张卡上」丢掉
        // （丢了之后银行存款明细账就对不上银行对账单了）。
        const bankByLineNo = new Map(current.lines.map((line) => [line.lineNo, line.bankId]));
        await tx.voucherLine.deleteMany({ where: { voucherId: id } });
        await tx.voucherLine.createMany({ data: lines.map((line) => this.lineData(id, { ...line, bank_id: line.bank_id ?? bankByLineNo.get(line.line_no) ?? null }, line.cash_flow_entry_id ?? null, user)) });
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
        cash_flow_entry_id: null,
      };
    });
  }

  private sumBy(lines: Array<{ direction: string; amount: string }>, direction: string) {
    return lines.filter((line) => line.direction === direction).reduce((sum, line) => sum.plus(new Prisma.Decimal(line.amount)), new Prisma.Decimal(0));
  }

  private invalid(code: string, message: string) { return new UnprocessableEntityException({ code, message, details: [] }); }
  private notFound(code: string, message: string) { return new NotFoundException({ code, message, details: [] }); }
}
