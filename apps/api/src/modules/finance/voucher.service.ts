import { Injectable, NotFoundException, UnprocessableEntityException, Optional } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { AuditService } from "../../platform/audit/audit.service";
import type { CurrentUser } from "../../platform/auth/auth.service";
import { CurrencyService } from "../../platform/currency/currency.service";
import { nextSequenceCode } from "../../platform/database/daily-sequence-code";
import { PrismaService } from "../../platform/database/prisma.service";
import { accountingSubjectKey, INPUT_TAX_SUBJECT_NAMES, PAYABLE_CONFIRM_SUBJECT_NAMES, paymentSubjectNames } from "./accounting-subject-catalog";
import { FUND_SUBJECT_BANK, FUND_SUBJECT_CASH, fundLineFor, isCashFamilySubject, reverseLines, voucherBalance, voucherLinesFor, voucherPeriodFor, voucherSummaryFor, type VoucherLineDraft } from "./voucher.domain";
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

/**
 * 挂账结果（`createAccrual` 的统一返回形状）。
 *
 * 只给调用方三件事：凭证 id、幂等命中与否、生成后的状态。
 * 需要完整详情（分录/摘要/借贷合计）时由调用方自行 `get(id)` —— 事务内挂账不能回读根连接，
 * 统一形状才能让「事务内」与「事务外」两条路径都类型安全。
 */
export type AccrualResult = { id: string; voucherNo: string; status: string; replayed: boolean };

const ENTRY_INCLUDE = {
  // 会计科目：凭证的业务分录科目直接取它（分类 = 科目类别，项目 = 科目名称），
  // 这就是 voucher.domain.ts 顶部预留的「接入正式科目表」——2026-09-17 已接入。
  subject: { select: { id: true, category: true, name: true } },
  /**
   * 收支类目（业务科目，2026-10-13）：它回答「这笔钱算什么」，与 `subject`（销账那条现金分录的
   * 对方科目、生成凭证要用它）是两回事。2026-11-09 R3-1 起它落进凭证行的 `business_subject_id`
   * （辅助维度），只用于展示/辅助核算，**不决定借贷方向**。
   */
  categorySubject: { select: { id: true, category: true, name: true } },
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

/**
 * `draftForEntry` 的入参（一条收支流水里生成凭证要用的那些字段），也是「资金搬运凭证纠正」里
 * 重新计算分录的入参 —— 两处用同一个形状，就不会出现「纠正出来的凭证和重新生成出来的不一样」。
 */
type CashFlowEntryForDraft = {
  entryNo: string;
  entryDate: Date;
  counterpartyName: string;
  direction: string;
  amount: Prisma.Decimal;
  currency: string;
  settlementMethod: string | null;
  remark: string | null;
  subject: { id: string; category: string; name: string } | null;
  /** 收支类目（业务科目）：只作凭证的 `business_subject_id` 辅助维度，不参与记账（R3-1）。 */
  categorySubject?: { id: string; category: string; name: string } | null;
  settlementAccount: { label: string } | null;
  bank: { id: string; bankName: string; accountNumber: string } | null;
};

/** 「资金搬运凭证纠正」的取数结果（预览与执行读的是同一份）。 */
type CashTransferRepairTargets = {
  accruals: Array<{ id: string; voucherNo: string; status: string; payableNo: string }>;
  flows: Array<{
    id: string;
    entryNo: string;
    subjectId: string;
    subjectCategory: string;
    subjectLabel: string;
    entry: CashFlowEntryForDraft;
    voucher: { id: string; voucherNo: string; status: string; sourceId: string | null } | null;
    payableNos: string[];
  }>;
  /** 不能整体改的流水（混着非资金搬运的应付）：如实点名，不硬改。 */
  skipped: Array<{ entry_no: string; reason: string }>;
  payableCount: number;
};

/** 纠正清单的条数汇总（预览与执行结果同形）。 */
function repairSummary(targets: CashTransferRepairTargets) {
  const vouchers = targets.flows.map((flow) => flow.voucher).filter((voucher): voucher is NonNullable<typeof voucher> => Boolean(voucher));
  return {
    payables: targets.payableCount,
    accruals: targets.accruals.length,
    accruals_draft: targets.accruals.filter((accrual) => accrual.status === "draft").length,
    accruals_posted: targets.accruals.filter((accrual) => accrual.status === "posted").length,
    flows: targets.flows.length,
    flows_without_voucher: targets.flows.length - vouchers.length,
    vouchers_draft: vouchers.filter((voucher) => voucher.status === "draft").length,
    vouchers_posted: vouchers.filter((voucher) => voucher.status === "posted").length,
    vouchers_reversed: vouchers.filter((voucher) => voucher.status === "reversed").length,
    skipped: targets.skipped,
  };
}


export type VoucherLineInput = {
  direction: string;
  subject_key?: string;
  subject_label?: string;
  summary?: string;
  amount: string;
  bank_id?: string | null;
  /**
   * 记账科目 id（2026-11-09 R3-1）：调用方已经知道科目 id 时直接给（如红冲沿用原行、模板命中）；
   * 不给（`undefined`）时由 `withLineSubjects` 按科目名解析成**唯一**启用科目；显式 `null` = 已知无科目。
   */
  subject_id?: string | null;
  /**
   * 业务科目（辅助维度）id：只有「业务分录行」需要（挂账的对方科目行 / 流水凭证的业务科目行）。
   * 落库时补上名称快照，并校验该科目存在且启用；解析不到就两列都留空（不猜）。
   */
  business_subject_id?: string | null;
};

/** 解析完科目 id 的分录行形状（落库前统一形状，`lineData` 只认它）。 */
type LineWithSubjectRefs = VoucherLineDraft & {
  cash_flow_entry_id?: string | null;
  subject_id?: string | null;
  business_subject_id?: string | null;
  business_subject_label?: string | null;
};

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
    // ⚠️ 这里的两个查询是**红冲历史语义**，故意不用 `activeVoucherOf`（那个排除 reversed）：
    //   - counterpart：红字凭证要能打开「被红冲的那张原凭证」（原凭证此时正是 reversed）；
    //   - reversalOf：原凭证要能显示「它的红字凭证是哪张」（红字凭证是 posted，但来源是原凭证）。
    // 两者都按 `deletedAt: null` 看，因为被软删的红字（资金搬运纠正撤掉的那张）不应该出现在界面上。
    const counterpart = row.sourceType === SOURCE_VOUCHER && row.sourceId
      ? await this.prisma.voucher.findFirst({ where: { id: row.sourceId, deletedAt: null }, select: { id: true, voucherNo: true, status: true, summary: true } })
      : null;
    const reversalOf = row.status === "reversed"
      ? await this.prisma.voucher.findFirst({ where: { sourceType: SOURCE_VOUCHER, sourceId: row.id, deletedAt: null }, select: { id: true, voucherNo: true, status: true } })
      : null;
    return { ...row, status_label: STATUS_LABELS[row.status] ?? row.status, source_entry: sourceEntry, counterpart_voucher: counterpart, reversal_voucher: reversalOf };
  }

  /**
   * 由一条收支流水生成凭证（**幂等**：该流水已有**有效**凭证就返回原凭证）。
   *
   * 已冲销的流水不生成凭证 —— 钱没真的动过，生成凭证会污染账目。
   * 需要「按现在的流水重算」时用 `regenerate`（草稿才允许）。
   *
   * 2026-11-09 R3-4：幂等只对「有效凭证」成立（`activeVoucherOf`：未删 + 未红冲）。
   * 这张凭证被红冲后，同一流水**可以再生成一张新的**（部分唯一索引已允许），
   * 否则一次红冲就把这条流水永久卡死（旧实现会回放那张已红冲的凭证）。
   *
   * 2026-11-09 R3-7（契约 F）：由流水自动生成的凭证**生成即 `posted`**（与 D2「确认即过账」同一口径）。
   * 只改这条自动生成入口——手工凭证（`createManual`）仍落草稿，由人核对后过账。
   * 幂等命中一张**存量草稿**（R3-7 之前生成的历史凭证）时原样返回，**不自动过账**：
   * 存量草稿由 R3-8 盘点清单人工处理。
   */
  async createFromCashFlowEntry(entryId: string, user: CurrentUser) {
    const entry = await this.prisma.cashFlowEntry.findFirst({ where: { id: entryId, deletedAt: null }, include: ENTRY_INCLUDE });
    if (!entry) throw this.notFound("CASH_FLOW_ENTRY_NOT_FOUND", "收支流水不存在");
    if (entry.status !== "posted") throw this.invalid("CASH_FLOW_ENTRY_NOT_VOUCHERABLE", "已冲销的收支流水不能生成凭证");
    const existing = await this.activeVoucherOf(SOURCE_CASH_FLOW, entry.id);
    if (existing) return { ...(await this.get(existing.id)), replayed: true };  // 幂等命中：同一来源只有一张有效凭证（存量草稿原样返回，不自动过账）

    const draft = await this.draftForEntry(entry);
    const amount = new Prisma.Decimal(entry.amount);
    const period = voucherPeriodFor(entry.entryDate);
    const row = await this.prisma.$transaction(async (tx) => {
      // 凭证号按「记-YYYYMM-####」在**期间内**顺延；并发撞号由 vouchers_voucher_no_key 兜底（唯一索引报错而非静默重号）。
      const siblings = await tx.voucher.findMany({ where: { voucherNo: { startsWith: `记-${period}-` } }, select: { voucherNo: true } });
      const voucherNo = nextSequenceCode(`记-${period}-`, siblings.map((item) => item.voucherNo));
      return this.createOrReviveVoucher(tx, { sourceType: SOURCE_CASH_FLOW, sourceId: entry.id }, {
        // R3-7：自动凭证生成即过账（显式传 posted；不改 createVoucher 的默认值，手工凭证仍是 draft）。
        voucherNo, voucherDate: entry.entryDate, period, status: "posted",
        summary: voucherSummaryFor({ counterpartyName: entry.counterpartyName, subjectLabel: entry.subject?.name ?? "未分类", remark: entry.remark }),
        currency: entry.currency, debitTotal: amount, creditTotal: amount,
      }, draft.lines, entry.id, user);
    });
    await this.audit.record("voucher.create", "voucher", user.id, row.id, { voucher_no: row.voucherNo, source_type: SOURCE_CASH_FLOW, source_id: entry.id, amount: amount.toString(), bank_id: draft.bankId, revived: row.revived, status: "posted" });
    // 自动过账补一条 post 审计（与 createVoucher 的 confirm_post 同一可追溯口径）：
    // 「这张从来没在草稿态被人动过」必须能从审计里看出来。
    await this.audit.record("voucher.post", "voucher", user.id, row.id, { voucher_no: row.voucherNo, auto: true, reason: "cash_flow_auto_post" });
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
    const created = await this.createVoucher({
      voucherDate,
      currency,
      // 摘要留空时给一句能认出来的兜底（一张没有摘要的凭证在清单里等于没写）。
      summary: (input.summary ?? "").trim().slice(0, 500) || `手工凭证 ${period}`,
      remark: input.remark ?? null,
      lines: input.lines ?? [],
    }, { sourceType: SOURCE_MANUAL, sourceId: null }, user);
    // 手工凭证走「事务外生成」，这里回读完整详情（分录/借贷合计）返回给调用方。
    return this.get(created.id);
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
    /** 对方科目候选链（收：主营业务收入…；付：原材料 / 主营业务成本…），按优先级取第一个存在的。 */
    contra_subject_names: readonly string[];
    /** 人工指定的对方科目（确认弹窗里选过就传）；给了但不存在显式 422，不静默换一个。 */
    contra_subject_id?: string | null;
    /**
     * 发票类型（2026-11-09 用户拍板 D5）：`special`=增值税专用发票（可抵扣，挂账时拆进项税）/
     * `general`=增值税普通发票 / `none`=无票 / `null`=未录。
     *
     * 只有 `special` 且税率 > 0 才拆；普票/无票/未录**一律不拆**（全额进业务科目）。
     * 「该不该拆」由发票类型判定，不靠猜税率 —— 这正是旧口径（模板金额一律留空、不自动拆税）被取代的原因。
     * 应收侧本轮**不拆销项税**（用户只拍进项），传了也忽略。
     */
    invoice_type?: string | null;
    /**
     * 价内税率（专票必填，> 0）：`不含税 = 含税 ÷ (1 + r)`。
     *
     * 接受字符串或 `Prisma.Decimal` —— 调用方从 `supplier_payable_entries.tax_rate` 直接透传，
     * 不要让金额先过一遍浮点（0.13 的浮点误差会变成 1 分钱的差额，而凭证要求借贷**严格**相等）。
     */
    tax_rate?: string | Prisma.Decimal | null;
    /**
     * 业务科目（辅助维度，2026-11-09 R3-1 / D3）：应付条目（或覆盖它的对账单）上写的科目 id。
     *
     * R2-3 负责传（`entry.subjectId ?? 对账单科目`）；凭证侧只负责**落库**：
     * 解析到科目行就写 `business_subject_id` + 名称快照 `business_subject_label`，解析不到就两列留空
     * （不猜、不 422 —— 业务科目只是辅助核算，不该挡住已经核对完的挂账）。
     * 只挂在**业务分录行**（借方 / 专票拆分后的不含税借方），不挂应付账款行与进项税行。
     * 应收侧没有这一维度（契约 C：应收为空），传了也忽略。
     */
    business_subject_id?: string | null;
    remark?: string;
  }, user: CurrentUser, options: {
    /**
     * 调用方事务。传了就在该事务内创建凭证、审计，**不再另开事务** ——
     * 「确认应收/应付」与「挂账」必须同生共死（2026-11-09 用户拍板「确认即过账」）。
     */
    client?: Prisma.TransactionClient;
    /** true = 生成即过账（确认即过账口径）；false/缺省 = 保留历史草稿口径。 */
    post?: boolean;
  } = {}): Promise<AccrualResult | null> {
    const db = options.client ?? this.prisma;
    const wantPosted = Boolean(options.post);
    const accrualSubjectName = ACCRUAL_SUBJECT_NAMES[input.source_type];
    if (!accrualSubjectName) throw this.invalid("ACCRUAL_SOURCE_UNSUPPORTED", `不支持挂账的来源类型：${input.source_type}`);
    const amount = new Prisma.Decimal(input.amount ?? 0);
    // 金额为 0 的应收/应付不挂账（0 元往来是噪音，不是账）。
    if (amount.lte(0)) return null;

    // 只找**有效**凭证（未删 + 未红冲）：红冲历史行不再占唯一键（R3-4 部分唯一索引），
    // 它是「历史事实」而不是「这个来源已经有账了」，不能参与幂等判断。
    const existing = await this.activeVoucherOf(input.source_type, input.source_id, db);
    /**
     * 幂等命中：同一来源只挂一张**有效**账。
     *
     * 2026-11-09 R3-4（契约 D）的处置：
     *   - 有效已过账：金额/币种一致就复用；不一致显式 422 —— **绝不静默把旧金额当成新金额**；
     *   - 有效草稿：按本次入参重建分录后过账（修复「回退改金额 → 重新确认仍是旧金额」）；
     *   - **只有已红冲的历史行（这里取不到）→ 走下面的新建**：按本次入参重记一张 posted 凭证，
     *     历史红字行原样保留。旧实现这里 422 `VOUCHER_ACCRUAL_REVERSED`，等于一次红冲就把这条
     *     应收/应付永久卡死（契约 D 明确改为允许重建）。
     */
    if (existing) {
      if (!wantPosted) return { id: existing.id, voucherNo: existing.voucherNo, status: existing.status, replayed: true };
      if (existing.status === "posted") {
        if (!new Prisma.Decimal(existing.debitTotal).eq(amount) || existing.currency !== (input.currency ?? "CNY").trim().toUpperCase()) {
          throw this.invalid("VOUCHER_ACCRUAL_AMOUNT_MISMATCH", `挂账凭证 ${existing.voucherNo} 已过账，但与本次确认的金额/币种不一致：请先在凭证页红冲该凭证，再重新确认`);
        }
        return { id: existing.id, voucherNo: existing.voucherNo, status: "posted", replayed: true };
      }
    }

    const voucherDate = input.voucher_date instanceof Date ? input.voucher_date : this.dateOf(input.voucher_date);
    const currency = (input.currency ?? "CNY").trim().toUpperCase() || "CNY";
    await this.currencies?.assertSupported(currency, "凭证币种");
    const accrual = await this.subjectByName([accrualSubjectName], `挂账需要会计科目「${accrualSubjectName}」，请在「收支管理 → 会计科目」里补上`, db);
    const contra = input.contra_subject_id
      ? await this.subjectById(input.contra_subject_id, "挂账指定的对方科目不存在或已停用，请在「收支管理 → 会计科目」里确认", db)
      : await this.subjectByName(input.contra_subject_names, `挂账需要会计科目「${input.contra_subject_names.join("」或「")}」，请在「收支管理 → 会计科目」里补上`, db);
    const text = amount.toFixed(4);
    const isReceivable = input.source_type === SOURCE_RECEIVABLE;
    /**
     * **资金搬运不挂账**（2026-10-16，用户报障 + 选定口径）。
     *
     * 一条其他应付的「会计科目」填的是资金科目本身（如「资产类 / 库存现金（备用金）」）时，
     * 它表达的不是「欠谁的钱」，而是**把钱从银行搬到备用金**（用户原话：借 库存现金（备用金）/
     * 贷 银行存款）。挂账会凭空造出一笔应付账款：
     *   确认 → 借 库存现金（备用金） / 贷 应付账款
     *   付款 → 借 应付账款 / 贷 银行存款
     * 用户点开凭证纸看到的正是后一张：会计科目写着「应付账款」，而她要的是「库存现金（备用金）」。
     * 现在确认这一步只改状态、不生成凭证；钱在付款那一步一次记完
     * （`SupplierPaymentService.post` 的借方取条目自己的科目，见那里的注释）。
     *
     * 为什么判定放在这里而不是调用方：只有这一处同时拿着「已解析的对方科目」与来源类型，
     * 三条确认入口（逐条 / 勾选批量 / 按对账单）就自动同一口径，不会有一处忘了改。
     */
    if (!isReceivable && isCashFamilySubject(contra.label)) {
      await this.audit.record("voucher.accrual_skipped", "voucher", user.id, input.source_id, {
        reason: "cash_transfer", source_type: input.source_type, document_no: input.document_no, subject: contra.label,
      }, options.client);
      return null;
    }
    const counterparty = (input.counterparty_name ?? "").trim();
    // 专票拆分（D5，2026-11-09）：只在应付侧；普票/无票/未录 → null（保持两行全额）。
    // 放在「资金搬运不挂账」之后：搬运本来就不生成凭证，没必要因为一张不可能有专票的支出挡住确认。
    const taxSplit = isReceivable
      ? null
      : await this.resolveAccrualTaxSplit({ amount, invoiceType: input.invoice_type, taxRate: input.tax_rate, documentNo: input.document_no, db });
    // 业务科目（辅助维度，R3-1）：应收侧为空；应付侧只认「存在且启用」的科目行，解析不到留空。
    const businessSubject = isReceivable ? null : await this.resolveBusinessSubject(input.business_subject_id, db);
    // 返回值统一带上 `replayed`（false = 这次真的挂的账）：调用方要拿它写审计与界面提示，
    // 两条分支的形状必须一样，否则「幂等命中」那一支会在调用处变成 `undefined`。
    const draft = this.accrualDraft({
      sourceType: input.source_type,
      documentNo: input.document_no,
      counterparty,
      amountText: text,
      accrual,
      contra,
      taxSplit,
      businessSubject,
    });
    if (existing) {
      // 草稿 → 按本次入参重建后过账（与「首次生成」共用 accrualDraft，逐字一致）。
      const rebuiltLines = await this.withLineSubjects(this.normalizeLines(draft.lines, currency), db);
      const rebuild = async (client: Prisma.TransactionClient | PrismaService) => {
        await client.voucherLine.deleteMany({ where: { voucherId: existing.id } });
        await client.voucherLine.createMany({ data: rebuiltLines.map((line) => this.lineData(existing.id, line, null, user)) });
        return client.voucher.update({
          where: { id: existing.id },
          data: { summary: draft.summary, currency, debitTotal: amount, creditTotal: amount, status: "posted", ...this.audit.update(user) },
        });
      };
      const row = options.client ? await rebuild(options.client) : await this.prisma.$transaction((tx) => rebuild(tx));
      await this.audit.record("voucher.regenerate", "voucher", user.id, existing.id, {
        voucher_no: row.voucherNo, source_type: input.source_type, source_id: input.source_id,
        before: { subjects: existing.lines.map((line) => line.subjectLabel), debit_total: existing.debitTotal.toString() },
        after: { subjects: rebuiltLines.map((line) => line.subject_label), debit_total: amount.toString() },
      }, options.client);
      await this.audit.record("voucher.post", "voucher", user.id, existing.id, { voucher_no: row.voucherNo, auto: true, reason: "confirm_post" }, options.client);
      return { id: row.id, voucherNo: row.voucherNo, status: "posted", replayed: true };
    }
    const created = await this.createVoucher({
      voucherDate,
      currency,
      summary: draft.summary,
      remark: input.remark ?? `挂账凭证：${input.document_no}（钱未动；收到/付出时在收付款登记里记现金）`,
      lines: draft.lines,
    }, { sourceType: input.source_type, sourceId: input.source_id }, user, { client: options.client, status: wantPosted ? "posted" : "draft" });
    return { ...created, replayed: false };
  }

  /**
   * 挂账凭证的分录与摘要（确认应收/应付共用）。
   *
   * 抽出来的唯一理由：**「第一次生成」与「重新生成」必须逐字一样** —— 否则财务点一次
   * 「重新生成」得到的分录和当初自动生成的不一致，又会变成一种新的口径分叉。
   */
  private accrualDraft(input: {
    sourceType: string;
    documentNo: string;
    counterparty: string;
    amountText: string;
    contra: { key: string; label: string };
    accrual: { key: string; label: string };
    /**
     * 专票进项税拆分（D5，2026-11-09）：给了 = 专票且有可拆税额 —— 借方拆成
     * 「业务科目（不含税）+ 应交税费-进项税（税额）」两行、贷方仍是含税的应付账款；
     * `null`/缺省 = 普票/无票/未录，保持两行全额（历史口径）。
     *
     * 必须作为参数传进来、不在这里查库/算税：`createAccrual` 的「首次生成」与「草稿重建」
     * 以及 `regenerateAccrual` 都要用**同一份**拆分结果，三处各算一次就会漂移
     * （这正是本文件反复强调的「第一次生成与重新生成必须逐字一样」）。
     */
    taxSplit?: { netText: string; taxText: string; inputTax: { key: string; label: string } } | null;
    /**
     * 业务科目（辅助维度，R3-1）：挂在**业务分录行**上（借方 / 专票拆分后的不含税借方）。
     * 不是「行科目」——它不决定借贷方向，只是「这笔分录对应单据上的哪个科目」的辅助核算引用。
     */
    businessSubject?: { id: string; label: string } | null;
  }): { summary: string; lines: VoucherLineInput[] } {
    const isReceivable = input.sourceType === SOURCE_RECEIVABLE;
    const business = input.businessSubject ? { business_subject_id: input.businessSubject.id } : {};
    return {
      summary: `${isReceivable ? "确认应收" : "确认应付"} ${input.documentNo}${input.counterparty ? `（${input.counterparty}）` : ""} 挂账`,
      lines: isReceivable
        ? [
            { direction: "debit", subject_key: input.accrual.key, subject_label: input.accrual.label, amount: input.amountText, summary: `应收 ${input.documentNo}` },
            { direction: "credit", subject_key: input.contra.key, subject_label: input.contra.label, amount: input.amountText },
          ]
        : input.taxSplit
          ? [
              // 专票三行：借 业务科目（不含税） + 借 应交税费-进项税（税额） / 贷 应付账款（含税）。
              // 金额由「不含税 = 含税 ÷ (1+r)、税额 = 含税 − 不含税」得出，二者相加严格等于含税总额。
              { direction: "debit", subject_key: input.contra.key, subject_label: input.contra.label, amount: input.taxSplit.netText, summary: `采购 ${input.documentNo}（不含税）`, ...business },
              { direction: "debit", subject_key: input.taxSplit.inputTax.key, subject_label: input.taxSplit.inputTax.label, amount: input.taxSplit.taxText, summary: `进项税额 ${input.documentNo}` },
              { direction: "credit", subject_key: input.accrual.key, subject_label: input.accrual.label, amount: input.amountText, summary: `应付 ${input.documentNo}` },
            ]
          : [
              { direction: "debit", subject_key: input.contra.key, subject_label: input.contra.label, amount: input.amountText, ...business },
              { direction: "credit", subject_key: input.accrual.key, subject_label: input.accrual.label, amount: input.amountText, summary: `应付 ${input.documentNo}` },
            ],
    };
  }

  /**
   * 专票进项税拆分（2026-11-09 用户拍板 D5）—— **只对应付侧**（应收侧本轮不拆销项税）。
   *
   * 返回 `null` 的两种情况（都不报错、两行全额进业务科目）：
   *   ① 发票类型不是 `special`（普票 / 无票 / 未录 / 不认识的取值）—— 用户口径：不拆，全额进成本；
   *   ② 税率四舍五入后净额或税额 ≤ 0（极小税率）—— 拆出一行 0 元分录会被 `normalizeLines` 判非法金额，
   *      而且「没有税额」与普票在账上等价，因此按不拆处理。
   * 应收侧根本不会调到这里（`createAccrual` 只在应付分支算拆分）：本轮用户只拍进项，不拆销项税。
   *
   * 专票但税率缺失 / 不是数字 / ≤ 0 → 422 `INVOICE_TAX_RATE_REQUIRED`：专票必须能算出税额，
   * **不许猜 13%**（猜出来的税额在凭证上看不出错，只有申报时才发现）。
   * 专票但科目表找不到进项税科目 → 422 `INPUT_TAX_SUBJECT_MISSING`，details 列出候选名。
   *
   * 金额口径：`net = round(amount ÷ (1 + r), 4, HALF_UP)`、`tax = amount − net`。
   * **税额必须由含税额减出来**，不能两边各自四舍五入：否则净额+税额可能比含税额多/少 0.0001，
   * 凭证的借贷就不再严格相等，用户看到的是「借贷不平衡」而不是真正的错因。
   */
  private async resolveAccrualTaxSplit(input: {
    amount: Prisma.Decimal;
    invoiceType?: string | null;
    taxRate?: string | Prisma.Decimal | null;
    documentNo: string;
    db: PrismaService | Prisma.TransactionClient;
  }): Promise<{ netText: string; taxText: string; inputTax: { key: string; label: string } } | null> {
    // 发票类型按契约是 `special` / `general` / `none` / null；这里 trim+lower 只为容错调用方的空白/大小写，
    // 不认识的取值一律按「不拆」处理（与普票同口径）—— 不在凭证侧发明新的 422。
    const invoiceType = (input.invoiceType ?? "").trim().toLowerCase();
    if (invoiceType !== "special") return null;
    const rateText = input.taxRate === null || input.taxRate === undefined ? "" : String(input.taxRate).trim();
    let rate: Prisma.Decimal | null = null;
    if (rateText) {
      try {
        rate = new Prisma.Decimal(rateText);
      } catch {
        rate = null;
      }
    }
    if (!rate || !rate.gt(0)) {
      throw this.invalid(
        "INVOICE_TAX_RATE_REQUIRED",
        `专票挂账必须填写大于 0 的税率（单号 ${input.documentNo}）：不含税与进项税不能靠猜，请补税率后重新确认`,
      );
    }
    /**
     * 防御守卫（2026-11-09 lead 指定）：`tax_rate` 是**价内税率**（0.13），必须落在 (0,1)。
     *
     * 上游 `tax_rate` 是自由 `Decimal(8,4)`，历史/UI 出现过按百分数存 13 的写法；若不在边界拦住，
     * `amount ÷ (1 + 13)` 会算出一个「看起来有净额有税额、实际全错」的凭证，而凭证上完全看不出来。
     * 归一化由 R2-3 在业务边界做（>1 视为百分数除以 100）；凭证侧只做最后一道守卫，报原值让人能定位。
     */
    if (rate.gte(1)) {
      throw this.invalid(
        "INVALID_TAX_RATE",
        `税率 ${rateText} 不是有效的价内税率（要求 0 < r < 1，如 13% 填 0.13；百分数写法请在应付侧归一）：单号 ${input.documentNo}`,
        [{ tax_rate: rateText }],
      );
    }
    const net = input.amount.div(new Prisma.Decimal(1).plus(rate)).toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP);
    const tax = input.amount.minus(net);
    if (net.lte(0) || tax.lte(0)) return null;
    const inputTax = await this.resolveInputTaxSubject(input.db);
    if (!inputTax) {
      throw this.invalid(
        "INPUT_TAX_SUBJECT_MISSING",
        `专票挂账需要进项税科目（候选：${INPUT_TAX_SUBJECT_NAMES.join(" / ")}），请在「收支管理 → 会计科目」里补上后重新确认`,
        [{ candidates: [...INPUT_TAX_SUBJECT_NAMES] }],
      );
    }
    return { netText: net.toFixed(4), taxText: tax.toFixed(4), inputTax };
  }

  /**
   * 某来源当前**有效**的凭证（2026-11-09 R3-4 / 契约 D）。
   *
   * 「有效」= **未软删 + 未红冲**（`deletedAt: null`、`status not "reversed"`），与迁移
   * `20261109130000_finance_governance_r3` 建的部分唯一索引逐字对应：
   *   `vouchers_source_active_key (source_type, source_id)
   *    WHERE deleted_at IS NULL AND status <> 'reversed' AND source_id IS NOT NULL`
   *
   * 为什么所有「按来源找现有凭证」都必须走它：R3 之前是全局唯一键，已红冲的行也占着
   * `(source_type, source_id)`，于是「红冲后按来源重算」永远建不出第二张（旧实现直接 422
   * `VOUCHER_ACCRUAL_REVERSED`）。改成部分索引后红冲行不再占键，但查询若仍按 `deletedAt: null`
   * 找，会把红冲行当成「已有凭证」→ 重算静默回放一张已失效的凭证（比报错更糟）。
   *
   * 语义确实需要「含红冲历史」的查询**不**用这个 helper，各自保留并在注释里注明：
   *   - `accruedSourceIds`（只认 `posted`，销账口径）、`postedAccrualOf`（只认 `posted`，护栏）、
   *     `discardDraftAccrual`（只认 `draft`，作废）；
   *   - 红字链路（`get()` 里的 counterpart / reversal）、历史纠正（`buildCashTransferRepair`）
   *     与 `dropReversalsOf`：它们要看的就是红冲后的状态。
   *
   * 同一来源理论上只可能有一张有效凭证（部分唯一索引保证）；`orderBy createdAt desc` 只是让
   * 「历史数据万一违规」时结果仍然确定（brief §R3-4 Unknowns：不允许依赖 findFirst 的随机顺序）。
   * 带 `include.lines`：`createAccrual` 的草稿重建要拿改前科目写审计，调用方不必再查一次。
   */
  private async activeVoucherOf(sourceType: string, sourceId: string | null, db: PrismaService | Prisma.TransactionClient = this.prisma) {
    if (!sourceId) return null;
    return db.voucher.findFirst({
      where: { sourceType, sourceId, deletedAt: null, status: { not: "reversed" } },
      include: { lines: { orderBy: { lineNo: "asc" } } },
      orderBy: [{ createdAt: "desc" }],
    });
  }

  /**
   * 已挂账的来源 id（销账时用来判断「这条应收有没有先挂账」）。
   *
   * 销账那条现金分录的对方科目取决于它：**挂了账的**贷 `应收账款` / 借 `应付账款`
   * （成本/收入已经在挂账时记过），**没挂账的**（历史数据、或当年「确认即记账」的那些）
   * 仍按老口径直接记成本/收入 —— 历史不动，否则同一笔钱会两边都记。
   *
   * **2026-11-09 起只认 `posted`**：历史口径是 `status !== "reversed"`，把**草稿**挂账凭证也当成
   * 「已挂账」，于是确认后还没过账就付款时，付款凭证按「借应付账款」记，而挂账凭证从未进总账
   * → 应付账款只有借方、成了负数（诊断 P0-1）。草稿不是账务事实，必须过账才算。
   *
   * ⚠️ 这里**故意**不用 `activeVoucherOf`：那个返回 draft+posted，会把草稿算成已挂账；本方法的
   * 语义是「**总账上**有没有这笔挂账」，所以只查 `status: "posted"`。
   */
  async accruedSourceIds(sourceType: string, sourceIds: readonly string[]): Promise<Set<string>> {
    const ids = [...new Set(sourceIds.filter(Boolean))];
    if (!ids.length) return new Set();
    const rows = await this.prisma.voucher.findMany({
      where: { sourceType, sourceId: { in: ids }, deletedAt: null, status: "posted" },
      select: { sourceId: true },
    });
    return new Set(rows.map((row) => row.sourceId).filter((id): id is string => Boolean(id)));
  }

  /**
   * 该来源当前**已过账**的挂账凭证（确认即过账之后的常态）。
   *
   * 用途：阻止「凭证还挂在账上就把业务单据回退 / 冲销 / 删除」——那会让挂账凭证失去来源，
   * 变成一笔无主负债/资产（2026-11-09 起确认即过账，这条护栏比以前更重要）。
   * 有它返回凭证号，调用方据此给出「请先在凭证页红冲」的可执行提示。
   *
   * ⚠️ 与 `activeVoucherOf` 的区别：这里只认 `posted`（草稿不算「挂在账上」）；红冲后本方法
   * 返回 null，业务单据因此可以回退/重算（R3-6 的 `accrual_status=reversed` 用同一口径）。
   */
  async postedAccrualOf(sourceType: string, sourceId: string, client?: Prisma.TransactionClient): Promise<{ id: string; voucherNo: string } | null> {
    const db = client ?? this.prisma;
    return db.voucher.findFirst({ where: { sourceType, sourceId, deletedAt: null, status: "posted" }, select: { id: true, voucherNo: true } });
  }

  /**
   * 作废该来源的**草稿**挂账凭证（软删 + 审计）。已过账的不动（只能红冲）。
   *
   * 用于：业务单据在「草稿挂账凭证还在」的情况下被回退/删除时，顺手清掉那张没进过账的草稿，
   * 避免留下孤儿凭证。返回被作废的凭证号，便于调用方写进审计。
   *
   * ⚠️ 只处理 `draft`：已红冲的历史行不在这里动（契约 D：历史红字行原样保留）。
   */
  async discardDraftAccrual(sourceType: string, sourceId: string, reason: string, user: CurrentUser, client?: Prisma.TransactionClient): Promise<string | null> {
    const db = client ?? this.prisma;
    const draft = await db.voucher.findFirst({ where: { sourceType, sourceId, deletedAt: null, status: "draft" }, select: { id: true, voucherNo: true } });
    if (!draft) return null;
    await db.voucher.update({ where: { id: draft.id }, data: { ...this.audit.softDelete(user) } });
    await this.audit.record("voucher.delete", "voucher", user.id, draft.id, { voucher_no: draft.voucherNo, reason, auto: true }, client);
    return draft.voucherNo;
  }

  /**
   * 某来源当前**有效的已过账**凭证（2026-11-09 R3-7 契约 F：改来源流水前的护栏）。
   *
   * 与 `postedAccrualOf` 是同一条查询、不同用途：那个给「业务单据回退/冲销/删除」用，
   * 这个给「来源流水还能不能改」用。只认 `posted` —— 草稿不是账务事实，不阻止改流水
   * （改完由调用方 `discardDraftVoucherOfSource` 作废，避免留下与来源分叉的孤儿草稿）。
   */
  async postedVoucherOf(sourceType: string, sourceId: string, client?: Prisma.TransactionClient): Promise<{ id: string; voucherNo: string } | null> {
    const db = client ?? this.prisma;
    return db.voucher.findFirst({ where: { sourceType, sourceId, deletedAt: null, status: "posted" }, select: { id: true, voucherNo: true } });
  }

  /**
   * 作废某来源当前**有效草稿**凭证（2026-11-09 R3-7 契约 F：来源流水更正后，草稿内容已过期）。
   *
   * 为什么必须作废：改完流水后草稿凭证仍是旧金额/旧科目/旧银行账户；它既不会被自动重算
   * （`regenerate` 要凭证页单独点），也可能被误过账。草稿不是账务事实，软删 + 审计（`auto:true`），
   * 之后用「生成凭证」会**原地复活**那一行（`createOrReviveVoucher`）并按 R3-7 直接建成 posted。
   *
   * 只处理 `draft`：已过账的不在这里动（契约 F 由 `postedVoucherOf` 先挡改流水）。
   * 返回被作废的凭证号，便于调用方写审计/日志；没有草稿返回 null。
   */
  async discardDraftVoucherOfSource(sourceType: string, sourceId: string, reason: string, user: CurrentUser, client?: Prisma.TransactionClient): Promise<string | null> {
    const db = client ?? this.prisma;
    const current = await this.activeVoucherOf(sourceType, sourceId, db);
    if (!current || current.status !== "draft") return null;
    await this.softDeleteVoucher(current, reason, { because: "source_updated", source_type: sourceType, source_id: sourceId }, user, client);
    return current.voucherNo;
  }

  /**
   * 软删一张凭证并记 `voucher.delete` 审计（R3-5 冲销作废 / R3-7 更正作废共用）。
   *
   * 不做状态校验：调用方负责只挑「该作废的草稿」；这里只保证「软删 + 审计」这一件事只有一处实现，
   * 避免两处口径（一处记 auto:true、一处忘记录审计）。
   */
  private async softDeleteVoucher(
    voucher: { id: string; voucherNo: string },
    reason: string,
    details: Record<string, unknown>,
    user: CurrentUser,
    client?: Prisma.TransactionClient,
  ) {
    const db = client ?? this.prisma;
    await db.voucher.update({ where: { id: voucher.id }, data: { ...this.audit.softDelete(user) } });
    await this.audit.record("voucher.delete", "voucher", user.id, voucher.id, { voucher_no: voucher.voucherNo, reason, auto: true, ...details }, client);
  }

  /**
   * 分录的科目必须来自科目表（快照 `分类/名称`）：按名称候选链取第一个存在的。
   *
   * ⚠️ 已知重复查询（**R4 项，本批不做**）：R3-1 起分录落 `subject_id` 走 `withLineSubjects`，
   * 它和本方法都按「科目名 → 科目行」查一次 —— 同一行科目因此查两次库（一次校验存在、一次取 id）。
   * 合并成一个「候选名 → 科目行」解析、让两边共用是 R4 的优化（会改本方法返回形状，牵动 R2-2/R3-1
   * 两个已验收契约），Task-16 回报里已登记；这里刻意不动，避免在收口期扩大改动面。
   */
  private async subjectByName(names: readonly string[], message: string, db: PrismaService | Prisma.TransactionClient = this.prisma) {
    if (!names.length) throw this.invalid("VOUCHER_SUBJECT_REQUIRED", "挂账需要指定对方科目");
    const candidates = await db.accountingSubject.findMany({
      where: { name: { in: [...names] }, deletedAt: null, isActive: true },
      select: { category: true, name: true },
    });
    const found = names.map((name) => candidates.find((candidate) => candidate.name === name)).find((row): row is { category: string; name: string } => Boolean(row));
    if (!found) throw this.invalid("ACCOUNTING_SUBJECT_NOT_FOUND", message);
    return { key: accountingSubjectKey(found.category, found.name), label: found.name };
  }

  /** 人工选定的科目：不存在/已停用显式 422（挂账凭证的科目不能是凭空编出来的名字）。 */
  private async subjectById(id: string, message: string, db: PrismaService | Prisma.TransactionClient = this.prisma) {
    const found = await db.accountingSubject.findFirst({ where: { id, deletedAt: null, isActive: true }, select: { category: true, name: true } });
    if (!found) throw this.invalid("ACCOUNTING_SUBJECT_NOT_FOUND", message);
    return { key: accountingSubjectKey(found.category, found.name), label: found.name };
  }

  /**
   * 解析进项税科目（D5）：按 `INPUT_TAX_SUBJECT_NAMES` 的顺序取第一个**存在且启用**的科目。
   *
   * 为什么不复用 `subjectByName`：
   *   ① 失败必须报专属错误码 `INPUT_TAX_SUBJECT_MISSING`（前端据此提示「去建科目」），
   *      而不是通用的 `ACCOUNTING_SUBJECT_NOT_FOUND`；
   *   ② 进项税的候选有严格优先级（科目表实际存在的明细在前、口头叫法在后、应交税费本体兜底），
   *      而 `subjectByName` 不排序、按查询返回顺序挑（见那里的注释）。
   *
   * 同名跨分类时按 `sortOrder` 取第一条（与 `CashFlowService.firstCandidateSubject` 同口径，结果确定）。
   * 一个都不命中返回 `null`（由调用方决定报什么错），不静默换成别的科目。
   */
  private async resolveInputTaxSubject(db: PrismaService | Prisma.TransactionClient = this.prisma) {
    const candidates = await db.accountingSubject.findMany({
      where: { name: { in: [...INPUT_TAX_SUBJECT_NAMES] }, deletedAt: null, isActive: true },
      select: { category: true, name: true },
      orderBy: [{ sortOrder: "asc" }],
    });
    const found = INPUT_TAX_SUBJECT_NAMES
      .map((name) => candidates.find((candidate) => candidate.name === name))
      .find((row): row is { category: string; name: string } => Boolean(row));
    return found ? { key: accountingSubjectKey(found.category, found.name), label: found.name } : null;
  }

  /* ------------------------------------------------ 凭证行科目 id / 辅助维度（2026-11-09 R3-1） */

  /**
   * 业务科目（辅助维度）解析：id → `{ id, label }`。
   *
   * - 解析不到（id 为空 / 已删 / 已停用）→ `null`，**不 422**：业务科目只是辅助核算，
   *   不该因为它把一张已经核对完的挂账/流水卡住（契约 C：「解析不到则留空」）。
   * - label 取科目 `name`，落库成名称快照 —— 科目改名后历史凭证仍显示记账当时的名字。
   * - R3-1 之前它根本不存在，历史行 `business_subject_id/label` 为空，报表/展示按空处理。
   */
  private async resolveBusinessSubject(id: string | null | undefined, db: PrismaService | Prisma.TransactionClient = this.prisma) {
    const key = (id ?? "").trim();
    if (!key) return null;
    const found = await db.accountingSubject.findFirst({ where: { id: key, deletedAt: null, isActive: true }, select: { id: true, name: true } });
    return found ? { id: found.id, label: found.name } : null;
  }

  /**
   * 分录行的「科目名」：`subject_key` 的 `分类/名称` 取**名称**部分，退休回 `subject_label`。
   *
   * 为什么优先 `subject_key`：资金行的科目名快照带账户（`银行存款—农业银行5706`），而它在科目表里
   * 的名称是 `银行存款`；`subject_key` 里才是真正的记账科目（`银行存款` 或 `分类/名称`）。
   * 手工凭证没有科目编码时才用 label（历史手工名在科目表里找不到 → 解析为 null，符合契约）。
   */
  private subjectNameOfLine(line: { subject_key?: string | null; subject_label?: string | null }): string {
    const key = (line.subject_key ?? "").trim();
    const label = (line.subject_label ?? "").trim();
    const slash = key.indexOf("/");
    const fromKey = slash >= 0 ? key.slice(slash + 1).trim() : key;
    return fromKey || label;
  }

  /**
   * 批量解析「科目名 → 记账科目 id」（R3-1 / D3）。
   *
   * 规则只有一条：**唯一同名才算解析成功**。同一个名字在不同分类下各有一个（同名跨类目）→ 歧义、
   * 返回空（不按 sortOrder 猜、不按分类猜）；名字不存在（历史手工名/科目改过名）→ 也返回空。
   * 一次查库、按名字分组，分录再逐行套用；`subject_label` 始终保留，读取方（R3-2）回退文本匹配。
   */
  private async resolveSubjectIdsByName(lines: ReadonlyArray<{ subject_key?: string | null; subject_label?: string | null }>, db: PrismaService | Prisma.TransactionClient): Promise<Map<string, string>> {
    const names = [...new Set(lines.map((line) => this.subjectNameOfLine(line)).filter((name) => Boolean(name)))];
    if (!names.length) return new Map();
    const rows = await db.accountingSubject.findMany({
      where: { name: { in: names }, deletedAt: null, isActive: true },
      select: { id: true, name: true },
    });
    const byName = new Map<string, string[]>();
    for (const row of rows) byName.set(row.name, [...(byName.get(row.name) ?? []), row.id]);
    const resolved = new Map<string, string>();
    for (const [name, ids] of byName) if (ids.length === 1) resolved.set(name, ids[0]);
    return resolved;
  }

  /**
   * 给一组分录补上 `subject_id` / `business_subject_id` / `business_subject_label`（落库前唯一入口）。
   *
   * - `subject_id`：行上**显式给了**（`undefined` 之外）就照用（红冲沿用原行 id 属于这一类），
   *   没给就按科目名解析成唯一科目；歧义/找不到 → `null`，`subject_label` 原样保留。
   * - 业务科目：只认「存在且启用」的 id；解析不到两列都留空（不猜）。
   * - 这一步不动借贷方向、金额、科目名称、资金行账户 —— R3-1 的口径是「只补维度，不改账」。
   */
  private async withLineSubjects<T extends { subject_key?: string | null; subject_label?: string | null; subject_id?: string | null; business_subject_id?: string | null }>(lines: T[], db: PrismaService | Prisma.TransactionClient): Promise<Array<T & { subject_id: string | null; business_subject_id: string | null; business_subject_label: string | null }>> {
    if (!lines.length) return [];
    const nameToId = await this.resolveSubjectIdsByName(lines, db);
    const businessIds = [...new Set(lines.map((line) => line.business_subject_id).filter((id): id is string => Boolean(id)))];
    const businessRows = businessIds.length
      ? await db.accountingSubject.findMany({ where: { id: { in: businessIds }, deletedAt: null, isActive: true }, select: { id: true, name: true } })
      : [];
    const businessLabelById = new Map(businessRows.map((row) => [row.id, row.name]));
    return lines.map((line) => {
      const subjectId = line.subject_id === undefined ? nameToId.get(this.subjectNameOfLine(line)) ?? null : line.subject_id ?? null;
      const businessId = line.business_subject_id ?? null;
      const businessLabel = businessId ? businessLabelById.get(businessId) ?? null : null;
      return { ...line, subject_id: subjectId, business_subject_id: businessId && businessLabel ? businessId : null, business_subject_label: businessLabel };
    });
  }

  /**
   * 真正落库的那一段（手工凭证 / 挂账凭证共用）。
   *
   * 抽出来的理由：两条路只有「来源」和「科目怎么来」不同，其余（分录校验、借贷平衡、期间编号、
   * 银行账户存在性、审计）**必须逐字一致** —— 复制一份就会分叉成「手工凭证查银行、挂账凭证不查」这种
   * 只有出事故时才会发现的差别。
   *
   * 2026-11-09：增加 `client`（加入调用方事务）与 `status`（确认即过账）。传了 `client` 时只返回
   * `{ id, voucherNo, status, revived }` —— 事务内不回读整张凭证（回读要走同一个事务客户端），
   * 需要完整详情的调用方（手工凭证）在事务外自己 `get()`。
   */
  private async createVoucher(
    input: { voucherDate: Date; currency: string; summary: string; remark?: string | null; lines: VoucherLineInput[] },
    source: { sourceType: string; sourceId: string | null },
    user: CurrentUser,
    options: { client?: Prisma.TransactionClient; status?: "draft" | "posted" } = {},
  ): Promise<{ id: string; voucherNo: string; status: string; revived: boolean }> {
    if (!input.lines?.length) throw this.invalid("VOUCHER_LINE_REQUIRED", "凭证至少需要一条分录");
    // 落库前统一补科目 id / 业务科目维度（R3-1）：手工凭证按名称解析、挂账按 accrualDraft 传入的 id。
    const lines = await this.withLineSubjects(this.normalizeLines(input.lines, input.currency), options.client ?? this.prisma);
    if (lines.length < 2) throw this.invalid("VOUCHER_LINE_REQUIRED", "凭证至少需要一条借方与一条贷方分录");
    await this.assertBanks(lines.map((line) => line.bank_id), options.client);
    const totals = { debit: this.sumBy(lines, "debit"), credit: this.sumBy(lines, "credit") };
    if (totals.debit.lte(0)) throw this.invalid("VOUCHER_AMOUNT_REQUIRED", "凭证金额必须大于零");
    if (!totals.debit.eq(totals.credit)) {
      throw this.invalid("VOUCHER_NOT_BALANCED", `借贷不平衡：借方 ${totals.debit.toString()} / 贷方 ${totals.credit.toString()}`);
    }
    const status = options.status ?? "draft";
    const period = voucherPeriodFor(input.voucherDate);
    const run = async (tx: Prisma.TransactionClient) => {
      // 与「由流水生成」同一套编号规则：期间内顺延，唯一索引兜底并发。
      const siblings = await tx.voucher.findMany({ where: { voucherNo: { startsWith: `记-${period}-` } }, select: { voucherNo: true } });
      const voucherNo = nextSequenceCode(`记-${period}-`, siblings.map((item) => item.voucherNo));
      return this.createOrReviveVoucher(tx, source, {
        voucherNo, voucherDate: input.voucherDate, period, summary: input.summary, status,
        currency: input.currency, debitTotal: totals.debit, creditTotal: totals.credit, remark: input.remark ?? null,
      }, lines, null, user);
    };
    const row = options.client ? await run(options.client) : await this.prisma.$transaction((tx) => run(tx));
    await this.audit.record("voucher.create", "voucher", user.id, row.id, {
      voucher_no: row.voucherNo, source_type: source.sourceType, source_id: source.sourceId,
      amount: totals.debit.toString(), line_count: lines.length, revived: row.revived, status,
    }, options.client);
    // 直接过账的凭证补一条 post 审计：审计里要能看出「这张从来没在草稿态被人动过」。
    if (status === "posted") {
      await this.audit.record("voucher.post", "voucher", user.id, row.id, { voucher_no: row.voucherNo, auto: true, reason: "confirm_post" }, options.client);
    }
    return { id: row.id, voucherNo: row.voucherNo, status, revived: row.revived };
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
   *   - **来源是收支流水或挂账（确认应收/应付）**：红冲凭证的内容由被红冲的凭证决定，重算没有意义；
   *     挂账凭证按来源单据重建成「借 业务科目 / 贷 应付账款（应收账款）」（2026-11-04 补）。
   *   - **流水已冲销时拒绝**：钱没真的动过，不能生成/重算凭证（与 `createFromCashFlowEntry` 同一口径）。
   *   - **覆盖手工改动**：重新生成就是「按来源重来」，所以界面上必须先说清楚（见凭证页的确认弹窗）。
   */
  async regenerate(id: string, user: CurrentUser) {
    const current = await this.prisma.voucher.findFirst({ where: { id, deletedAt: null }, include: { lines: { orderBy: { lineNo: "asc" } } } });
    if (!current) throw this.notFound("VOUCHER_NOT_FOUND", "凭证不存在");
    if (current.status !== "draft") throw this.invalid("VOUCHER_NOT_REGENERABLE", "只有草稿凭证可以重新生成；已过账的凭证请先红冲");
    // 挂账凭证：按来源单据重建（2026-11-04）。财务手改挂账凭证的分录后，这是唯一能拉回系统口径的入口。
    // 只覆盖**应付**挂账：应付条目上存着财务选的科目，能逐字还原；应收挂账的对方科目是候选链推的，
    // 财务当初若选过别的收入科目，重算会把它换掉（应收侧等有了科目快照再开）。
    if (current.sourceType === SOURCE_PAYABLE) return this.regenerateAccrual(current, user);
    if (current.sourceType !== SOURCE_CASH_FLOW) throw this.invalid("VOUCHER_NOT_REGENERABLE", "红冲凭证不能重新生成（它的内容由被红冲的凭证决定）");
    // 手工凭证不进这条路（sourceId 为空）；这里显式挡住，顺带把类型收窄成 string。
    if (!current.sourceId) throw this.invalid("VOUCHER_NOT_REGENERABLE", "手工凭证没有来源流水，不能重新生成（直接编辑分录即可）");
    const entry = await this.prisma.cashFlowEntry.findFirst({ where: { id: current.sourceId, deletedAt: null }, include: ENTRY_INCLUDE });
    if (!entry) throw this.invalid("VOUCHER_SOURCE_MISSING", "来源收支流水已不存在，无法重新生成");
    if (entry.status !== "posted") throw this.invalid("CASH_FLOW_ENTRY_NOT_VOUCHERABLE", "来源收支流水已冲销，不能重新生成凭证");

    const draft = await this.draftForEntry(entry);
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
   * 挂账凭证的重新生成（2026-11-04，当前只覆盖**应付**挂账）。
   *
   * 用户报障：财务把挂账凭证的分录手改成现金分录（把「贷 应付账款」改成「贷 银行存款」）后，
   * 凭证页只有「编辑分录」，没有把凭证拉回系统口径的办法 —— 只能红冲或删草稿，于是越改越乱。
   * 这里按**来源应付单现在的内容**重建凭证，并且与 `createAccrual` 共用 `accrualDraft`，
   * 保证「重新生成出来的」与「第一次自动生成出来的」逐字一致。
   *
   * 边界与收支流水的重算相同：只对草稿开放、覆盖手工改动、审计记改前/改后科目。
   */
  private async regenerateAccrual(
    current: { id: string; voucherNo: string; summary: string; currency: string; sourceType: string; sourceId: string | null; lines: Array<{ subjectLabel: string }> },
    user: CurrentUser,
  ) {
    if (!current.sourceId) throw this.invalid("VOUCHER_NOT_REGENERABLE", "挂账凭证没有来源单据，不能重新生成");
    const entry = await this.prisma.supplierPayableEntry.findFirst({
      where: { id: current.sourceId, deletedAt: null },
      include: { subject: { select: { category: true, name: true } }, supplier: { select: { name: true } } },
    });
    if (!entry) throw this.invalid("VOUCHER_SOURCE_MISSING", "来源应付单已不存在，无法重新生成挂账凭证");
    const amount = new Prisma.Decimal(entry.amount);
    const currency = entry.currency;
    const documentNo = entry.payableNo;
    const counterparty = entry.supplier?.name ?? entry.supplierId;
    // 与 `SupplierPayableService.accrue` 同一条优先级：条目自己填的科目 > 按来源类型的候选链。
    const contra = entry.subject
      ? { key: accountingSubjectKey(entry.subject.category, entry.subject.name), label: entry.subject.name }
      : await this.subjectByName(entry.sourceType ? paymentSubjectNames(entry.sourceType) : PAYABLE_CONFIRM_SUBJECT_NAMES, "挂账需要会计科目，请在「收支管理 → 会计科目」里补上");
    if (isCashFamilySubject(contra.label)) throw this.invalid("VOUCHER_ACCRUAL_NOT_REGENERABLE", "该应付的会计科目是资金科目（资金搬运），本来就不挂账：请删除这张草稿，钱在付款流水里记");
    const accrual = await this.subjectByName([ACCRUAL_SUBJECT_NAMES[SOURCE_PAYABLE]], "挂账需要会计科目「应付账款」");
    // 专票口径与首次挂账一致（R2-2）：从来源应付单读发票类型与税率，重建出同样的三行。
    // 少了这一步，「重新生成」会把专票的三行悄悄退回两行全额 —— 那正是「首次生成与重算不一致」的老问题。
    const taxSplit = await this.resolveAccrualTaxSplit({
      amount,
      invoiceType: entry.invoiceType,
      taxRate: entry.taxRate,
      documentNo,
      db: this.prisma,
    });
    // 业务科目（辅助维度，R3-1）：来源应付单自己写的科目；与首次挂账同一条口径（解析不到留空）。
    const businessSubject = await this.resolveBusinessSubject(entry.subjectId, this.prisma);
    const draft = this.accrualDraft({ sourceType: current.sourceType, documentNo, counterparty, amountText: amount.toFixed(4), accrual, contra, taxSplit, businessSubject });
    // 科目 id 在事务外解析（只读、科目行稳定）：事务内只做「删旧行 + 写新行」，缩短锁持有时间。
    const resolvedLines = await this.withLineSubjects(this.normalizeLines(draft.lines, currency), this.prisma);
    const row = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM vouchers WHERE id = ${current.id}::uuid FOR UPDATE`;
      const locked = await tx.voucher.findFirst({ where: { id: current.id, deletedAt: null } });
      if (!locked || locked.status !== "draft") throw this.invalid("VOUCHER_NOT_REGENERABLE", "凭证已被其他操作处理");
      await tx.voucherLine.deleteMany({ where: { voucherId: current.id } });
      await tx.voucherLine.createMany({ data: resolvedLines.map((line) => this.lineData(current.id, line, null, user)) });
      return tx.voucher.update({ where: { id: current.id }, data: { summary: draft.summary, currency, debitTotal: amount, creditTotal: amount, ...this.audit.update(user) } });
    });
    await this.audit.record("voucher.regenerate", "voucher", user.id, current.id, {
      voucher_no: current.voucherNo,
      source_type: current.sourceType,
      source_id: current.sourceId,
      before: { summary: current.summary, subjects: current.lines.map((line) => line.subjectLabel) },
      after: { summary: row.summary, subjects: draft.lines.map((line) => line.subject_label) },
    });
    return { ...(await this.get(current.id)), regenerated: true };
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
   *
   * 2026-11-09 R3-1：顺带落两类 id ——
   *   - `subject_id`：按科目名解析成唯一科目（`withLineSubjects`，歧义/找不到留空）；
   *   - `business_subject_id`：流水的**收支类目**（`categorySubjectId`），只挂在业务分录行上；
   *     它是辅助核算维度，不参与记账（记账科目仍是 `subject`）。
   */
  private async draftForEntry(entry: CashFlowEntryForDraft, options: { db?: PrismaService | Prisma.TransactionClient; resolveIds?: boolean } = {}) {
    const db = options.db ?? this.prisma;
    const resolveIds = options.resolveIds ?? true;
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
    const fund = fundLineFor({ bankId: entry.bank?.id ?? null, bankLabel, settlementMethod: entry.settlementMethod, settlementAccountLabel: entry.settlementAccount?.label ?? null, subjectLabel: entry.subject?.name ?? "" });
    // 业务分录行 = 不是资金行的那个方向：收入 → 贷方是业务科目；支出 → 借方是业务科目。
    // （`voucherLinesFor` 恒返回 [借方 line 1, 贷方 line 2]，所以按方向就能定位，不用比对科目名。）
    const businessLineIndex = entry.direction === "income" ? 1 : 0;
    const withBusiness = entry.categorySubject
      ? lines.map((line, index) => (index === businessLineIndex ? { ...line, business_subject_id: entry.categorySubject!.id } : line))
      : lines;
    // `resolveIds: false` 只给「只看科目名、不落库」的调用方（资金行科目名回填预览）用，省一次查库。
    return { lines: resolveIds ? await this.withLineSubjects(withBusiness, db) : withBusiness, bankId: fund.bank_id };
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
    // 落库前统一补科目 id / 业务科目维度（R3-1）：编辑后的分行同样按名称解析，歧义/找不到留空。
    const lines = input.lines ? await this.withLineSubjects(this.normalizeLines(input.lines, current.currency), this.prisma) : null;
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
    /**
     * 2026-11-09：改分录必须留下「改前 / 改后」的科目与金额。
     *
     * 历史审计只记 `{line_edited:true}`，线上被手改 33 次后没人说得清原来是什么科目
     * （诊断 P0-6 / 2026-11-04 审计 P2）。自动生成的凭证被改后与来源单据永久不一致，
     * 没有改前值就只能靠行时间戳反推。
     */
    const beforeLines = current.lines.map((line) => ({ direction: line.direction, subject: line.subjectLabel, amount: line.amount.toString() }));
    const afterLines = lines
      ? lines.map((line) => ({ direction: line.direction, subject: line.subject_label, amount: line.amount }))
      : beforeLines;
    await this.audit.record("voucher.update", "voucher", user.id, id, {
      voucher_no: row.voucherNo,
      line_edited: Boolean(lines),
      before: { summary: current.summary, lines: beforeLines },
      after: { summary: row.summary, lines: afterLines },
    });
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
    /**
     * **红字凭证不能再红冲**（2026-11-09）。
     *
     * 红字凭证落库时就是 `posted`，于是它本身也能被红冲 —— 生产库因此出现过 9 连红冲链
     * （0006→0007→…→0018）：链上每张「原作者」都已被置为 reversed，最终只有链尾留在账上，
     * 3 张 posted 红字凭证合计反向虚增 12,061.20（诊断 §6.6）。
     * 要更正一张红字凭证，正确做法是回到业务单据重新生成，而不是在凭证层反复对冲。
     */
    if (current.sourceType === SOURCE_VOUCHER) throw this.invalid("VOUCHER_RED_NOT_REVERSIBLE", "红字凭证不能再次红冲：如需更正，请调整业务单据后重新生成凭证");
    const red = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM vouchers WHERE id = ${id}::uuid FOR UPDATE`;
      const locked = await tx.voucher.findFirst({ where: { id, deletedAt: null }, include: { lines: { orderBy: { lineNo: "asc" } } } });
      if (!locked || locked.status !== "posted") throw this.invalid("VOUCHER_NOT_REVERSIBLE", "凭证已被其他操作处理");
      const period = locked.period;
      const siblings = await tx.voucher.findMany({ where: { voucherNo: { startsWith: `记-${period}-` } }, select: { voucherNo: true } });
      const lines = reverseLines(locked.lines.map((line) => ({ direction: line.direction, subject_key: line.subjectKey, subject_label: line.subjectLabel, summary: line.summary, amount: line.amount, currency: line.currency, bank_id: line.bankId })))
        // R3-1：红字分录沿用原行的记账科目 id 与业务科目维度（借贷对调、科目不变）——
        // 不按名称重新解析：科目若在两次操作之间被改名/停用，重新解析会把红字挂到别的科目上。
        .map((line, index) => ({
          ...line,
          subject_id: locked.lines[index]?.subjectId ?? null,
          business_subject_id: locked.lines[index]?.businessSubjectId ?? null,
          business_subject_label: locked.lines[index]?.businessSubjectLabel ?? null,
        }));
      // 红字凭证也走「同来源只有一行」的落库路径：它的来源是被红冲的那张凭证，
      // 所以那张凭证第二次被红冲时要**复活**原来那张红字凭证，而不是新建（全量唯一索引会拦）。
      const red = await this.createOrReviveVoucher(tx, { sourceType: SOURCE_VOUCHER, sourceId: locked.id }, {
        voucherNo: nextSequenceCode(`记-${period}-`, siblings.map((item) => item.voucherNo)),
        voucherDate: new Date(), period, status: "posted",
        summary: `红冲 ${locked.voucherNo}：${reason.trim()}`.slice(0, 500),
        currency: locked.currency, debitTotal: locked.creditTotal, creditTotal: locked.debitTotal, remark: reason.trim(),
      }, lines, null, user);
      await tx.voucher.update({ where: { id }, data: { status: "reversed", ...this.audit.update(user) } });
      return red;
    });
    await this.audit.record("voucher.reverse", "voucher", user.id, id, { voucher_no: current.voucherNo, red_voucher_no: red.voucherNo, reason: reason.trim() });
    return this.get(red.id);
  }

  /**
   * 按**来源**红冲其当前有效凭证（契约 E，2026-11-09 R3-5）。
   *
   * 调用点：
   *   - `CashFlowService.reverse`（手工冲销一条流水）→ 红冲该流水的凭证；
   *   - `CashFlowService.autoReverseFromPayment`（付款/收款冲销链）→ 红冲被回冲流水各自的凭证。
   *
   * 语义（幂等优先，绝不重复开红字）：
   *   - 来源**没有有效凭证**（从未生成 / 已红冲）→ 返回 `null`，不报错；重复冲销不会产生第二张红字；
   *   - 有效凭证是 `posted` → 走既有 `reverse`（生成红字凭证、原凭证置 `reversed`、审计 `voucher.reverse`）；
   *   - 有效凭证是 `draft` → 草稿不是账务事实，**软删作废**（审计 `voucher.delete`，`auto:true`），不生成红字。
   *     为什么必须处理：R3-7 之前（以及测试/历史数据）自动生成的流水凭证都可能是草稿；流水一旦冲销，
   *     那张草稿就永远过不了账（`regenerate` / `createFromCashFlowEntry` 都拒绝已冲销流水），留着只会
   *     变成可以误过账的孤儿。契约 E 只规定「已过账凭证要红冲」，草稿按「作废」处理是 R3-5 的落地细节。
   *   - **不改业务单据状态**（契约 E 第三行）：业务侧靠 `accrual_status`（R3-6）或付款冲销链处理。
   *
   * 事务纪律：红冲仍是 `reverse` 自己的独立事务；`client` 只用于「找有效凭证」的查询（本轮调用点都在
   * 业务事务外，不传）。审计由 `voucher.reverse` / `voucher.delete` 自己记，调用方不需要再记一遍。
   */
  async reverseBySource(
    sourceType: string,
    sourceId: string | null,
    reason: string,
    user: CurrentUser,
    client?: Prisma.TransactionClient,
  ): Promise<{ id: string; voucherNo: string; redVoucherNo: string | null; action: "reversed" | "draft_discarded" } | null> {
    if (!reason?.trim()) throw this.invalid("REVERSAL_REASON_REQUIRED", "红冲必须填写原因");
    if (!sourceId) return null;
    const db = client ?? this.prisma;
    const current = await this.activeVoucherOf(sourceType, sourceId, db);
    if (!current) return null;
    if (current.status === "posted") {
      const red = await this.reverse(current.id, reason.trim(), user);
      return { id: current.id, voucherNo: current.voucherNo, redVoucherNo: red.voucherNo, action: "reversed" };
    }
    await this.softDeleteVoucher(current, reason.trim(), { because: "source_reversed", source_type: sourceType, source_id: sourceId }, user, client);
    return { id: current.id, voucherNo: current.voucherNo, redVoucherNo: null, action: "draft_discarded" };
  }

  /* ------------------------------------------------ 资金搬运凭证的纠正（2026-10-16，旧数据） */

  /**
   * 找出「资金搬运」的旧凭证（预览与纠正共用同一次取数，两处口径不会分叉）。
   *
   * 资金搬运 = 其他应付的会计科目是**资金科目本身**（`库存现金（备用金）`这类，
   * 见 `voucher.domain.ts` 的 `isCashFamilySubject`）。2026-10-16 之前它们被当成负债记账：
   *   确认 → 借 库存现金（备用金） / 贷 应付账款（挂账）
   *   付款 → 借 应付账款 / 贷 银行存款
   * 用户点开凭证纸看到的就是后一张：「会计科目」写着应付账款，而她要的是库存现金（备用金）。
   *
   * 口径已改成「不挂账 + 付款时借方取条目自己的科目」（见 `createAccrual` 与
   * `SupplierPaymentService.post`），但**已经生成出来的凭证不会自己变**，所以这里按凭证事实逐张纠正：
   *   - 挂账凭证：草稿 → 删除（草稿不是账务事实）；已过账 → 红冲（留痕，不改历史数字）；
   *   - 付款流水：主科目改成条目自己的科目（借 库存现金（备用金）），资金侧按新规则算（贷 银行存款）；
   *   - 付款凭证：草稿 → 原地按新口径重算分录；已过账 → 先红冲（旧内容留痕）再重开成草稿。
   *
   * 为什么「一条流水核销了多条应付、其中混着非资金搬运」时**不动它**：一条流水只有一个主科目，
   * 拆不开两种语义 —— 宁可点名让人工处理，也不要按金额最大的那条硬改（那种账事后没人说得清）。
   */
  private async buildCashTransferRepair() {
    const empty = { accruals: [], flows: [], skipped: [], payableCount: 0 } as CashTransferRepairTargets;
    const subjects = await this.prisma.accountingSubject.findMany({ where: { category: "资产类", deletedAt: null }, select: { id: true, name: true, category: true } });
    const cashSubjects = new Map(subjects.filter((subject) => isCashFamilySubject(subject.name)).map((subject) => [subject.id, subject]));
    if (!cashSubjects.size) return empty;
    const payables = await this.prisma.supplierPayableEntry.findMany({
      where: { deletedAt: null, subjectId: { in: [...cashSubjects.keys()] } },
      select: { id: true, payableNo: true, subjectId: true },
    });
    if (!payables.length) return empty;
    const payableById = new Map(payables.map((payable) => [payable.id, payable]));
    const payableIds = [...payableById.keys()];

    // ⚠️ 历史纠正语义，故意不用 `activeVoucherOf`：这里要把 draft / posted / 已红冲三种状态都看到
    // （draft→软删、posted→红冲后撤红字；已红冲→只需撤掉它那张红字，别重复红冲）。
    const accruals = await this.prisma.voucher.findMany({
      where: { sourceType: SOURCE_PAYABLE, sourceId: { in: payableIds }, deletedAt: null },
      select: { id: true, voucherNo: true, status: true, sourceId: true },
    });
    // 核销记录 → 付款单 → 收支流水。只认**生效**的核销与**已过账**的付款单：
    // 冲销掉的付款不该出现在纠正清单里（它的钱已经退回来了）。
    const allocations = await this.prisma.supplierPaymentAllocation.findMany({
      where: { payableEntryId: { in: payableIds }, deletedAt: null, status: "active" },
      select: { paymentId: true, payableEntryId: true, amount: true },
    });
    const paymentIds = [...new Set(allocations.map((allocation) => allocation.paymentId))];
    const postedPayments = paymentIds.length
      ? await this.prisma.supplierPayment.findMany({ where: { id: { in: paymentIds }, status: "posted", deletedAt: null }, select: { id: true } })
      : [];
    const postedPaymentIds = postedPayments.map((payment) => payment.id);
    const postedSet = new Set(postedPaymentIds);
    const flows = postedPaymentIds.length
      ? await this.prisma.cashFlowEntry.findMany({ where: { sourceType: "supplier_payment", sourceId: { in: postedPaymentIds }, status: "posted", deletedAt: null }, include: ENTRY_INCLUDE })
      : [];
    const flowVouchers = flows.length
      // ⚠️ 历史纠正语义：这里**要看红冲状态**，所以故意不排除 `reversed` 行（契约 D 的
      // `activeVoucherOf` 是「来源的有效凭证」，回答不了「用户自己先红冲过这张凭证」这种情况）。
      // 一条流水若同时有「已红冲旧行 + 新有效行」，下面按「有效优先」挑一张作为纠正目标。
      ? await this.prisma.voucher.findMany({ where: { sourceType: SOURCE_CASH_FLOW, sourceId: { in: flows.map((flow) => flow.id) }, deletedAt: null }, select: { id: true, voucherNo: true, status: true, sourceId: true }, orderBy: [{ createdAt: "desc" }] })
      : [];
    const voucherByFlow = new Map<string, (typeof flowVouchers)[number]>();
    for (const voucher of flowVouchers) {
      if (!voucher.sourceId) continue;
      const current = voucherByFlow.get(voucher.sourceId);
      // 有效行优先；两张都 reversed（历史连冲）时保留先放进去的那张，结果不随查询顺序漂移。
      if (!current || (current.status === "reversed" && voucher.status !== "reversed")) voucherByFlow.set(voucher.sourceId, voucher);
    }
    // 每张付款单的**全部**核销（含不属于资金搬运的那些）：用来判断「这条流水能不能整体改」。
    const paymentAllocations = postedPaymentIds.length
      ? await this.prisma.supplierPaymentAllocation.findMany({ where: { paymentId: { in: postedPaymentIds }, deletedAt: null, status: "active" }, select: { paymentId: true, payableEntryId: true, amount: true } })
      : [];

    const targets: CashTransferRepairTargets = { accruals: [], flows: [], skipped: [], payableCount: payables.length };
    for (const accrual of accruals) {
      targets.accruals.push({ id: accrual.id, voucherNo: accrual.voucherNo, status: accrual.status, payableNo: payableById.get(accrual.sourceId as string)?.payableNo ?? "" });
    }
    for (const flow of flows) {
      const rows = paymentAllocations.filter((allocation) => allocation.paymentId === flow.sourceId);
      const outsider = rows.find((row) => !payableById.has(row.payableEntryId));
      if (outsider) {
        targets.skipped.push({ entry_no: flow.entryNo, reason: "这条流水还核销了非资金搬运的应付，主科目拆不开，请人工处理" });
        continue;
      }
      // 主科目取金额最大的那条应付自己的科目（多条备用金时它们本来就是同一个科目）。
      const dominant = [...rows].sort((left, right) => new Prisma.Decimal(right.amount).comparedTo(new Prisma.Decimal(left.amount)))[0];
      const subjectId = payableById.get(dominant.payableEntryId)?.subjectId ?? null;
      if (!subjectId) { targets.skipped.push({ entry_no: flow.entryNo, reason: "找不到条目上的会计科目" }); continue; }
      targets.flows.push({
        id: flow.id, entryNo: flow.entryNo, entry: flow, subjectId,
        subjectCategory: cashSubjects.get(subjectId)?.category ?? "资产类",
        subjectLabel: cashSubjects.get(subjectId)?.name ?? "",
        voucher: voucherByFlow.get(flow.id) ?? null,
        payableNos: rows.map((row) => payableById.get(row.payableEntryId)?.payableNo ?? "").filter(Boolean),
      });
    }
    return targets;
  }

  /** 预览：**不写库**。财务点按钮之前先看清会发生什么（改几张、删几张、红冲几张）。 */
  async cashTransferRepairPreview() {
    const targets = await this.buildCashTransferRepair();
    return {
      ...repairSummary(targets),
      targets: targets.flows.map((flow) => ({
        entry_no: flow.entryNo,
        cash_flow_entry_id: flow.id,
        payable_nos: flow.payableNos,
        subject_label: flow.subjectLabel,
        voucher_no: flow.voucher?.voucherNo ?? null,
        voucher_status: flow.voucher?.status ?? null,
      })),
    };
  }

  /**
   * 撤掉一张凭证的红字凭证（有就撤，返回被撤的凭证号）。
   *
   * 为什么纠正动作必须做这一步：红字凭证是「旧内容」的对冲件，而纠正要么把旧内容重写成新口径、
   * 要么让旧凭证整个从账上消失（挂账凭证本就不该存在）。报表取数只认 `status = "posted"`：
   * 原凭证 `reversed` 不进表，红字还留在表里就会剩下一笔**没有任何对应正分录的反向金额**
   * （比不改还糟：账上凭空多一个相反方向的数）。行不物理删除，谁在什么时候撤的在审计里。
   */
  private async dropReversalsOf(voucherId: string, reason: string, user: CurrentUser): Promise<string[]> {
    // ⚠️ 红冲历史语义（同 `get()`）：要看的就是「这张凭证的红字件」，红字件本身状态是 posted，
    // 不看 `activeVoucherOf`（那是「来源的有效凭证」，与「被红冲的原凭证」不是一个问题）。
    const reds = await this.prisma.voucher.findMany({
      where: { sourceType: SOURCE_VOUCHER, sourceId: voucherId, deletedAt: null },
      select: { id: true, voucherNo: true },
    });
    for (const red of reds) {
      await this.prisma.voucher.update({ where: { id: red.id }, data: { ...this.audit.softDelete(user) } });
      await this.audit.record("voucher.cash_transfer_repair", "voucher", user.id, red.id, {
        action: "drop_reversal", voucher_no: red.voucherNo, of_voucher_id: voucherId, reason,
      });
    }
    return reds.map((red) => red.voucherNo);
  }

  /**
   * 执行纠正（用户 2026-10-16：「旧的那些也一起纠正过来（已过账的按需红冲，草稿直接改）」）。
   *
   * 每一步都留审计；红冲用既有的 `reverse`（同一套编号规则与「红字凭证已过账」的语义），
   * 不自己写一份 —— 账上的红字凭证必须是标准件。
   */
  async repairCashTransferVouchers(user: CurrentUser) {
    const targets = await this.buildCashTransferRepair();
    const before = repairSummary(targets);
    const reason = "资金搬运口径纠正：备用金这类应付的会计科目是资金科目（不挂账），凭证按「借 库存现金（备用金）/贷 银行存款」重记";
    for (const accrual of targets.accruals) {
      if (accrual.status === "draft") {
        await this.prisma.voucher.update({ where: { id: accrual.id }, data: { ...this.audit.softDelete(user) } });
        await this.audit.record("voucher.cash_transfer_repair", "voucher", user.id, accrual.id, { action: "delete_draft_accrual", voucher_no: accrual.voucherNo, payable_no: accrual.payableNo, reason });
      } else {
        // 已过账的先红冲（留痕），再把红字凭证撤掉：这一对在账上必须是**0**（这张挂账凭证本就不该存在）。
        if (accrual.status === "posted") await this.reverse(accrual.id, reason, user);
        await this.dropReversalsOf(accrual.id, reason, user);
      }
    }
    let rebuilt = 0;
    let reopened = 0;
    let withoutVoucher = 0;
    for (const flow of targets.flows) {
      // ① 流水的主科目改成条目自己的科目 —— 这才是凭证业务分录取的那个科目。
      await this.prisma.cashFlowEntry.update({ where: { id: flow.id }, data: { subjectId: flow.subjectId, ...this.audit.update(user) } });
      // 科目快照要连**分类**一起换掉：旧流水上挂的是「负债类/应付账款」，只改名会得到
      // 「负债类/库存现金（备用金）」这种不存在的科目（资产类下才有它）。
      const entry = { ...flow.entry, subjectId: flow.subjectId, subject: { id: flow.subjectId, category: flow.subjectCategory, name: flow.subjectLabel } };
      if (!flow.voucher) { withoutVoucher += 1; continue; }
      // ② 已过账的付款凭证先红冲（旧内容原样留在红字凭证上，可追溯），
      //    然后连同红字一起撤掉、按新口径重记 —— 见 `dropReversalsOf` 的注释。
      if (flow.voucher.status === "posted") await this.reverse(flow.voucher.id, reason, user);
      await this.dropReversalsOf(flow.voucher.id, reason, user);
      const draft = await this.draftForEntry(entry);
      const amount = new Prisma.Decimal(entry.amount);
      const summary = voucherSummaryFor({ counterpartyName: entry.counterpartyName, subjectLabel: entry.subject?.name ?? "未分类", remark: entry.remark });
      const period = voucherPeriodFor(entry.entryDate);
      await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM vouchers WHERE id = ${flow.voucher!.id}::uuid FOR UPDATE`;
        await tx.voucherLine.deleteMany({ where: { voucherId: flow.voucher!.id } });
        await tx.voucherLine.createMany({ data: draft.lines.map((line) => this.lineData(flow.voucher!.id, line, flow.id, user)) });
        // 状态回到**草稿**：重记过的内容财务要能再核对一次（已过账的那张内容已经红冲留痕了）。
        await tx.voucher.update({
          where: { id: flow.voucher!.id },
          data: { status: "draft", summary, voucherDate: entry.entryDate, period, currency: entry.currency, debitTotal: amount, creditTotal: amount, ...this.audit.update(user) },
        });
      });
      if (flow.voucher.status === "posted") reopened += 1; else rebuilt += 1;
      await this.audit.record("voucher.cash_transfer_repair", "voucher", user.id, flow.voucher.id, {
        action: flow.voucher.status === "posted" ? "reverse_and_reopen" : "rebuild_draft",
        voucher_no: flow.voucher.voucherNo, entry_no: flow.entryNo, payable_nos: flow.payableNos,
        subject: flow.subjectLabel, before_status: flow.voucher.status, reason,
      });
    }
    await this.audit.record("voucher.repair_cash_transfer", "voucher", user.id, undefined, { ...before, rebuilt, reopened, without_voucher: withoutVoucher, reason });
    return { ...before, rebuilt, reopened, without_voucher: withoutVoucher };
  }

  /**
   * 2026-11-05：贷方资金科目的账户名改成「**结算账户优先**」（见 `fundLineFor`）后，
   * **已经生成出来的草稿凭证不会自己变**。这两个方法按来源流水重算草稿凭证**资金行**的科目名：
   * `GET` 预览（不写库）、`POST` 执行。
   *
   * 只动科目名（`subject_key` / `subject_label`），金额、业务分录、财务手工调整过的行一律不动 ——
   * 草稿是财务还没过账的东西，不能像「重新生成」那样整张覆盖。与「重新生成」的分工就在这里：
   * 那个按来源整张重算（会覆盖手改），这个只把资金行的账户名对齐到新口径。
   */
  async fundLabelRefreshPreview() {
    const targets = await this.buildFundLabelRefresh();
    const changed = targets.filter((target) => target.changed);
    return {
      checked: targets.length,
      changed: changed.length,
      targets: targets.map((target) => ({ voucher_no: target.voucherNo, entry_no: target.entryNo, line_no: target.lineNo, before: target.before, after: target.after, changed: target.changed })),
    };
  }

  async refreshDraftFundLabels(user: CurrentUser) {
    const targets = (await this.buildFundLabelRefresh()).filter((target) => target.changed);
    for (const target of targets) {
      await this.prisma.voucherLine.update({
        where: { id: target.lineId },
        data: { subjectKey: target.afterKey, subjectLabel: target.after, ...this.audit.update(user) },
      });
      await this.audit.record("voucher.refresh_fund_label", "voucher", user.id, target.voucherId, {
        voucher_no: target.voucherNo, entry_no: target.entryNo, line_no: target.lineNo, before: target.before, after: target.after,
      });
    }
    return { changed: targets.length, vouchers: [...new Set(targets.map((target) => target.voucherNo))] };
  }

  /** 预览与执行共用：草稿凭证（来源=收支流水）的资金行，按来源流水现在的结算账户/银行账户重算科目名。 */
  private async buildFundLabelRefresh() {
    const drafts = await this.prisma.voucher.findMany({
      where: { deletedAt: null, status: "draft", sourceType: SOURCE_CASH_FLOW, sourceId: { not: null } },
      select: {
        id: true,
        voucherNo: true,
        sourceId: true,
        lines: { orderBy: { lineNo: "asc" }, select: { id: true, lineNo: true, subjectKey: true, subjectLabel: true, bankId: true } },
      },
    });
    const sourceIds = [...new Set(drafts.map((draft) => draft.sourceId).filter((id): id is string => Boolean(id)))];
    if (!sourceIds.length) return [];
    const entries = await this.prisma.cashFlowEntry.findMany({ where: { id: { in: sourceIds }, deletedAt: null }, include: ENTRY_INCLUDE });
    const entryById = new Map(entries.map((entry) => [entry.id, entry]));
    const targets: Array<{
      voucherId: string; voucherNo: string; entryNo: string; lineId: string; lineNo: number;
      before: string; after: string; afterKey: string; changed: boolean;
    }> = [];
    for (const draft of drafts) {
      const entry = draft.sourceId ? entryById.get(draft.sourceId) : undefined;
      // 来源流水被删/冲销：没有可重算的事实，留给财务点「重新生成」或人工处理，不在这里猜。
      if (!entry) continue;
      // 只读用途（回填资金行科目名）：不必解析科目 id，省一次查库。
      const next = (await this.draftForEntry(entry, { resolveIds: false })).lines.find((line) => line.subject_key === FUND_SUBJECT_BANK || line.subject_key === FUND_SUBJECT_CASH);
      if (!next) continue;
      // 现凭证里的资金行：先认银行账户引用，再退回科目名前缀（历史凭证可能没有账户引用）。
      const current = draft.lines.find((line) => line.bankId !== null)
        ?? draft.lines.find((line) => line.subjectLabel.startsWith(FUND_SUBJECT_BANK) || line.subjectLabel.startsWith(FUND_SUBJECT_CASH));
      if (!current) continue;
      targets.push({
        voucherId: draft.id, voucherNo: draft.voucherNo, entryNo: entry.entryNo, lineId: current.id, lineNo: current.lineNo,
        before: current.subjectLabel, after: next.subject_label, afterKey: next.subject_key,
        changed: current.subjectLabel !== next.subject_label || current.subjectKey !== next.subject_key,
      });
    }
    return targets;
  }

  /**
   * 落库一张凭证：**同一个来源最多一行「可写」的凭证**。
   *
   * 2026-11-09 R3-4 起唯一约束是**部分唯一索引**（迁移 `20261109130000_finance_governance_r3`）：
   *   `(source_type, source_id) WHERE deleted_at IS NULL AND status <> 'reversed' AND source_id IS NOT NULL`
   * —— 已红冲的历史行**不占键**，所以「红冲后按来源重算」可以直接 INSERT 新的一行，历史红字原样保留。
   *
   * 因此这里要找的「可写行」只有两种：
   *   ① 当前有效行（未删 + 未红冲）：并发/幂等窗口里撞上时按现在的内容重写它；
   *   ② **软删可复活**的行：删除草稿后重新生成沿用原凭证号，审计里「被删掉的那张」才对得上。
   * ⚠️ 已红冲的行既不复活也不改写（契约 D：红冲历史行不得删除/改写）；写 `status not "reversed"`
   * 一条条件同时表达①和②（软删行的 status 仍是 draft/posted）。
   *
   * 「资金搬运凭证纠正」（`repairCashTransferVouchers`）会删掉草稿挂账凭证，
   * 之后财务如果把那条应付回退成草稿再确认一次，走的正是复活这条路 —— 没有它就会 500。
   */
  private async createOrReviveVoucher(
    tx: Prisma.TransactionClient,
    source: { sourceType: string; sourceId: string | null },
    header: { voucherNo: string; voucherDate: Date; period: string; summary: string; currency: string; debitTotal: Prisma.Decimal; creditTotal: Prisma.Decimal; status: string; remark?: string | null },
    lines: LineWithSubjectRefs[],
    entryId: string | null,
    user: CurrentUser,
  ) {
    // 不带 `deletedAt` 过滤：要复活的恰恰是那张被软删的行；但必须排除已红冲的历史行（见方法注释），
    // 部分唯一索引也不把红冲行算作占位。`orderBy createdAt desc`：历史数据万一有多行时取最新，结果确定。
    const occupied = source.sourceId
      ? await tx.voucher.findFirst({
          where: { sourceType: source.sourceType, sourceId: source.sourceId, status: { not: "reversed" } },
          select: { id: true, voucherNo: true },
          orderBy: [{ createdAt: "desc" }],
        })
      : null;
    if (occupied) {
      await tx.voucherLine.deleteMany({ where: { voucherId: occupied.id } });
      await tx.voucherLine.createMany({ data: lines.map((line) => this.lineData(occupied.id, line, entryId, user)) });
      await tx.voucher.update({
        where: { id: occupied.id },
        // 凭证号沿用原来的：同一个来源换一个号会让「那张被删掉的凭证」在审计里对不上。
        data: { ...header, voucherNo: occupied.voucherNo, remark: header.remark ?? null, deletedAt: null, deletedBy: null, ...this.audit.update(user) },
      });
      return { id: occupied.id, voucherNo: occupied.voucherNo, revived: true };
    }
    const created = await tx.voucher.create({
      data: { ...header, sourceType: source.sourceType, sourceId: source.sourceId, remark: header.remark ?? null, ...this.audit.create(user) },
    });
    await tx.voucherLine.createMany({ data: lines.map((line) => this.lineData(created.id, line, entryId, user)) });
    return { id: created.id, voucherNo: created.voucherNo, revived: false };
  }

  /** 分录落库形状（新建、编辑、重新生成、红冲四处共用，避免字段漂移）。 */
  private lineData(voucherId: string, line: LineWithSubjectRefs, entryId: string | null, user: CurrentUser) {
    return {
      voucherId, lineNo: line.line_no, direction: line.direction,
      subjectKey: line.subject_key, subjectLabel: line.subject_label, summary: line.summary,
      amount: new Prisma.Decimal(line.amount), currency: line.currency,
      cashFlowEntryId: line.cash_flow_entry_id ?? entryId,
      bankId: line.bank_id ?? null,
      // R3-1 / 契约 C：记账科目 id（解析不到为 null，读取方回退 subject_label）
      // + 业务科目（辅助维度）id 与名称快照。三个字段都不参与借贷方向与金额。
      subjectId: line.subject_id ?? null,
      businessSubjectId: line.business_subject_id ?? null,
      businessSubjectLabel: line.business_subject_label ?? null,
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
        // R3-1：显式给的主科目 id / 业务科目 id 原样带下去（`undefined` = 交给 withLineSubjects 按名解析）。
        subject_id: line.subject_id,
        business_subject_id: line.business_subject_id,
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
  private async assertBanks(bankIds: Array<string | null | undefined>, db: PrismaService | Prisma.TransactionClient = this.prisma): Promise<void> {
    const ids = [...new Set(bankIds.filter((id): id is string => Boolean(id)))];
    if (!ids.length) return;
    const found = await db.bank.findMany({ where: { id: { in: ids }, deletedAt: null }, select: { id: true } });
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

  private invalid(code: string, message: string, details: Array<Record<string, unknown>> = []) { return new UnprocessableEntityException({ code, message, details }); }
  private notFound(code: string, message: string) { return new NotFoundException({ code, message, details: [] }); }
}
