// 建账期初余额面板的纯逻辑（**不能**放进 "use client" 文件）。
//
// 财务 2026-09-24：「1,3,4 都要」的第 ③ 件 —— 科目期初余额表。
// 为什么需要它：银行账户档案里只有**货币资金**的期初余额，其它科目没有；只把货币资金期初加进资产侧，
// 资产负债表的勾稽永远差一个期初余额。财务录一次全科目期初（试算平衡的借/贷两侧），勾稽才真正为 0。
//
// 界面口径（与后端 `opening-balance.service.ts` 逐条对应）：
//   - 金额存「方向 + 正数金额」：方向是借/贷，金额不写负数；
//   - **整批替换**：界面上这张表就是「我现在的期初」，保存时整批发出去（不是逐行增删）；
//   - 借贷不平衡**不拦**，但必须实时显示合计与差额（报表那边会因为这个数不平）。

// 金额按「整数 1e-4」用 BigInt 相加。
//
// ⚠️ 下面这两个小函数与 `lib/voucher-lines.ts` 的 `parseCents` / `formatCents` **同一形状、同一正则**。
// 为什么不去 import 它：`lib/*.test.mjs` 用 node:test 直接跑 `.ts`，而 Node 的 ESM 解析器
// 解析不了「无扩展名的同级导入」（`./voucher-lines` 会 ERR_MODULE_NOT_FOUND）——
// 被 node:test 覆盖的 lib 模块因此**保持自包含**（`finance-slip.ts` 也是这么做的）。
// 改动这两个函数时，`voucher-lines.ts` 里的那一对要一起改（形状必须一致：都是最多 4 位小数）。

const AMOUNT = /^(\d+)(?:\.(\d{1,4}))?$/;

/** 金额文本 → 整数「1e-4」；非法（含负数、超过 4 位小数）返回 null。 */
export function parseOpeningAmount(text: string): bigint | null {
  const match = AMOUNT.exec((text ?? "").trim());
  if (!match) return null;
  const [, whole, fraction = ""] = match;
  return BigInt(`${whole}${fraction.padEnd(4, "0")}`);
}

/** 整数「1e-4」→ 十进制字符串（去掉无意义的尾零）。 */
export function formatOpeningAmount(units: bigint): string {
  const fraction = (units % 10000n).toString().padStart(4, "0").replace(/0+$/, "");
  return fraction ? `${units / 10000n}.${fraction}` : `${units / 10000n}`;
}

export type OpeningDirection = "debit" | "credit";

/** 后端返回的一行期初余额。 */
export type OpeningBalanceRow = {
  subject_key: string;
  subject_label: string;
  direction: string;
  amount: string;
  remark?: string | null;
};

/** 编辑器里的一行（多一个 React key）：金额在界面上是字符串，提交前只 trim。 */
export type OpeningEditorRow = {
  key: string;
  subjectKey: string;
  subjectLabel: string;
  direction: OpeningDirection;
  amount: string;
  remark: string;
};

/** 期初余额接口路径（走 apiGet/apiRequest，前缀由 api-client 补）。 */
export const OPENING_BALANCES_PATH = "/finance/opening-balances";

/** 稳定且不会撞的行 key。 */
let sequence = 0;
export function nextOpeningRowKey(): string {
  sequence += 1;
  return `opening-row-${sequence}`;
}

/** 编辑器的科目下拉选项形状（与会计科目页共用一套标签：`分类 / 名称`）。 */
export type OpeningSubject = { id: string; category: string; name: string };

/** 科目键：与凭证、期初余额表同一口径（`分类/名称`）。 */
export function subjectKeyOf(subject: Pick<OpeningSubject, "category" | "name">): string {
  return `${subject.category}/${subject.name}`;
}

/** 新建一行：默认借方（试算平衡表里资产/成本在借方的居多）。 */
export function emptyOpeningRow(key: string = nextOpeningRowKey()): OpeningEditorRow {
  return { key, subjectKey: "", subjectLabel: "", direction: "debit", amount: "", remark: "" };
}

/** 后端行 → 编辑器行（科目下拉按 `分类/名称` 反查，查不到时用快照名兜底显示）。 */
export function openingRowsFromApi(rows: readonly OpeningBalanceRow[]): OpeningEditorRow[] {
  return rows.map((row) => ({
    key: nextOpeningRowKey(),
    subjectKey: row.subject_key,
    subjectLabel: row.subject_label || row.subject_key,
    direction: row.direction === "credit" ? "credit" : "debit",
    amount: row.amount,
    remark: row.remark ?? "",
  }));
}

export type OpeningTotals = { debit: string; credit: string; difference: string; balanced: boolean; invalid: boolean };

/**
 * 借贷合计与差额（界面实时显示）。
 *
 * `invalid` = 有金额不是合法正数（`abc` / `-5` / `0`）—— 与「还没填」分开：
 * 前者要红字告诉财务哪一行写错了，后者只是这一行还没填完。
 * 整张空表（一行金额都没填）算平：借/贷都是 0，不该显示「借贷不平」吓人。
 */
export function openingTotals(rows: readonly OpeningEditorRow[]): OpeningTotals {
  let debit = 0n;
  let credit = 0n;
  let invalid = false;
  for (const row of rows) {
    const text = (row.amount ?? "").trim();
    if (!text) continue;
    const units = parseOpeningAmount(text);
    if (units === null || units <= 0n) { invalid = true; continue; }
    if (row.direction === "credit") credit += units;
    else debit += units;
  }
  const difference = debit > credit ? debit - credit : credit - debit;
  return {
    debit: formatOpeningAmount(debit),
    credit: formatOpeningAmount(credit),
    difference: formatOpeningAmount(difference),
    // 非法金额（`abc` / `-5`）时不算平：界面上不能一边标着「金额写错了」一边说「借贷平衡」。
    balanced: debit === credit && !invalid,
    invalid,
  };
}

/** 有内容的行（整行都没填的行丢掉，不挡保存 —— 与收/付款单、凭证编辑器同一约定）。 */
export function openingRowsToSave(rows: readonly OpeningEditorRow[]): OpeningEditorRow[] {
  return rows.filter((row) => row.subjectKey.trim() || row.amount.trim() || row.remark.trim());
}

/**
 * 编辑器状态 → `PUT /finance/opening-balances` 的请求体。
 *
 * **整批提交**：界面上的这张表就是「我现在的期初」，服务层整批替换（没出现的行会被软删）——
 * 逐行提交会让「删掉一行」变成额外的删除动作，而财务的心智里没有这一步。
 */
export function openingPayload(asOfDate: string, currency: string, rows: readonly OpeningEditorRow[]) {
  return {
    as_of_date: asOfDate.trim(),
    currency: currency.trim().toUpperCase() || "CNY",
    rows: openingRowsToSave(rows).map((row) => ({
      subject_key: row.subjectKey.trim(),
      subject_label: row.subjectLabel.trim() || row.subjectKey.trim(),
      direction: row.direction,
      amount: row.amount.trim(),
      remark: row.remark.trim() || undefined,
    })),
  };
}

/**
 * 保存前能拦住的问题（**返回全部原因**，一次说完）。
 *
 * 借贷不平**不拦**（财务可能分批录）—— 报表会因为不平而不平，那是财务的决策依据，
 * 界面上实时显示差额就够了，不该把保存挡掉。
 */
export function openingBlockers(rows: readonly OpeningEditorRow[], asOfDate: string): string[] {
  const problems: string[] = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOfDate.trim())) problems.push("请选择建账日期");
  openingRowsToSave(rows).forEach((row, index) => {
    const at = index + 1;
    if (!row.subjectKey.trim()) problems.push(`第 ${at} 行请选择会计科目`);
    const text = row.amount.trim();
    const units = text ? parseOpeningAmount(text) : null;
    if (!text) problems.push(`第 ${at} 行请填写期初金额`);
    else if (units === null || units <= 0n) problems.push(`第 ${at} 行金额必须是大于零的数字（最多 4 位小数）`);
  });
  return problems;
}
