/**
 * 「库存盘点」导入的口径（纯函数 + 模板生成，无 Nest/Prisma 依赖）。
 *
 * 用户 2026-09-16：「仓库模块增加一个盘点管理，可以将每月一次的盘点数据导入系统，调整库存物料数量。
 * 物料的产品代码作为唯一性，在新建物料时自动生成一个物料代码。物料导入模板，需要有这些 column：
 * 产品名称 / 产品规格 / 产品代码 / 仓位 / 货位 / 实际数量」。
 *
 * 与「其他应付批量导入」（`modules/finance/other-payable-import.ts`）、员工花名册导入
 * （`modules/production/employee-roster.ts`）刻意保持同一套规矩 —— 操作员面对的是同一件事
 * （下载模板 → 填写 → 上传 → 看逐行错误）：
 *   - **按表头名匹配，不按列序号**：挪动列顺序、增删无关列都不会错位；无关列如实上报；
 *   - **行级错误不连坐**：只有「找不到表头 / 缺必需列 / 没有数据行」才是整批失败，
 *     其余情况通过校验的行照常入单、出错的行逐条列出（status = partial）。
 *
 * 本文件只做**形状与逐行校验**；「产品代码能不能在物料清单里找到」「账面数是多少」要查库，
 * 属于 StocktakeService 的职责。这样解析器可以脱离数据库被完整测试。
 */

import * as XLSX from "xlsx";
import { textCell } from "../production/employee-roster";
// 十进制单元格归一化（千分位、货币符号、全角数字、数字单元格）与「其他应付导入」共用一份：
// 再抄一遍必然漂移，而这类漂移的表现是「同一张表有的列认得出、有的列认不出」。
import { normalizeAmountCell } from "../finance/other-payable-import";

/** 单次导入的行数上限：月度盘点表通常几百行，2000 已远超手工量级，也挡住误传整本台账。 */
export const STOCKTAKE_MAX_ROWS = 2000;

export type StocktakeField =
  | "product_name"
  | "specification"
  | "product_code"
  | "warehouse_zone"
  | "bin_location"
  | "actual_quantity"
  | "difference_reason";

/** 模板列（表头名即口径）。顺序不与解析绑定：解析按表头名认列。 */
export const STOCKTAKE_TEMPLATE_HEADERS = [
  "产品名称",
  "产品规格",
  "产品代码",
  "仓位",
  "货位",
  "实际数量",
] as const;

/** 每个字段认的同义表头（操作员手写、旧模板、导出回灌都能对上）。 */
export const STOCKTAKE_HEADER_ALIASES: Record<StocktakeField, readonly string[]> = {
  product_name: ["产品名称", "物料名称", "品名", "名称", "货物名称"],
  specification: ["产品规格", "规格型号", "规格", "型号"],
  // 产品代码 = 物料编码：用户 2026-09-16 确认两者是同一个字段（与财务报表里
  // 「产品代码 ← 物料编码」的映射一致）。同义词收全，是因为操作员手上三种写法都有。
  product_code: ["产品代码", "物料编码", "物料代码", "产品编码", "产品编号", "物料编号", "编码", "代码"],
  warehouse_zone: ["仓位", "库位", "库区", "仓库", "区域"],
  bin_location: ["货位", "货架", "储位", "架位", "具体货位"],
  actual_quantity: ["实际数量", "实盘数量", "实盘数", "盘点数量", "实际库存", "数量"],
  // 模板里没有这一列（用户只点了 6 列），但盘点差异必须能写原因，所以认它、不强求它。
  difference_reason: ["差异原因", "差异说明", "盘点备注", "备注", "原因"],
};

export const STOCKTAKE_FIELD_LABELS: Record<StocktakeField, string> = {
  product_name: "产品名称",
  specification: "产品规格",
  product_code: "产品代码",
  warehouse_zone: "仓位",
  bin_location: "货位",
  actual_quantity: "实际数量",
  difference_reason: "差异原因",
};

/** 硬性必需的列：少了就没法匹配物料 / 没法算差异。其余列缺失只提示，不拦。 */
const REQUIRED_FIELDS: readonly StocktakeField[] = ["product_code", "actual_quantity"];

/**
 * 模板里的示例行：产品代码故意写成占位符，避免示例编码被当真导进去。
 * 最后一行的实际数量填 0：盘点表里「盘没了」就是要填 0，示例必须把这件事示范出来。
 */
export const STOCKTAKE_SAMPLE_ROWS: ReadonlyArray<ReadonlyArray<string>> = [
  ["示例-涤纶布（请替换成物料清单里的名称）", "150D", "示例-替换成物料编码1", "A区", "A-01-02", "120"],
  ["示例-松紧带（请替换成物料清单里的名称）", "5mm", "示例-替换成物料编码2", "B区", "B-02-01", "0"],
];

export type StocktakeImportRow = {
  /** Excel 行号（1 起，报错时给操作员看的那个号）。 */
  row: number;
  productCode: string;
  productName: string;
  specification: string;
  warehouseZone: string;
  binLocation: string;
  /** 归一化后的十进制文本（去掉千分位与货币符号），由服务层转 Decimal。允许 "0"。 */
  actualQuantity: string;
  differenceReason: string;
};

export type StocktakeImportError = { row: number; field?: string; reason: string };

export type StocktakeParseResult = {
  status: "ok" | "partial" | "failed";
  headerRow: number;
  dataStartRow: number;
  /** 数据行数（不含表头，含报错行）。 */
  total: number;
  /** 通过逐行校验、可以进盘点单的行。 */
  rows: StocktakeImportRow[];
  errors: StocktakeImportError[];
  missingColumns: string[];
  /** 表头里有、但不属于盘点口径的列（如实上报，不静默丢）。 */
  ignoredColumns: string[];
  /** 文档形态（表头不在第一行）时，数据块之后被跳过的行数。 */
  ignoredTrailingRows: number;
  documentLayout: boolean;
  hints: string[];
};

const normalizeHeader = (value: unknown) => textCell([value], 0).replace(/\s+/g, "").toLowerCase();

/** 表头 → 字段下标。同名表头取第一次出现的位置。 */
function resolveHeaderIndexes(labels: readonly unknown[]): Map<StocktakeField, number> {
  const found = new Map<StocktakeField, number>();
  labels.forEach((label, index) => {
    const text = normalizeHeader(label);
    if (!text) return;
    for (const field of Object.keys(STOCKTAKE_HEADER_ALIASES) as StocktakeField[]) {
      if (found.has(field)) continue;
      if (STOCKTAKE_HEADER_ALIASES[field].some((alias) => normalizeHeader(alias) === text)) found.set(field, index);
    }
  });
  return found;
}

/**
 * 实盘数：容忍千分位、货币符号、全角数字与数字单元格；认不出返回空串（由调用方报错）。
 *
 * 与金额的差别只有一条：**0 是合法值**（整箱盘没了就是 0，这正是盘亏要记的事），
 * 所以这里不能像应付金额那样把 0 当非法。
 */
export function normalizeQuantityCell(value: unknown): string {
  return normalizeAmountCell(value);
}

const isBlankRow = (row: readonly unknown[]) => row.every((cell) => textCell([cell], 0) === "");

/** 产品代码的匹配键：忽略大小写与空格（与物料清单、其他导入的匹配口径一致）。 */
export const stocktakeCodeKey = (value: string) => value.replace(/\s+/g, "").toLowerCase();

/**
 * 解析「库存盘点导入」表。
 *
 * `rows` 是 `sheet_to_json(sheet, { header: 1, raw: true, defval: "" })` 的结果（二维数组）。
 * 表头找不到时只回一条整体错误、一行都不解析 —— 否则会把「误传了别的表」当成一堆行级错误。
 */
export function parseStocktakeRows(rows: readonly unknown[][]): StocktakeParseResult {
  const base: StocktakeParseResult = {
    status: "failed", headerRow: -1, dataStartRow: -1, total: 0, rows: [], errors: [],
    missingColumns: [], ignoredColumns: [], ignoredTrailingRows: 0, documentLayout: false, hints: [],
  };

  // 表头可能不在第一行（有人习惯先写个标题行）：在前 10 行里找最像表头的那一行。
  let headerRow = -1;
  let indexes = new Map<StocktakeField, number>();
  for (let index = 0; index < Math.min(rows.length, 10); index += 1) {
    const candidate = resolveHeaderIndexes((rows[index] ?? []) as readonly unknown[]);
    // 「像盘点表」的判据：产品代码 + 实际数量，两者同时命中才算表头。
    if (candidate.has("product_code") && candidate.has("actual_quantity")) { headerRow = index; indexes = candidate; break; }
    if (candidate.size > indexes.size) indexes = candidate; // 记下最全的一行，好在失败时报缺了哪列
  }

  if (headerRow < 0) {
    const missing = REQUIRED_FIELDS.filter((field) => !indexes.has(field)).map((field) => STOCKTAKE_FIELD_LABELS[field]);
    return {
      ...base,
      missingColumns: missing,
      errors: [{ row: 0, reason: missing.length
        ? `缺少必需列：${missing.join("、")}（请使用「下载模板」得到的表头）`
        : "找不到表头行：请使用「下载模板」，第一行必须是表头（产品名称 / 产品规格 / 产品代码 / 仓位 / 货位 / 实际数量）" }],
    };
  }

  const headerLabels = (rows[headerRow] ?? []).map((label) => textCell([label], 0));
  const mapped = new Set(indexes.values());
  const ignoredColumns = headerLabels.filter((label, index) => label && !mapped.has(index));
  // 表头不在第一行 = 文档形态：数据块到第一个空行为止，避免把末尾的说明批注当成数据行。
  const documentLayout = headerRow > 0;

  const errors: StocktakeImportError[] = [];
  const parsedRows: StocktakeImportRow[] = [];
  /**
   * 产品代码 → 首次出现的 Excel 行号。
   *
   * 同一个产品代码在一份文件里出现两次，只能说明一件事：操作员把多个仓位的数量分开写了。
   * 而库存只按「物料 + 单位」记一本账，两行会各自与同一个账面数比较，得出两个互相矛盾的差异
   * （各减一遍账面），确认后库存会被扣两遍。所以这里直接拒绝，并告诉他怎么改。
   * 这也正是用户说的「物料的产品代码作为唯一性」。
   */
  const seenCode = new Map<string, number>();
  let total = 0;
  let ignoredTrailingRows = 0;
  const reasonColumnMissing = !indexes.has("difference_reason");

  for (let index = headerRow + 1; index < rows.length; index += 1) {
    const row = rows[index] ?? [];
    if (isBlankRow(row)) {
      // 文档形态：数据块结束；系统模板形态：中间的空行照旧跳过。
      if (documentLayout && total > 0) { ignoredTrailingRows = rows.length - index; break; }
      continue;
    }
    const excelRow = index + 1;
    total += 1;
    const productCode = textCell(row, indexes.get("product_code"));
    const productName = textCell(row, indexes.get("product_name"));
    const specification = textCell(row, indexes.get("specification"));
    const warehouseZone = textCell(row, indexes.get("warehouse_zone"));
    const binLocation = textCell(row, indexes.get("bin_location"));
    const differenceReason = textCell(row, indexes.get("difference_reason"));

    const rowErrors: StocktakeImportError[] = [];
    if (!productCode) rowErrors.push({ row: excelRow, field: STOCKTAKE_FIELD_LABELS.product_code, reason: "请填写产品代码（= 物料清单里的物料编码），系统靠它匹配物料" });

    const rawQuantity = row[indexes.get("actual_quantity")!];
    const quantityText = textCell([rawQuantity], 0);
    const actualQuantity = normalizeQuantityCell(rawQuantity);
    if (quantityText === "") {
      // 留空与「填 0」是两件事：留空多半是漏填，静默当 0 会凭空盘亏一整行。
      rowErrors.push({ row: excelRow, field: STOCKTAKE_FIELD_LABELS.actual_quantity, reason: "请填写实际数量（盘点后确实没有库存就填 0，不要留空）" });
    } else if (!actualQuantity) {
      rowErrors.push({ row: excelRow, field: STOCKTAKE_FIELD_LABELS.actual_quantity, reason: "实际数量必须是不小于 0 的数字（最多 4 位小数，不接受负数）" });
    } else if (!/^\d{1,14}(\.\d{1,4})?$/.test(actualQuantity)) {
      // 与 parseQuantity 同一条边界：PG numeric(18,4) 会把 0.00004 四舍五入成 0、把第 15 位整数截掉，
      // 让「实盘 0.00004」变成「实盘 0」而没人发现。
      rowErrors.push({ row: excelRow, field: STOCKTAKE_FIELD_LABELS.actual_quantity, reason: "实际数量最多 4 位小数、整数位最多 14 位" });
    }

    if (productCode) {
      const key = stocktakeCodeKey(productCode);
      const duplicateOf = seenCode.get(key);
      if (duplicateOf !== undefined) rowErrors.push({ row: excelRow, field: STOCKTAKE_FIELD_LABELS.product_code, reason: `产品代码 ${productCode} 在本文件里已出现在第 ${duplicateOf} 行：同一个产品请把各仓位的数量相加后填成一行（库存只按物料记一本账）` });
      else seenCode.set(key, excelRow);
    }

    if (productCode.length > 80) rowErrors.push({ row: excelRow, field: STOCKTAKE_FIELD_LABELS.product_code, reason: "产品代码过长（最多 80 字）" });
    if (warehouseZone.length > 100) rowErrors.push({ row: excelRow, field: STOCKTAKE_FIELD_LABELS.warehouse_zone, reason: "仓位过长（最多 100 字）" });
    if (binLocation.length > 100) rowErrors.push({ row: excelRow, field: STOCKTAKE_FIELD_LABELS.bin_location, reason: "货位过长（最多 100 字）" });
    if (differenceReason.length > 1000) rowErrors.push({ row: excelRow, field: STOCKTAKE_FIELD_LABELS.difference_reason, reason: "差异原因过长（最多 1000 字）" });

    if (rowErrors.length) { errors.push(...rowErrors); continue; }
    parsedRows.push({ row: excelRow, productCode, productName, specification, warehouseZone, binLocation, actualQuantity, differenceReason });
  }

  if (!total) {
    return { ...base, headerRow, dataStartRow: headerRow + 2, documentLayout, ignoredColumns, missingColumns: [],
      errors: [{ row: headerRow + 2, reason: "表头下面没有数据行：请按模板填写至少一行" }] };
  }

  const hints: string[] = [];
  const optionalMissing = (["product_name", "specification", "warehouse_zone", "bin_location"] as StocktakeField[])
    .filter((field) => !indexes.has(field)).map((field) => STOCKTAKE_FIELD_LABELS[field]);
  if (optionalMissing.length) hints.push(`没有识别到「${optionalMissing.join(" / ")}」列：这几列只用于对照盘点表与找货，不影响匹配和调账`);
  if (reasonColumnMissing) hints.push("模板没有「差异原因」列：差异原因可以在盘点单里逐行补填（也可以自己加一列写上）");

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
export function stocktakeTemplateWorkbook(): Buffer {
  const sheet = XLSX.utils.aoa_to_sheet([
    [...STOCKTAKE_TEMPLATE_HEADERS],
    ...STOCKTAKE_SAMPLE_ROWS.map((row) => [...row]),
  ]);
  sheet["!cols"] = STOCKTAKE_TEMPLATE_HEADERS.map((header) => ({ wch: Math.max(14, header.length * 2 + 8) }));
  const notes = XLSX.utils.aoa_to_sheet([
    ["填写说明"],
    ["1. 「库存盘点导入」表里那两行是示例，上传前请删掉或改成你的数据。"],
    ["2. 表头名就是口径，列顺序可以调整、多余的列会被忽略。必填：产品代码、实际数量。"],
    ["3. 产品代码 = 物料清单（【采购 → 物料清单】）里的「物料编码」，也是系统里物料的唯一标识；匹配时忽略大小写与空格。"],
    ["4. 一个产品代码在一份表里只能出现一行：多个仓位请把数量相加后填一行（库存按物料记一本账，同一产品分两行会重复计算差异）。"],
    ["5. 实际数量填盘点后的真实数量，允许 0（盘没了就填 0），不允许负数，最多 4 位小数。留空会被当成漏填并报错，不会当成 0。"],
    ["6. 产品名称 / 产品规格 留空不影响导入：匹配与调账都只看产品代码，这两列用于对照纸质盘点表。"],
    ["7. 仓位 / 货位 只作为盘点行的记录（本系统不按库位分账），填了就能在盘点单里看到，方便找货。"],
    ["8. 代码在本厂物料清单里找不到时会逐行报错，**不会自动新建物料**：模板里没有单位，建不出物料。请先到【采购 → 物料清单】新建（物料编码默认自动生成），再重新导入。"],
    ["9. 导入只会生成**盘点草稿单**：数量和差异原因都可以在页面上改，确认后才写库存调整；已确认的单子只能冲销，不能改。"],
    [`10. 单次最多 ${STOCKTAKE_MAX_ROWS} 行。`],
  ]);
  notes["!cols"] = [{ wch: 130 }];
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, "库存盘点导入");
  XLSX.utils.book_append_sheet(book, notes, "填写说明");
  return XLSX.write(book, { type: "buffer", bookType: "xlsx" });
}
