import { Injectable, UnprocessableEntityException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import * as XLSX from "xlsx";
import { AuditService } from "../../platform/audit/audit.service";
import type { CurrentUser } from "../../platform/auth/auth.service";
import { PrismaService } from "../../platform/database/prisma.service";

type Filters = { operation_id?: string; month?: string; order_no?: string };
const LIMIT = 10000;

type ReportRow = Prisma.EmployeeDailyReportGetPayload<{ include: { employee: { include: { department: true } }; productionOrderOperation: true } }>;

@Injectable()
export class ProductionPayrollExportService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  /** 工序盘点表：按月份（生产日期）统计该工序在当月所有订单下的明细，并附各订单汇总。 */
  async exportOperation(filters: { operation_id: string; month: string }, user: CurrentUser) {
    if (!filters.operation_id || !/^\d{4}-\d{2}$/.test(filters.month)) throw this.invalid("工序和月份不能为空，月份格式为YYYY-MM");
    const { from, to } = this.monthRange(filters.month);
    const rows = await this.fetchRows({ operation_id: filters.operation_id, from, to });
    const operation = await this.prisma.operationCatalog.findFirst({ where: { id: filters.operation_id }, select: { operationName: true } });
    const detailHeader = ["订单号", "生产单号", "工序", "工序日期", "工号", "员工姓名", "部门", "员工类型", "计薪方式", "件数", "时长（小时）", "单价", "合计", "备注"];
    const summaryHeader = ["当月各订单该工序汇总（按生产日期划分）", "订单号", "生产单号", "件数合计", "时长（小时）合计", "合计"];
    const summary = this.summarizeByOrder(rows);
    const summaryRows = summary.map((row) => [null, row.orderNo, row.productionOrderNo, row.quantity.toString(), this.hours(row.duration), row.amount.toString()]);
    const sheetRows: Array<Array<string | number | null>> = [
      ["工序盘点表"],
      ["统计月份", filters.month],
      ["工序", operation?.operationName ?? filters.operation_id],
      ["数据范围", "当月（按工序生产日期划分）所有订单的该工序有效员工日报明细；计时展示时长（小时），合计 = 时长（小时）× 单价"],
      ["生成时间", new Date().toISOString()],
      ["操作人", user.username],
      [],
      detailHeader,
      ...rows.map((row) => this.detailRow(row)),
      [],
      summaryHeader,
      ...summaryRows,
    ];
    return this.buildSheet(sheetRows, "工序盘点表", { report_type: "工序盘点表", filters, row_count: rows.length }, user);
  }

  /** 当月工序明细总表：当月（按生产日期）所有订单、所有工序的员工日报明细，附各工序汇总。 */
  async exportMonthlyOperations(filters: { month: string }, user: CurrentUser) {
    if (!/^\d{4}-\d{2}$/.test(filters.month)) throw this.invalid("月份格式为YYYY-MM");
    const { from, to } = this.monthRange(filters.month);
    const rows = await this.fetchRows({ from, to });
    const detailHeader = ["订单号", "生产单号", "工序", "工序日期", "工号", "员工姓名", "部门", "员工类型", "计薪方式", "件数", "时长（小时）", "单价", "合计", "备注"];
    const summaryHeader = ["当月各工序汇总（按生产日期划分）", "工序", "件数合计", "时长（小时）合计", "合计"];
    const summary = this.summarizeByOperation(rows);
    const summaryRows = summary.map((row) => [null, row.operationName, row.quantity.toString(), this.hours(row.duration), row.amount.toString()]);
    const sheetRows: Array<Array<string | number | null>> = [
      ["当月工序明细总表"],
      ["统计月份", filters.month],
      ["数据范围", "当月（按工序生产日期划分）所有订单、所有工序的有效员工日报明细；计时展示时长（小时）"],
      ["生成时间", new Date().toISOString()],
      ["操作人", user.username],
      [],
      detailHeader,
      ...rows.map((row) => this.detailRow(row)),
      [],
      summaryHeader,
      ...summaryRows,
    ];
    return this.buildSheet(sheetRows, "当月工序明细总表", { report_type: "当月工序明细总表", filters, row_count: rows.length }, user);
  }

  /** 订单号盘点表：单订单明细（时长小时、合计），表头附每道工序的生产日期数组、计划数量与汇总数量；可选按生产日期月份过滤。 */
  async exportOrder(filters: { order_no: string; operation_id?: string; month?: string }, user: CurrentUser) {
    if (!filters.order_no?.trim()) throw this.invalid("订单号不能为空");
    const monthValid = /^\d{4}-\d{2}$/.test(filters.month ?? "");
    const range = monthValid ? this.monthRange(filters.month!) : undefined;
    const rows = await this.fetchRows({ order_no: filters.order_no.trim(), operation_id: filters.operation_id, ...(range ?? {}) });
    const operation = filters.operation_id ? await this.prisma.operationCatalog.findFirst({ where: { id: filters.operation_id }, select: { operationName: true } }) : null;
    const detailHeader = ["订单号", "生产单号", "工序", "工序日期", "工号", "员工姓名", "部门", "员工类型", "计薪方式", "件数", "时长（小时）", "单价", "合计", "备注"];
    const operationHeader = rows.length ? this.operationHeaderRows(rows) : [];
    const sheetRows: Array<Array<string | number | null>> = [
      ["订单号盘点表"],
      ["订单号", filters.order_no],
      ...(monthValid ? [["统计月份（按生产日期过滤）", filters.month!]] : []),
      ["工序", operation?.operationName ?? "全部工序"],
      ["数据范围", "该订单号下全部有效工序员工日报；计时展示时长（小时），总薪酬列更名为合计"],
      ["生成时间", new Date().toISOString()],
      ["操作人", user.username],
      [],
      ...operationHeader,
      [],
      detailHeader,
      ...rows.map((row) => this.detailRow(row)),
    ];
    return this.buildSheet(sheetRows, "订单号盘点表", { report_type: "订单号盘点表", filters, row_count: rows.length }, user);
  }

  /** 材料与车间生产对应表：上表为原料对应（该订单号的采购单明细），下表为工序 × 生产日期的生产进度二维矩阵。 */
  async exportMaterialProduction(filters: { order_no: string }, user: CurrentUser) {
    if (!filters.order_no?.trim()) throw this.invalid("订单号不能为空");
    const orderNo = filters.order_no.trim();
    const [sales, purchaseOrders, productionOrders] = await Promise.all([
      this.prisma.salesOrder.findFirst({ where: { orderNo, deletedAt: null }, select: { quantity: true, productName: true } }),
      this.prisma.purchaseOrder.findMany({ where: { orderNo, deletedAt: null }, orderBy: { purchaseDate: "asc" }, include: { items: { where: { deletedAt: null }, include: { material: true, receipts: { where: { deletedAt: null }, orderBy: { receivedDate: "asc" } } } }, supplier: true } }),
      this.prisma.productionOrder.findMany({ where: { orderNo, deletedAt: null, NOT: { status: "cancelled" } }, include: { executionLocation: true, operations: { where: { deletedAt: null, NOT: { status: "cancelled" } }, orderBy: { sequenceNo: "asc" } } } }),
    ]);
    const orderQuantity = sales?.quantity?.toString() ?? "";
    const materialRows: Array<Array<string | number | null>> = purchaseOrders.flatMap((po) => po.items.map((item) => {
      const arrival = (item.receipts ?? []).map((receipt) => receipt.receivedDate.toISOString().slice(0, 10)).join("、");
      const supply = item.expectedDate ? item.expectedDate.toISOString().slice(0, 10) : po.expectedDate ? po.expectedDate.toISOString().slice(0, 10) : "";
      const supplierName = (item.supplierSnapshot as { name?: string } | null)?.name ?? po.supplier?.name ?? "";
      return [orderNo, orderQuantity, item.material?.name ?? "", item.unitPrice?.toString() ?? "", item.quantity.toString(), po.purchaseDate ? po.purchaseDate.toISOString().slice(0, 10) : "", arrival, supply, supplierName, po.remark ?? ""];
    }));
    if (!materialRows.length) materialRows.push([orderNo, orderQuantity, "（无采购记录）", "", "", "", "", "", "", ""]);
    const productionIds = productionOrders.map((po) => po.id);
    const daily = productionIds.length ? await this.prisma.employeeDailyReport.groupBy({ by: ["productionOrderOperationId", "reportDate"], where: { productionOrderId: { in: productionIds }, deletedAt: null }, _sum: { quantity: true } }) : [];
    const dates = [...new Set(daily.map((row) => row.reportDate.toISOString().slice(0, 10)))].sort();
    const quantityByOperationDate = new Map<string, Prisma.Decimal>();
    for (const row of daily) {
      const key = `${row.productionOrderOperationId}|${row.reportDate.toISOString().slice(0, 10)}`;
      quantityByOperationDate.set(key, (quantityByOperationDate.get(key) ?? new Prisma.Decimal(0)).plus(row._sum.quantity ?? 0));
    }
    const shipped = await this.prisma.finishedGoodsOutbound.aggregate({ where: { orderNo, deletedAt: null, status: { in: ["posted", "shipped", "signed"] } }, _sum: { quantity: true } });
    const shippedQuantity = shipped._sum.quantity?.toString() ?? "";
    const progressHeader: Array<string | number | null> = ["工序", "数量", "加工地点"];
    for (const date of dates) progressHeader.push(date, "数量");
    progressHeader.push("汇总", "出货");
    const progressRows = productionOrders.flatMap((po) => po.operations.map((operation) => {
      const cells: Array<string | number | null> = [operation.operationNameSnapshot, operation.targetQuantity?.toString() ?? "", po.executionLocation?.name ?? ""];
      let total = new Prisma.Decimal(0);
      for (const date of dates) {
        const quantity = quantityByOperationDate.get(`${operation.id}|${date}`);
        cells.push(date, quantity ? quantity.toString() : "");
        if (quantity) total = total.plus(quantity);
      }
      cells.push(total.toString(), shippedQuantity);
      return cells;
    }));
    const sheetRows: Array<Array<string | number | null>> = [
      ["材料与车间生产对应表"],
      ["订单号", orderNo],
      ["产品", sales?.productName ?? ""],
      ["生成时间", new Date().toISOString()],
      ["操作人", user.username],
      [],
      ["上表：原料对应表"],
      ["订单号", "订单数量", "规格", "单价", "数量", "采购日期", "到货日期", "供货日期", "供应商", "备注"],
      ...materialRows,
      [],
      ["下表：生产进度表"],
      progressHeader,
      ...progressRows,
    ];
    return this.buildSheet(sheetRows, "材料与车间生产对应表", { report_type: "材料与车间生产对应表", filters, material_rows: materialRows.length, progress_rows: progressRows.length }, user);
  }

  private async fetchRows(filters: Filters & { from?: Date; to?: Date }) {
    const rows = await this.prisma.employeeDailyReport.findMany({
      where: { deletedAt: null, ...(filters.order_no ? { orderNo: filters.order_no } : {}), ...(filters.from || filters.to ? { reportDate: { gte: filters.from, lt: filters.to } } : {}), ...(filters.operation_id ? { productionOrderOperation: { OR: [{ id: filters.operation_id }, { operationCatalogId: filters.operation_id }] } } : {}) },
      include: { employee: { include: { department: true } }, productionOrderOperation: true },
      orderBy: [{ reportDate: "asc" }, { orderNo: "asc" }, { operationNameSnapshot: "asc" }, { employeeNameSnapshot: "asc" }],
      take: LIMIT + 1,
    });
    if (rows.length > LIMIT) throw new UnprocessableEntityException({ code: "EXPORT_LIMIT_EXCEEDED", message: "导出结果过多，请缩小筛选范围", details: [{ limit: LIMIT }] });
    return rows;
  }

  /** 明细行。全站计时单位统一为小时：计时行展示 时长（小时）＝ 落库分钟 ÷ 60；计件行时长留空。合计列原为“总薪酬”。 */
  private detailRow(row: ReportRow) {
    const duration = row.wageMode === "time_rate" ? this.hours(row.durationMinutes) : "";
    return [row.orderNo, row.productionOrderNoSnapshot, row.operationNameSnapshot, row.reportDate.toISOString().slice(0, 10), row.employee.employeeNo, row.employeeNameSnapshot, row.employee.department.name, row.employee.employeeType === "workshop" ? "车间" : "非车间", row.wageMode === "piece_rate" ? "计件" : "计时", row.wageMode === "piece_rate" ? row.quantity.toString() : "", duration, row.unitPrice.toString(), row.calculatedAmount.toString(), row.remark ?? ""];
  }

  /** 订单号盘点表表头：每道工序的生产日期数组、计划数量、汇总数量。 */
  private operationHeaderRows(rows: ReportRow[]) {
    const byOperation = new Map<string, { name: string; target: Prisma.Decimal | null; dates: Set<string>; quantity: Prisma.Decimal }>();
    for (const row of rows) {
      const group = byOperation.get(row.productionOrderOperationId) ?? { name: row.operationNameSnapshot, target: row.productionOrderOperation?.targetQuantity ?? null, dates: new Set<string>(), quantity: new Prisma.Decimal(0) };
      group.dates.add(row.reportDate.toISOString().slice(0, 10));
      group.quantity = group.quantity.plus(row.quantity);
      byOperation.set(row.productionOrderOperationId, group);
    }
    const header: Array<Array<string | number | null>> = [["各工序生产概况"]];
    for (const group of byOperation.values()) {
      header.push(["工序", group.name, "生产日期", [...group.dates].sort().join("、"), "计划数量", group.target?.toString() ?? "", "汇总数量", group.quantity.toString()]);
    }
    return header;
  }

  private summarizeByOrder(rows: ReportRow[]) {
    const groups = new Map<string, { orderNo: string; productionOrderNo: string; quantity: Prisma.Decimal; duration: Prisma.Decimal; amount: Prisma.Decimal }>();
    for (const row of rows) {
      const group = groups.get(row.productionOrderNoSnapshot) ?? { orderNo: row.orderNo, productionOrderNo: row.productionOrderNoSnapshot, quantity: new Prisma.Decimal(0), duration: new Prisma.Decimal(0), amount: new Prisma.Decimal(0) };
      if (row.wageMode === "piece_rate") group.quantity = group.quantity.plus(row.quantity);
      if (row.wageMode === "time_rate") group.duration = group.duration.plus(row.durationMinutes ?? 0);
      group.amount = group.amount.plus(row.calculatedAmount);
      groups.set(row.productionOrderNoSnapshot, group);
    }
    return [...groups.values()];
  }

  private summarizeByOperation(rows: ReportRow[]) {
    const groups = new Map<string, { operationName: string; quantity: Prisma.Decimal; duration: Prisma.Decimal; amount: Prisma.Decimal }>();
    for (const row of rows) {
      const group = groups.get(row.operationNameSnapshot) ?? { operationName: row.operationNameSnapshot, quantity: new Prisma.Decimal(0), duration: new Prisma.Decimal(0), amount: new Prisma.Decimal(0) };
      if (row.wageMode === "piece_rate") group.quantity = group.quantity.plus(row.quantity);
      if (row.wageMode === "time_rate") group.duration = group.duration.plus(row.durationMinutes ?? 0);
      group.amount = group.amount.plus(row.calculatedAmount);
      groups.set(row.operationNameSnapshot, group);
    }
    return [...groups.values()];
  }

  /**
   * 分钟 -> 小时展示（最多 4 位小数、去掉尾随零）。
   * 落库单位始终是分钟，小时仅用于录入/展示，因此所有导出与接口的“小时”都必须走这里换算，
   * 避免出现“表头写小时、单元格还是分钟”的口径错位。
   */
  private hours(durationMinutes: Prisma.Decimal | null) { if (durationMinutes === null || durationMinutes === undefined) return ""; return new Prisma.Decimal(durationMinutes).div(60).toFixed(4).replace(/0+$/, "").replace(/\.$/, ""); }

  private monthRange(month: string) {
    const from = new Date(`${month}-01T00:00:00.000Z`);
    return { from, to: new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1)) };
  }

  private async buildSheet(sheetRows: Array<Array<string | number | null>>, title: string, auditDetails: Record<string, unknown>, user: CurrentUser) {
    const width = Math.max(...sheetRows.map((row) => row.length), 14);
    const sheet = XLSX.utils.aoa_to_sheet(sheetRows);
    sheet["!cols"] = Array.from({ length: width }, () => ({ wch: 18 }));
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, title);
    await this.audit.record("production_payroll_export", "employee_daily_report", user.id, undefined, { ...auditDetails });
    return XLSX.write(book, { type: "buffer", bookType: "xlsx" });
  }

  private invalid(message: string) { return new UnprocessableEntityException({ code: "INVALID_EXPORT_FILTER", message, details: [] }); }
}
