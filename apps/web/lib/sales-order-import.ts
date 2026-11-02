/**
 * 销售单「Excel 补录」（2026-11-02）的路径、返回形状与几句纯函数。
 *
 * 用户原话：「针对销售模块，现在要加一个补录功能。用户上传销售单 excel，系统进行字段读取与匹配，
 * 展示一份系统表单，让用户进行修改与确认。用户通过之后，再确认建立销售单。」
 *
 * 与后端 `apps/api/src/modules/sales/sales-order-import.service.ts` 的 `SalesOrderImportPreview`
 * 一一对应（两个 workspace 没有共享包，只能两份，用同一组测试向量钉住形状）。
 *
 * 为什么这里只有"摆事实"的函数（拆错误/一句话汇总/结论档位）：补录页只负责渲染与上传，
 * 而这些判定写错一次的代价是「界面说没问题、点保存 400」—— 那种错最难查，
 * 所以放到纯函数里由 `node:test` 覆盖（React 组件不参与 node:test）。
 */

/** 上传端点（必须带 `/api/v1` 前缀）：multipart 只能自己 fetch，不能走 `apiPost`（那会把 body JSON 化）。 */
export const SALES_ORDER_IMPORT_PATH = "/api/v1/sales-orders/import-preview";
/** 与后端 Multer 白名单一致：只放行 Excel。 */
export const SALES_ORDER_IMPORT_ACCEPT = ".xlsx,.xls";
/** 单文件上限（与控制器 `limits.fileSize` 同一个数）：超了后端直接 413/422，界面上先说清楚。 */
export const SALES_ORDER_IMPORT_MAX_BYTES = 10 * 1024 * 1024;

/** 「这一格认成了什么」：核对清单的一行（`from` 是单元格地址，如 `C2`）。 */
export type SalesOrderImportFact = { field: string; label: string; value: string; from: string };
/** 认不出的格子：原文照抄，让人自己去表单里补。 */
export type SalesOrderImportUnknown = { where: string; text: string };
/** 待修正项（error 不修就建不了单；warning 只是提醒）。 */
export type SalesOrderImportIssue = { level: "error" | "warning"; field?: string; message: string };

export type SalesOrderImportCustomer = { id: string; name: string; customer_code: string; currency: string | null; matched_by: string };

export type SalesOrderImportResult = {
  file_name: string;
  sheet_name: string;
  status: "ok" | "partial";
  customer_id: string | null;
  customer: SalesOrderImportCustomer | null;
  customer_raw: string;
  /** 直接灌进销售单编辑器的预填载荷（与返单预览 / 复制快照的 `copy` 同一个形状）。 */
  copy: Record<string, unknown>;
  must_fill: string[];
  issues: SalesOrderImportIssue[];
  warnings: string[];
  recognized: SalesOrderImportFact[];
  unrecognized: SalesOrderImportUnknown[];
  summary: { recognized: number; detail_rows: number; extra_rows: number; fills: number; missing: string[] };
};

/** 把待修正项按「必须改 / 只是提醒」分开（错误先显示：用户要知道能不能点「确认建立销售单」）。 */
export function importIssueSplit(issues: SalesOrderImportIssue[]): { errors: SalesOrderImportIssue[]; warnings: SalesOrderImportIssue[] } {
  return { errors: issues.filter((issue) => issue.level === "error"), warnings: issues.filter((issue) => issue.level === "warning") };
}

/**
 * 一句话汇总：「读出 35 处 · 细分明细 12 行 · 材料追加 2 行 · 待修正 1 项」。
 *
 * 「待修正 0 项」也要说出来（而不是省掉）—— 用户看到 0 才敢直接点确认。
 */
export function importSummaryText(result: Pick<SalesOrderImportResult, "summary" | "issues" | "unrecognized">): string {
  const { errors } = importIssueSplit(result.issues);
  const parts = [`读出 ${result.summary.recognized} 处字段`];
  if (result.summary.detail_rows) parts.push(`细分明细 ${result.summary.detail_rows} 行`);
  if (result.summary.extra_rows) parts.push(`材料追加 ${result.summary.extra_rows} 行`);
  if (result.unrecognized.length) parts.push(`${result.unrecognized.length} 处没认出`);
  parts.push(errors.length ? `待修正 ${errors.length} 项` : "待修正 0 项");
  return parts.join(" · ");
}

/**
 * 结论档位：`blocked` = 还有 error（建单会被后端拒，界面上先说清楚是哪几格），
 * `ready` = 只剩提醒。两者都会渲染成横幅，但**只有 ready 时才把「确认建立销售单」写成主按钮**。
 */
export function importOutcome(result: Pick<SalesOrderImportResult, "issues">): "ready" | "blocked" {
  return importIssueSplit(result.issues).errors.length ? "blocked" : "ready";
}

/** 文件先在前端挡一道（后端还要再挡）：扩展名 + 体积。返回空串 = 通过。 */
export function importFileProblem(file: { name?: string; size?: number } | null | undefined): string {
  if (!file) return "请选择要补录的 Excel 文件";
  const name = (file.name ?? "").toLowerCase();
  if (!name.endsWith(".xlsx") && !name.endsWith(".xls")) return "只支持 .xlsx / .xls 文件，请用 Excel 另存为这两种格式";
  if ((file.size ?? 0) > SALES_ORDER_IMPORT_MAX_BYTES) return `文件超过 ${Math.round(SALES_ORDER_IMPORT_MAX_BYTES / 1024 / 1024)}MB，请精简后再传`;
  return "";
}
