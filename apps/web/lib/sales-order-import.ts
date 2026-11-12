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

/** 人读的体积：`1.5MB` / `820KB`（用来把「多大」写进错误里，用户才知道要不要换个文件）。 */
export function readableSize(bytes: number | undefined): string {
  if (!bytes || bytes < 0) return "";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/**
 * 上传失败时页面该说哪句话（2026-11-12）。
 *
 * 为什么单独成函数：原来这里只有一句兜底的「读取失败」，而它把**五种完全不同的原因**
 * 说成了同一句话 —— 用户唯一的线索就是「失败」，运维唯一的线索也是「失败」。
 * 真实案例：一份 1.5MB 的销售单 .xls 被 nginx 的 `client_max_body_size` 默认值（1m）
 * 在**转发之前**回了一个 413 的 HTML 错误页，请求根本没到 API；页面 `response.json()` 解析失败，
 * 就退化成「读取失败：请确认文件没有损坏、且是 .xlsx / .xls」—— 文件既没坏、格式也对，
 * 于是这条提示把排查方向指错了方向，病灶在网关。
 *
 * 判据顺序：先看**网关状态码**（它最具体、且一定没有业务信封），再看服务端那句业务话，
 * 最后才是兜底（兜底里必须带上状态码，下次至少能从界面上看出是 403 还是 500）。
 */
export function importFailureMessage(input: { status: number; serverMessage?: string; fileSize?: number }): string {
  const { status, serverMessage } = input;
  const size = readableSize(input.fileSize);
  const withSize = size ? `（这份文件 ${size}）` : "";
  // 413 只会来自网关/反代：应用侧的体积上限走的是 Multer，回的是 422 业务错误。
  if (status === 413) {
    return `文件太大，被服务器网关挡在门外${withSize}：当前网关允许的上传体积比这份文件小（应用本身支持 ${Math.round(SALES_ORDER_IMPORT_MAX_BYTES / 1024 / 1024)}MB）。请先压缩或拆成两份再传；如果确认这份文件应该能传，请管理员检查边缘 nginx 的 client_max_body_size`;
  }
  if (status === 401) return "登录已失效，请重新登录后再传这份文件";
  if (status === 403) return serverMessage ? `没有补录权限：${serverMessage}` : "没有补录权限（当前账号看不到销售模块的上传入口），请联系管理员分配权限";
  if (status === 502 || status === 503 || status === 504) return `服务器暂时不可用（HTTP ${status}），请稍后重试；连续出现请把这句话发给管理员`;
  if (serverMessage) return serverMessage;
  // 没有业务信封：多半是网关/框架回的 HTML（404 页面、502 页面、代理错误页）。
  return `读取失败（HTTP ${status}）：服务器没有返回可识别的错误内容${withSize}。请把这句里的状态码发给管理员，它能直接指向是网关还是应用`;
}
