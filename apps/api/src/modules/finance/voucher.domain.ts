/**
 * 记账凭证的纯逻辑：收支流水 → 借贷分录。
 *
 * 与 Nest/Prisma 完全解耦，便于用 node:test 直接跑（apps/api/test/unit/voucher-domain.test.cjs）。
 *
 * ## 科目从哪来（当前口径，可替换）
 *
 * 库里**还没有正式会计科目表**（凭证管理页此前一直是占位，产品文档也把「会计科目」列在 V1 之外）。
 * 因此本期采用**业务科目口径**：
 *   - 损益/成本类科目 = 收支项目字典的 label（货款 / 原材料 成本 / 管理费用 / 人 工费 …）——
 *     财务本来就是按这张表分类的，等于把「收支项目」直接当科目用；
 *   - 资金类科目 = 银行存款 / 库存现金（按结算方式或结算账户名里是否含「现金」二选一）。
 * 分录永远是「一借一贷、金额相等」，因此凭证在形式上就是标准复式凭证。
 *
 * 将来接入正式科目表时，**只需要改本文件里 subjectKey/subjectLabel 的取值来源**
 * （例如查一张「收支项目 → 科目」映射），凭证与分录模型、页面、打印视图都不用动。
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
  itemKey: string;
  itemLabel: string;
  settlementMethod?: string | null;
  settlementAccountLabel?: string | null;
  remark?: string | null;
};

/** 资金科目：结算方式或结算账户名里含「现金」→ 库存现金，否则银行存款。 */
export function fundSubjectFor(hint?: string | null): string {
  return hint && hint.includes("现金") ? FUND_SUBJECT_CASH : FUND_SUBJECT_BANK;
}

/** 摘要：对方 + 收支项目（+ 备注），并裁剪到 500 字以内（列宽 VARCHAR(500)）。 */
export function voucherSummaryFor(parts: { counterpartyName: string; itemLabel: string; remark?: string | null }): string {
  const head = [parts.counterpartyName, parts.itemLabel].filter((text) => Boolean(text && text.trim()));
  const base = head.join(" · ");
  const remark = parts.remark?.trim();
  const text = remark ? `${base}（${remark}）` : base;
  return text.slice(0, 500);
}

/**
 * 收支流水 → 一借一贷分录。
 *
 * - 收入：借 银行存款/库存现金，贷 收支项目（钱进来了，科目是收入侧）
 * - 支出：借 收支项目，贷 银行存款/库存现金（钱出去了）
 */
export function voucherLinesFor(entry: CashFlowEntryForVoucher): VoucherLineDraft[] {
  const amount = typeof entry.amount === "string" ? entry.amount : entry.amount.toString();
  const income = entry.direction === "income";
  const fundSubject = fundSubjectFor(entry.settlementAccountLabel ?? entry.settlementMethod);
  const summary = voucherSummaryFor(entry);
  const businessLine = { subject_key: entry.itemKey, subject_label: entry.itemLabel };
  const fundLine = { subject_key: fundSubject, subject_label: fundSubject };
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
export function reverseLines(source: Array<{ direction: string; subject_key: string; subject_label: string; summary: string; amount: { toString(): string } | string; currency: string }>): VoucherLineDraft[] {
  return source.map((line, index) => ({
    line_no: index + 1,
    direction: line.direction === "debit" ? "credit" : "debit",
    subject_key: line.subject_key,
    subject_label: line.subject_label,
    summary: `红冲：${line.summary}`.slice(0, 500),
    amount: typeof line.amount === "string" ? line.amount : line.amount.toString(),
    currency: line.currency,
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
