import { Injectable, UnprocessableEntityException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import * as XLSX from "xlsx";
import { AuditService } from "../../platform/audit/audit.service";
import type { CurrentUser } from "../../platform/auth/auth.service";
import { PrismaService } from "../../platform/database/prisma.service";

type Filters = { operation_id?: string; month?: string; order_no?: string };
const LIMIT = 10000;

@Injectable()
export class ProductionPayrollExportService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  async exportOperation(filters: { operation_id: string; month: string }, user: CurrentUser) {
    if (!filters.operation_id || !/^\d{4}-\d{2}$/.test(filters.month)) throw this.invalid("工序和月份不能为空，月份格式为YYYY-MM");
    const from = new Date(`${filters.month}-01T00:00:00.000Z`); const to = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1));
    return this.exportRows({ operation_id: filters.operation_id, month: filters.month, from, to }, "工序盘点表", user);
  }

  async exportOrder(filters: { order_no: string; operation_id?: string }, user: CurrentUser) {
    if (!filters.order_no?.trim()) throw this.invalid("订单号不能为空");
    return this.exportRows({ order_no: filters.order_no.trim(), operation_id: filters.operation_id }, "订单号盘点表", user);
  }

  private async exportRows(filters: Filters & { from?: Date; to?: Date }, title: string, user: CurrentUser) {
    const rows = await this.prisma.employeeDailyReport.findMany({
      where: { deletedAt: null, ...(filters.order_no ? { orderNo: filters.order_no } : {}), ...(filters.from || filters.to ? { reportDate: { gte: filters.from, lt: filters.to } } : {}), ...(filters.operation_id ? { productionOrderOperation: { OR: [{ id: filters.operation_id }, { operationCatalogId: filters.operation_id }] } } : {}) },
      include: { employee: { include: { department: true } }, productionOrderOperation: true },
      orderBy: [{ reportDate: "asc" }, { orderNo: "asc" }, { operationNameSnapshot: "asc" }, { employeeNameSnapshot: "asc" }],
      take: LIMIT + 1,
    });
    if (rows.length > LIMIT) throw new UnprocessableEntityException({ code: "EXPORT_LIMIT_EXCEEDED", message: "导出结果过多，请缩小筛选范围", details: [{ limit: LIMIT }] });
    const data = rows.map((row) => [row.orderNo, row.productionOrderNoSnapshot, row.operationNameSnapshot, row.reportDate.toISOString().slice(0, 10), row.employee.employeeNo, row.employeeNameSnapshot, row.employee.department.name, row.employee.employeeType === "workshop" ? "车间" : "非车间", row.wageMode === "piece_rate" ? "计件" : "计时", row.wageMode === "piece_rate" ? row.quantity.toString() : "", row.wageMode === "time_rate" ? row.durationMinutes?.toString() ?? "" : "", row.unitPrice.toString(), row.calculatedAmount.toString(), row.remark ?? ""]);
    const operation = filters.operation_id ? await this.prisma.operationCatalog.findFirst({ where: { id: filters.operation_id }, select: { operationName: true } }) : null;
    const sheet = XLSX.utils.aoa_to_sheet([[title], ["统计月份", filters.month ?? ""], ["订单号", filters.order_no ?? ""], ["工序", operation?.operationName ?? "全部工序"], ["数据范围", "仅统计有效工序员工日报；计件展示件数，计时展示时长"], ["生成时间", new Date().toISOString()], ["操作人", user.username], [], ["订单号", "生产单号", "工序", "工序日期", "工号", "员工姓名", "部门", "员工类型", "计薪方式", "件数", "时长（分钟）", "单价", "总薪酬", "备注"], ...data]);
    sheet["!cols"] = Array.from({ length: 14 }, () => ({ wch: 18 }));
    const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, sheet, title);
    await this.audit.record("production_payroll_export", "employee_daily_report", user.id, undefined, { report_type: title, filters, row_count: rows.length });
    return XLSX.write(book, { type: "buffer", bookType: "xlsx" });
  }

  private invalid(message: string) { return new UnprocessableEntityException({ code: "INVALID_EXPORT_FILTER", message, details: [] }); }
}
