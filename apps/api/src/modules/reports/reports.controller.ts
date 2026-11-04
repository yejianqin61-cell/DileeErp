import { Controller, Get, Param, Query, Res, UseGuards } from "@nestjs/common";
import { IsDateString, IsInt, IsOptional, IsString, Max, MaxLength, Min } from "class-validator";
import { Type } from "class-transformer";
import type { Response } from "express";
import { AuthenticationGuard } from "../../platform/authorization/authentication.guard";
import { ModulePermissionGuard } from "../../platform/authorization/module-permission.guard";
import { RequireAnyModules } from "../../platform/authorization/require-any-modules.decorator";
import { ReportsService } from "./reports.service";
import { ProcurementWarehouseReportService } from "./procurement-warehouse-report.service";
import { ProcurementWarehouseReportExportService } from "./procurement-warehouse-report-export.service";
class ReportQueryDto { @IsOptional() @IsString() order_no?: string; @IsOptional() @IsDateString() from?: string; @IsOptional() @IsDateString() to?: string; @IsOptional() @IsString() status?: string; @IsOptional() @IsString() employee_id?: string; @IsOptional() @IsString() supplier_id?: string; @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1; @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) page_size = 20; }

/**
 * 采购与仓储报表的筛选 DTO（设计文档 §2/§3）：两个参数都可选、都是模糊匹配。
 *
 * 为什么在这里限长：筛选条件会拼成 SQL `LIKE '%…%'`，超长搜索词除了让查询变慢没有任何意义；
 * 上限与库里的列宽对齐（订单号 `VARCHAR(100)`、物料名称 `VARCHAR(200)`），
 * 这样「用户能填多长」与「字段能存多长」是同一个数。
 * `order_no` / `material` 空串在服务层按「未筛选」处理（与既有报表一致）。
 */
export class ProcurementWarehouseQueryDto {
  @IsOptional() @IsString() @MaxLength(100) order_no?: string;
  @IsOptional() @IsString() @MaxLength(200) material?: string;
}
@Controller("reports") @UseGuards(AuthenticationGuard, ModulePermissionGuard) @RequireAnyModules("sales", "procurement", "production", "warehouse", "finance", "hr")
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly procurementWarehouseReports: ProcurementWarehouseReportService,
    private readonly procurementWarehouseExports: ProcurementWarehouseReportExportService
  ) {}
  @Get("orders") async orders(@Query() q: ReportQueryDto) { const r = await this.reports.orders(q); return { data: r.data, meta: { page: q.page, page_size: q.page_size, total: r.total } }; } @Get("procurement-payables") async procurement(@Query() q: ReportQueryDto) { const r = await this.reports.procurement(q); return { data: r.data, meta: { page: q.page, page_size: q.page_size, total: r.total } }; } @Get("inventory") async inventory(@Query() q: ReportQueryDto) { const r = await this.reports.inventory(q); return { data: r.data, meta: { page: q.page, page_size: q.page_size, total: r.total } }; } @Get("production-qc") async productionQc(@Query() q: ReportQueryDto) { const r = await this.reports.productionQc(q); return { data: r.data, meta: { page: q.page, page_size: q.page_size, total: r.total } }; } @Get("payroll") async payroll(@Query() q: ReportQueryDto) { const r = await this.reports.payroll(q); return { data: r.data, meta: { page: q.page, page_size: q.page_size, total: r.total } }; }

  /**
   * 采购与仓储报表（屏幕取数，设计文档 §3.1）。
   *
   * 这两条路由**必须声明在 `@Get(":report/export")` 之前**：Nest/Express 按声明顺序匹配，
   * 静态段与参数段有歧义时先声明的赢；把静态路由放在参数路由后面，`procurement-warehouse`
   * 会被 `:report` 吃掉（仓库模块踩过同样的坑）。
   *
   * 权限用方法级 `@RequireAnyModules("procurement", "warehouse")` 覆盖类级的六个模块：
   * 本表同时读采购与仓库两边的单据，采购或仓库任一模组可看即可（设计文档 §3）。
   */
  @Get("procurement-warehouse")
  @RequireAnyModules("procurement", "warehouse")
  async procurementWarehouse(@Query() query: ProcurementWarehouseQueryDto) {
    return this.procurementWarehouseReports.report(query);
  }

  /** 采购与仓储报表（Excel 导出，设计文档 §3.2）：与屏幕接口同一份取数，行数超 5000 同样 422。 */
  @Get("procurement-warehouse/export.xlsx")
  @RequireAnyModules("procurement", "warehouse")
  async exportProcurementWarehouse(@Query() query: ProcurementWarehouseQueryDto, @Res() response: Response) {
    const result = await this.procurementWarehouseExports.exportWorkbook(query);
    response.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    // 文件名里有中文：必须 `filename*=UTF-8''` + encodeURIComponent（与采购单导出同一写法），
    // 只写 filename="…" 时浏览器按 Latin-1 解，中文文件名会变成乱码。
    response.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(result.fileName)}`);
    response.setHeader("Cache-Control", "no-store");
    return response.send(result.buffer);
  }

  @Get(":report/export") async export(@Param("report") report: string, @Query() q: ReportQueryDto, @Res() response: Response) { const body = await this.reports.export(report, q); response.setHeader("Content-Type", "text/csv; charset=utf-8"); response.setHeader("Content-Disposition", `attachment; filename="${report}.csv"`); return response.send(body); } }
