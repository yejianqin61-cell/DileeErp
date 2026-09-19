/**
 * 财务对账导出报表的版式类型。
 *
 * 需求来源：`example/财务/` 下 6 份老系统（WPS 表格 / 管家）导出的报表。
 * 口径与逐列映射见 `docs/design/finance-example-forms-export-mapping-design-2026-09-14.md`（R1–R7）。
 *
 * 为什么把版式做成**数据**：老表要求「列名与列序照抄」（R1）。把列定义写成常量数组后，
 * 版式不会在渲染代码里被悄悄改掉；而且「数字列必须落数值类型」这条约束可以在渲染层统一保证，
 * 并在单测里全表扫描钉住。
 *
 * 单独的模块（不含 ExcelJS）：`finance-report.tables.ts` 是纯函数，只依赖这里的类型，
 * 这样单元测试构造报表不需要加载 Excel 库。
 */

/** 一列的定义。**给了 `numFmt` 就是数值列**，必须写 Excel 数值类型。 */
export type ReportColumn = {
  /** 表头文字：照抄老表 */
  header: string;
  width: number;
  /** 数值列的显示格式（如 `0.0000##`）。不填 = 文本列 */
  numFmt?: string;
  /** 对齐方式；不填时数值列右对齐、文本列左对齐 */
  align?: "left" | "center" | "right";
};

/**
 * 一个单元格的值。
 *
 * - `number` → Excel 数值类型；
 * - `string` → 文本（日期列也走这里，写成 `YYYY-MM-DD` 文本）；
 * - `null` → **空单元格**。缺字段就是「系统没有这个数据」，不能写 0（0 是「确实为零」的事实），
 *   也不能写 `""`（那是一格文本）。
 */
export type ReportCell = string | number | null;

export type ReportTable = {
  /** 工作表名（规范中文，不照抄老系统的拼写错误 sheet 名） */
  sheetName: string;
  columns: ReportColumn[];
  rows: ReportCell[][];
  /** 需要合计的列下标（0 基）。只在有数据行时追加合计行，且只对数值列求和。 */
  totalColumns?: number[];
  /** 表尾说明行（用于「缺采购价物料」这类必须显式列出、不能静默按 0 算完的提示） */
  footnotes?: string[];
};

/** 报表取数筛选条件。`from`/`to` 可选：不给就不按期间过滤。 */
export type FinanceReportFilter = {
  from?: string;
  to?: string;
  customerId?: string;
  supplierId?: string;
  orderNo?: string;
  currency?: string;
  /** 是否包含草稿。默认 false —— 草稿还没确认，算进对账金额会让欠款虚高。 */
  includeDraft?: boolean;
  /** 收支报表专用：按会计科目（项目 = 科目名称）过滤 */
  subjectId?: string;
  /** 收支报表专用：按分类（科目类别）过滤 —— 用户要求「很多报表都要根据这个来统计」 */
  category?: string;
  /** 收支报表专用：income / expense */
  direction?: string;
};
