/**
 * 「销售单 Excel 补录」的解析口径（纯函数，无 Nest / Prisma 依赖，可脱离数据库被完整测试）。
 *
 * 用户 2026-11-02：「针对销售模块，现在要加一个补录功能。用户上传销售单 excel，系统进行字段读取
 * 与匹配，展示一份系统表单，让用户进行修改与确认。用户通过之后，再确认建立销售单。」
 * 同日拍板两件事：**两种版式都认**（先按我们自己的工艺单/生产单版式逐格对，认不出的再按字段名
 * 在整张表里找）、**一份文件 = 一张单**。
 *
 * 版式依据（`example/销售单/` 两份真实样本，也是工艺单导出
 * `sales-order-export.service.ts` 的版式来源）：
 *   - `DL260134 JBN生产单(1).xls`：表头写「标签：值」同格；正文左栏「材料 A 列 + 明细 B–F 列」、
 *     右栏「工艺要求 G–J 列」；**细分明细表嵌在材料区中间**；布量区在正唛/侧唛之下。
 *   - `DL260001-1 花色生产单-IS(FLOWER1 PO#32366-1).xlsx`：表头「标签」「值」分格；材料与工艺两栏；
 *     尾部还有一张「伞头」明细表（英文名 / 配色 / 条码 / 数量打）。
 *
 * 三条纪律（都是「纸上的字决定车间做什么」换来的）：
 *   1. **不猜**：认得出的才填，认不出的**如实上报**（`unrecognized`），由人在系统表单里补/改。
 *      猜错一格（把「伞带」的规格填进「布量」）在界面上看不出来，却会印到工厂照着做的单子上。
 *   2. **不丢**：同一类目出现多行（3 款伞头）按 2026-10-29 的口径收成「同类目再加一款」；不认识的
 *      材料类目收成「其它」行 —— 补录件里多一行可以删，少一行没人发现。
 *   3. **只读**：解析器不写库。建单仍走 `POST /sales-orders`（同一套 DTO / 归一 / 快照），
 *      补录只是把「手工打字」换成「预先填好」，口径与校验一份都不另起。
 *
 * 与全站其它导入（物料 / 盘点 / 其他应付 / 花名册）刻意保持距离：那边是**模板驱动**（按表头名认列、
 * 逐行校验、行级错误不连坐），这边是**版式驱动**（锚点是纸上的中文标签，不是列序号）——
 * 因为用户手上的 Excel 是**已经写给工厂的单子**，不是拿来给系统导入的模板。
 */

import * as XLSX from "xlsx";
import { MATERIAL_CATEGORY_LABELS, materialCategoryLabel, type MaterialCategoryKey } from "./sales-material-labels";
import { MATERIAL_EXTRA_CONTENT_MAX_LENGTH, MATERIAL_EXTRA_LABEL_MAX_LENGTH, MATERIAL_EXTRA_LIMIT } from "./sales-orders.service";
import { ITEM_NO_MAX_LENGTH } from "./item-no";

/** 单张表最多读多少行（整本台账误传时的护栏；不是业务上限）。 */
export const SALES_ORDER_IMPORT_MAX_ROWS = 400;
/** 细分明细最多收多少行（工艺单印不下更多）。 */
export const SALES_ORDER_IMPORT_MAX_DETAIL_ROWS = 200;

/** 「这一格被认成了什么」——给核对清单用，一条条摆给人看（`from` 是单元格地址）。 */
export type ImportedFact = { field: string; label: string; value: string; from: string };
/** 认不出的格子：原文照抄，让人自己在表单里补。 */
export type ImportedUnknown = { where: string; text: string };
export type ImportedDetailRow = { group_name: string; name: string; color: string; barcode: string; quantity: string; unit: string; sort_order: number };
/** 材料明细追加行：`spec_key` 非空 = 某个固定类目的「再加一款」；空 = 「其它」自由类目。 */
export type ImportedMaterialExtra = { label: string; content: string; spec_key: string | null; sort_order: number };

export type ParsedSalesOrder = {
  sheet_name: string;
  /** 请求键（snake_case）→ 文本。缺的键不出现（由服务层决定给不给默认值）。 */
  fields: Record<string, string>;
  details: ImportedDetailRow[];
  extras: ImportedMaterialExtra[];
  recognized: ImportedFact[];
  unrecognized: ImportedUnknown[];
  warnings: string[];
};

// --------------------------------------------------------------------------- 锚点清单
//
// 锚点 = 纸上的中文标签。两张样本是同一代模板的两种写法（「标签：值」同格 / 分格），
// 所以认法是「先认标签，再取它右边（或下一行同窗口）的第一段非空内容」。

type HeaderFieldKey =
  | "factory"
  | "order_no"
  | "customer_code"
  | "customer_po_no"
  | "external_contract_no"
  | "order_date"
  | "delivery_date"
  | "quantity"
  | "product_name"
  | "item_no"
  | "region"
  | "attention_note"
  | "unit"
  | "currency";

/**
 * 表头字段同义词。
 *
 * ⚠️「客户单号 → 订单号」是我们自己模板的口径（工艺单是发给**工厂**的：对工厂来说迪礼是客户，
 * 所以「客户单号」印的是我们的销售单号）。客户发来的原始订单里「客户单号」可能指他们自己的 PO ——
 * 那种表一般写「PO 号/订单号」，会落到 `customer_po_no`。认错了不要紧：核对清单会把
 * 「客户单号 → 订单号：DL260134」一条条摆出来，人一眼能改。
 */
const HEADER_FIELDS: ReadonlyArray<readonly [HeaderFieldKey, string, readonly string[]]> = [
  ["factory", "工厂", ["工厂", "工厂名称", "生产工厂"]],
  ["order_no", "订单号", ["客户单号", "订单号", "销售单号", "生产单号", "单号"]],
  ["customer_code", "客户", ["客户代码", "客户名称", "客户简称", "客户"]],
  ["customer_po_no", "客户 PO 号", ["客户po", "客户po号", "po号", "po", "客户订单号", "客户订单编号"]],
  ["external_contract_no", "外部合同号", ["合同号", "合同编号", "外部合同号"]],
  ["order_date", "下单日期", ["下单日期", "订单日期", "接单日期"]],
  ["delivery_date", "完工日期", ["完工日期", "交货日期", "交期"]],
  ["quantity", "数量", ["数量", "订单数量", "总数量", "合计数量"]],
  ["product_name", "品名规格", ["品名规格", "品名", "产品名称", "产品规格"]],
  ["item_no", "货号", ["货号", "货号/型号"]],
  ["region", "地区", ["地区", "销往地区", "国家"]],
  ["attention_note", "注意事项", ["注意事项", "注意", "备注"]],
  ["unit", "单位", ["单位", "计量单位"]],
  ["currency", "币种", ["币种", "货币"]],
];

/**
 * 工艺要求 9 项的同义词。
 *
 * 两张样本里编号是**断的**（样本1 是 1、2、4、5、6、7 + 吊牌位置 + 质检报告；样本2 是 1、2、6、7、8…），
 * 所以只能按词认、不能按编号认；编号只是这一条的前缀。
 */
const PROCESS_LABELS: ReadonlyArray<readonly [string, string, readonly string[]]> = [
  ["sample_requirement", "样品要求", ["样品要求", "产前样", "大货样", "大样", "产前样品"]],
  ["cutting_requirement", "裁布要求", ["裁布要求", "大裁开布要求", "开布要求", "小裁要求", "大裁", "小裁", "裁布"]],
  ["edge_requirement", "拉边要求", ["拉边要求", "拉边"]],
  ["joining_requirement", "合片要求", ["合片要求", "合片"]],
  ["top_stitch_requirement", "打顶要求", ["打顶要求", "打顶"]],
  ["sewing_requirement", "缝伞要求", ["缝伞要求", "缝伞"]],
  ["strap_requirement", "伞带要求", ["伞带要求"]],
  ["hang_tag_note", "吊牌位置", ["吊牌位置", "吊牌图稿", "吊牌"]],
  ["qc_requirement", "质检报告", ["质检报告", "质量检测报告", "质量检测", "质检"]],
];

/** 布量五格（模板「伞面/伞带/木耳/天布/布套（Y/DZ)」）。靠 `Y/DZ` 与材料区的同名标签区分。 */
const FABRIC_LABELS: ReadonlyArray<readonly [string, string, readonly string[]]> = [
  ["fabric_usage_canopy", "伞面布量", ["伞面"]],
  ["fabric_usage_strap", "伞带布量", ["伞带"]],
  ["fabric_usage_wood_ear", "木耳布量", ["木耳"]],
  ["fabric_usage_top", "天布布量", ["天布"]],
  ["fabric_usage_bag", "布套布量", ["布套"]],
];

/**
 * 18 个材料类目在纸上的写法（同义词）。
 *
 * 键与 `sales-material-labels.ts` 是同一份清单：印在纸上的类目名由它给，这里只补「纸上可能怎么写」。
 * `伞布` 是样本2 的写法（样本1 写「伞布规格」），`织唛` 是样本1 到货状态表里的写法（材料区写「织标」）——
 * 两处都必须认，否则同一份文件里同一类目会一半认得出。
 */
const MATERIAL_LABEL_ALIASES: Record<MaterialCategoryKey, readonly string[]> = {
  rib_spec: ["伞骨（孔对孔）", "伞骨(孔对孔)", "伞骨", "伞架"],
  canopy_spec: ["伞布规格", "伞布", "面料规格", "布料规格"],
  handle_spec: ["伞头"],
  handle_strap_spec: ["伞头带"],
  tail_spec: ["伞尾、笠", "伞尾/笠", "伞尾", "伞笠", "伞尾、伞笠"],
  runner_spec: ["伞束、珠", "伞束", "伞珠", "伞束、伞珠"],
  strap_spec: ["伞带"],
  strap_fastener_spec: ["伞带粘扣", "粘扣", "魔术贴"],
  inner_label_spec: ["内标"],
  woven_label_spec: ["织标", "织唛"],
  hang_tag_spec: ["吊牌"],
  opp_spec: ["opp", "opp袋", "opp套"],
  bag_spec: ["布套", "伞套"],
  packaging_spec: ["包装明细", "包装方式", "包装"],
  top_fabric_spec: ["天布"],
  wood_ear_spec: ["木耳", "木耳花"],
  keychain_spec: ["钥匙扣"],
  printing_spec: ["印刷"],
};

/** 正唛 / 侧唛：值可能在同一行右边，也可能在下一行的同一段里（两张样本都是后一种）。 */
const MARK_LABELS: ReadonlyArray<readonly [string, string, readonly string[]]> = [
  ["shipping_mark_front", "正唛", ["正唛", "正唛头"]],
  ["shipping_mark_side", "侧唛", ["侧唛", "侧唛头"]],
];

/** 细分明细的列头同义词（一张是「品番/品名 + カラー（颜色）+ 数量」，一张只有英文名/配色/条码/数量打）。 */
const DETAIL_NAME_ALIASES = ["品番/品名", "品番", "品名", "产品名称", "名称", "英文名", "名字", "款式", "花号", "花色", "型号"];
const DETAIL_COLOR_ALIASES = ["カラー", "颜色", "配色", "色号"];
const DETAIL_BARCODE_ALIASES = ["条码", "条形码", "barcode", "货号"];
const DETAIL_QTY_ALIASES = ["数量", "件数", "qty", "套数"];

// --------------------------------------------------------------------------- 文本归一

type GridCell = { text: string; raw: unknown };
type CellRange = { row: number; col: number };
type Grid = { sheetName: string; cells: GridCell[][]; width: number; merges: Map<string, { endRow: number; endCol: number }>; otherSheets: string[] };

const WHITESPACE = /[\s\u3000]+/g;
const pad2 = (value: number): string => String(value).padStart(2, "0");

/** 显示用文本：折叠空白（纸上的换行与全角空格对字段值没有意义）。 */
const collapse = (text: string): string => text.replace(WHITESPACE, " ").trim();

/**
 * 比对用文本：去掉**全部**空白、冒号，并转小写。
 *
 * 为什么空白要全去掉（不是折叠成一个）：纸上的标签为了对齐会写成「数　　量」「工　厂」「明  细」，
 * 折叠后仍带一个空格，就一个也认不出来（第一版就是这么把「数量」整格漏掉的）。
 * 为什么转小写：`OPP` / `opp` / `OPP套` 在两张样本里大小写不一致，靠它统一。
 */
const labelKey = (text: string): string => text.replace(WHITESPACE, "").replace(/[：:]/g, "").toLowerCase();

/** 布量标签的专门归一：`伞面（Y/DZ)` → `伞面`（Y/DZ 是纸上的固定单位说明，不是类目名的一部分）。 */
const fabricKey = (text: string): string => labelKey(text).replace(/[（(]?y\/?dz[）)]?/g, "");

const isBlank = (text: string): boolean => text.trim() === "";

/** 数字 → 十进制文本（去掉浮点尾巴：0.1+0.2 那种脏值不进表单）。 */
function formatNumber(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return String(Number(value.toFixed(6)));
}

/** 单元格 → 文本。数字优先用 Excel 的**显示文本**（`1960支` / `2505打` 的单位就藏在这里）。 */
function cellText(cell: XLSX.CellObject | undefined): string {
  if (!cell) return "";
  const value = cell.v;
  if (value === null || value === undefined) return "";
  const display = typeof cell.w === "string" ? cell.w.trim() : "";
  if (typeof value === "number") {
    if (display && /[^\d.,\-+eE\s]/.test(display)) return collapse(display);
    return formatNumber(value);
  }
  if (typeof value === "boolean") return value ? "是" : "否";
  if (value instanceof Date) return `${value.getFullYear()}-${pad2(value.getMonth() + 1)}-${pad2(value.getDate())}`;
  return collapse(String(value));
}

const addressOf = (row: number, col: number): string => `${XLSX.utils.encode_col(col)}${row + 1}`;

/** 把工作表铺成二维文本网格（合并区只有左上格有值，与 Excel 显示一致），顺带记下合并范围。 */
function readGrid(buffer: Buffer): Grid {
  const book = XLSX.read(buffer, { type: "buffer", cellDates: false, dense: false });
  // 一份文件按**一张单**处理（用户 2026-11-02 拍板）：只读第一张有内容的表，其余如实上报。
  const dataSheets = book.SheetNames.filter((name) => Boolean(book.Sheets[name]?.["!ref"]));
  const sheetName = dataSheets[0];
  if (!sheetName) throw new Error("EMPTY_WORKBOOK");
  const sheet = book.Sheets[sheetName];
  const range = XLSX.utils.decode_range(sheet["!ref"]!);
  const lastRow = Math.min(range.e.r, range.s.r + SALES_ORDER_IMPORT_MAX_ROWS - 1);
  const cells: GridCell[][] = [];
  for (let row = range.s.r; row <= lastRow; row += 1) {
    const line: GridCell[] = [];
    for (let col = range.s.c; col <= range.e.c; col += 1) {
      const cell = sheet[XLSX.utils.encode_cell({ r: row, c: col })];
      line.push({ text: cellText(cell), raw: cell?.v });
    }
    cells.push(line);
  }
  const merges = new Map<string, { endRow: number; endCol: number }>();
  for (const merge of sheet["!merges"] ?? []) {
    merges.set(`${merge.s.r}:${merge.s.c}`, { endRow: merge.e.r, endCol: merge.e.c });
  }
  return { sheetName, cells, width: range.e.c - range.s.c + 1, merges, otherSheets: dataSheets.slice(1) };
}

// --------------------------------------------------------------------------- 日期 / 数量

/**
 * 日期文本 → `YYYY-MM-DD`（样本里出现过 `2026.6.18`、`2025.12.15`、`2026.7.30进仓`；Excel 里还可能是
 * 日期序列号）。认不出来返回空串 —— 绝不猜一个"看起来像"的日期。
 */
export function parseImportDate(value: unknown, text: string): string {
  if (typeof value === "number" && value > 20000 && value < 80000) {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (parsed) return `${parsed.y}-${pad2(parsed.m)}-${pad2(parsed.d)}`;
  }
  const source = collapse(text);
  const full = /(\d{4})\s*[.\-/年]\s*(\d{1,2})\s*[.\-/月]\s*(\d{1,2})/.exec(source);
  if (full) return `${full[1]}-${pad2(Number(full[2]))}-${pad2(Number(full[3]))}`;
  const short = /^(\d{2})\s*[.\-/]\s*(\d{1,2})\s*[.\-/]\s*(\d{1,2})/.exec(source);
  if (short) return `20${short[1]}-${pad2(Number(short[2]))}-${pad2(Number(short[3]))}`;
  // Excel 默认区域设置下的 m/d/yy（6/18/26）：两位年份按 20xx 解读。
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(source);
  if (us) {
    const year = us[3].length === 2 ? `20${us[3]}` : us[3];
    const month = Number(us[1]) > 12 ? Number(us[2]) : Number(us[1]);
    const day = Number(us[1]) > 12 ? Number(us[1]) : Number(us[2]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) return `${year}-${pad2(month)}-${pad2(day)}`;
  }
  return "";
}

/** 「完工日期」那一格常把日期与备注合写（`2026.7.30进仓`）：日期给交期，尾巴进完工备注。 */
function splitDateAndRemark(text: string, value: unknown): { date: string; remark: string } {
  const date = parseImportDate(value, text);
  if (!date) return { date: "", remark: "" };
  const source = collapse(text);
  const match = /(\d{4}\s*[.\-/年]\s*\d{1,2}\s*[.\-/月]\s*\d{1,2}|\d{1,2}\/\d{1,2}\/\d{2,4})/.exec(source);
  const rest = match ? source.slice(match.index + match[0].length).replace(/^[\s：:、,，]+/, "") : "";
  return { date, remark: rest };
}

/** 数量格 → `{ quantity, unit }`（`1960支` / `2505打` / `1,960 PCS` / 纯数字）。 */
export function parseQuantityCell(text: string): { quantity: string; unit: string } {
  const source = collapse(text).replace(/,/g, "");
  const match = /^([+-]?\d+(?:\.\d+)?)\s*(.*)$/.exec(source);
  if (!match) return { quantity: "", unit: "" };
  if (Number(match[1]) < 0) return { quantity: "", unit: "" };
  const unit = match[2].replace(/[（(][^）)]*[）)]/g, "").trim();
  return { quantity: formatNumber(Number(match[1])), unit: unit.length <= 10 ? unit : "" };
}

// --------------------------------------------------------------------------- 主流程

export function parseSalesOrderWorkbook(buffer: Buffer): ParsedSalesOrder {
  const grid = readGrid(buffer);
  const state: ParserState = { grid, fields: {}, details: [], extras: [], recognized: [], unrecognized: [], warnings: [], consumed: new Set() };
  const layout = findLayout(grid);
  if (layout) consumeDetailTables(state, layout);
  readHeaderFields(state, layout);
  if (layout) readBody(state, layout);
  collectUnrecognizedHeader(state, layout);
  noteOneOrderPerFile(state, layout);
  fillMissingWarnings(state);
  return {
    sheet_name: grid.sheetName,
    fields: state.fields,
    details: state.details,
    extras: state.extras,
    recognized: state.recognized,
    unrecognized: state.unrecognized,
    warnings: state.warnings,
  };
}

type ParserState = {
  grid: Grid;
  fields: Record<string, string>;
  details: ImportedDetailRow[];
  extras: ImportedMaterialExtra[];
  recognized: ImportedFact[];
  unrecognized: ImportedUnknown[];
  warnings: string[];
  consumed: Set<string>;
};

type Layout = {
  /** 「材料 / 明细 / 工艺要求」那一行（0 起）。 */
  headerRow: number;
  /** 材料区（左栏）的列宽：0..materialEnd-1；右栏从 materialEnd 起（工艺要求 + 样本2 挤在右边的材料行）。 */
  materialEnd: number;
};

const textAt = (state: ParserState, row: number, col: number): string => state.grid.cells[row]?.[col]?.text ?? "";
const rawAt = (state: ParserState, row: number, col: number): unknown => state.grid.cells[row]?.[col]?.raw;
const consumedKey = (row: number, col: number): string => `${row}:${col}`;

/**
 * 正文分栏：认「材料」「工艺要求」两格所在的行；材料区的右边界取「明　细」这一格**合并范围的右端**
 * （样本2 的 B6:G6 说明材料值到 G 列为止，H 起的「吊牌图稿发客人确认」是工艺内容，不是材料值）。
 */
function findLayout(grid: Grid): Layout | null {
  for (let row = 0; row < grid.cells.length; row += 1) {
    const line = grid.cells[row];
    const materialCol = line.findIndex((cell) => labelKey(cell.text) === "材料");
    const processCol = line.findIndex((cell) => labelKey(cell.text).startsWith("工艺要求"));
    if (materialCol < 0 || processCol < 0) continue;
    const detailCol = line.findIndex((cell) => labelKey(cell.text) === "明细");
    const merge = detailCol >= 0 ? grid.merges.get(`${row}:${detailCol}`) : undefined;
    const materialEnd = merge ? merge.endCol + 1 : processCol;
    return { headerRow: row, materialEnd: Math.max(materialEnd, detailCol + 1, 1) };
  }
  return null;
}

function recordFact(state: ParserState, field: string, label: string, value: string, target: CellRange): void {
  state.recognized.push({ field, label, value, from: addressOf(target.row, target.col) });
}

/** 字段长度上限：与建单 DTO 同一组数（否则表单能填、保存 400）。 */
const FIELD_MAX: Record<string, number> = {
  factory: 100,
  order_no: 100,
  customer_po_no: 100,
  external_contract_no: 100,
  product_name: 200,
  item_no: ITEM_NO_MAX_LENGTH,
  completion_remark: 100,
  attention_note: 2000,
  shipping_mark_front: 2000,
  shipping_mark_side: 2000,
};

/** 写一个字段（**先到先得**：同一份表里第一个认出来的说了算）。 */
function assignField(state: ParserState, field: string, label: string, value: string, target: CellRange, maxLength = 1000): void {
  const text = value.trim();
  if (!text || state.fields[field]) return;
  let final = text;
  if (text.length > maxLength) {
    final = text.slice(0, maxLength);
    state.warnings.push(`「${label}」原文超过 ${maxLength} 字，已截到上限，请核对`);
  }
  state.fields[field] = final;
  recordFact(state, field, label, final, target);
}

// --------------------------------------------------------------------------- 表头

type HeaderHit = { key: HeaderFieldKey; label: string; alias: string; col: number };

/**
 * 表头字段：只在正文分栏**之上**的行里找。
 *
 * 为什么限定在上方：下面「数量」「客户」这些词还会出现在明细表头里（「数量」就是明细的一列），
 * 在整张表里找必然抓错一行。取值顺序：① 同一格「标签：值」；② 同一行右边第一段非空内容。
 * **不做「下一行」回退**：表头的值写在下一行的情况只出现在唛头（那在正文区，另有专门的读法），
 * 而「下一行」回退会把下一个标签本身当成上一个字段的值（样本1 的「工厂」下一行就是「数量」）。
 */
function readHeaderFields(state: ParserState, layout: Layout | null): void {
  const lastRow = layout ? layout.headerRow - 1 : Math.min(state.grid.cells.length, 12) - 1;
  for (let row = 0; row <= lastRow; row += 1) {
    const hits = findHeaderLabels(state, row);
    for (const hit of hits) {
      const inline = inlineAfterLabel(textAt(state, row, hit.col), hit.alias);
      if (inline) {
        takeHeaderField(state, hit, inline, { row, col: hit.col });
        state.consumed.add(consumedKey(row, hit.col));
        continue;
      }
      const found = firstNonEmpty(state, row, hit.col + 1, nextLabelCol(hits, hit.col), (text) => !isHeaderLabelText(text));
      if (found) {
        takeHeaderField(state, hit, found.text, found.target);
        state.consumed.add(consumedKey(found.target.row, found.target.col));
      }
    }
  }
}

/**
 * 一行里的表头标签：**长的优先**（「客户单号」与「客户」同在一行时，不能把「客户单号」认成「客户」），
 * 同一个字段只认第一次出现的位置。
 */
function findHeaderLabels(state: ParserState, row: number): HeaderHit[] {
  const hits: HeaderHit[] = [];
  const seen = new Set<string>();
  (state.grid.cells[row] ?? []).forEach((cell, col) => {
    const key = labelKey(cell.text);
    if (!key) return;
    const candidates: Array<HeaderHit & { length: number }> = [];
    for (const [field, label, aliases] of HEADER_FIELDS) {
      for (const alias of aliases) {
        const aliasKey = labelKey(alias);
        if (!aliasKey || !key.startsWith(aliasKey)) continue;
        candidates.push({ key: field, label, alias, col, length: aliasKey.length });
      }
    }
    if (!candidates.length) return;
    candidates.sort((left, right) => right.length - left.length);
    const hit = candidates[0];
    if (seen.has(hit.key)) return;
    seen.add(hit.key);
    hits.push({ key: hit.key, label: hit.label, alias: hit.alias, col });
  });
  return hits;
}

/** 「标签：值」同格时把值切出来。`标签` 里可能夹着全角空格（「工　厂」），按归一后的文本定位。 */
function inlineAfterLabel(text: string, alias: string): string {
  const source = collapse(text);
  const aliasKey = labelKey(alias);
  if (!source || !labelKey(source).startsWith(aliasKey)) return "";
  let consumed = 0;
  let matched = 0;
  for (const char of source) {
    consumed += char.length;
    if (/[\s\u3000：:]/.test(char)) continue;
    matched += char.length;
    if (matched >= aliasKey.length) break;
  }
  return source.slice(consumed).replace(/^[\s：:]+/, "");
}

function nextLabelCol(hits: HeaderHit[], col: number): number {
  const next = hits.map((hit) => hit.col).filter((value) => value > col).sort((left, right) => left - right)[0];
  return next ?? Number.MAX_SAFE_INTEGER;
}

function takeHeaderField(state: ParserState, hit: HeaderHit, value: string, target: CellRange): void {
  if (hit.key === "order_date") {
    const date = parseImportDate(rawAt(state, target.row, target.col), value);
    if (date) assignField(state, "order_date", hit.label, date, target, 10);
    return;
  }
  if (hit.key === "delivery_date") {
    const { date, remark } = splitDateAndRemark(value, rawAt(state, target.row, target.col));
    if (date) {
      assignField(state, "delivery_date", hit.label, date, target, 10);
      if (remark) assignField(state, "completion_remark", "完工备注", remark, target, FIELD_MAX.completion_remark);
    }
    return;
  }
  if (hit.key === "quantity") {
    const { quantity, unit } = parseQuantityCell(value);
    if (quantity) assignField(state, "quantity", hit.label, quantity, target, 30);
    if (unit) assignField(state, "unit", "单位", unit, target, 30);
    return;
  }
  if (hit.key === "customer_code") {
    // 客户代码只是「对上客户」的线索，本身不是销售单字段（建单要客户 id）。
    const raw = value.trim();
    if (raw && !state.fields.customer_code) {
      state.fields.customer_code = raw;
      recordFact(state, "customer_code", "客户（待匹配）", raw, target);
    }
    return;
  }
  if (hit.key === "region") {
    const raw = value.trim();
    if (raw && !state.fields.region) {
      state.fields.region = raw;
      recordFact(state, "region", "地区（仅用于核对客户）", raw, target);
    }
    return;
  }
  assignField(state, hit.key, hit.label, value, target, FIELD_MAX[hit.key] ?? 1000);
}

type Found = { text: string; target: CellRange };

/** 从 (row, col) 起向右找第一段非空内容；`stop` 是上界（下一个标签所在的列）。 */
function firstNonEmpty(state: ParserState, row: number, col: number, stop: number, accept: (text: string) => boolean): Found | null {
  for (let current = col; current < Math.min(stop, state.grid.width); current += 1) {
    if (state.consumed.has(consumedKey(row, current))) continue;
    const text = textAt(state, row, current);
    if (!isBlank(text) && accept(text)) return { text, target: { row, col: current } };
  }
  return null;
}

// --------------------------------------------------------------------------- 细分明细

/** 明细表的一列：品名在左，颜色/条码/数量/单位往右排。 */
type DetailBlock = { nameCol: number; colorCol: number; barcodeCol: number; qtyCol: number; unitCol: number; unitFromHeader: string };
type DetailTable = { headerRow: number; blocks: DetailBlock[] };

/**
 * 找出表里的明细表并读成 `spec_details` 行（一张表可能有多块并排：样本1 就是左右两块伞布明细）；
 * 尾部单独的「伞头」表（英文名/配色/条码/数量打）也走这条。
 *
 * 认法：某一行里同时有「数量」类列头与它左边的「品名/品番/名字」类列头。数据行到「所有块的品名与
 * 数量都空」或「遇到材料/唛头这类标签」为止 —— 明细表可能嵌在材料区中间（样本1 第 10–16 行），
 * 下一行就是「伞头」这样的材料标签，用「表头列全空」判结束才不会被材料行骗过去。
 */
function consumeDetailTables(state: ParserState, layout: Layout): void {
  const consumedRows = new Set<number>();
  for (let row = layout.headerRow + 1; row < state.grid.cells.length; row += 1) {
    if (consumedRows.has(row)) continue;
    const table = detectDetailTable(state, row);
    if (!table) continue;
    const rows: ImportedDetailRow[] = [];
    let lastRow = row;
    for (let cursor = row + 1; cursor < state.grid.cells.length; cursor += 1) {
      if (isTerminatorRow(state, table, cursor)) break;
      const line = readDetailLine(state, table, cursor);
      // 停表条件之一：**整行没有数量**。明细表嵌在材料区里（样本1 第 10–16 行），紧随其后的
      // 「伞头 / 伞头带…」那一行在某些块里仍会落在品名列上（右块的品名列正好是工艺栏），
      // 只看「品名与数量都空」会把后面整片材料当明细读进来（第一版多读了 19 行）。
      if (line.every((cell) => isBlank(cell.quantity))) break;
      const empty = line.every((cell) => isBlank(cell.name) && isBlank(cell.quantity));
      if (empty) break;
      lastRow = cursor;
      for (const [index, cell] of line.entries()) {
        if (isBlank(cell.name) && isBlank(cell.quantity)) continue;
        if (rows.length >= SALES_ORDER_IMPORT_MAX_DETAIL_ROWS) break;
        rows.push({ group_name: "", name: cell.name, color: cell.color, barcode: cell.barcode, quantity: cell.quantity, unit: cell.unit || table.blocks[index].unitFromHeader, sort_order: rows.length });
      }
    }
    // 至少一行数据才算明细表（否则可能只是表头里恰好有「数量」两个字）。
    if (!rows.length) continue;
    const groupName = groupNameOf(state, table.headerRow);
    for (const line of rows) line.group_name = groupName;
    for (let cursor = row; cursor <= lastRow; cursor += 1) {
      consumedRows.add(cursor);
      for (let col = 0; col < state.grid.width; col += 1) state.consumed.add(consumedKey(cursor, col));
    }
    // 表头上面那一行常是分组横幅（`DL260134 伞布明细（图片见客户原稿…）`）：整行吃掉，
    // 否则它会被当成「上一行材料标签的续写」灌进某个材料字段。
    const bannerRow = row - 1;
    if (bannerRow > layout.headerRow && !consumedRows.has(bannerRow) && isBannerRow(state, table, bannerRow)) {
      consumedRows.add(bannerRow);
      for (let col = 0; col < state.grid.width; col += 1) state.consumed.add(consumedKey(bannerRow, col));
    }
    state.details.push(...rows);
    state.warnings.push(`读到细分明细 ${rows.length} 行（分组「${groupName}」），请核对品名与数量`);
  }
}

function isQtyHeader(text: string): boolean {
  const key = labelKey(text);
  if (!key || key.length > 12) return false;
  return DETAIL_QTY_ALIASES.some((alias) => key.includes(labelKey(alias)));
}

function qtyHeaderUnit(text: string): string {
  const match = /[\/／]\s*([^\s/／]+)\s*$/.exec(collapse(text));
  return match ? match[1] : "";
}

function columnMatching(state: ParserState, row: number, aliases: readonly string[], from: number, to: number): number {
  for (let col = Math.max(0, from); col < Math.min(to, state.grid.width); col += 1) {
    const key = labelKey(textAt(state, row, col));
    if (!key) continue;
    if (aliases.some((alias) => key.includes(labelKey(alias)))) return col;
  }
  return -1;
}

function detectDetailTable(state: ParserState, row: number): DetailTable | null {
  const qtyCols: number[] = [];
  for (let col = 0; col < state.grid.width; col += 1) if (isQtyHeader(textAt(state, row, col))) qtyCols.push(col);
  if (!qtyCols.length) return null;
  const blocks: DetailBlock[] = [];
  for (const qtyCol of qtyCols) {
    const nameCandidates: number[] = [];
    for (let col = 0; col < qtyCol; col += 1) {
      const key = labelKey(textAt(state, row, col));
      // 品名列头可能是一长串说明（样本2 的「Flower1 伞头英文名字 伞头图片…」），所以只卡 40 字。
      if (!key || key.length > 40) continue;
      if (DETAIL_NAME_ALIASES.some((alias) => key.includes(labelKey(alias)))) nameCandidates.push(col);
    }
    const near = nameCandidates.filter((col) => qtyCol - col <= 12);
    if (!near.length) continue;
    const nameCol = Math.max(...near);
    const colorCol = columnMatching(state, row, DETAIL_COLOR_ALIASES, nameCol + 1, qtyCol);
    const barcodeCol = columnMatching(state, row, DETAIL_BARCODE_ALIASES, nameCol + 1, qtyCol);
    const unitCol = columnMatching(state, row, ["单位"], qtyCol + 1, state.grid.width);
    blocks.push({ nameCol, colorCol, barcodeCol, qtyCol, unitCol, unitFromHeader: qtyHeaderUnit(textAt(state, row, qtyCol)) });
  }
  return blocks.length ? { headerRow: row, blocks } : null;
}

/** 结束行：所有块的品名与数量都空，或品名列里出现的其实是下一个区块的标签（「伞头」「正唛」）。 */
function isTerminatorRow(state: ParserState, table: DetailTable, row: number): boolean {
  return table.blocks.some((block) => classifyLabel(textAt(state, row, block.nameCol)) !== null);
}

type DetailLineCell = { name: string; color: string; barcode: string; quantity: string; unit: string };

function readDetailLine(state: ParserState, table: DetailTable, row: number): DetailLineCell[] {
  return table.blocks.map((block) => {
    const name = textAt(state, row, block.nameCol);
    const color = block.colorCol >= 0 ? textAt(state, row, block.colorCol) : "";
    const barcode = block.barcodeCol >= 0 ? textAt(state, row, block.barcodeCol) : "";
    const { quantity, unit } = parseQuantityCell(textAt(state, row, block.qtyCol));
    const unitCell = block.unitCol >= 0 ? textAt(state, row, block.unitCol) : "";
    return { name: name.slice(0, 200), color: color.slice(0, 100), barcode: barcode.slice(0, 100), quantity, unit: (unit || unitCell).slice(0, 30) };
  });
}

/** 表头上方是不是一块分组横幅（只有一个非空格、且不含任何已知标签）。 */
function isBannerRow(state: ParserState, table: DetailTable, row: number): boolean {
  const firstCol = Math.min(...table.blocks.map((block) => block.nameCol));
  const texts: string[] = [];
  for (let col = 0; col < state.grid.width; col += 1) {
    const text = textAt(state, row, col);
    if (!isBlank(text)) texts.push(text);
  }
  if (texts.length !== 1) return false;
  if (firstCol > 0 && !isBlank(textAt(state, row, firstCol - 1))) return false;
  return classifyLabel(texts[0]) === null && !isHeaderLabelText(texts[0]) && !isFooterText(texts[0]);
}

/**
 * 明细分组名（`group_name` 必填）。
 *
 * 只认**带「明细」二字**的横幅（样本1 的 A10「DL260134 伞布明细（伞布到库后请通知跟单核对）」、
 * 我们自己导出的一整行 `{单号} {分组}（图片见客户原稿…）`）；没有横幅就按表头里出现的「伞头/伞布」
 * 说一个（样板产品的明细只有这两类），再不行就叫「明细」。分组名在表单里可改，**不为了好看去猜**。
 */
function groupNameOf(state: ParserState, headerRow: number): string {
  const candidates: string[] = [];
  for (const row of [headerRow, headerRow - 1, headerRow - 2]) {
    if (row < 0) continue;
    for (let col = 0; col < state.grid.width; col += 1) {
      const text = textAt(state, row, col);
      if (!isBlank(text)) candidates.push(text);
    }
  }
  for (const candidate of candidates) {
    if (!candidate.includes("明细")) continue;
    const cleaned = cleanGroupName(candidate, state.fields.order_no ?? "");
    if (cleaned.length >= 2 && cleaned.length <= 20) return cleaned;
  }
  const headerText = Array.from({ length: state.grid.width }, (_, col) => textAt(state, headerRow, col)).join(" ");
  if (headerText.includes("伞头")) return "伞头明细";
  if (headerText.includes("伞布")) return "伞布明细";
  return "明细";
}

/** 横幅 → 分组名：去掉单号前缀与括号说明（「DL260134 伞布明细（…）」→「伞布明细」）。 */
function cleanGroupName(text: string, orderNo: string): string {
  let name = collapse(text);
  if (orderNo && name.toLowerCase().startsWith(orderNo.toLowerCase())) name = name.slice(orderNo.length).trim();
  name = name.replace(/^[A-Za-z]{1,5}\d[\w\-]*\s*/, "").trim();
  name = name.replace(/[（(][^（）()]*[）)]/g, " ").trim();
  return collapse(name);
}

// --------------------------------------------------------------------------- 正文（材料 / 工艺 / 布量 / 唛头）

type Segment =
  | { kind: "material"; key: MaterialCategoryKey; label: string; col: number }
  | { kind: "fabric"; key: string; label: string; col: number }
  | { kind: "mark"; key: string; label: string; col: number }
  | { kind: "unknown"; label: string; col: number };

const materialLabelIndex = buildMaterialLabelIndex();
function buildMaterialLabelIndex(): Map<string, { key: MaterialCategoryKey; label: string }> {
  const index = new Map<string, { key: MaterialCategoryKey; label: string }>();
  for (const [key, label] of MATERIAL_CATEGORY_LABELS) {
    for (const alias of [label, ...(MATERIAL_LABEL_ALIASES[key] ?? [])]) {
      const aliasKey = labelKey(alias);
      if (aliasKey && !index.has(aliasKey)) index.set(aliasKey, { key, label });
    }
  }
  return index;
}

/**
 * 一格文本是什么标签？布量靠 `Y/DZ` 与材料区的同名标签区分（「伞带」在两边都有）；
 * 材料类目要求**整格相等**（「包装要求」不是「包装明细」），否则一句「伞头需印 LOGO」就会被当成类目名。
 */
function classifyLabel(text: string): Segment | null {
  const key = labelKey(text);
  if (!key) return null;
  const markedFabric = key.includes("y/dz") || key.includes("ydz");
  const fabric = FABRIC_LABELS.find(([, , aliases]) => aliases.some((alias) => fabricKey(text) === labelKey(alias)));
  if (fabric && markedFabric) return { kind: "fabric", key: fabric[0], label: fabric[1], col: 0 };
  const mark = MARK_LABELS.find(([, , aliases]) => aliases.some((alias) => key === labelKey(alias)));
  if (mark) return { kind: "mark", key: mark[0], label: mark[1], col: 0 };
  const material = materialLabelIndex.get(key);
  if (material) return { kind: "material", key: material.key, label: material.label, col: 0 };
  return null;
}

const isHeaderLabelText = (text: string): boolean => {
  const key = labelKey(text);
  return HEADER_FIELDS.some(([, , aliases]) => aliases.some((alias) => key.startsWith(labelKey(alias))));
};

const isFooterText = (text: string): boolean => {
  const key = labelKey(text);
  return /^(制单|审核|制表时间)/.test(key) || /^第\d+页/.test(key) || key.startsWith("图片区") || key.startsWith("核对提示");
};

/** 正文：材料 / 布量 / 唛头（左栏 + 右栏的已知标签）与工艺要求（右栏）各走一遍。 */
function readBody(state: ParserState, layout: Layout): void {
  let lastMaterial: { key: string; label: string; row: number } | null = null;
  for (let row = layout.headerRow + 1; row < state.grid.cells.length; row += 1) {
    if (isRowConsumed(state, row)) continue;
    // 「材料到货状态」以下是仓库收货用的勾选表（伞骨/伞布/纸箱/不干胶…），不是这一单的材料口径：
    // 再往下读只会把勾选项当成类目内容（第一版把「纸箱」「不干胶」读成了 OPP、伞头的第二款）。
    const rowText = collectRowLabels(state, row);
    if (/材料到货状态/.test(rowText)) break;
    const segments = splitSegments(state, row, layout);
    if (!segments.length) {
      // 只有值、没有标签的行：属于上一行材料标签的续写（样本2 第 22 行「OPP袋、伞头…」是「印刷」的续写）。
      // 但要求第一段非空内容落在**值列**（第 2 列起）—— 落在第 1 列的多半是一个自己起名的小标题
      // （样本2 第 10 行「Flower1 外层花色」），它是下一行的抬头，不是上一格内容的一部分。
      const firstCol = firstContentCol(state, row);
      if (lastMaterial && row === lastMaterial.row + 1 && firstCol > 0) {
        const texts = collectValues(state, row, 0, layout.materialEnd);
        if (texts) appendField(state, lastMaterial.key, texts, { row, col: firstCol });
      }
      continue;
    }
    // 一行里只有「自己起名的小标题 + 一串值」（样本2「搭配内层颜色」+ 6 个颜色）：右栏的值也属于它 ——
    // 那些值不是工艺条目，不并进来就只剩一半，还会在核对清单里变成几条「认不出」。
    if (segments.length === 1 && segments[0].segment.kind === "unknown") {
      const extraValues: string[] = [];
      for (let col = layout.materialEnd; col < state.grid.width; col += 1) {
        if (state.consumed.has(consumedKey(row, col))) continue;
        const text = textAt(state, row, col);
        if (isBlank(text) || classifyLabel(text) || isFooterText(text)) continue;
        extraValues.push(text);
        state.consumed.add(consumedKey(row, col));
      }
      if (extraValues.length) segments[0].value = collapse([segments[0].value, ...extraValues].join(" "));
    }
    for (const item of segments) {
      const { segment, value, target } = item;
      if (segment.kind === "mark") {
        const resolved = value || markValueBelow(state, row, segment.col, layout);
        if (resolved) assignField(state, segment.key, segment.label, resolved, target, 2000);
        continue;
      }
      if (segment.kind === "fabric") {
        const cleaned = stripFabricUnit(value);
        if (cleaned) assignField(state, segment.key, segment.label, cleaned, target, 30);
        continue;
      }
      if (segment.kind === "material") {
        const text = value || materialValueBelow(state, row, segment.col, layout);
        if (!text) continue;
        if (!state.fields[segment.key]) assignField(state, segment.key, segment.label, text, target, 1000);
        // 同一类目第二行起 = 「同类目再加一款」（2026-10-29 的口径：3 款伞头就是 3 行伞头）。
        else addExtra(state, segment.label, text, segment.key);
        lastMaterial = { key: segment.key, label: segment.label, row };
        continue;
      }
      // 不认识的类目：收成「其它」行（多一行可以删，少一行没人发现）。
      if (value) addExtra(state, truncateLabel(segment.label), value, null);
    }
  }
  readProcessLines(state, layout);
}

function isRowConsumed(state: ParserState, row: number): boolean {
  return (state.grid.cells[row] ?? []).every((_, col) => state.consumed.has(consumedKey(row, col)));
}

/** 一行里所有非空文本（拼起来做「到货状态」这类整行判断用）。 */
function collectRowLabels(state: ParserState, row: number): string {
  return (state.grid.cells[row] ?? []).map((cell) => cell.text).filter((text) => !isBlank(text)).join(" ");
}

/** 一行里第一个非空、且没被吃掉的格子所在的列（没有就返回 -1）。 */
function firstContentCol(state: ParserState, row: number): number {
  const line = state.grid.cells[row] ?? [];
  for (let col = 0; col < line.length; col += 1) {
    if (state.consumed.has(consumedKey(row, col))) continue;
    if (!isBlank(line[col].text)) return col;
  }
  return -1;
}

/**
 * 这一格是不是**标签**（而不是恰好和某个类目同名的值）。
 *
 * 为什么需要这道判断：我们自己导出的工艺单里，有类目的**值就是类目名**（「织标 | 织标」
 * 「钥匙扣 | 钥匙扣」）。只按"文本等于类目名"判标签，就会把值当成新标签，把上一格的值弄丢
 * （第一版从「织标」那一行起整块错位）。
 *
 * 判定：① 行首的格子一定是标签；② 行中间的格子，若与**当前正打开的那一段是同一个类目**、且它右边
 * 再没有内容 → 它是那一段的值（「织标 | 织标」）；③ 其余都当标签（样本1 的「木耳：| 本布…」、
 * 我们自己导出的「正唛 | 值 | 侧唛 | 值」都是这种）。
 */
function isLabelStart(state: ParserState, row: number, col: number, open: Segment | null, segment: Segment): boolean {
  if (col === firstContentCol(state, row)) return true;
  if (!open) return true;
  if (segmentKey(open) !== segmentKey(segment)) return true;
  return hasContentRight(state, row, col);
}

/** 段的身份（类目键/唛头键；`unknown` 每段各自独立）。 */
function segmentKey(segment: Segment): string {
  return segment.kind === "unknown" ? "unknown" : `${segment.kind}:${segment.key}`;
}

function hasContentRight(state: ParserState, row: number, afterCol: number): boolean {
  for (let col = afterCol + 1; col < state.grid.width; col += 1) {
    if (state.consumed.has(consumedKey(row, col))) continue;
    if (!isBlank(textAt(state, row, col))) return true;
  }
  return false;
}

/**
 * 把一行切成若干「标签 + 值」段。段与段之间以**已知标签**为界。
 *
 * 左栏（0..materialEnd）里的自由文本按「上一段的续写」处理（样本2 的「搭配内层颜色」+ 6 个颜色值）；
 * 右栏（工艺区）里只有**已知标签**会被认走，其余文本归工艺那一条路 —— 否则「吊牌图稿发客人确认」
 * 这种工艺内容会被当成「上一行材料标签的续写」灌进内标里。
 */
function splitSegments(state: ParserState, row: number, layout: Layout): Array<{ segment: Segment; value: string; target: CellRange }> {
  const segments: Array<{ segment: Segment; value: string; target: CellRange }> = [];
  let open: { segment: Segment; texts: string[]; target: CellRange } | null = null;
  const flush = () => {
    if (!open) return;
    const value = collapse(open.texts.join(" "));
    // 布量的值常常**只在值那一格**写 Y/DZ（我们自己导出的工艺单就是「伞面 | 12（Y/DZ)」，
    // 标签本身不带 Y/DZ）。所以除了按标签认，还要按值认：值里带 Y/DZ 且标签对得上布量五格，
    // 就是布量，不是材料（「伞带」两边都有这个名字，靠这一条分开）。
    const fabricFromValue = /[（(]?\s*Y\s*\/?\s*DZ\s*[）)]?/i.test(value);
    if (fabricFromValue && open.segment.kind !== "fabric") {
      const fabric = FABRIC_LABELS.find(([, , aliases]) => aliases.some((alias) => fabricKey(open!.segment.label) === labelKey(alias)));
      if (fabric) {
        segments.push({ segment: { kind: "fabric", key: fabric[0], label: fabric[1], col: open.target.col }, value, target: open.target });
        open = null;
        return;
      }
    }
    segments.push({ segment: open.segment, value, target: open.target });
    open = null;
  };
  for (let col = 0; col < state.grid.width; col += 1) {
    if (state.consumed.has(consumedKey(row, col))) continue;
    const text = textAt(state, row, col);
    if (isBlank(text)) continue;
    const segment = classifyLabel(text);
    if (segment && isLabelStart(state, row, col, open?.segment ?? null, segment)) {
      flush();
      segment.col = col;
      open = { segment, texts: [], target: { row, col } };
      continue;
    }
    if (isFooterText(text)) {
      flush();
      break;
    }
    if (/^注意/.test(labelKey(text))) {
      if (!state.fields.attention_note) {
        const value = text.replace(/^注意[:：]?\s*/, "").slice(0, 2000);
        state.fields.attention_note = value;
        recordFact(state, "attention_note", "注意事项", value, { row, col });
      }
      continue;
    }
    // 小节标题（「布量」「材料到货状态」「相关图片」）：是分栏界标，不是上一段的值。
    // 少了这一条，「布量」会被当成侧唛的内容（第一版就是这么来的）。
    if (/^(布量|材料到货状态|相关图片|包装要求|备注)/.test(labelKey(text))) {
      flush();
      continue;
    }
    // 唛头的内容可以写到右栏去（我们自己导出的那一行是「正唛 | 值 | 侧唛 | 值」，右侧的值落在工艺栏；
    // 左边的材料区判定在这里不适用），其余自由文本仍按左/右栏分工处理。
    if (col < layout.materialEnd || open?.segment.kind === "mark") {
      if (open) {
        open.texts.push(text);
        // 唛头的内容在纸上是一整块（「ORDER NO. / ITEM NO. / QTY…」），读走之后工艺那一遍不能再把它
        // 当成一条工艺要求上报（第一版就这样在核对清单里多出一条「没认出来」）。
        if (open.segment.kind === "mark") state.consumed.add(consumedKey(row, col));
      } else open = { segment: { kind: "unknown", label: text, col }, texts: [], target: { row, col } };
    }
    // 右栏里的自由文本不在这里收（交给工艺那一遍，或作为认不出的格子如实上报）。
  }
  flush();
  // 「未知段」只有标签、没有值 → 丢掉（多半是小节标题：「布量」「材料到货状态」「相关图片」）。
  return segments.filter((item) => item.segment.kind !== "unknown" || item.value !== "");
}

/** 只收左栏的值（续行用）。 */
function collectValues(state: ParserState, row: number, from: number, to: number): string {
  const texts: string[] = [];
  for (let col = from; col < Math.min(to, state.grid.width); col += 1) {
    if (state.consumed.has(consumedKey(row, col))) continue;
    const text = textAt(state, row, col);
    if (!isBlank(text) && !classifyLabel(text) && !isFooterText(text)) texts.push(text);
  }
  return collapse(texts.join(" "));
}

/**
 * 材料标签的值写在**下一行**（样本2 的「包装明细」：标签在 H28、内容在 H29；样本1 的「正唛/侧唛」
 * 也是这种写法）。窗口 = 本标签列 .. 本行下一个标签列（不含）。
 */
function materialValueBelow(state: ParserState, row: number, col: number, layout: Layout): string {
  const nextCol = nextLabelColInRow(state, row, col, layout);
  const value = collectValues(state, row + 1, col, nextCol);
  if (value) for (let cursor = col; cursor < nextCol; cursor += 1) state.consumed.add(consumedKey(row + 1, cursor));
  return value;
}

function markValueBelow(state: ParserState, row: number, col: number, layout: Layout): string {
  const nextCol = nextLabelColInRow(state, row, col, layout);
  for (let cursor = col; cursor < Math.min(nextCol, state.grid.width); cursor += 1) {
    const text = textAt(state, row + 1, cursor);
    if (!isBlank(text)) {
      state.consumed.add(consumedKey(row + 1, cursor));
      return text;
    }
  }
  return "";
}

function nextLabelColInRow(state: ParserState, row: number, col: number, layout: Layout): number {
  for (let cursor = col + 1; cursor < state.grid.width; cursor += 1) {
    if (classifyLabel(textAt(state, row, cursor))) return cursor;
  }
  // 后面没有别的标签 → 一直到这一行的末尾：右栏（工艺区）里的材料行（样本2 的「包装明细」写在 H 列）
  // 内容也在右边/下一行，截到材料区右边界会把内容切掉。
  return state.grid.width;
}

/** `12（Y/DZ)` → `12`（布量单位是纸上的固定说明，不是字段内容）。 */
function stripFabricUnit(value: string): string {
  return collapse(value).replace(/[（(]\s*Y\s*\/\s*DZ\s*[）)]/gi, "").trim();
}

function truncateLabel(text: string): string {
  const clean = collapse(text);
  return clean.length > MATERIAL_EXTRA_LABEL_MAX_LENGTH ? clean.slice(0, MATERIAL_EXTRA_LABEL_MAX_LENGTH) : clean;
}

function appendField(state: ParserState, field: string, value: string, target: CellRange): void {
  const existing = state.fields[field];
  if (!existing) {
    assignField(state, field, materialCategoryLabel(field), value, target, 1000);
    return;
  }
  state.fields[field] = `${existing} ${value}`.trim().slice(0, 1000);
}

/** 追加一行材料明细（`sort_order` = 纸上的先后顺序，与手工加的「再加一款」同一套口径）。 */
function addExtra(state: ParserState, label: string, content: string, specKey: MaterialCategoryKey | null): void {
  if (state.extras.length >= MATERIAL_EXTRA_LIMIT) {
    state.warnings.push(`材料明细超过 ${MATERIAL_EXTRA_LIMIT} 行，多出的行没带过来（请在表单里手工补）`);
    return;
  }
  let text = collapse(content);
  if (!text) return;
  if (text.length > MATERIAL_EXTRA_CONTENT_MAX_LENGTH) {
    text = text.slice(0, MATERIAL_EXTRA_CONTENT_MAX_LENGTH);
    state.warnings.push(`「${label}」的内容超过 ${MATERIAL_EXTRA_CONTENT_MAX_LENGTH} 字，已截到上限`);
  }
  const finalLabel = specKey ? materialCategoryLabel(specKey) : label;
  state.extras.push({ label: finalLabel, content: text, spec_key: specKey, sort_order: state.extras.length });
  recordFact(state, specKey ?? "material_extra", specKey ? `${finalLabel}（再加一款）` : `其它：${label}`, text, { row: 0, col: 0 });
}

/**
 * 工艺要求逐条读：`1.大货样：每个设计各1支` / `吊牌图稿发客人确认` / `质检报告 | 所有材料和成品都要质检报告`。
 *
 * 三条口径：
 *   1. 编号只是前缀，**按词认**（两张样本的编号是断的）；
 *   2. 有冒号 → 左标签右内容；没冒号但开头就是标签 → 标签后面那截是内容；整句里含标签 → 整句都是内容；
 *   3. 认不出的一律上报 —— 工艺要求是最容易被「看起来像」填错的一块：把「吊牌位置」写进「伞带要求」，
 *      在纸上只差一行，车间就会照着错的那行做。
 */
function readProcessLines(state: ParserState, layout: Layout): void {
  for (let row = layout.headerRow + 1; row < state.grid.cells.length; row += 1) {
    if (isRowConsumed(state, row)) continue;
    for (let col = layout.materialEnd; col < state.grid.width; col += 1) {
      if (state.consumed.has(consumedKey(row, col))) continue;
      const text = textAt(state, row, col);
      if (isBlank(text) || classifyLabel(text) || isFooterText(text)) continue;
      const target = { row, col };
      const numbered = /^\s*\d+\s*[.、．)）]\s*/.test(text) ? text.replace(/^\s*\d+\s*[.、．)）]\s*/, "") : text;
      const split = /^([^：:]{1,20})[：:]\s*(.*)$/.exec(numbered);
      const labelPart = split ? split[1] : numbered;
      const matched = matchProcessLabel(labelPart) ?? matchProcessLabel(numbered);
      if (!matched) {
        state.unrecognized.push({ where: addressOf(row, col), text: collapse(text).slice(0, 200) });
        continue;
      }
      let value = split ? split[2] : "";
      if (!value) {
        // 「质检报告 | 内容」这种标签与内容分格的写法：取右边第一段非空内容。
        const right = firstNonEmpty(state, row, col + 1, state.grid.width, (candidate) => !classifyLabel(candidate) && !isFooterText(candidate));
        if (right) {
          value = right.text;
          state.consumed.add(consumedKey(right.target.row, right.target.col));
        }
      }
      if (!value && !split) {
        // 没有冒号、标签在句首：标签后面那截就是内容（`吊牌图稿发客人确认` → `发客人确认`）。
        const key = labelKey(numbered);
        const aliasKey = labelKey(matched.alias);
        value = key.startsWith(aliasKey) ? collapse(numbered).slice(matched.alias.length).trim() : collapse(numbered);
        // 「出货前发给客人质量检测报告」这种整句含标签的：整句就是内容。
        if (!key.startsWith(aliasKey)) value = collapse(numbered);
      }
      if (!value) {
        state.unrecognized.push({ where: addressOf(row, col), text: collapse(text).slice(0, 200) });
        continue;
      }
      const existing = state.fields[matched.key];
      if (!existing) {
        state.fields[matched.key] = value.slice(0, 1000);
        recordFact(state, matched.key, matched.label, value.slice(0, 1000), target);
      } else if (!existing.includes(value)) {
        state.fields[matched.key] = `${existing}；${value}`.slice(0, 1000);
        recordFact(state, matched.key, matched.label, value.slice(0, 1000), target);
      }
    }
  }
}

function matchProcessLabel(text: string): { key: string; label: string; alias: string } | null {
  const key = labelKey(text);
  if (!key) return null;
  for (const [, , aliases] of PROCESS_LABELS) {
    const alias = aliases.find((item) => key === labelKey(item));
    if (alias) {
      const found = PROCESS_LABELS.find(([, , list]) => list.includes(alias))!;
      return { key: found[0], label: found[1], alias };
    }
  }
  for (const [, , aliases] of PROCESS_LABELS) {
    const alias = aliases.find((item) => key.startsWith(labelKey(item)));
    if (alias) {
      const found = PROCESS_LABELS.find(([, , list]) => list.includes(alias))!;
      return { key: found[0], label: found[1], alias };
    }
  }
  for (const [, , aliases] of PROCESS_LABELS) {
    const alias = aliases.find((item) => key.includes(labelKey(item)));
    if (alias) {
      const found = PROCESS_LABELS.find(([, , list]) => list.includes(alias))!;
      return { key: found[0], label: found[1], alias };
    }
  }
  return null;
}

// --------------------------------------------------------------------------- 补漏 / 上报

/** 表头区里认不出标签的短文本（样本1 第 4 行「加大货样各1支」）：如实上报，不硬塞进某个字段。 */
function collectUnrecognizedHeader(state: ParserState, layout: Layout | null): void {
  const lastRow = layout ? layout.headerRow - 1 : Math.min(state.grid.cells.length, 12) - 1;
  for (let row = 1; row <= lastRow; row += 1) {
    for (let col = 0; col < state.grid.width; col += 1) {
      if (state.consumed.has(consumedKey(row, col))) continue;
      const text = textAt(state, row, col);
      if (isBlank(text)) continue;
      if (isHeaderLabelText(text) || isFooterText(text)) continue;
      const key = labelKey(text);
      if (/^注意/.test(key) || /^厦\s*门/.test(collapse(text))) continue;
      const clean = collapse(text);
      if (clean.length > 80) continue;
      state.unrecognized.push({ where: addressOf(row, col), text: clean.slice(0, 200) });
    }
  }
  if (state.unrecognized.length > 40) {
    const overflow = state.unrecognized.length - 40;
    state.unrecognized = state.unrecognized.slice(0, 40);
    state.warnings.push(`另有 ${overflow} 处内容没认出来（见原文件），请按需在表单里手工补`);
  }
}

/**
 * 「一份文件 = 一张单」这件事要**说出来**：多表 / 多个客户单号时不静默只取第一个。
 *
 * 用户 2026-11-02 拍板一份文件当一张单处理，但"只取第一个"如果不说，用户会以为整本都补进去了 ——
 * 这种错只有在对账少了一张单的时候才会被发现，而那时已经过去几周了。
 */
function noteOneOrderPerFile(state: ParserState, layout: Layout | null): void {
  if (state.grid.otherSheets.length) {
    state.warnings.push(`这个文件还有 ${state.grid.otherSheets.length} 张有内容的表（${state.grid.otherSheets.slice(0, 5).join("、")}），只读了第一张「${state.grid.sheetName}」—— 补录一份文件按一张单处理，其余请另存成单张再传`);
  }
  const lastRow = layout ? layout.headerRow - 1 : Math.min(state.grid.cells.length, 12) - 1;
  const aliases = HEADER_FIELDS.find(([key]) => key === "order_no")![2].map((alias) => labelKey(alias));
  const positions: string[] = [];
  for (let row = 0; row <= lastRow; row += 1) {
    for (let col = 0; col < state.grid.width; col += 1) {
      const key = labelKey(textAt(state, row, col));
      if (!key) continue;
      if (aliases.some((alias) => key.startsWith(alias))) positions.push(addressOf(row, col));
    }
  }
  if (positions.length > 1) {
    state.warnings.push(`表头里出现了 ${positions.length} 处「单号」字样（${positions.slice(0, 5).join("、")}），只取了第一处「${state.fields.order_no ?? "（空）"}」—— 如果这其实是多张单，请拆成一份一张再传`);
  }
}

/** 缺什么就说什么：表单会拦住保存，但"为什么空着"要在这里讲清楚。 */
function fillMissingWarnings(state: ParserState): void {  if (!state.fields.order_no) state.warnings.push("没读到「客户单号」，订单号请手工填（系统里不能重号）");
  if (!state.fields.order_date) state.warnings.push("没读到「下单日期」，请手工填");
  if (!state.fields.product_name) state.warnings.push("没读到「品名规格」，请手工填");
  if (!state.fields.quantity) state.warnings.push("没读到「数量」，请手工填");
  if (!state.fields.unit) state.warnings.push("数量那一格没带单位，单位请在表单里选");
  if (!state.details.length) state.warnings.push("没读到「细分明细」（伞布/伞头的花色与数量表），如有请手工补");
  const detailTotal = state.details.reduce((sum, row) => sum + (Number(row.quantity) || 0), 0);
  const quantity = Number(state.fields.quantity ?? "");
  if (state.details.length && Number.isFinite(quantity) && quantity > 0 && Math.abs(detailTotal - quantity) > 0.001) {
    state.warnings.push(`细分明细合计 ${formatNumber(detailTotal)} 与标题数量 ${formatNumber(quantity)} 不一致，请核对`);
  }
}
