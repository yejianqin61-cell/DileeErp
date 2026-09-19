import type { ReportCell, ReportColumn, ReportTable } from "./finance-report.types";
import { NUMBER_FORMAT } from "./finance-report.domain";
import { beijingDateTime } from "../../platform/time/beijing-time";

/**
 * 「确认应收 / 确认应付」两处台账的导出工作簿（用户要求：「两处表单要支持导出 excel，
 * 支持按照已付未付、已收未收，还有按照时间范围筛选」）。
 *
 * 与 `finance-report.tables.ts` 的关系：那边是**老表版式**（列名列序照抄老系统导出件），
 * 这两张是**系统自己的台账视图**导出（列取列表页看到的字段），所以单独一个模块，不去挤老表清单。
 * 但渲染走同一套 `renderReportWorkbook` —— 关键约束一样：**金额与数量必须是 Excel 数值类型**，
 * 否则财务在 Excel 里 `SUM` 得 0、筛选与排序都会错（见 finance-report-workbook.ts 顶部说明）。
 *
 * 两个口径写在表尾说明里（不写进单元格，免得污染可求和区域）：
 *   - 「付款情况」按状态口径：草稿 = 未付；已确认 = 已付（确认即记账，钱已经从所选银行账户出去）；
 *     部分付款 / 已付清来自收付款核销。
 *   - 含多种币种时**不做合计**：跨币种相加是一个没有意义的数（与全站既定口径一致）。
 */

const numeric = (header: string, width: number): ReportColumn => ({ header, width, numFmt: NUMBER_FORMAT });

const day = (value: Date | string | null | undefined): string => {
  if (!value) return "";
  return (typeof value === "string" ? value : value.toISOString()).slice(0, 10);
};

const amountOrNull = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * 台账导出末尾的四个审计列（2026-09-16「操作人与操作时间」全站治理）。
 *
 * 导出用**四个独立列**而不是像界面那样把姓名与时间挤在一格：Excel 里挤在一格就没法按时间排序、
 * 也没法筛选，而这正是财务拿到文件后最常做的事。姓名由调用方在导出前用
 * `AuditActorService.attachAll` 换好（服务层返回的是 Prisma 整行，只有 createdBy 的 UUID）——
 * 导出**绝不允许把 UUID 写进单元格**。
 */
const AUDIT_LEDGER_COLUMNS: ReportColumn[] = [
  { header: "创建人", width: 12 },
  { header: "创建时间", width: 18 },
  { header: "最后修改人", width: 12 },
  { header: "最后修改时间", width: 18 },
];

const auditLedgerCells = (row: { created_by_name?: string | null; updated_by_name?: string | null; createdAt?: Date | string | null; updatedAt?: Date | string | null }): ReportCell[] => [
  row.created_by_name ?? "",
  beijingDateTime(row.createdAt),
  row.updated_by_name ?? "",
  beijingDateTime(row.updatedAt),
];

/** 应付台账导出的取数形状（`SupplierPayableService.list()` 的返回值子集）。 */
export type PayableLedgerExportRow = {
  payableNo: string;
  confirmationDate: Date | string | null;
  supplier_name?: string | null;
  supplierId: string;
  sourceType: string;
  source_no?: string | null;
  sourceNoSnapshot: string;
  orderNo: string | null;
  purchase_order_no?: string | null;
  material_name?: string | null;
  material_code?: string | null;
  material_specification?: string | null;
  quantity: { toString(): string } | string;
  unit_name?: string | null;
  unitPrice: { toString(): string } | string;
  amount: { toString(): string } | string;
  currency: string;
  status: string;
  remark?: string | null;
  /** 审计（2026-09-16 全站治理）：姓名由调用方在导出前解析好，见 AUDIT_LEDGER_COLUMNS。 */
  created_by_name?: string | null;
  updated_by_name?: string | null;
  createdAt?: Date | string | null;
  updatedAt?: Date | string | null;
};

/** 应收台账导出的取数形状（`ReceivableService.list()` 的返回值子集）。 */
export type ReceivableLedgerExportRow = {
  sourceNo: string;
  createdAt: Date | string | null;
  customer_name?: string | null;
  customerId: string;
  orderNo: string;
  outbound_no?: string | null;
  product_name?: string | null;
  product_specification?: string | null;
  quantity: { toString(): string } | string;
  unit: string;
  unitPrice: { toString(): string } | string | null;
  amount: { toString(): string } | string;
  currency: string;
  dueDate: Date | string | null;
  status: string;
  remark?: string | null;
  /** 审计（2026-09-16 全站治理）：姓名由调用方在导出前解析好，见 AUDIT_LEDGER_COLUMNS。
   *  `createdAt` 上面已经有了（它同时是「出库日期」列与创建时间列的取值）。 */
  created_by_name?: string | null;
  updated_by_name?: string | null;
  updatedAt?: Date | string | null;
};

const SOURCE_LABELS: Record<string, string> = { raw_material_inbound: "原料入库", purchase_receipt: "采购到货", outsource_receipt: "外加工签收", other: "其他应付" };

/** 应付台账的「付款情况」（与筛选口径同源：见 ledger-filter.ts 的 paymentBucket）。 */
export function payablePaymentText(status: string): string {
  if (status === "draft") return "未付";
  if (status === "confirmed") return "已付";
  if (status === "partially_paid") return "部分付款";
  if (status === "paid") return "已付清";
  if (status === "reversed") return "已冲销";
  if (status === "voided") return "已作废";
  return status;
}

export function payableStatusText(status: string): string {
  const labels: Record<string, string> = { draft: "应付草稿", confirmed: "应付已确认", partially_paid: "部分付款", paid: "已付清", reversed: "已冲销", voided: "已作废" };
  return labels[status] ?? status;
}

export function receivablePaymentText(status: string): string {
  if (status === "draft") return "未收";
  if (status === "confirmed") return "已收";
  if (status === "partially_paid") return "部分收款";
  if (status === "paid") return "已收清";
  if (status === "cancelled") return "已取消";
  if (status === "closed") return "已关闭";
  return status;
}

export function receivableStatusText(status: string): string {
  const labels: Record<string, string> = { draft: "草稿", confirmed: "已确认", partially_paid: "部分收款", paid: "已收清", cancelled: "已取消", closed: "已关闭" };
  return labels[status] ?? status;
}

export const PAYABLE_LEDGER_COLUMNS: ReportColumn[] = [
  { header: "确认日期", width: 12 },
  { header: "应付单号", width: 22 },
  { header: "供应商", width: 26 },
  { header: "来源", width: 12 },
  { header: "来源批次", width: 20 },
  { header: "订单号", width: 18 },
  { header: "采购单号", width: 18 },
  { header: "物料", width: 24 },
  { header: "规格型号", width: 20 },
  numeric("数量", 12),
  { header: "单位", width: 8 },
  numeric("单价", 12),
  numeric("应付金额", 14),
  { header: "币种", width: 10 },
  { header: "付款情况", width: 12 },
  { header: "状态", width: 14 },
  { header: "备注", width: 30 },
  ...AUDIT_LEDGER_COLUMNS,
];

export function buildPayableLedgerTable(rows: PayableLedgerExportRow[]): ReportTable {
  return {
    sheetName: "应付台账",
    columns: PAYABLE_LEDGER_COLUMNS,
    rows: rows.map((row): ReportCell[] => [
      day(row.confirmationDate),
      row.payableNo,
      row.supplier_name ?? row.supplierId,
      SOURCE_LABELS[row.sourceType] ?? row.sourceType,
      row.source_no ?? row.sourceNoSnapshot,
      row.orderNo ?? "",
      row.purchase_order_no ?? "",
      row.material_name ?? row.material_code ?? "",
      row.material_specification ?? "",
      amountOrNull(row.quantity.toString()),
      row.unit_name ?? "",
      amountOrNull(row.unitPrice.toString()),
      amountOrNull(row.amount.toString()),
      row.currency,
      payablePaymentText(row.status),
      payableStatusText(row.status),
      row.remark ?? "",
      ...auditLedgerCells(row),
    ]),
    footnotes: ledgerFootnotes(rows.map((row) => row.currency), "付款情况按状态口径：草稿 = 未付；已确认 = 已付（确认应付即记账，金额已从所选银行账户支出）；部分付款 / 已付清来自收付款核销。"),
  };
}

export const RECEIVABLE_LEDGER_COLUMNS: ReportColumn[] = [
  { header: "出库日期", width: 12 },
  { header: "应收来源", width: 22 },
  { header: "客户", width: 26 },
  { header: "订单号", width: 20 },
  { header: "出库单", width: 18 },
  { header: "产品", width: 22 },
  { header: "规格型号", width: 20 },
  numeric("数量", 12),
  { header: "单位", width: 8 },
  numeric("单价", 12),
  numeric("应收金额", 14),
  { header: "币种", width: 10 },
  { header: "到期日", width: 12 },
  { header: "收款情况", width: 12 },
  { header: "状态", width: 14 },
  { header: "备注", width: 30 },
  ...AUDIT_LEDGER_COLUMNS,
];

export function buildReceivableLedgerTable(rows: ReceivableLedgerExportRow[]): ReportTable {
  return {
    sheetName: "应收台账",
    columns: RECEIVABLE_LEDGER_COLUMNS,
    rows: rows.map((row): ReportCell[] => [
      // 应收来源没有「确认日期」列（确认与生成同一天），所以时间筛选与导出都用创建日期＝出库过账日期。
      day(row.createdAt),
      row.sourceNo,
      row.customer_name ?? row.customerId,
      row.orderNo,
      row.outbound_no ?? "",
      row.product_name ?? "",
      row.product_specification ?? "",
      amountOrNull(row.quantity.toString()),
      row.unit,
      row.unitPrice === null ? null : amountOrNull(row.unitPrice.toString()),
      amountOrNull(row.amount.toString()),
      row.currency,
      day(row.dueDate),
      receivablePaymentText(row.status),
      receivableStatusText(row.status),
      row.remark ?? "",
      ...auditLedgerCells(row),
    ]),
    footnotes: ledgerFootnotes(rows.map((row) => row.currency), "收款情况按状态口径：草稿 = 未收；已确认 = 已收（确认应收即记账，金额已记入所选银行账户）；部分收款 / 已收清来自收付款核销。"),
  };
}

/** 表尾说明：多币种时不做合计（与全站「不跨币种相加」一致）。 */
function ledgerFootnotes(currencies: string[], statusNote: string): string[] {
  const unique = [...new Set(currencies.filter(Boolean))];
  return unique.length > 1
    ? [statusNote, `本表含 ${unique.join(" / ")} 共 ${unique.length} 种币种，金额列不做合计（跨币种相加没有意义）。`]
    : [statusNote];
}
