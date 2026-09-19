/**
 * 记账凭证的纯逻辑：收支流水 → 借贷分录。
 *
 * 与 Nest/Prisma 完全解耦，便于用 node:test 直接跑（apps/api/test/unit/voucher-domain.test.cjs）。
 *
 * ## 科目从哪来（2026-09-17 起：正式科目表）
 *
 * 用户 2026-09-17 交付了 `example/财务/科目表(2).xls`，收支流水的分类从此是**会计科目**
 * （`accounting_subjects`：分类 = 科目类别，项目 = 科目名称）。凭证的业务科目直接取它：
 *   - 损益/成本类科目 = 会计科目名称（主营业务收入 / 主营业务成本 / 管理费用 …）——
 *     财务本来就是按这张表分类的；
 *   - 资金类科目 = 银行存款 / 库存现金（按结算方式或结算账户名里是否含「现金」二选一）。
 * 分录永远是「一借一贷、金额相等」，因此凭证在形式上就是标准复式凭证。
 *
 * 本文件顶部原来写着「将来接入正式科目表时只需要改 subjectKey/subjectLabel 的取值来源」——
 * 那次改动就发生在 `voucher.service.ts` 的 `draftForEntry`（科目名 + `分类/项目` 作为科目编码），
 * 凭证与分录模型、页面、打印视图都一行没动，验证了当时的判断。
 */

/** 资金类科目：默认银行存款。 */
export const FUND_SUBJECT_BANK = "银行存款";
/** 资金类科目：结算方式/账户里出现「现金」时用库存现金。 */
export const FUND_SUBJECT_CASH = "库存现金";

export type VoucherDirection = "debit" | "credit";

export type VoucherLineDraft = {
  line_no: number;
  direction: VoucherDirection;
  subject_key: string;
  subject_label: string;
  summary: string;
  /** 恒为正数的金额字符串（与收支流水同一约定：方向由 direction 决定）。 */
  amount: string;
  currency: string;
  /** 资金类分录引用的具体银行账户（库存现金与非资金类分录为 null）。 */
  bank_id?: string | null;
};

/** 生成凭证时的来源流水（只取用得到的字段，避免与 Prisma 类型耦合）。 */
export type CashFlowEntryForVoucher = {
  entryNo: string;
  entryDate: Date | string;
  counterpartyName: string;
  direction: string;
  /** Decimal 或字符串都能接受：domain 不参与金额运算，只做字符串透传。 */
  amount: { toString(): string } | string;
  currency: string;
  /** 会计科目编码快照：`分类/项目`（科目表没有唯一编码，两段拼起来才唯一）。 */
  subjectKey: string;
  /** 会计科目名称快照。 */
  subjectLabel: string;
  settlementMethod?: string | null;
  settlementAccountLabel?: string | null;
  remark?: string | null;
  /**
   * 这笔钱落在哪个银行账户（`cash_flow_entries.bank_id`）。
   *
   * 有了它，资金类科目就不再只是一句「银行存款」：科目名仍是银行存款，但分录**引用**这个账户，
   * 科目名快照写成「银行存款—农业银行5706」，打印出来的凭证自己就说明是哪本账。
   */
  bankId?: string | null;
  bankLabel?: string | null;
};

/** 资金科目：结算方式或结算账户名里含「现金」→ 库存现金，否则银行存款。 */
export function fundSubjectFor(hint?: string | null): string {
  return hint && hint.includes("现金") ? FUND_SUBJECT_CASH : FUND_SUBJECT_BANK;
}

/**
 * 资金类分录：科目名 + **具体银行账户**。
 *
 * 判定顺序（显式引用优先于文本猜测）：
 *   1. 流水上挂了 `bank_id`（财务在收付款/确认时从银行池里选的账户）→ 银行存款 + 该账户；
 *   2. 否则按结算方式/结算账户名里有没有「现金」猜 库存现金 / 银行存款（历史数据只有文本）。
 *
 * 科目名（`subject_key`）保持「银行存款」不变 —— 它才是会计科目；账户是明细/辅助核算引用
 * （`bank_id` + 科目名快照），这样「银行存款」仍然能汇总，同时能按账户出明细账。
 */
export function fundLineFor(entry: Pick<CashFlowEntryForVoucher, "bankId" | "bankLabel" | "settlementMethod" | "settlementAccountLabel">): { subject_key: string; subject_label: string; bank_id: string | null } {
  const subject = entry.bankId ? FUND_SUBJECT_BANK : fundSubjectFor(entry.settlementAccountLabel ?? entry.settlementMethod);
  if (subject !== FUND_SUBJECT_BANK) return { subject_key: subject, subject_label: subject, bank_id: null };
  // 没有账户名快照时退回科目名本身：宁可不写账户，也不要写一个空的「银行存款—」。
  const account = entry.bankLabel?.trim();
  return { subject_key: subject, subject_label: account ? `${subject}—${account}` : subject, bank_id: entry.bankId ?? null };
}

/** 摘要：对方 + 会计科目（+ 备注），并裁剪到 500 字以内（列宽 VARCHAR(500)）。 */
export function voucherSummaryFor(parts: { counterpartyName: string; subjectLabel: string; remark?: string | null }): string {
  const head = [parts.counterpartyName, parts.subjectLabel].filter((text) => Boolean(text && text.trim()));
  const base = head.join(" · ");
  const remark = parts.remark?.trim();
  const text = remark ? `${base}（${remark}）` : base;
  return text.slice(0, 500);
}

/**
 * 收支流水 → 一借一贷分录。
 *
 * - 收入：借 银行存款/库存现金，贷 会计科目（钱进来了，科目是收入侧）
 * - 支出：借 会计科目，贷 银行存款/库存现金（钱出去了）
 */
export function voucherLinesFor(entry: CashFlowEntryForVoucher): VoucherLineDraft[] {
  const amount = typeof entry.amount === "string" ? entry.amount : entry.amount.toString();
  const income = entry.direction === "income";
  const summary = voucherSummaryFor(entry);
  const businessLine = { subject_key: entry.subjectKey, subject_label: entry.subjectLabel };
  const fundLine = fundLineFor(entry);
  const debit = income ? fundLine : businessLine;
  const credit = income ? businessLine : fundLine;
  return [
    { line_no: 1, direction: "debit", ...debit, summary, amount, currency: entry.currency },
    { line_no: 2, direction: "credit", ...credit, summary, amount, currency: entry.currency },
  ];
}

/** 会计期间 YYYY-MM（按凭证日期；收支流水有 entry_date，凭证日期取它）。 */
export function voucherPeriodFor(date: Date | string): string {
  return (typeof date === "string" ? date : date.toISOString()).slice(0, 7);
}

/**
 * 红字凭证的分录：把原凭证的借/贷**对调**（金额不变）。
 * 红冲是「另开一张反向凭证」而不是删原凭证 —— 已过账的凭证不能消失（保留历史事实）。
 */
export function reverseLines(source: Array<{ direction: string; subject_key: string; subject_label: string; summary: string; amount: { toString(): string } | string; currency: string; bank_id?: string | null }>): VoucherLineDraft[] {
  return source.map((line, index) => ({
    line_no: index + 1,
    direction: line.direction === "debit" ? "credit" : "debit",
    subject_key: line.subject_key,
    subject_label: line.subject_label,
    summary: `红冲：${line.summary}`.slice(0, 500),
    amount: typeof line.amount === "string" ? line.amount : line.amount.toString(),
    currency: line.currency,
    // 银行账户引用照旧带过去：红字凭证同样要指向那张卡，否则银行存款明细账上会凭空少一笔对不上。
    bank_id: line.bank_id ?? null,
  }));
}

/**
 * 借贷合计是否平衡，以及每行金额是否为正。
 *
 * 用字符串大数比较会引入依赖，所以这里只做「按分位对齐后的十进制加法」：
 * 金额统一由 Prisma.Decimal 序列化成 4 位小数的字符串，转成整数分即可精确比较
 * （18,4 的 Decimal 最大 18 位，转成整数分后仍远小于 Number.MAX_SAFE_INTEGER）。
 */
export function voucherBalance(lines: Array<{ direction: string; amount: { toString(): string } | string }>): { debit: bigint; credit: bigint; balanced: boolean } {
  let debit = 0n;
  let credit = 0n;
  for (const line of lines) {
    const text = typeof line.amount === "string" ? line.amount : line.amount.toString();
    const cents = toCents(text);
    if (line.direction === "debit") debit += cents;
    else credit += cents;
  }
  return { debit, credit, balanced: debit === credit };
}

/** 4 位小数的金额字符串 → 整数「分」。非数字直接抛错（调用方会包成 422）。 */
function toCents(text: string): bigint {
  const match = /^(-?)(\d+)(?:\.(\d{1,4}))?$/.exec(text.trim());
  if (!match) throw new Error(`INVALID_AMOUNT:${text}`);
  const [, sign, whole, fraction = ""] = match;
  const padded = fraction.padEnd(4, "0");
  return BigInt(`${sign}${whole}${padded}`);
}
