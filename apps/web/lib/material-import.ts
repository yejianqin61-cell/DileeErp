// 「物料清单批量导入」的路径与结果口径（纯函数，供页面与测试共用）。
//
// 与后端 `apps/api/src/modules/procurement/material-import.ts` 的
// `MaterialImportResult` 一一对应（两个 workspace 之间没有共享包，只能两份，用同一组向量钉住形状）。
// 页面只负责渲染：把「成功 / 部分成功 / 全失败」的判定与那句汇总文案放在这里，是为了能脱离
// React 直接被 node:test 覆盖 —— 这三种结果的提示口径写错的代价是「导入了一半，界面说全成功」。

/** 下载模板：必须带 /api/v1 前缀，走 lib/download 的 fetch（带鉴权 cookie）。 */
export const MATERIAL_IMPORT_TEMPLATE_PATH = "/api/v1/materials/import-template.xlsx";
/** 后端 Content-Disposition 里给的文件名通常一致；这里作为兜底（并测试它拼对）。 */
export const MATERIAL_IMPORT_TEMPLATE_FILENAME = "迪礼ERP-物料清单导入模板.xlsx";
/** 上传：multipart 只能自己 fetch，不能走 apiPost（那会把 body JSON 化）。 */
export const MATERIAL_IMPORT_PATH = "/api/v1/materials/import";
/** 与后端 Multer 白名单一致：只放行 Excel。 */
export const MATERIAL_IMPORT_ACCEPT = ".xlsx,.xls";

/** 模板列（与后端 MATERIAL_TEMPLATE_HEADERS 一致），用于页面上那句「模板 N 列」说明。 */
export const MATERIAL_IMPORT_COLUMNS = ["物料编码", "物料名称", "规格型号", "颜色", "默认单位", "物料类型", "备注"] as const;

export type MaterialImportCreated = { row: number; material_code: string; name: string; auto_code: boolean };
export type MaterialImportError = { row: number; field?: string; reason: string };

export type MaterialImportResult = {
  status: "ok" | "partial" | "failed";
  total: number;
  imported: number;
  errorCount: number;
  headerRow: number;
  errors: MaterialImportError[];
  missingColumns: string[];
  ignoredColumns: string[];
  ignoredTrailingRows: number;
  hints: string[];
  /** 真正建档的物料（含自动生成的编码）—— 自动编码不显示出来的话，操作员不知道后续该引用哪个码。 */
  created: MaterialImportCreated[];
};

/** 三种结果的展示档位：全成功 / 部分成功 / 一条都没进。 */
export type MaterialImportOutcome = "success" | "partial" | "failed";

/**
 * 结果档位。
 *
 * 注意判据用的是 `imported` 而不是后端的 `status`：后端在「整批失败」时才给 `failed`，
 * 但「全部行都被拒」与「一行都没录进来」对操作员是同一件事，界面不该让它们长得不一样。
 */
export function materialImportOutcome(result: Pick<MaterialImportResult, "imported" | "errorCount">): MaterialImportOutcome {
  if (result.imported <= 0) return "failed";
  return result.errorCount > 0 ? "partial" : "success";
}

/**
 * 一句汇总：「共 12 行：新增 10 条 / 未导入 2 行 / 其中自动生成编码 3 条」。
 *
 * 自动编码的条数必须说出来：那 3 条物料的编码是系统生成的，操作员不看这一句就不知道
 * 后续开采购单/建 BOM 时该引用哪个编码。
 */
export function materialImportSummary(result: Pick<MaterialImportResult, "total" | "imported" | "errorCount" | "created">): string {
  const parts = [`共 ${result.total} 行：新增 ${result.imported} 条`];
  if (result.errorCount > 0) parts.push(`未导入 ${result.errorCount} 行`);
  const autoCoded = (result.created ?? []).filter((item) => item.auto_code).length;
  if (autoCoded > 0) parts.push(`其中自动生成编码 ${autoCoded} 条`);
  return parts.join(" / ");
}

/** 导出/报错表里「哪一格」的展示：没有 field 时给一个占位，不要渲染成 undefined。 */
export const materialImportErrorField = (error: Pick<MaterialImportError, "field">): string => error.field ?? "-";
