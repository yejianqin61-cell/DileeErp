import { Injectable, UnprocessableEntityException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../platform/database/prisma.service";
import { MAX_PAGE_SIZE } from "../../platform/http/pagination-query.dto";
import { AuditActorService } from "../../platform/audit/audit-actor.service";

/**
 * 报表导出单次行数上限。
 *
 * 与列表上限分开：列表是「屏幕上一次显示多少」（1000），导出是「一次拉多少写 CSV」。
 * 两者共用 200 是 2026-11-27 之前的缺陷 —— 导出被列表上限夹住，永远只出 200 行，
 * 而「超过就报错」那条护栏因为夹取在前、比较在后，永远不会触发。
 */
const EXPORT_ROW_LIMIT = 5000;

type Query = { order_no?: string; from?: string; to?: string; status?: string; employee_id?: string; supplier_id?: string; page?: number; page_size?: number };
type Row = Record<string, unknown>;

@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService, private readonly actors: AuditActorService) {}

  /**
   * 报表行是「手工挑字段 + 改写成 snake_case」的，所以操作人姓名必须在这里就地换好。
   *
   * 为什么不能像其它模块那样依赖响应出口的 AuditActorInterceptor：
   * 报表页是**按响应键动态生成列**的（`reports/page.tsx` 用 `Object.keys(rows[0])`），
   * 一旦把 `createdBy` 原样带出去，它就会自己长出一列显示 UUID 的表头
   * （正是全站治理要消灭的「制单：6f3a1c8e-…」）。所以这里只输出姓名，不输出 id。
   */
  private async resolveNames(rows: { createdBy?: string | null; updatedBy?: string | null }[]) {
    return this.actors.namesOf(rows.flatMap((row) => [row.createdBy, row.updatedBy]));
  }

  async orders(query: Query, cap?: number) { const where = this.orderWhere(query); const [rows, total] = await Promise.all([this.prisma.salesOrder.findMany({ where, orderBy: { updatedAt: "desc" }, skip: this.skip(query, cap), take: this.take(query, cap), select: { orderNo: true, productName: true, quantity: true, unit: true, status: true, deliveryDate: true, createdAt: true, updatedAt: true, createdBy: true, updatedBy: true } }), this.prisma.salesOrder.count({ where })]); const names = await this.resolveNames(rows); return { data: rows.map((row) => ({ order_no: row.orderNo, product_name: row.productName, quantity: row.quantity.toString(), unit: row.unit, status: row.status, delivery_date: row.deliveryDate, created_at: row.createdAt, updated_at: row.updatedAt, created_by_name: row.createdBy ? names.get(row.createdBy) ?? null : null, updated_by_name: row.updatedBy ? names.get(row.updatedBy) ?? null : null })), total }; }

  async procurement(query: Query, cap?: number) { const rows = await this.prisma.purchaseOrder.findMany({ where: { deletedAt: null, ...(query.order_no ? { orderNo: query.order_no } : {}), ...(query.supplier_id ? { supplierId: query.supplier_id } : {}), ...(query.status ? { status: query.status } : {}) }, orderBy: { updatedAt: "desc" }, skip: this.skip(query, cap), take: this.take(query, cap), select: { purchaseOrderNo: true, orderNo: true, supplierSnapshot: true, status: true, totalAmount: true, currency: true, createdAt: true, updatedAt: true, createdBy: true, updatedBy: true } }); const names = await this.resolveNames(rows); return { data: rows.map((row) => ({ purchase_order_no: row.purchaseOrderNo, order_no: row.orderNo, supplier: row.supplierSnapshot, status: row.status, amount: row.totalAmount.toString(), currency: row.currency, created_at: row.createdAt, updated_at: row.updatedAt, created_by_name: row.createdBy ? names.get(row.createdBy) ?? null : null, updated_by_name: row.updatedBy ? names.get(row.updatedBy) ?? null : null })), total: rows.length }; }

  // 库存报表读的是 InventoryFact —— 追加型账本，没有 updated_by/updated_at（只有创建人），
  // 所以只给「创建人」，最后修改人一列为空（不是漏了）。
  async inventory(query: Query, cap?: number) { const rows = await this.prisma.inventoryFact.findMany({ where: { ...(query.order_no ? { orderNo: query.order_no } : {}), ...(query.from || query.to ? { createdAt: { ...(query.from ? { gte: new Date(query.from) } : {}), ...(query.to ? { lte: new Date(query.to) } : {}) } } : {}) }, orderBy: { createdAt: "desc" }, skip: this.skip(query, cap), take: this.take(query, cap), select: { id: true, orderNo: true, inventoryCategory: true, quantityDelta: true, sourceType: true, sourceId: true, createdAt: true, createdBy: true } }); const names = await this.resolveNames(rows); return { data: rows.map((row) => ({ id: row.id, order_no: row.orderNo, inventory_category: row.inventoryCategory, quantity_delta: row.quantityDelta.toString(), source_type: row.sourceType, source_id: row.sourceId, created_at: row.createdAt, created_by_name: row.createdBy ? names.get(row.createdBy) ?? null : null, updated_by_name: null })), total: rows.length }; }

  async productionQc(query: Query, cap?: number) { const rows = await this.prisma.finishedGoodsQcRecord.findMany({ where: { deletedAt: null, ...(query.order_no ? { orderNo: query.order_no } : {}), ...(query.status ? { status: query.status } : {}) }, orderBy: { updatedAt: "desc" }, skip: this.skip(query, cap), take: this.take(query, cap), select: { qcNo: true, orderNo: true, conclusion: true, status: true, inspectedQuantity: true, qualifiedQuantity: true, rejectedQuantity: true, inspectionDate: true, createdAt: true, updatedAt: true, createdBy: true, updatedBy: true } }); const names = await this.resolveNames(rows); return { data: rows.map((row) => ({ qc_no: row.qcNo, order_no: row.orderNo, conclusion: row.conclusion, status: row.status, inspected_quantity: row.inspectedQuantity.toString(), qualified_quantity: row.qualifiedQuantity.toString(), rejected_quantity: row.rejectedQuantity.toString(), inspection_date: row.inspectionDate, created_at: row.createdAt, updated_at: row.updatedAt, created_by_name: row.createdBy ? names.get(row.createdBy) ?? null : null, updated_by_name: row.updatedBy ? names.get(row.updatedBy) ?? null : null })), total: rows.length }; }

  async payroll(query: Query, cap?: number) { const rows = await this.prisma.payrollLedger.findMany({ where: { deletedAt: null, ...(query.employee_id ? { employeeId: query.employee_id } : {}), ...(query.status ? { status: query.status } : {}) }, orderBy: { periodStart: "desc" }, skip: this.skip(query, cap), take: this.take(query, cap), select: { ledgerNo: true, employeeId: true, periodStart: true, periodEnd: true, status: true, baseSalary: true, productionSourceAmount: true, createdAt: true, updatedAt: true, createdBy: true, updatedBy: true } }); const names = await this.resolveNames(rows); return { data: rows.map((row) => ({ ledger_no: row.ledgerNo, employee_id: row.employeeId, period_start: row.periodStart, period_end: row.periodEnd, status: row.status, base_salary: row.baseSalary.toString(), production_source_amount: row.productionSourceAmount.toString(), created_at: row.createdAt, updated_at: row.updatedAt, created_by_name: row.createdBy ? names.get(row.createdBy) ?? null : null, updated_by_name: row.updatedBy ? names.get(row.updatedBy) ?? null : null })), total: rows.length }; }

  async export(report: string, query: Query) { const result = await this.query(report, { ...query, page: 1, page_size: EXPORT_ROW_LIMIT }, EXPORT_ROW_LIMIT); if (result.data.length >= EXPORT_ROW_LIMIT) throw new UnprocessableEntityException({ code: "EXPORT_LIMIT_EXCEEDED", message: "导出结果过多，请缩小筛选范围", details: [] }); return csv(result.data); }
  async query(report: string, query: Query, cap?: number): Promise<{ data: Row[]; total: number }> { switch (report) { case "orders": return this.orders(query, cap) as Promise<{ data: Row[]; total: number }>; case "procurement-payables": return this.procurement(query, cap) as Promise<{ data: Row[]; total: number }>; case "inventory": return this.inventory(query, cap) as Promise<{ data: Row[]; total: number }>; case "production-qc": return this.productionQc(query, cap) as Promise<{ data: Row[]; total: number }>; case "payroll": return this.payroll(query, cap) as Promise<{ data: Row[]; total: number }>; default: throw new UnprocessableEntityException({ code: "REPORT_NOT_FOUND", message: "报表不存在", details: [] }); } }
  private orderWhere(query: Query): Prisma.SalesOrderWhereInput { return { deletedAt: null, ...(query.order_no ? { orderNo: query.order_no } : {}), ...(query.status ? { status: query.status } : {}), ...(query.from || query.to ? { updatedAt: { ...(query.from ? { gte: new Date(query.from) } : {}), ...(query.to ? { lte: new Date(query.to) } : {}) } } : {}) }; }
  private skip(query: Query, cap?: number) { return ((query.page ?? 1) - 1) * this.take(query, cap); }
  /**
   * 取多少行。
   *
   * `cap` 默认是列表上限（1000）；**导出**必须显式放宽，否则「导出」会被列表上限夹住。
   * 2026-11-27 之前这里硬编码 200：`export()` 传 `page_size: 5000` 也会被夹到 200，
   * 于是报表导出永远只出 200 行，而 `>= 5000 就报错` 那条护栏永远不会触发 —— 用户看到的是
   * 「导出少了」，不是「导出被限制了」。
   */
  private take(query: Query, cap: number = MAX_PAGE_SIZE) { return Math.min(Math.max(query.page_size ?? 20, 1), cap); }
}

function csv(rows: Row[]) { if (!rows.length) return "\uFEFF"; const keys = [...new Set(rows.flatMap((row) => Object.keys(row)))]; const value = (item: unknown) => { const text = item === null || item === undefined ? "" : typeof item === "object" ? JSON.stringify(item) : String(item); return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text; }; return `\uFEFF${[keys, ...rows.map((row) => keys.map((key) => value(row[key])))] .map((line) => line.join(",")).join("\r\n")}\r\n`; }
