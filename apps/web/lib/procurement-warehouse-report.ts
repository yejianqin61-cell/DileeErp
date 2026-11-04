/**
 * 采购与仓储报表（`/reports/procurement-warehouse`）的前端口径（纯函数，无 React / 无网络依赖）。
 *
 * 设计：`docs/design/procurement-warehouse-report-2026-11-04.md`。这一份只放「能写错的那些字」：
 *   1. 九列的**列名 / 顺序 / 宽度 / 数字列** —— 屏幕、打印纸、导出 xlsx 必须是同一组，
 *      分成三处各写一遍，迟早出现「纸上有、屏幕上少一列」；
 *   2. 数量的显示规则：接口给的是**去掉无意义尾零的十进制字符串**（`4700` 而不是 `4700.0000`），
 *      但历史数据/手工造的数据仍可能出现 `-0.00`、`4700.0000`，显示前统一收口；
 *   3. 三条业务口径说明与五个数量列的来源说明 —— 文案是给用户判断这张表能回答什么、不能回答什么，
 *      不能写表名/字段名（那是实现细节），只能写业务口径；
 *   4. 筛选查询串与两条接口路径 —— 导出与屏幕取数用**同一组筛选参数、同一次返回**，不各拼一遍。
 *
 * 为什么放在 `lib/` 而不是组件里：`lib` 下的 `*.test.mjs` 用 `node --test` 直接跑 `.ts`（无需 jsdom），
 * 列宽合计 100%、去尾零、文案三条规则这些纯规则在这里能被钉死，组件测试只负责渲染行为。
 */

/** 筛选条件（两个都是模糊匹配，空串＝不筛）。 */
export type ProcurementWarehouseFilters = { order_no: string; material: string };

/** 契约 §3.1 的一行（字段名与后端 `reports` 模块的 JSON 一一对应）。 */
export type ProcurementWarehouseRow = {
  order_no: string;
  material_name: string;
  color: string;
  unit: string;
  purchase_quantity: string;
  inbound_quantity: string;
  pending_inbound_quantity: string;
  production_issue_quantity: string;
  stock_quantity: string;
};

/** 契约 §3.1 的 meta（字段缺失时页面按宽松口径兜底）。 */
export type ProcurementWarehouseMeta = {
  generated_at?: string;
  row_count?: number;
  row_limit?: number;
  filters?: { order_no?: string | null; material?: string | null };
};

/** 报表标题、公司名、导出兜底文件名（与后端 `Content-Disposition` 里的名字统一口径）。 */
export const REPORT_TITLE = "采购与仓储报表";
export const REPORT_COMPANY = "厦门迪礼伞业有限公司";
export const REPORT_EXPORT_FILE_NAME = "迪礼ERP-采购与仓储报表.xlsx";

/**
 * 单次行数上限（设计 §2）。前端只用来在面板上写清楚「超过请缩小范围」，
 * 真正的闸门在后端（422 `REPORT_ROW_LIMIT_EXCEEDED`），前端不做截断 ——
 * 屏幕、打印、导出必须是同一份数据，前端偷偷截断就会出现「屏幕 5000 行、导出 5000 但内容不同」。
 */
export const REPORT_ROW_LIMIT = 5000;

/** 屏幕取数路径（不带 `/api/v1`：走 `apiGet`，它会补前缀）。 */
export const REPORT_DATA_PATH = "/reports/procurement-warehouse";
/** Excel 导出路径（带 `/api/v1`：走 `downloadFile` 的原生 fetch）。 */
export const REPORT_EXPORT_PATH = "/api/v1/reports/procurement-warehouse/export.xlsx";

/**
 * 九列定义：屏幕 `DataTable`、打印纸、导出件共用同一份。
 *
 * 九个百分比必须合计 **100%**：`DataTable` 一律 `table-layout: fixed`（data-table.tsx:117），
 * 固定布局下没写宽度的列由浏览器均分剩余空间 —— 少写一个就会让那列变成"别人写多少它剩多少"，
 * 表宽与截图里那张 Excel 就再也对不上。守卫见 `procurement-warehouse-report.test.mjs`。
 *
 * `numeric`：数量列右对齐 + `tabular-nums`（打印纸同样按这个类走）。
 * `negativeIsAlert`：只有「采购未入库数」（超收为负）与「库存量」（负库存）允许为负且必须标红；
 * 采购数量 / 入库量 / 领用量为负是数据错误，不该用同一种红色掩盖过去。
 */
export type ProcurementWarehouseColumn = {
  key: keyof ProcurementWarehouseRow;
  label: string;
  width: string;
  numeric: boolean;
  negativeIsAlert?: boolean;
};

export const REPORT_COLUMNS: ProcurementWarehouseColumn[] = [
  { key: "order_no", label: "订单号", width: "9%", numeric: false },
  { key: "material_name", label: "物料名称", width: "26%", numeric: false },
  { key: "color", label: "颜色", width: "8%", numeric: false },
  { key: "unit", label: "单位", width: "6%", numeric: false },
  { key: "purchase_quantity", label: "采购数量", width: "9%", numeric: true },
  { key: "inbound_quantity", label: "采购入库量", width: "10%", numeric: true },
  { key: "pending_inbound_quantity", label: "采购未入库数", width: "11%", numeric: true, negativeIsAlert: true },
  { key: "production_issue_quantity", label: "生产领用数量", width: "11%", numeric: true },
  { key: "stock_quantity", label: "库存量", width: "10%", numeric: true, negativeIsAlert: true },
];

/**
 * 把筛选条件拼成查询串；两个条件都为空时返回空串（不拼一个只有 `?` 的尾巴）。
 *
 * 刻意走 `URLSearchParams` 而不是手拼：物料名里带 `&`、空格、中文都是可能的，
 * 手拼会让筛选条件被截断，而用户看到的是「这个物料没数据」。
 */
export function reportQueryString(filters: ProcurementWarehouseFilters): string {
  const params = new URLSearchParams();
  const orderNo = (filters.order_no ?? "").trim();
  const material = (filters.material ?? "").trim();
  if (orderNo) params.set("order_no", orderNo);
  if (material) params.set("material", material);
  return params.toString() ? `?${params.toString()}` : "";
}

/** 屏幕取数 URL（交给 `apiGet`，它会补 `/api/v1`）。 */
export function reportDataUrl(filters: ProcurementWarehouseFilters): string {
  return `${REPORT_DATA_PATH}${reportQueryString(filters)}`;
}

/** 导出 URL（交给 `downloadFile`，需要完整 `/api/v1` 前缀）。 */
export function reportExportUrl(filters: ProcurementWarehouseFilters): string {
  return `${REPORT_EXPORT_PATH}${reportQueryString(filters)}`;
}

/**
 * 数量显示：**去掉无意义尾零**，`-0` 归一成 `0`，空值显示 `-`。
 *
 * 接口契约已经保证是去尾零字符串（§3.1），这里再收一遍是防御历史数据与手工测试数据：
 * `-0.00` 在负数判断里是「不小于 0」的，如果原样显示会写出「-0」，用户会以为欠了 0 个。
 * 不做千分位分隔：这张表要与导出的 xlsx 逐格对照，屏幕上多一个逗号就对不上。
 */
export function formatReportQuantity(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "-";
  const text = String(value).trim();
  if (!text) return "-";
  // 非数字形态（例如接口出错时塞进来的整句中文）原样显示：宁可难看，也不要把原因吞掉。
  if (!/^-?\d+(?:\.\d+)?$/.test(text)) return text;
  const negative = text.startsWith("-");
  const [integerPart, fractionPart = ""] = text.replace(/^-/, "").split(".");
  const trimmedInteger = integerPart.replace(/^0+(?=\d)/, "");
  const trimmedFraction = fractionPart.replace(/0+$/, "");
  const digits = trimmedFraction ? `${trimmedInteger}.${trimmedFraction}` : trimmedInteger;
  // `-0` / `-0.000` 归一成 `0`：负零没有业务含义，显示出来只会让人以为数据坏了。
  return negative && digits !== "0" ? `-${digits}` : digits;
}

/** 是否要标红：按数值判断而不是看首字符，`-0` / `-0.000` 不算负。 */
export function isNegativeReportQuantity(value: string | number | null | undefined): boolean {
  if (value === null || value === undefined) return false;
  const text = String(value).trim();
  if (!text) return false;
  const parsed = Number(text);
  return Number.isFinite(parsed) && parsed < 0;
}

/** 颜色：契约保证空串而不是 null，空串在屏幕上显示 `-`（纸面上留空更利于手写补）。 */
export function displayReportColor(color: string | null | undefined): string {
  const text = String(color ?? "").trim();
  return text || "-";
}

/** 订单号 / 物料名称 / 单位这类文本列：空值显示 `-`，避免一格空白让人以为被裁掉了。 */
export function displayReportText(value: string | null | undefined): string {
  const text = String(value ?? "").trim();
  return text || "-";
}

/**
 * 三条业务口径规则（设计 §1 的「必须写进页面、打印件、导出件」）。
 *
 * 写法照设计原文：只写业务口径，不写表名/字段名 —— 用户关心的是「这数能不能用」，
 * 不是它从哪张表聚合的。这三条同样会出现在 xlsx 末尾（后端那份），两边文案必须一致。
 */
export const REPORT_SCOPE_RULES: string[] = [
  "不跨单位相加：同一物料若历史上出现过两个单位，会分成两行；把「米」和「卷」加在一起得到的库存数不可比，不能用于任何判断。",
  "库存量不按订单拆账：同一物料出现在多张订单时，每行的库存量是同一个数（当前结存），不是「这张订单还剩多少料」。",
  "本表不设合计行：行是不同单位组成的，跨单位合计没有意义；合计只在单位内部才有意义，而本表不按单位分组展示。",
];

/** 口径说明的开头：一行是什么（不是 BOM 需求，也不是生产单）。 */
export const REPORT_SCOPE_INTRO =
  "一行 = 一张订单上的一个物料（物料 = 名称 + 规格型号 + 颜色，单位不换算）；五个数量都是同一订单、同一物料、同一单位上的账。";

/**
 * 五个数量列各自的来源一句话（设计 §4「口径说明面板」）。
 *
 * 顺序与表格列顺序一致：用户对着表头往下找，说明也在同一个位置。
 */
export const REPORT_COLUMN_NOTES: Array<{ label: string; note: string }> = [
  { label: "采购数量", note: "该订单已下单采购明细的订购数量合计；草稿与已取消的采购单不计。" },
  { label: "采购入库量", note: "该订单已过账的原料入库数量合计；草稿与已冲销的入库单不计。" },
  { label: "采购未入库数", note: "采购数量 − 采购入库量。允许为负：多送的按实收入库，负数就是超收量。" },
  { label: "生产领用数量", note: "该订单生产已过账的领料 + 补料 − 退料净额；冲销与撤销过账已抵消，报废不计入领用。" },
  { label: "库存量", note: "该物料 + 单位的当前结存（原料仓 + 报废仓），是物料级静态结存，不按订单拆账。" },
];

/** 打印纸/导出件第 2 行的筛选条件摘要（空条件写「全部」）。 */
export function reportFilterSummary(filters: ProcurementWarehouseFilters): string {
  const orderNo = (filters.order_no ?? "").trim();
  const material = (filters.material ?? "").trim();
  return `订单号：${orderNo || "全部"}；物料：${material || "全部"}`;
}

/**
 * 打印纸副标题：筛选条件 + 行数 + 打印时间（北京时间）。
 *
 * `printedAt` 由调用方用 `formatBeijing(new Date(), { seconds: true })` 生成后传进来 ——
 * 纯函数不碰时钟，测试才能钉住文案；纸上的时间必须是**按打印那一刻**，
 * 不是接口的 `generated_at`（用户可能打开页面半小时后才按打印）。
 */
export function reportPrintSubtitle(input: { filters: ProcurementWarehouseFilters; rowCount: number; printedAt: string }): string {
  const printedAt = (input.printedAt ?? "").trim() || "-";
  return `筛选条件：${reportFilterSummary(input.filters)}　行数：${input.rowCount} 行　打印时间：${printedAt}（北京时间）`;
}
