// 收/付款单编辑器的纯逻辑（**不能**放进 "use client" 文件）。
//
// 财务 2026-09-20：「她需要在付款界面能导出付款单……允许用户编辑付款单中的一些字段。
// 比如我要付款 100，我可以自己填加行，我可以写付款备注」，随后补一句「同理，收款单的编辑和导出」。
//
// 关键决定：**单子不落库** —— 它是一张打印件（银行单据），不是系统单据。所以这一块只有两件事：
//   1. 从后端预填一张（`/finance/{payment,receipt}-slips/draft`：单号 / 对方单位 / 开户行 / 科目 / 借贷行）；
//   2. 财务在界面上改（金额、增删行、备注）后提交给 `/finance/{payment,receipt}-slips.xlsx` 出文件。
//
// 两种单据共用这一份实现，只在**用词**与「钱走哪一侧」上不同（`slipLabels`）——
// 与后端 `apps/api/src/modules/finance/finance-slip.ts` 是同一条口径。
//
// 本模块给编辑器提供可单测的骨架：行的形状与序列化、借贷合计与平衡判定、以及**导出按钮该不该禁用**
// 的那几条原因（与后端 `validateFinanceSlip` 同一套规则，所以不会出现「界面说能导出、后端说不行」）。
//
// 金额一律按「整数分」用 BigInt 相加（与凭证分录编辑器同一条理由）：浮点求和会出现
// `0.1 + 0.2 = 0.30000000000000004`，而这张单要拿合计去和财务逐位比对、还要决定按钮能不能点。
//
// ⚠️ 「人民币大写」刻意**不在这里实现**：它是导出的那份文件里的权威字段，只有后端一份实现。
// 前端要预览时应调接口，而不是再抄一套「金额转中文」的规则。

export type FinanceSlipKind = "payment" | "receipt";

/** 编辑器里的一行（六格 + 一个 React key）。 */
export type FinanceSlipEditorLine = {
  /**
   * 前端行标识。**不能用下标**：增删行之后下标会错位，React 会把上一行的输入框复用给下一行
   * （用户看到的是「删掉的行又变了」）。
   */
  key: string;
  summary: string;
  general_subject: string;
  detail_subject: string;
  debit: string;
  credit: string;
  remark: string;
};

/** 单子的表头（模板上表头那四行 + 备注 + 制单人）。字段名与种类无关，用词由 `slipLabels` 决定。 */
export type FinanceSlipHeader = {
  slip_no: string;
  slip_date: string;
  slip_method: string;
  counterparty_name: string;
  bank_name: string;
  bank_account: string;
  attachment_count: number;
  remark: string;
  maker: string;
};

/** 后端预填接口的返回：种类 + 表头 + 分录行。 */
export type FinanceSlipDraft = FinanceSlipHeader & { kind: FinanceSlipKind; lines: Array<Omit<FinanceSlipEditorLine, "key">> };

/**
 * 两种单据的用词。
 *
 * ⚠️ 这份文案必须与 `apps/api/src/modules/finance/finance-slip.ts` 的 `slipLabels(kind)` 逐字一致
 * （两个 workspace 之间没有共享包，只能各有一份 —— 与 `audit-time` / `beijing-time` 同一处理）。
 * 不一致的后果是界面上的列头与导出的文件对不上，而财务会拿界面上的话去核对文件。
 */
export const SLIP_LABELS = {
  payment: {
    name: "付款单", counterparty: "收款单位", date: "付款日期", method: "付款方式", remark: "付款备注",
    summary: "摘要", generalSubject: "总账科目", detailSubject: "明细科目",
    debit: "借方金额", credit: "贷方金额", remarkColumn: "备注", maker: "制单人",
  },
  receipt: {
    name: "收款单", counterparty: "付款单位", date: "收款日期", method: "收款方式", remark: "收款备注",
    summary: "摘要", generalSubject: "总账科目", detailSubject: "明细科目",
    debit: "借方金额", credit: "贷方金额", remarkColumn: "备注", maker: "制单人",
  },
} as const satisfies Record<FinanceSlipKind, Record<string, string>>;

export type SlipLabelSet = (typeof SLIP_LABELS)[FinanceSlipKind];

export function slipLabels(kind: FinanceSlipKind): SlipLabelSet {
  return SLIP_LABELS[kind];
}

/**
 * 预填接口的路径。
 *
 * 注意前缀：这条走 `apiPost`，而 `api-client` 会自己补 `/api/v1`（`api-client.ts:32`），
 * 所以这里**不能**带前缀。导出那条（`financeSlipExportPath`）恰恰相反 —— 两者必须分开看。
 */
export function financeSlipDraftPath(kind: FinanceSlipKind): string {
  return `/finance/${kind === "payment" ? "payment" : "receipt"}-slips/draft`;
}

/**
 * 导出接口的路径。
 *
 * ⚠️ 必须自带 `/api/v1` 前缀：导出走的是 `downloadPost`（**裸 fetch**，见 lib/download.ts），
 * 它不像 `api-client` 那样补前缀。少了这三个字，请求会打到 Web 服务而不是 API，
 * 拿回一个 404 的 HTML —— 用户看到的是「导出失败」，而网络面板里那条请求根本没到过后端。
 * 全站其余下载（台账、工资付款表）也都是在调用处写全 `/api/v1/...`，这里是同一件事。
 */
export function financeSlipExportPath(kind: FinanceSlipKind): string {
  return `/api/v1/finance/${kind === "payment" ? "payment" : "receipt"}-slips.xlsx`;
}

/**
 * 预填请求体。
 *
 * 付款单勾的是**应付条目**、收款单勾的是**应收来源**，两边的主键在各自表里，
 * 所以字段名必须分开（后端两个 DTO 也是这样分的）—— 用同一个 `ids` 会让「传错表」变成一个
 * 只有运行时才暴露的错误。
 */
export function financeSlipDraftBody(kind: FinanceSlipKind, ids: string[]): Record<string, string[]> {
  return kind === "payment" ? { payable_entry_ids: ids } : { receivable_source_ids: ids };
}

/** 新建一行的默认值：借方 + 空摘要/科目/金额（用户要「自己填加行」，所以默认就该是借方一行）。 */
export function emptyFinanceSlipLine(key: string): FinanceSlipEditorLine {
  return { key, summary: "", general_subject: "", detail_subject: "", debit: "", credit: "", remark: "" };
}

/** 稳定且不会重复的行 key（同一毫秒内连点两次「新增行」不能撞）。 */
let lineSequence = 0;
export function nextFinanceSlipLineKey(): string {
  lineSequence += 1;
  return `slip-line-${lineSequence}`;
}

/** 后端预填的分录 → 编辑器行。 */
export function slipLinesFromDraft(lines: readonly Omit<FinanceSlipEditorLine, "key">[]): FinanceSlipEditorLine[] {
  return lines.map((line) => ({ ...emptyFinanceSlipLine(nextFinanceSlipLineKey()), ...line }));
}

/**
 * 金额文本 → 整数「分」（1e-4 精度）。非法或 ≤ 0 返回 null。
 *
 * 正则与后端 `finance-slip.ts` 的 `MONEY` 完全一致（最多 4 位小数，与 DECIMAL(18,4) 对齐）。
 */
export function parseSlipAmount(text: string): bigint | null {
  const match = /^(\d+)(?:\.(\d{1,4}))?$/.exec((text ?? "").trim());
  if (!match) return null;
  const [, whole, fraction = ""] = match;
  const units = BigInt(`${whole}${fraction.padEnd(4, "0")}`);
  return units > 0n ? units : null;
}

/** 整数「分」→ 十进制字符串（去掉无意义的尾零）。 */
export function formatSlipAmount(units: bigint): string {
  const fraction = (units % 10000n).toString().padStart(4, "0").replace(/0+$/, "");
  return fraction ? `${units / 10000n}.${fraction}` : `${units / 10000n}`;
}

export type SlipTotals = { debit: string; credit: string; balanced: boolean; invalid: boolean; empty: boolean };

/**
 * 借贷合计。
 *
 * 与后端同一套规则：一行同时填两侧算 `invalid`（这一行自己就不平），两侧都空算「还没填完」。
 */
export function slipTotals(lines: readonly FinanceSlipEditorLine[]): SlipTotals {
  let debit = 0n;
  let credit = 0n;
  let invalid = false;
  let money = false;
  for (const line of lines) {
    const left = parseSlipAmount(line.debit);
    const right = parseSlipAmount(line.credit);
    const leftText = (line.debit ?? "").trim();
    const rightText = (line.credit ?? "").trim();
    if (left !== null && right !== null) { invalid = true; continue; }
    if (!leftText && !rightText) continue;
    if (leftText && left === null) { invalid = true; continue; }
    if (rightText && right === null) { invalid = true; continue; }
    money = true;
    if (left !== null) debit += left; else credit += right!;
  }
  return {
    debit: formatSlipAmount(debit),
    credit: formatSlipAmount(credit),
    balanced: money && debit > 0n && debit === credit,
    invalid,
    empty: !money,
  };
}

/** 这一行有没有写过东西（六个格子全空 = 财务新加了一行但还没填，导出时整行丢掉，不挡着导出）。 */
export function slipLineHasContent(line: FinanceSlipEditorLine): boolean {
  return [line.summary, line.general_subject, line.detail_subject, line.debit, line.credit, line.remark]
    .some((value) => (value ?? "").trim() !== "");
}

/** 导出的行 = 真正填过内容的行（全空行不提交：它会在后端变成「第 N 行请填金额」而挡住整张单）。 */
export function financeSlipLines(lines: readonly FinanceSlipEditorLine[]): FinanceSlipEditorLine[] {
  return lines.filter(slipLineHasContent);
}

/**
 * 导出按钮该不该禁用 —— **返回全部原因**（不是第一个）。
 *
 * 与后端 `validateFinanceSlip` 逐条对应：界面先拦一次只是为了让财务别走到「点了导出才被告知」，
 * 后端仍然会再校验一次（两处同一套规则，结论不会分叉）。
 */
export function financeSlipBlockers(kind: FinanceSlipKind, header: FinanceSlipHeader, lines: readonly FinanceSlipEditorLine[]): string[] {
  const labels = slipLabels(kind);
  const problems: string[] = [];
  if (!header.slip_no.trim()) problems.push("请填写单据编号");
  if (!header.counterparty_name.trim()) problems.push(`请填写${labels.counterparty}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(header.slip_date ?? "")) problems.push(`请选择${labels.date}`);
  if (!Number.isInteger(header.attachment_count) || header.attachment_count < 0) problems.push("附单据张数必须是非负整数");

  const filled = financeSlipLines(lines);
  if (filled.length === 0) { problems.push("请至少填写一行分录"); return problems; }
  filled.forEach((line, index) => {
    const row = index + 1;
    if (!line.summary.trim() && !line.general_subject.trim()) problems.push(`第 ${row} 行请填写摘要或总账科目`);
    const leftText = line.debit.trim();
    const rightText = line.credit.trim();
    if (leftText && rightText) { problems.push(`第 ${row} 行不能同时填写借方与贷方金额`); return; }
    if (!leftText && !rightText) { problems.push(`第 ${row} 行请填写借方或贷方金额`); return; }
    if ((leftText ? parseSlipAmount(leftText) : parseSlipAmount(rightText)) === null) problems.push(`第 ${row} 行金额必须是大于零的数字（最多 4 位小数）`);
  });
  if (problems.length) return problems;

  const totals = slipTotals(filled);
  if (totals.empty) problems.push("请至少填写一行有金额的分录");
  else if (!totals.balanced) problems.push(`借贷不平衡：借方 ${totals.debit} / 贷方 ${totals.credit}（差额 ${slipDifference(totals)}）`);
  return problems;
}

/** 借贷差额（绝对值，用于提示文案）。 */
export function slipDifference(totals: SlipTotals): string {
  const debit = parseSlipAmount(totals.debit) ?? 0n;
  const credit = parseSlipAmount(totals.credit) ?? 0n;
  return formatSlipAmount(debit > credit ? debit - credit : credit - debit);
}

/** 编辑器状态 → 导出接口的请求体（丢掉 key、空行，并把表头字段 trim）。 */
export function financeSlipPayload(kind: FinanceSlipKind, header: FinanceSlipHeader, lines: readonly FinanceSlipEditorLine[]) {
  return {
    kind,
    slip_no: header.slip_no.trim(),
    slip_date: header.slip_date,
    slip_method: header.slip_method.trim(),
    counterparty_name: header.counterparty_name.trim(),
    bank_name: header.bank_name.trim(),
    bank_account: header.bank_account.trim(),
    attachment_count: header.attachment_count,
    remark: header.remark.trim(),
    maker: header.maker.trim(),
    lines: financeSlipLines(lines).map((line) => ({
      summary: line.summary.trim(),
      general_subject: line.general_subject.trim(),
      detail_subject: line.detail_subject.trim(),
      debit: line.debit.trim(),
      credit: line.credit.trim(),
      remark: line.remark.trim(),
    })),
  };
}

/**
 * 单子导出后的兜底文件名（与后端 `Content-Disposition` 给出的那份一致）。
 *
 * 前端也拼一份是因为 `downloadPost` 只在响应头缺失时才用兜底名 —— 正常情况下以响应头为准。
 */
export function financeSlipFileName(kind: FinanceSlipKind, slipNo: string): string {
  return `${kind === "payment" ? "迪礼付款单" : "迪礼收款单"}-${slipNo.trim() || "未编号"}.xlsx`;
}
