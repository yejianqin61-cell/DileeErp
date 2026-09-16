/**
 * 「其他应付」批量导入的口径（纯函数 + 模板生成，无 Nest/Prisma 依赖）。
 *
 * 用户 2026-09-16：「应付管理，因为有一些非原料类的支出，也就是其他应付，现在要支持批量导入
 * 这类应付对账条目。我们提供模板，用户填写上传，直接进入应付对账，然后再流转到确认应付。」
 *
 * 与员工花名册导入（`modules/production/employee-roster.ts`）刻意保持同一套规矩，
 * 因为操作员面对的是同一件事（下载模板 → 填写 → 上传 → 看逐行错误）：
 *   - **按表头名匹配，不按列序号**：挪动列顺序、增删无关列都不会错位；无关列如实上报；
 *   - **行级错误不连坐**：只有「找不到表头 / 缺必需列 / 没有数据行」才是整批失败，
 *     其余情况通过校验的行照常入库、出错的行逐条列出（status = partial）；
 *   - 日期解析直接复用花名册那份 `parseRosterDate`：它处理了 SheetJS 的 `cellDates: false`
 *     + Excel 序列号换算（见下面 readSheet 的注释），再写一份必然漂移。
 *
 * 导入的落点（用户已确认）：**只生成应付草稿条目**，与页面上的「新建其他应付」完全同形，
 * 于是它们立刻出现在【应付管理 → 应付对账 → 待创建对账】，也可以在【确认应付】里勾选批量确认。
 */

import * as XLSX from "xlsx";
import { parseRosterDate, textCell } from "../production/employee-roster";

/** 单次导入的行数上限：这是付款相关的账目，一次几百条已经远超手工量级。 */
export const OTHER_PAYABLE_MAX_ROWS = 500;

export type OtherPayableField =
  | "supplier_code"
  | "supplier_name"
  | "amount"
  | "currency"
  | "description"
  | "confirmation_date"
  | "remark";

/** 模板列（表头名即口径）。顺序不与解析绑定：解析按表头名认列。 */
export const OTHER_PAYABLE_TEMPLATE_HEADERS = [
  "供应商编码",
  "供应商名称",
  "应付金额",
  "币种",
  "费用说明",
  "确认日期",
  "备注",
] as const;

/** 每个字段认的同义表头（操作员手写、旧模板、导出回灌都能对上）。 */
export const OTHER_PAYABLE_HEADER_ALIASES: Record<OtherPayableField, readonly string[]> = {
  supplier_code: ["供应商编码", "供应商编号", "供应商代码", "编码"],
  supplier_name: ["供应商名称", "供应商", "对方名称", "对方单位", "收款方", "费用对方"],
  amount: ["应付金额", "金额", "应付金额(原币)", "金额(原币)", "应付"],
  currency: ["币种", "货币", "结算币种"],
  description: ["费用说明", "费用项目", "费用内容", "摘要", "说明", "用途"],
  confirmation_date: ["确认日期", "记账日期", "费用日期", "日期"],
  remark: ["备注"],
};

export const OTHER_PAYABLE_FIELD_LABELS: Record<OtherPayableField, string> = {
  supplier_code: "供应商编码",
  supplier_name: "供应商名称",
  amount: "应付金额",
  currency: "币种",
  description: "费用说明",
  confirmation_date: "确认日期",
  remark: "备注",
};

/** 模板里的示例行：供应商编码故意留空，靠名称自动建档，避免示例编码被当真。 */
export const OTHER_PAYABLE_SAMPLE_ROWS: ReadonlyArray<ReadonlyArray<string>> = [
  ["", "示例-请替换成供应商名称", "1200.00", "CNY", "9 月厂房租金", "2026-09-16", "银行转账"],
  ["", "示例-请替换成供应商名称", "86.50", "", "8 月快递费", "", "月结，留空日期按今天记账"],
];

/** 币种的中文/别名写法 → 标准代码。认不出时按 3 位字母代码兜底。 */
const CURRENCY_ALIASES: Record<string, string> = {
  人民币: "CNY", 元: "CNY", rmb: "CNY", "￥": "CNY",
  美元: "USD", 美金: "USD", usd: "USD", "$": "USD",
  欧元: "EUR",
  港元: "HKD", 港币: "HKD",
  日元: "JPY", 日圆: "JPY",
};

export type OtherPayableImportRow = {
  /** Excel 行号（1 起，报错时给操作员看的那个号）。 */
  row: number;
  supplierCode: string;
  supplierName: string;
  /** 归一化后的十进制文本（去掉千分位与货币符号），由服务层转 Decimal。 */
  amount: string;
  currency: string;
  description: string;
  /** YYYY-MM-DD；空表示「按今天记账」。 */
  confirmationDate: string | null;
  remark: string;
};

export type OtherPayableImportError = { row: number; field?: string; reason: string };

export type OtherPayableParseResult = {
  status: "ok" | "partial" | "failed";
  headerRow: number;
  dataStartRow: number;
  /** 数据行数（不含表头，含报错行）。 */
  total: number;
  /** 通过逐行校验、可以入账的行。 */
  rows: OtherPayableImportRow[];
  errors: OtherPayableImportError[];
  missingColumns: string[];
  /** 表头里有、但不属于其他应付口径的列（如实上报，不静默丢）。 */
  ignoredColumns: string[];
  /** 文档形态（表头不在第一行）时，数据块之后被跳过的行数。 */
  ignoredTrailingRows: number;
  documentLayout: boolean;
  hints: string[];
};

const normalizeHeader = (value: unknown) => textCell([value], 0).replace(/\s+/g, "").toLowerCase();

/** 表头 → 字段下标。同名表头取第一次出现的位置。 */
function resolveHeaderIndexes(labels: readonly unknown[]): Map<OtherPayableField, number> {
  const found = new Map<OtherPayableField, number>();
  labels.forEach((label, index) => {
    const text = normalizeHeader(label);
    if (!text) return;
    for (const field of Object.keys(OTHER_PAYABLE_HEADER_ALIASES) as OtherPayableField[]) {
      if (found.has(field)) continue;
      if (OTHER_PAYABLE_HEADER_ALIASES[field].some((alias) => normalizeHeader(alias) === text)) found.set(field, index);
    }
  });
  return found;
}

/** 应付金额：容忍千分位、货币符号、全角数字与数字单元格；认不出返回空串（由调用方报错）。 */
export function normalizeAmountCell(value: unknown): string {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  const text = String(value)
    .replace(/[\uff10-\uff19]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0)) // 全角数字
    .replace(/[,\s\u00a0]/g, "")
    .replace(/^[¥￥$€£]/, "");
  return /^\d+(\.\d+)?$/.test(text) ? text : "";
}

/** 币种：留空 → CNY；中文/别名 → 标准代码；3~10 位字母按大写代码收下；其余报错。 */
export function normalizeCurrencyCell(value: unknown): { currency: string } | { error: string } {
  const raw = textCell([value], 0);
  if (!raw) return { currency: "CNY" };
  const alias = CURRENCY_ALIASES[raw.toLowerCase()] ?? CURRENCY_ALIASES[raw];
  if (alias) return { currency: alias };
  const code = raw.toUpperCase();
  if (/^[A-Z]{3,10}$/.test(code)) return { currency: code };
  return { error: `币种「${raw}」无法识别（可留空按 CNY，或写 USD / 人民币 这类写法）` };
}

const isBlankRow = (row: readonly unknown[]) => row.every((cell) => textCell([cell], 0) === "");

/**
 * 解析「其他应付导入」表。
 *
 * `rows` 是 `sheet_to_json(sheet, { header: 1, raw: true, defval: "" })` 的结果（二维数组）。
 * 表头在找不到时只回一条整体错误、一行都不解析 —— 否则会把「误传了别的表」当成一堆行级错误。
 */
export function parseOtherPayableRows(rows: readonly unknown[][]): OtherPayableParseResult {
  const base: OtherPayableParseResult = {
    status: "failed", headerRow: -1, dataStartRow: -1, total: 0, rows: [], errors: [],
    missingColumns: [], ignoredColumns: [], ignoredTrailingRows: 0, documentLayout: false, hints: [],
  };

  // 表头可能不在第一行（有人习惯先写个标题行）：在前 10 行里找最像表头的那一行。
  let headerRow = -1;
  let indexes = new Map<OtherPayableField, number>();
  for (let index = 0; index < Math.min(rows.length, 10); index += 1) {
    const candidate = resolveHeaderIndexes((rows[index] ?? []) as readonly unknown[]);
    // 「像其他应付」的判据：金额 + 费用说明 + （编码或名称），三者同时命中才算表头。
    const supplierOk = candidate.has("supplier_code") || candidate.has("supplier_name");
    if (candidate.has("amount") && candidate.has("description") && supplierOk) { headerRow = index; indexes = candidate; break; }
    if (candidate.size > indexes.size) indexes = candidate; // 记下最全的一行，好在失败时报缺了哪列
  }

  if (headerRow < 0) {
    const missing: string[] = [];
    if (!indexes.has("amount")) missing.push(OTHER_PAYABLE_FIELD_LABELS.amount);
    if (!indexes.has("description")) missing.push(OTHER_PAYABLE_FIELD_LABELS.description);
    if (!indexes.has("supplier_code") && !indexes.has("supplier_name")) missing.push("供应商编码或供应商名称");
    return {
      ...base,
      missingColumns: missing,
      errors: [{ row: 0, reason: missing.length
        ? `缺少必需列：${missing.join("、")}（请使用「下载模板」得到的表头）`
        : "找不到表头行：请使用「下载模板」，第一行必须是表头（供应商编码 / 供应商名称 / 应付金额 / 币种 / 费用说明 / 确认日期 / 备注）" }],
    };
  }

  const headerLabels = (rows[headerRow] ?? []).map((label) => textCell([label], 0));
  const mapped = new Set(indexes.values());
  const ignoredColumns = headerLabels.filter((label, index) => label && !mapped.has(index));
  // 表头不在第一行 = 文档形态：数据块到第一个空行为止，避免把末尾的说明批注当成数据行。
  const documentLayout = headerRow > 0;

  const errors: OtherPayableImportError[] = [];
  const parsedRows: OtherPayableImportRow[] = [];
  const seen = new Map<string, number>();
  let total = 0;
  let ignoredTrailingRows = 0;
  let defaultedCurrency = 0;
  let defaultedDate = 0;

  for (let index = headerRow + 1; index < rows.length; index += 1) {
    const row = rows[index] ?? [];
    if (isBlankRow(row)) {
      // 文档形态：数据块结束；系统模板形态：中间的空行照旧跳过。
      if (documentLayout && total > 0) { ignoredTrailingRows = rows.length - index; break; }
      continue;
    }
    const excelRow = index + 1;
    total += 1;
    const supplierCode = textCell(row, indexes.get("supplier_code"));
    const supplierName = textCell(row, indexes.get("supplier_name"));
    const description = textCell(row, indexes.get("description"));
    const remark = textCell(row, indexes.get("remark"));
    const currencyCell = textCell(row, indexes.get("currency"));
    const dateCell = indexes.has("confirmation_date") ? row[indexes.get("confirmation_date")!] : "";

    const rowErrors: OtherPayableImportError[] = [];
    if (!supplierCode && !supplierName) rowErrors.push({ row: excelRow, field: OTHER_PAYABLE_FIELD_LABELS.supplier_name, reason: "请填写供应商编码或供应商名称（两个都空时无法确定付款对象）" });
    if (!description) rowErrors.push({ row: excelRow, field: OTHER_PAYABLE_FIELD_LABELS.description, reason: "请填写费用说明（它会作为应付单的来源说明）" });

    const amount = normalizeAmountCell(row[indexes.get("amount")!]);
    if (!amount) rowErrors.push({ row: excelRow, field: OTHER_PAYABLE_FIELD_LABELS.amount, reason: "应付金额必须是大于 0 的数字" });
    else if (Number(amount) <= 0) rowErrors.push({ row: excelRow, field: OTHER_PAYABLE_FIELD_LABELS.amount, reason: "应付金额必须大于 0" });

    let currency = "CNY";
    if (currencyCell) {
      const normalized = normalizeCurrencyCell(currencyCell);
      if ("error" in normalized) rowErrors.push({ row: excelRow, field: OTHER_PAYABLE_FIELD_LABELS.currency, reason: normalized.error });
      else currency = normalized.currency;
    } else defaultedCurrency += 1;

    let confirmationDate: string | null = null;
    if (textCell([dateCell], 0) === "" && !(dateCell instanceof Date)) defaultedDate += 1;
    else {
      const parsed = parseRosterDate(dateCell);
      if (!parsed) rowErrors.push({ row: excelRow, field: OTHER_PAYABLE_FIELD_LABELS.confirmation_date, reason: "确认日期无法识别（示例 2026-09-16；留空表示按今天记账）" });
      else confirmationDate = parsed.toISOString().slice(0, 10);
    }

    if (remark.length > 1000) rowErrors.push({ row: excelRow, field: OTHER_PAYABLE_FIELD_LABELS.remark, reason: "备注过长（最多 1000 字）" });

    // 同一份文件里的重复行直接拒绝：金额行重复入账等于重复付款，比少导一行危险得多。
    const key = [supplierCode || supplierName, amount, currency, confirmationDate ?? "", description].join("\u0001");
    const duplicateOf = seen.get(key);
    if (duplicateOf !== undefined) rowErrors.push({ row: excelRow, reason: `与本文件第 ${duplicateOf} 行重复（同一供应商、金额、币种、日期与说明）` });
    else seen.set(key, excelRow);

    if (rowErrors.length) { errors.push(...rowErrors); continue; }
    parsedRows.push({ row: excelRow, supplierCode, supplierName, amount, currency, description, confirmationDate, remark });
  }

  if (!total) {
    return { ...base, headerRow, dataStartRow: headerRow + 2, documentLayout, ignoredColumns, missingColumns: [],
      errors: [{ row: headerRow + 2, reason: "表头下面没有数据行：请按模板填写至少一行" }] };
  }

  const hints: string[] = [];
  if (defaultedCurrency) hints.push(`${defaultedCurrency} 行没有填币种，按 CNY 记账`);
  if (defaultedDate) hints.push(`${defaultedDate} 行没有填确认日期，按导入当天记账`);

  return {
    status: errors.length ? (parsedRows.length ? "partial" : "failed") : "ok",
    headerRow: headerRow + 1,
    dataStartRow: headerRow + 2,
    total,
    rows: parsedRows,
    errors,
    missingColumns: [],
    ignoredColumns,
    ignoredTrailingRows,
    documentLayout,
    hints,
  };
}

/** 导入模板：一页数据表（表头 + 两行示例）+ 一页填写说明。 */
export function otherPayableTemplateWorkbook(): Buffer {
  const sheet = XLSX.utils.aoa_to_sheet([
    [...OTHER_PAYABLE_TEMPLATE_HEADERS],
    ...OTHER_PAYABLE_SAMPLE_ROWS.map((row) => [...row]),
  ]);
  sheet["!cols"] = OTHER_PAYABLE_TEMPLATE_HEADERS.map((header) => ({ wch: Math.max(12, header.length * 2 + 6) }));
  const notes = XLSX.utils.aoa_to_sheet([
    ["填写说明"],
    ["1. 「其他应付导入」表里那两行是示例，上传前请删掉或改成你的数据。"],
    ["2. 表头名就是口径，列顺序可以调整、多余的列会被忽略。必填：供应商编码或供应商名称（至少一个）、应付金额、费用说明。"],
    ["3. 供应商先在【采购 → 供应商池】里按编码或名称匹配（忽略大小写与空格）；两边都匹配不到时，系统会按名称自动建一个供应商（编码自动生成 SUP-当天日期-序号），并在导入结果里列出建了哪些，请导入后去补联系方式。"],
    ["4. 币种留空按 CNY，也可以写 人民币 / 美元 / 欧元 / 港元 / 日元。"],
    ["5. 确认日期留空按导入当天；格式 YYYY-MM-DD（也接受 2026/1/5 与 Excel 日期单元格）。"],
    ["6. 应付金额必须大于 0，可以带千分位和货币符号（1,200.00 与 ￥1200 都认）。"],
    ["7. 同一份文件里「同一供应商 + 同一金额 + 同一币种 + 同一日期 + 同一说明」的重复行会被拒绝，避免重复记账。"],
    ["8. 导入只生成**应付草稿**：它们出现在【应付管理 → 应付对账 → 待创建对账】，也可以在【应付管理 → 确认应付】里勾选批量确认。"],
    [`9. 单次最多 ${OTHER_PAYABLE_MAX_ROWS} 行。`],
  ]);
  notes["!cols"] = [{ wch: 120 }];
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, "其他应付导入");
  XLSX.utils.book_append_sheet(book, notes, "填写说明");
  return XLSX.write(book, { type: "buffer", bookType: "xlsx" });
}
