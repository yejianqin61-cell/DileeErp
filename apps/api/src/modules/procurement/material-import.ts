/**
 * 「物料清单批量导入」的口径（纯函数 + 模板生成，无 Nest/Prisma 依赖）。
 *
 * 用户 2026-09-20：「针对采购模块，物料清单，我们新增一个批量导入物料。我们提供模板，
 * 用户填写并上传。模板的 column 口径你来定」。
 *
 * 与「库存盘点导入」（`modules/warehouse/stocktake-import.ts`）、「其他应付批量导入」
 * （`modules/finance/other-payable-import.ts`）、员工花名册导入
 * （`modules/production/employee-roster.ts`）刻意保持同一套规矩 —— 操作员面对的是同一件事
 * （下载模板 → 填写 → 上传 → 看逐行错误）：
 *   - **按表头名匹配，不按列序号**：挪动列顺序、增删无关列都不会错位；无关列如实上报；
 *   - **行级错误不连坐**：只有「找不到表头 / 缺必需列 / 没有数据行」才是整批失败，
 *     其余情况通过校验的行照常建档、出错的行逐条列出（status = partial）。
 *
 * 本文件只做**形状与逐行校验**；「单位在不在」「物料编码/组合有没有被占用」要查库，
 * 属于 ProcurementMasterDataService 的职责。这样解析器可以脱离数据库被完整测试。
 */

import * as XLSX from "xlsx";
import { textCell } from "../production/employee-roster";

/**
 * 单次导入的行数上限。
 *
 * 物料主数据是「一次录完、长期不动」的量级（一个厂几百到几千条），1000 已远超手工整理的规模，
 * 也挡住误传整本台账。与盘点导入的 2000 不同：那里是每月一次的全量盘点，量更大。
 */
export const MATERIAL_IMPORT_MAX_ROWS = 1000;

export type MaterialImportField =
  | "material_code"
  | "name"
  | "specification_model"
  | "color"
  | "unit"
  | "material_type"
  | "remark";

/**
 * 模板列（表头名即口径）。顺序**不与解析绑定**：解析按表头名认列，列顺序随便调。
 *
 * 为什么是这 7 列：物料表（`prisma/schema.prisma` 的 `Material`）加上「新建物料」弹窗
 * （`components/bom/material-create-dialog.tsx`）的可填字段就是这几个，多一列就多一个
 * 界面填不了、只能改库的字段。逐列的必填口径见 `MATERIAL_FIELD_LABELS` 的注释与模板说明页。
 */
export const MATERIAL_TEMPLATE_HEADERS = [
  "物料编码",
  "物料名称",
  "规格型号",
  "颜色",
  "默认单位",
  "物料类型",
  "备注",
] as const;

/** 每个字段认的同义表头（操作员手写、旧模板、导出回灌都能对上）。 */
export const MATERIAL_HEADER_ALIASES: Record<MaterialImportField, readonly string[]> = {
  // 留空 = 自动生成，所以这一列不是必需的。同义词收全是因为「产品代码」在别的模块是同一个字段
  // （盘点导入就是这么叫的），操作员手上两种写法都有。
  material_code: ["物料编码", "物料代码", "产品代码", "产品编码", "物料编号", "物料号", "编码", "代码"],
  name: ["物料名称", "产品名称", "物料品名", "品名", "名称", "货物名称"],
  specification_model: ["规格型号", "产品规格", "物料规格", "规格", "型号"],
  color: ["颜色", "色号", "配色", "颜色/配色"],
  unit: ["默认单位", "单位", "计量单位", "基本单位", "单位名称"],
  material_type: ["物料类型", "物料类别", "类型", "类别"],
  remark: ["备注", "说明", "备注说明"],
};

export const MATERIAL_FIELD_LABELS: Record<MaterialImportField, string> = {
  material_code: "物料编码",
  name: "物料名称",
  specification_model: "规格型号",
  color: "颜色",
  unit: "默认单位",
  material_type: "物料类型",
  remark: "备注",
};

/** 硬性必需的列：少了就建不出物料（默认单位是必填外键，物料编码可以自动生成）。 */
const REQUIRED_FIELDS: readonly MaterialImportField[] = ["name", "unit"];

/**
 * 物料类型的归一表。**留空 = 原料**（与 `Material.materialType` 的库默认值一致）；
 * 写错的值不猜、直接报错 —— 猜错的后果是「以为导的是成品，结果进了原料池」这种没人会去查的错。
 */
const MATERIAL_TYPE_ALIASES: Record<string, string> = {
  "原料": "raw_material",
  "原材料": "raw_material",
  "材料": "raw_material",
  "raw_material": "raw_material",
  "raw": "raw_material",
  "成品": "finished_product",
  "产成品": "finished_product",
  "成品物料": "finished_product",
  "finished_product": "finished_product",
  "finished": "finished_product",
};

export const MATERIAL_TYPE_LABELS: Record<string, string> = { raw_material: "原料", finished_product: "成品" };

/**
 * 模板里的示例行。
 *
 * 第一行的物料编码故意写成占位符（照「示例-」开头一眼能看出该替换）；第二行**编码留空**，
 * 用来示范「留空 = 自动生成 MAT-日期-序号」—— 这是本模板最容易被忽略、也最容易填错的一格。
 */
export const MATERIAL_TEMPLATE_SAMPLE_ROWS: ReadonlyArray<ReadonlyArray<string>> = [
  ["示例-请替换或留空", "示例-涤纶布（请替换成物料名称）", "150D", "米白", "米", "原料", "示例行：上传前请删除或改成你的数据"],
  ["", "示例-松紧带（编码留空 = 自动生成）", "5mm", "黑色", "米", "原料", "编码这一格留空，系统按 MAT-日期-序号 自动生成"],
];

export type MaterialImportRow = {
  /** Excel 行号（1 起，报错时给操作员看的那个号）。 */
  row: number;
  /** 空串 = 让服务层自动生成编码。 */
  materialCode: string;
  name: string;
  specificationModel: string;
  color: string;
  /** 单位**名称**（解析器不认识单位池，由服务层按名字匹配）。 */
  unitName: string;
  /** 已归一：raw_material / finished_product。 */
  materialType: string;
  /** 归一前的写法（报错与原样回显用）。 */
  materialTypeText: string;
  remark: string;
};

export type MaterialImportError = { row: number; field?: string; reason: string };

export type MaterialParseResult = {
  status: "ok" | "partial" | "failed";
  headerRow: number;
  dataStartRow: number;
  /** 数据行数（不含表头，含报错行）。 */
  total: number;
  /** 通过逐行校验、可以建档的行。 */
  rows: MaterialImportRow[];
  errors: MaterialImportError[];
  missingColumns: string[];
  /** 表头里有、但不属于物料口径的列（如实上报，不静默丢）。 */
  ignoredColumns: string[];
  /** 文档形态（表头不在第一行）时，数据块之后被跳过的行数。 */
  ignoredTrailingRows: number;
  documentLayout: boolean;
  hints: string[];
};

const normalizeHeader = (value: unknown) => textCell([value], 0).replace(/\s+/g, "").toLowerCase();

/**
 * 物料编码的匹配键：忽略大小写与空格。
 *
 * 与盘点导入的 `stocktakeCodeKey` 同一口径（同一个物料在两张表里必须认得出来）。
 * 注意这比数据库的 `material_code` 唯一索引**更严**（索引区分大小写）：这是有意的 ——
 * 放 `MAT-001` 与 `mat-001` 同时进来等于给自己造两个「同一个物料」。
 */
export const materialCodeKey = (value: string) => value.replace(/\s+/g, "").toLowerCase();

/** 单位名称的匹配键：同样忽略大小写与空格（「米」与「 米 」是同一个单位）。 */
export const materialUnitKey = (value: string) => value.replace(/\s+/g, "").toLowerCase();

/**
 * 「名称 + 规格型号 + 颜色」组合键 —— 物料表的第二个唯一口径（`@@unique([name, specificationModel, color])`）。
 *
 * 这里**刻意不做大小写归一**：库层索引区分大小写，跟着库走才能保证「文件里判为重复」与
 * 「库里插不进去」是同一件事。只按库层一样去空格（服务层的 `materialKey` 就是把空值落成空串）。
 */
export const materialComboKey = (name: string, specificationModel: string, color: string) =>
  [name, specificationModel, color].map((value) => value.trim()).join("|");

/** 表头 → 字段下标。同名表头取第一次出现的位置。 */
function resolveHeaderIndexes(labels: readonly unknown[]): Map<MaterialImportField, number> {
  const found = new Map<MaterialImportField, number>();
  labels.forEach((label, index) => {
    const text = normalizeHeader(label);
    if (!text) return;
    for (const field of Object.keys(MATERIAL_HEADER_ALIASES) as MaterialImportField[]) {
      if (found.has(field)) continue;
      if (MATERIAL_HEADER_ALIASES[field].some((alias) => normalizeHeader(alias) === text)) found.set(field, index);
    }
  });
  return found;
}

const isBlankRow = (row: readonly unknown[]) => row.every((cell) => textCell([cell], 0) === "");

/**
 * 解析「物料清单批量导入」表。
 *
 * `rows` 是 `sheet_to_json(sheet, { header: 1, raw: true, defval: "" })` 的结果（二维数组）。
 * 表头找不到时只回一条整体错误、一行都不解析 —— 否则会把「误传了别的表」当成一堆行级错误。
 */
export function parseMaterialRows(rows: readonly unknown[][]): MaterialParseResult {
  const base: MaterialParseResult = {
    status: "failed", headerRow: -1, dataStartRow: -1, total: 0, rows: [], errors: [],
    missingColumns: [], ignoredColumns: [], ignoredTrailingRows: 0, documentLayout: false, hints: [],
  };

  // 表头可能不在第一行（有人习惯先写个标题行）：在前 10 行里找最像表头的那一行。
  let headerRow = -1;
  let indexes = new Map<MaterialImportField, number>();
  for (let index = 0; index < Math.min(rows.length, 10); index += 1) {
    const candidate = resolveHeaderIndexes((rows[index] ?? []) as readonly unknown[]);
    // 「像物料表」的判据：物料名称 + 默认单位，两者同时命中才算表头（少了单位建不出物料）。
    if (candidate.has("name") && candidate.has("unit")) { headerRow = index; indexes = candidate; break; }
    if (candidate.size > indexes.size) indexes = candidate; // 记下最全的一行，好在失败时报缺了哪列
  }

  if (headerRow < 0) {
    const missing = REQUIRED_FIELDS.filter((field) => !indexes.has(field)).map((field) => MATERIAL_FIELD_LABELS[field]);
    return {
      ...base,
      missingColumns: missing,
      errors: [{
        row: 0,
        reason: missing.length
          ? `缺少必需列：${missing.join("、")}（请使用「下载模板」得到的表头）`
          : "找不到表头行：请使用「下载模板」，第一行必须是表头（物料编码 / 物料名称 / 规格型号 / 颜色 / 默认单位 / 物料类型 / 备注）",
      }],
    };
  }

  const headerLabels = (rows[headerRow] ?? []).map((label) => textCell([label], 0));
  const mapped = new Set(indexes.values());
  const ignoredColumns = headerLabels.filter((label, index) => label && !mapped.has(index));
  // 表头不在第一行 = 文档形态：数据块到第一个空行为止，避免把末尾的说明批注当成数据行。
  const documentLayout = headerRow > 0;

  const errors: MaterialImportError[] = [];
  const parsedRows: MaterialImportRow[] = [];
  /** 物料编码（归一后）→ 首次出现的 Excel 行号；同一个文件里重复出现只能说明是失误。 */
  const seenCode = new Map<string, number>();
  /** 名称+规格型号+颜色 组合 → 首次出现的 Excel 行号。 */
  const seenCombo = new Map<string, number>();
  let total = 0;
  let ignoredTrailingRows = 0;

  for (let index = headerRow + 1; index < rows.length; index += 1) {
    const row = rows[index] ?? [];
    if (isBlankRow(row)) {
      // 文档形态：数据块结束；系统模板形态：中间的空行照旧跳过。
      if (documentLayout && total > 0) { ignoredTrailingRows = rows.length - index; break; }
      continue;
    }
    const excelRow = index + 1;
    total += 1;
    const materialCode = textCell(row, indexes.get("material_code"));
    const name = textCell(row, indexes.get("name"));
    const specificationModel = textCell(row, indexes.get("specification_model"));
    const color = textCell(row, indexes.get("color"));
    const unitName = textCell(row, indexes.get("unit"));
    const materialTypeText = textCell(row, indexes.get("material_type"));
    const remark = textCell(row, indexes.get("remark"));

    const rowErrors: MaterialImportError[] = [];
    if (!name) rowErrors.push({ row: excelRow, field: MATERIAL_FIELD_LABELS.name, reason: "请填写物料名称" });
    if (!unitName) rowErrors.push({ row: excelRow, field: MATERIAL_FIELD_LABELS.unit, reason: "请填写默认单位（单位名称，必须是系统里已有的单位）" });

    // 物料类型：留空 = 原料；写错不猜，直接报错并列出可填的值。
    let materialType = "raw_material";
    if (materialTypeText) {
      const resolved = MATERIAL_TYPE_ALIASES[materialTypeText.replace(/\s+/g, "").toLowerCase()];
      if (resolved) materialType = resolved;
      else rowErrors.push({ row: excelRow, field: MATERIAL_FIELD_LABELS.material_type, reason: `物料类型「${materialTypeText}」无法识别：请填「原料」或「成品」（留空默认原料）` });
    }

    // 长度按库列宽来（超出会被 PG 截断或报错，不如在这里说清楚）。
    if (materialCode.length > 80) rowErrors.push({ row: excelRow, field: MATERIAL_FIELD_LABELS.material_code, reason: "物料编码过长（最多 80 字）" });
    if (name.length > 200) rowErrors.push({ row: excelRow, field: MATERIAL_FIELD_LABELS.name, reason: "物料名称过长（最多 200 字）" });
    if (specificationModel.length > 200) rowErrors.push({ row: excelRow, field: MATERIAL_FIELD_LABELS.specification_model, reason: "规格型号过长（最多 200 字）" });
    if (color.length > 100) rowErrors.push({ row: excelRow, field: MATERIAL_FIELD_LABELS.color, reason: "颜色过长（最多 100 字）" });
    if (unitName.length > 30) rowErrors.push({ row: excelRow, field: MATERIAL_FIELD_LABELS.unit, reason: "单位名称过长（最多 30 字）" });
    if (remark.length > 1000) rowErrors.push({ row: excelRow, field: MATERIAL_FIELD_LABELS.remark, reason: "备注过长（最多 1000 字）" });

    // 文件内重复：编码重复 = 两条记录抢同一个唯一键；组合重复 = 同一款物料写了两遍。
    if (materialCode) {
      const key = materialCodeKey(materialCode);
      const duplicateOf = seenCode.get(key);
      if (duplicateOf !== undefined) rowErrors.push({ row: excelRow, field: MATERIAL_FIELD_LABELS.material_code, reason: `物料编码 ${materialCode} 在本文件里已出现在第 ${duplicateOf} 行：请删掉其中一行` });
      else seenCode.set(key, excelRow);
    }
    if (name) {
      const combo = materialComboKey(name, specificationModel, color);
      const duplicateOf = seenCombo.get(combo);
      if (duplicateOf !== undefined) rowErrors.push({ row: excelRow, field: MATERIAL_FIELD_LABELS.name, reason: `「${name} + ${specificationModel || "（无规格型号）"} + ${color || "（无颜色）"}」在本文件里已出现在第 ${duplicateOf} 行：同名同规格同颜色只能有一条` });
      else seenCombo.set(combo, excelRow);
    }

    if (rowErrors.length) { errors.push(...rowErrors); continue; }
    parsedRows.push({ row: excelRow, materialCode, name, specificationModel, color, unitName, materialType, materialTypeText, remark });
  }

  if (!total) {
    return {
      ...base, headerRow, dataStartRow: headerRow + 2, documentLayout, ignoredColumns, missingColumns: [],
      errors: [{ row: headerRow + 2, reason: "表头下面没有数据行：请按模板填写至少一行" }],
    };
  }

  const hints: string[] = [];
  const autoCodeRows = parsedRows.filter((row) => !row.materialCode).length;
  if (autoCodeRows) hints.push(`有 ${autoCodeRows} 行没有填物料编码：已按「MAT-当天日期-序号」自动生成，生成结果见下方新增清单`);
  if (!indexes.has("material_code")) hints.push("没有识别到「物料编码」列：本批物料都会自动生成编码（也可以自己加一列填编码）");
  if (!indexes.has("remark")) hints.push("没有识别到「备注」列：备注不是必填，可以自己加一列");
  if (parsedRows.some((row) => row.materialType === "finished_product")) {
    hints.push("本批含「成品」：成品的库存按生产单记账，【采购 → 物料清单】这一页只列原料，成品要去对应模块查");
  }

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
export function materialTemplateWorkbook(): Buffer {
  const sheet = XLSX.utils.aoa_to_sheet([
    [...MATERIAL_TEMPLATE_HEADERS],
    ...MATERIAL_TEMPLATE_SAMPLE_ROWS.map((row) => [...row]),
  ]);
  sheet["!cols"] = MATERIAL_TEMPLATE_HEADERS.map((header) => ({ wch: Math.max(14, header.length * 2 + 8) }));
  const notes = XLSX.utils.aoa_to_sheet([
    ["填写说明"],
    ["1. 「物料清单导入」表里那两行是示例，上传前请删掉或改成你的数据。"],
    ["2. 表头名就是口径，列顺序可以调整、多余的列会被忽略。必填：物料名称、默认单位。"],
    ["3. 物料编码：留空 = 系统按「MAT-当天日期-序号」自动生成（推荐，与弹窗里的「自动生成」同一套规则）；"],
    ["   自己填就必须唯一，且不能与**已删除**物料的编码重复（数据库的唯一索引不看删除标记）。匹配时忽略大小写与空格。"],
    ["4. 物料名称 + 规格型号 + 颜色 三者组合必须唯一：同名不同规格/颜色可以并存，完全相同则视为同一款物料，会逐行报错。"],
    ["5. 默认单位必填，填**单位名称**（如 米 / 打 / 个），必须是系统里已有的单位；留空或写错都会报错，不会自动新建单位。"],
    ["   需要新单位时：到【采购 → 物料清单 → 新建物料】，在「默认单位」旁点「新增类目」先把单位建出来，再重新上传本表。"],
    ["6. 物料类型：填「原料」或「成品」，留空默认「原料」。写别的字会报错（不猜，免得成品悄悄进了原料池）。"],
    ["7. 备注选填，最多 1000 字。"],
    ["8. 行级错误不连坐：出错的行会逐条告诉你第几行、哪一格、为什么，其余行照常导入。"],
    ["9. 本导入只**新增**物料，不修改已有物料：编码或组合撞上库里已有的记录会报错，请改用「编辑」逐条改。"],
    [`10. 单次最多 ${MATERIAL_IMPORT_MAX_ROWS} 行。`],
  ]);
  notes["!cols"] = [{ wch: 130 }];
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, "物料清单导入");
  XLSX.utils.book_append_sheet(book, notes, "填写说明");
  return XLSX.write(book, { type: "buffer", bookType: "xlsx" });
}
