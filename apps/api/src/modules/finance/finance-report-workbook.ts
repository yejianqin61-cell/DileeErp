import * as ExcelJS from "exceljs";
// 文件名里的时间戳也走北京时间：它和文件内容里的「制表时间」会被用户对照。
import { beijingStamp } from "../../platform/time/beijing-time";
import { reportTotalRow } from "./finance-report.tables";
import type { ReportCell, ReportColumn, ReportTable } from "./finance-report.types";

/**
 * 报表工作簿渲染：把 `ReportTable`（版式数据）落成 ExcelJS 工作簿。
 *
 * 这一层唯一但最要紧的职责：**保证数字落成 Excel 数值类型**。
 * 老表（`example/财务/*.xls`）里所有数据单元格都是文本型（BIFF 格式 `z="@"`），
 * 文本型数字在 Excel 里 `SUM` 得 0、筛选分不出数值区间、排序按字典序（`"100" < "20"`）。
 * 用户明确要求「数字一定要是数值型」，因此这里把「数值列不允许写非数值」做成硬约束（违反直接抛错），
 * 并由单测全表扫描钉住（不允许存在「看起来是数字却写成文本」的单元格）。
 *
 * 渲染代码不含任何业务口径：口径在 `finance-report.tables.ts` / `finance-report.domain.ts`。
 */

const BODY_FONT = { name: "宋体", size: 11 } as const;
const HEADER_FONT = { name: "宋体", size: 11, bold: true } as const;
const THIN_BORDER: Partial<ExcelJS.Borders> = {
  top: { style: "thin" },
  left: { style: "thin" },
  bottom: { style: "thin" },
  right: { style: "thin" },
};

const MAX_SHEET_NAME = 31;

/** 数值列 = 声明了 `numFmt` 的列。 */
function isNumericColumn(column: ReportColumn): boolean {
  return Boolean(column.numFmt);
}

/** 列下标（1 基）→ 列字母。支持超过 26 列（销售对账明细表有 23 列，A–W）。 */
export function columnLetter(index: number): string {
  let value = "";
  let current = index;
  while (current > 0) {
    const remainder = (current - 1) % 26;
    value = String.fromCharCode(65 + remainder) + value;
    current = Math.floor((current - 1) / 26);
  }
  return value;
}

/** 工作表名：去掉 Excel 禁用字符、截断到 31 字符，重名时补序号。 */
function uniqueSheetName(workbook: ExcelJS.Workbook, base: string): string {
  const cleaned = (base.replace(/[\\/*?:[\]]/g, " ").trim() || "报表").slice(0, MAX_SHEET_NAME);
  let name = cleaned;
  let suffix = 1;
  while (workbook.getWorksheet(name)) name = `${cleaned.slice(0, MAX_SHEET_NAME - 4)}-${suffix++}`;
  return name;
}

/** 把一张报表写成工作表。 */
export function addReportSheet(workbook: ExcelJS.Workbook, table: ReportTable): ExcelJS.Worksheet {
  const sheet = workbook.addWorksheet(uniqueSheetName(workbook, table.sheetName), {
    pageSetup: {
      paperSize: 9,
      orientation: "landscape",
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 },
    },
  });
  sheet.columns = table.columns.map((column) => ({ width: column.width }));

  // 表头：列名与列序照抄老表模板（R1），因此这里只渲染，不做任何改名或重排。
  const headerRow = sheet.getRow(1);
  table.columns.forEach((column, index) => {
    const cell = headerRow.getCell(index + 1);
    cell.value = column.header;
    cell.font = HEADER_FONT;
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    cell.border = THIN_BORDER;
  });
  headerRow.height = 22;
  sheet.views = [{ state: "frozen", ySplit: 1 }];

  table.rows.forEach((values, rowIndex) => {
    const row = sheet.getRow(2 + rowIndex);
    table.columns.forEach((column, columnIndex) => {
      const cell = row.getCell(columnIndex + 1);
      const value: ReportCell = values[columnIndex] ?? null;
      cell.font = BODY_FONT;
      cell.border = THIN_BORDER;
      const align = column.align ?? (isNumericColumn(column) ? "right" : "left");
      cell.alignment = { horizontal: align, vertical: "middle", wrapText: align === "left" };

      if (value === null || value === undefined) {
        // 空单元格：缺字段就是「系统没有这个数据」，不写 0（0 是「确实为零」的事实），
        // 也不写 ""（那是一格文本）。
        return;
      }
      const numFmt = column.numFmt;
      if (numFmt) {
        // 硬约束：数值列只能写 number。写出字符串型数字正是老表的毛病，这里直接拦住。
        if (typeof value !== "number") {
          throw new Error(
            `报表「${table.sheetName}」的数值列「${column.header}」收到非数值 ${JSON.stringify(value)}：数值列必须写 Excel 数值类型`,
          );
        }
        cell.value = value;
        cell.numFmt = numFmt;
        return;
      }
      cell.value = value;
    });
  });

  // 合计行：只对声明的数值列求和，且只在确有数据行时追加。
  // 合计值直接复用 `reportTotalRow`（页面预览用的同一份计算），
  // 因此「页面上的合计」与「导出的合计」不可能不一致。
  const totals = reportTotalRow(table);
  if (totals) {
    const firstDataRow = 2;
    const lastDataRow = 1 + table.rows.length;
    const totalRow = sheet.getRow(lastDataRow + 1);
    table.columns.forEach((column, columnIndex) => {
      const cell = totalRow.getCell(columnIndex + 1);
      cell.font = HEADER_FONT;
      cell.border = THIN_BORDER;
      cell.alignment = { horizontal: isNumericColumn(column) ? "right" : "left", vertical: "middle" };
      const value = totals[columnIndex] ?? null;
      if (value === null) return;
      if (columnIndex === 0) {
        cell.value = value;
        return;
      }
      if (column.numFmt) {
        const letter = columnLetter(columnIndex + 1);
        // 公式 + 缓存结果一起写：公式让用户在 Excel 里看得到求和范围，
        // 缓存结果让「不重算公式的读取器」（例如断言用的 SheetJS）也能拿到数值，
        // 否则公式单元格在读取端会变成空格子。
        cell.value = { formula: `SUM(${letter}${firstDataRow}:${letter}${lastDataRow})`, result: value };
        cell.numFmt = column.numFmt;
      }
    });
  }

  // 表尾说明：例如「缺采购价物料」清单 —— 必须显式列出，不能静默按 0 算完。
  // 与正文空一行，避免读起来像是明细的最后一行。
  if (table.footnotes?.length) {
    const lastContentRow = 1 + table.rows.length + (totals ? 1 : 0);
    const start = lastContentRow + 2;
    table.footnotes.forEach((note, index) => {
      const cell = sheet.getCell(`A${start + index}`);
      cell.value = note;
      cell.font = BODY_FONT;
      cell.alignment = { horizontal: "left", vertical: "middle", wrapText: false };
    });
  }

  return sheet;
}

/** 把多张报表渲染成一个工作簿（每张一个工作表）。 */
export async function renderReportWorkbook(tables: ReportTable[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  for (const table of tables) addReportSheet(workbook, table);
  const data = await workbook.xlsx.writeBuffer();
  return Buffer.from(data);
}

/** 能收下工作簿的最小响应形状（避免把 express 的类型引进这个纯渲染模块）。 */
type WorkbookResponse = {
  setHeader(name: string, value: string): unknown;
  send(body: Buffer): unknown;
};

/**
 * 一次性把**一张或多张**表渲染成一个 xlsx 并作为附件下发。
 *
 * 报表导出与「确认应收/应付台账」导出共用这一处：文件名编码（`filename*=UTF-8''`）、
 * Content-Type、`no-store` 三件事必须一致，否则中文文件名在不同浏览器上会乱码、
 * 或者下载被浏览器缓存住。文件名带上行数，财务拿到文件就知道导的是哪一批。
 *
 * 为什么收数组：外汇一览表是**两张表**（明细 + 客户汇总），它们必须落在同一个文件里 ——
 * 分成两个下载文件，财务很容易只发出去一张，而「汇总和明细分开传」正是对账对不上的经典原因。
 * 单张表的调用方照旧传一个 `ReportTable` 就行，不用为了这个能力改成 `[table]`。
 * 文件名里的行数取**第一张（主页）**表的行数：明细是主表，汇总的行数随客户数变化、看着会莫名其妙。
 */
export async function sendWorkbook(response: WorkbookResponse, table: ReportTable | ReportTable[], label: string) {
  const tables = Array.isArray(table) ? table : [table];
  const body = await renderReportWorkbook(tables);
  const stamp = beijingStamp();
  const fileName = `迪礼ERP-${label}-${stamp}-${tables[0]?.rows.length ?? 0}行.xlsx`;
  response.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  response.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
  response.setHeader("Cache-Control", "no-store");
  return response.send(body);
}
