import type { ReportCell, ReportColumn, ReportTable } from "./finance-report.types";

/**
 * 记账凭证导出（2026-10-13）。
 *
 * 用户原话：「财务模块，记账凭证中，摘要也要一并导出。」
 *
 * **一行一条分录**，不是一张凭证一行：摘要与会计科目是**分录行**上的字段
 * （`voucher_lines.summary` / `subject_label`），凭证头上只有一个总摘要 —— 一行一张凭证的话，
 * 财务拿到的表里看不到"每一行记到什么科目、凭什么"，而那正是她要的摘要。
 * 同一张凭证的多行共用前几列（凭证号/日期/期间/状态/来源），这是刻意的：
 * Excel 里可以按凭证号筛选，比再拆一张"头表 + 行表"好读。
 *
 * 列序照页面上那张凭证纸：先认出是哪张凭证，再是要看的那一行，最后是币种与备注。
 * 「借方金额 / 贷方金额」分两列（照凭证纸），**没有的那一边是空单元格**（纸张上也是空着的；
 * 写 0 会让人以为"这一行借贷各有一笔 0"，而 0 在金额列是"确实为零"的事实）。
 *
 * 本表**不设合计列**：一列里混着多个币种，跨币种相加没有意义（与收支明细表同一条口径，R7）。
 * 每张凭证的借贷合计在凭证头上（页面与凭证图上都有），导出表里逐行相加即可核对。
 */
export const VOUCHER_EXPORT_COLUMNS: ReportColumn[] = [
  { header: "凭证号", width: 24 },
  { header: "日期", width: 12 },
  { header: "期间", width: 10 },
  { header: "状态", width: 10 },
  { header: "来源", width: 26 },
  { header: "行号", width: 6 },
  { header: "摘要", width: 40 },
  { header: "会计科目", width: 26 },
  { header: "借方金额", width: 16, numFmt: "0.0000", align: "right" },
  { header: "贷方金额", width: 16, numFmt: "0.0000", align: "right" },
  { header: "币种", width: 10 },
  { header: "备注", width: 30 },
];

/** 导出用的最小行形状（`VoucherService.list()` 的返回，只取这里用得到的列）。 */
export type VoucherExportSource = {
  voucherNo: string;
  voucherDate: Date | string;
  period: string;
  /** 中文状态（服务层的 `status_label`；没有就用原值）。 */
  statusLabel?: string | null;
  status?: string | null;
  /** 来源的文字（收支流水号 / 红冲 / 手工），没有就留空。 */
  sourceLabel?: string | null;
  summary: string;
  currency: string;
  remark?: string | null;
  /** `amount` 是 Prisma `Decimal`（有 `toString()`）：这里只要求"能转成数"，不耦合 Decimal 类型。 */
  lines: Array<{ lineNo: number; summary?: string | null; subjectLabel: string; direction: string; amount: string | number | { toString(): string } | null }>;
};

/** 金额 → Excel 数值：字符串先去掉千分位与币种符号（导出的是**不带币种**的数，币种单独一列）。 */
function toNumber(value: string | number | { toString(): string } | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const cleaned = String(value).replace(/,/g, "").trim();
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

export function buildVoucherExportTable(rows: VoucherExportSource[]): ReportTable {
  const body: ReportCell[][] = [];
  for (const voucher of rows) {
    const date = voucher.voucherDate instanceof Date ? voucher.voucherDate.toISOString().slice(0, 10) : String(voucher.voucherDate ?? "").slice(0, 10);
    const status = voucher.statusLabel ?? voucher.status ?? "";
    // 一张没有任何分录的凭证（理论上不该有）也要出现在表里：凭证在清单上有、导出里没有，
    // 财务只会以为导出漏了。给一行空分录，摘要列写凭证总摘要。
    const lines = voucher.lines.length ? voucher.lines : [{ lineNo: 0, summary: voucher.summary, subjectLabel: "", direction: "", amount: "" }];
    for (const line of lines) {
      body.push([
        voucher.voucherNo,
        date,
        voucher.period,
        status,
        voucher.sourceLabel ?? "",
        line.lineNo || null,
        // 分录行没写摘要时回退凭证总摘要 —— 与页面上的凭证纸、导出的 PNG 同一口径
        // （三处各判一次的话，屏幕上有一句、导出的表里空着，财务会以为导出坏了）。
        (line.summary ?? "").trim() || voucher.summary,
        line.subjectLabel,
        line.direction === "debit" ? toNumber(line.amount) : null,
        line.direction === "credit" ? toNumber(line.amount) : null,
        voucher.currency,
        voucher.remark ?? "",
      ]);
    }
  }
  return {
    sheetName: "记账凭证",
    columns: VOUCHER_EXPORT_COLUMNS,
    rows: body,
    footnotes: [
      "一行一条分录：摘要与会计科目都在分录行上（凭证头上的只是总摘要）。",
      "「借方金额 / 贷方金额」分列，没有的那一边是空单元格（与凭证纸一致）；金额不带币种符号，币种见「币种」列。",
      "本表不设合计列：一列里可能混着多个币种，跨币种相加没有意义。",
    ],
  };
}
