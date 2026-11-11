import { NUMBER_FORMAT, toExportNumber } from "./finance-report.domain";
import type { ReportCell, ReportColumn, ReportTable } from "./finance-report.types";
import { formatStatementValue, type StatementLineValue } from "./finance-three-statements";
import type { BalanceSheetReport, CashFlowReport, IncomeStatementReport, StatementGap } from "./finance-three-statements.service";

/**
 * 三大报表的**版式**（纯函数）：把内核算出来的行值摆成 `ReportTable`。
 *
 * 列名与列序照抄财务给的标准格式（`example/财务/财务三大报表（标准格式）(2).xlsx`）：
 *   - 资产负债表：资产 / 行次 / 期末余额 / 年初余额 | 负债和所有者权益 / 行次 / 期末余额 / 年初余额（两栏对照）；
 *   - 利润表、现金流量表：项目 / 行次 / 本期金额 / 上期金额。
 *
 * 与模板的一处**有意**差异（写在表尾）：资产负债表的段落标题（「流动资产：」这类）不单独占一行 ——
 * 两栏按**行次**一一对齐，行次列本身就是模板的行次，段落标题不占行反而让两栏不错位
 * （模板里两栏的段落标题本来就不在同一 Excel 行上）。
 *
 * 金额一律经 `toExportNumber` 落成 Excel 数值（`finance-report-workbook.ts` 会拒绝字符串型数字）。
 */

const numeric = (header: string, width: number): ReportColumn => ({ header, width, numFmt: NUMBER_FORMAT });

/** 一行的金额 → 导出用数值（`null` 保持空单元格：缺数据不等于 0）。 */
function money(units: bigint | null): number | null {
  return toExportNumber(formatStatementValue(units));
}

/** 本期 / 上期两列的表（利润表、现金流量表）。段落行只写项目名。 */
function twoPeriodTable(
  sheetName: string,
  current: readonly StatementLineValue[],
  previous: readonly StatementLineValue[],
): ReportTable {
  const rows: ReportCell[][] = current.map((line, index) => {
    if (line.section) return [line.label, null, null, null];
    const before = previous[index];
    return [line.label, line.row, money(line.value), before ? money(before.value) : null];
  });
  return {
    sheetName,
    columns: [{ header: "项目", width: 46 }, { header: "行次", width: 6, align: "center" }, numeric("本期金额", 16), numeric("上期金额", 16)],
    rows,
  };
}

/** 缺口与口径说明（每张表都要带上；`makerStamp` 由控制器追加）。 */
export function statementFootnotes(gap: StatementGap, extra: readonly string[] = []): string[] {
  const notes = [...extra];
  if (gap.entriesWithoutVoucher > 0) {
    notes.push(`本期有 ${gap.entriesWithoutVoucher} 条已生效的收支流水**还没有生成凭证**：三大报表取的是凭证，`
      + "这些钱在报表里还不存在，请到「凭证管理」生成后重新出表");
  }
  if (gap.draftVouchers > 0) notes.push(`本期另有 ${gap.draftVouchers} 张草稿凭证（未过账，不计入报表）`);
  for (const other of gap.otherCurrencies) {
    notes.push(`本期有 ${other.count} 张 ${other.currency} 凭证：已按 ${other.period} 的期末汇率折算并入本表`
      + `（外币按期汇率折算成人民币；汇率变动的影响在现金流量表行次 32）`);
  }
  for (const lost of gap.unconverted) {
    notes.push(`本期有 ${lost.vouchers} 张 ${lost.currency} 凭证${lost.opening ? "、以及该币种的建账期初" : ""}：`
      + `**没有维护 ${lost.currency} 的期末汇率，这部分没有折进本表**（钱少了、两侧都少所以勾稽照样平），`
      + `请到「期末汇率」页维护后重新出表`);
  }
  return notes;
}

/** 资产负债表（两栏对照，按行次一一对齐）。 */
export function buildBalanceSheetTable(report: BalanceSheetReport): ReportTable {
  const assets = new Map(report.current.assets.map((line) => [line.row, line]));
  const assetsYearStart = new Map(report.yearStartResult.assets.map((line) => [line.row, line]));
  const equities = new Map(report.current.equities.map((line) => [line.row, line]));
  const equitiesYearStart = new Map(report.yearStartResult.equities.map((line) => [line.row, line]));

  const rows: ReportCell[][] = [];
  for (let row = 1; row <= 34; row += 1) {
    const left = assets.get(row);
    const right = equities.get(row);
    if (!left && !right) continue;
    rows.push([
      left?.label ?? null, left ? row : null,
      money(left?.value ?? null), money(assetsYearStart.get(row)?.value ?? null),
      right?.label ?? null, right ? row : null,
      money(right?.value ?? null), money(equitiesYearStart.get(row)?.value ?? null),
    ]);
  }
  // 勾稽核对 = 资产总计 − 负债和所有者权益总计（模板最后一行；✓/✗ 一眼看得出）。
  rows.push([
    "勾稽核对：资产总计 − 负债和所有者权益总计", null, money(report.current.difference), money(report.yearStartResult.difference),
    report.current.balanced ? "✓ 平衡" : "✗ 不平衡", null, null, null,
  ]);

  const notes = [
    ...(report.openingAsOfDate
      ? [`期初余额：取自「建账期初余额表」（建账日 ${report.openingAsOfDate}），建账日之后的凭证另计`]
      : ["期初余额：还没有录入「建账期初余额表」，货币资金用的是银行账户档案的期初余额兜底"]),
    ...report.current.notes,
    ...report.yearStartResult.notes.filter((note) => !report.current.notes.includes(note)),
    ...statementFootnotes(report.gap),
  ];
  /**
   * 未归位科目（2026-11-11 R-3 / T6）。
   *
   * 为什么必须写：利润表与现金流量表都会点名，只有资产负债表什么都不说 ——
   * 而它恰恰是财务最先看的那张。「新增了一个科目、金额没进任何一行」在资产负债表上
   * 原本是彻底静默的（诊断 P0-2 的另一半）。
   */
  const unmapped = report.current.unmapped;
  if (unmapped.length) {
    notes.push(`未归入任何报表行的科目（本期有发生额）：${unmapped.map((item) => `${item.subjectKey}（${formatStatementValue(item.balance)}）`).join("、")}`);
  }
  if (!report.current.balanced) {
    // 差额的归因顺序很重要：科目没归位时差额就是它们造成的，先看期初会把人引到错的方向。
    notes.push(`资产总计与负债和所有者权益总计相差 ${formatStatementValue(report.current.difference)}：`
      + (unmapped.length
        ? "先看上面那条未归位科目的说明 —— 它们没有进任何一行，差额很可能就是它们；确认之后再看期初余额那条。"
        : "先看上面那条期初余额说明 —— 只录了银行账户期初、还没有「科目期初余额表」时，这个差额是已知的"));
  }
  return {
    sheetName: "资产负债表",
    columns: [
      { header: "资产", width: 30 },
      { header: "行次", width: 6, align: "center" },
      numeric("期末余额", 16),
      numeric("年初余额", 16),
      { header: "负债和所有者权益（或股东权益）", width: 34 },
      { header: "行次", width: 6, align: "center" },
      numeric("期末余额", 16),
      numeric("年初余额", 16),
    ],
    rows,
    footnotes: notes,
  };
}

/** 利润表（本期 / 上期）。 */
export function buildIncomeStatementTable(report: IncomeStatementReport): ReportTable {
  const notes = [
    `期间：${report.period.from} 至 ${report.period.to}（上期 ${report.previousPeriod.from} 至 ${report.previousPeriod.to}）`,
    ...report.current.notes,
    ...statementFootnotes(report.gap),
  ];
  if (report.current.unmapped.length) {
    // 金额走 `formatStatementValue`：unmapped 里的 balance 是「万分之一元」的整数，
    // 直接印出来会变成 1000000 而不是 100（与现金流量表那句同口径，三张表统一）。
    notes.push(`未归入任何报表行的科目（本期有发生额）：${report.current.unmapped.map((item) => `${item.subjectKey}（${formatStatementValue(item.balance)}）`).join("、")}`);
  }
  return { ...twoPeriodTable("利润表", report.current.lines, report.previous.lines), footnotes: notes };
}

/** 现金流量表（本期 / 上期）。 */
export function buildCashFlowStatementTable(report: CashFlowReport): ReportTable {
  const notes = [
    `期间：${report.period.from} 至 ${report.period.to}（上期 ${report.previousPeriod.from} 至 ${report.previousPeriod.to}）`,
    ...report.current.notes,
    `期初现金及现金等价物余额 ${formatStatementValue(report.cashOpening)}（银行账户期初余额 + 期初之前的资金类科目净额）`,
    ...statementFootnotes(report.gap),
  ];
  if (report.current.nonCashVouchers > 0) notes.push(`本期有 ${report.current.nonCashVouchers} 张凭证没有资金分录（如计提/折旧），不计入现金流量表`);
  if (report.current.internalTransfers > 0) notes.push(`本期有 ${report.current.internalTransfers} 张凭证两边都是资金科目（内部划转），不构成现金流量`);
  if (report.current.unmapped.length) {
    notes.push(`认不出落哪一行的对方科目：${report.current.unmapped.map((item) => `${item.subjectKey}（${formatStatementValue(item.amount)}）`).join("、")}`);
  }
  return { ...twoPeriodTable("现金流量表", report.current.lines, report.previous.lines), footnotes: notes };
}
