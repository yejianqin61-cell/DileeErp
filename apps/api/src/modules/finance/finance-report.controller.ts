import { Controller, Get, Query, Res, UseGuards } from "@nestjs/common";
import { IsDateString, IsIn, IsOptional, IsString, IsUUID, MaxLength } from "class-validator";
import type { Response } from "express";
import { AuthenticationGuard } from "../../platform/authorization/authentication.guard";
import { ModulePermissionGuard } from "../../platform/authorization/module-permission.guard";
import { RequireAdministrator } from "../../platform/authorization/require-administrator.decorator";
import { RequireModules } from "../../platform/authorization/require-modules.decorator";
import { FinanceReportQueryService } from "./finance-report-query.service";
import {
  buildCashFlowDetailTable,
  buildCashFlowSummaryTable,
  buildPurchaseReconciliationDetailTable,
  buildSalesGrossProfitTable,
  buildSalesReconciliationDetailTable,
  buildSalesReconciliationSummaryTable,
  reportTotalRow,
} from "./finance-report.tables";
import type { FinanceReportFilter, ReportTable } from "./finance-report.types";
import { sendWorkbook } from "./finance-report-workbook";

/**
 * 财务对账报表：页面预览（JSON）+ 导出（XLSX）。
 *
 * 需求来源：`example/财务/` 下 6 份老系统报表；口径见
 * `docs/design/finance-example-forms-export-mapping-design-2026-09-14.md`（R1–R7）。
 *
 * 两条路由共用**同一个 `ReportTable`**：预览与导出是同一份数据、同一套列定义，
 * 所以「页面上看到的」和「导出的」不可能不是一批（这是把它们放在一个 controller 里的原因）。
 *
 * 权限沿用仓库既有导出的做法（见 `procurement/purchase-order-export.controller.ts`）：
 * 类级 `@RequireModules("finance")` + 导出方法级 `@RequireAdministrator()`。
 */

class FinanceReportFilterDto {
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
  @IsOptional() @IsUUID() customer_id?: string;
  @IsOptional() @IsUUID() supplier_id?: string;
  @IsOptional() @IsString() @MaxLength(100) order_no?: string;
  @IsOptional() @IsString() @MaxLength(10) currency?: string;
  /** 是否含草稿；只有字符串 "true" 才算（默认不含）。 */
  @IsOptional() @IsIn(["true", "false"]) include_draft?: string;
  /** 收支报表：按收支项目过滤。 */
  @IsOptional() @IsUUID() item_id?: string;
  /** 收支报表：income / expense。 */
  @IsOptional() @IsIn(["income", "expense"]) direction?: string;
}

/** 报表标识：同时是路由子路径与取数分支的键。 */
type FinanceReportKey =
  | "sales-reconciliation-detail"
  | "purchase-reconciliation-detail"
  | "sales-reconciliation-summary"
  | "sales-gross-profit"
  | "cash-flow-detail"
  | "cash-flow-summary";

@Controller("finance/reports")
@UseGuards(AuthenticationGuard, ModulePermissionGuard)
@RequireModules("finance")
export class FinanceReportController {
  constructor(private readonly reports: FinanceReportQueryService) {}

  /** 销售对账明细表：页面预览。 */
  @Get("sales-reconciliation-detail")
  async salesReconciliationDetail(@Query() query: FinanceReportFilterDto) {
    return this.preview(await this.tableFor("sales-reconciliation-detail", this.filter(query)));
  }

  /** 销售对账明细表：导出 XLSX（23 列，列名列序照抄老表）。 */
  @Get("sales-reconciliation-detail.xlsx")
  @RequireAdministrator()
  async exportSalesReconciliationDetail(@Query() query: FinanceReportFilterDto, @Res() response: Response) {
    return this.send(response, await this.tableFor("sales-reconciliation-detail", this.filter(query)), "销售对账明细");
  }

  /** 采购对账明细表：页面预览。 */
  @Get("purchase-reconciliation-detail")
  async purchaseReconciliationDetail(@Query() query: FinanceReportFilterDto) {
    return this.preview(await this.tableFor("purchase-reconciliation-detail", this.filter(query)));
  }

  /** 采购对账明细表：导出 XLSX（16 列，列名列序照抄老表）。 */
  @Get("purchase-reconciliation-detail.xlsx")
  @RequireAdministrator()
  async exportPurchaseReconciliationDetail(@Query() query: FinanceReportFilterDto, @Res() response: Response) {
    return this.send(response, await this.tableFor("purchase-reconciliation-detail", this.filter(query)), "采购对账明细");
  }

  /** 销售对账汇总表：页面预览（10 列，按销售单汇总）。 */
  @Get("sales-reconciliation-summary")
  async salesReconciliationSummary(@Query() query: FinanceReportFilterDto) {
    return this.preview(await this.tableFor("sales-reconciliation-summary", this.filter(query)));
  }

  /** 销售对账汇总表：导出 XLSX。 */
  @Get("sales-reconciliation-summary.xlsx")
  @RequireAdministrator()
  async exportSalesReconciliationSummary(@Query() query: FinanceReportFilterDto, @Res() response: Response) {
    return this.send(response, await this.tableFor("sales-reconciliation-summary", this.filter(query)), "销售对账汇总");
  }

  /** 销售利润报表(毛利)：页面预览（10 列，成本 = BOM 原料成本）。 */
  @Get("sales-gross-profit")
  async salesGrossProfit(@Query() query: FinanceReportFilterDto) {
    return this.preview(await this.tableFor("sales-gross-profit", this.filter(query)));
  }

  /** 销售利润报表(毛利)：导出 XLSX。 */
  @Get("sales-gross-profit.xlsx")
  @RequireAdministrator()
  async exportSalesGrossProfit(@Query() query: FinanceReportFilterDto, @Res() response: Response) {
    return this.send(response, await this.tableFor("sales-gross-profit", this.filter(query)), "销售利润(毛利)");
  }

  /** 收支明细表：页面预览（6 列，一行一条流水）。 */
  @Get("cash-flow-detail")
  async cashFlowDetail(@Query() query: FinanceReportFilterDto) {
    return this.preview(await this.tableFor("cash-flow-detail", this.filter(query)));
  }

  /** 收支明细表：导出 XLSX。 */
  @Get("cash-flow-detail.xlsx")
  @RequireAdministrator()
  async exportCashFlowDetail(@Query() query: FinanceReportFilterDto, @Res() response: Response) {
    return this.send(response, await this.tableFor("cash-flow-detail", this.filter(query)), "收支明细");
  }

  /** 收支汇总表：页面预览（项目 × 币种，按币种分段并给出各币种合计）。 */
  @Get("cash-flow-summary")
  async cashFlowSummary(@Query() query: FinanceReportFilterDto) {
    return this.preview(await this.tableFor("cash-flow-summary", this.filter(query)));
  }

  /** 收支汇总表：导出 XLSX。 */
  @Get("cash-flow-summary.xlsx")
  @RequireAdministrator()
  async exportCashFlowSummary(@Query() query: FinanceReportFilterDto, @Res() response: Response) {
    return this.send(response, await this.tableFor("cash-flow-summary", this.filter(query)), "收支汇总");
  }

  /** 六张表共用一套筛选条件；每张表的取数分支集中在这里，便于对照。 */
  private async tableFor(report: FinanceReportKey, filter: FinanceReportFilter): Promise<ReportTable> {
    const currencyLabels = await this.reports.currencyLabels();
    switch (report) {
      case "sales-reconciliation-detail":
        return buildSalesReconciliationDetailTable(await this.reports.salesReconciliationDetail(filter), { currencyLabels });
      case "purchase-reconciliation-detail":
        return buildPurchaseReconciliationDetailTable(await this.reports.purchaseReconciliationDetail(filter), { currencyLabels });
      case "sales-reconciliation-summary":
        return buildSalesReconciliationSummaryTable(await this.reports.salesReconciliationSummary(filter), { currencyLabels });
      case "sales-gross-profit": {
        const { rows, footnotes } = await this.reports.salesGrossProfit(filter);
        return buildSalesGrossProfitTable(rows, { currencyLabels, footnotes });
      }
      case "cash-flow-detail":
        return buildCashFlowDetailTable(await this.reports.cashFlowDetail(filter), { currencyLabels });
      case "cash-flow-summary": {
        const { items, amounts, currencies } = await this.reports.cashFlowSummary(filter);
        return buildCashFlowSummaryTable(items, amounts, currencies, { currencyLabels });
      }
    }
  }

  private filter(query: FinanceReportFilterDto): FinanceReportFilter {
    return {
      from: query.from,
      to: query.to,
      customerId: query.customer_id,
      supplierId: query.supplier_id,
      orderNo: query.order_no,
      currency: query.currency,
      includeDraft: query.include_draft === "true",
      itemId: query.item_id,
      direction: query.direction,
    };
  }

  /**
   * 预览响应。
   *
   * 键名转成 snake_case 与全站 API 约定一致；列只暴露前端渲染需要的三项
   * （表头 / 数值格式 / 对齐），列宽是导出专用。
   */
  private preview(table: ReportTable) {
    return {
      data: {
        sheet_name: table.sheetName,
        columns: table.columns.map((column) => ({
          header: column.header,
          num_fmt: column.numFmt ?? null,
          align: column.align ?? null,
        })),
        rows: table.rows,
        total_columns: table.totalColumns ?? [],
        totals: reportTotalRow(table),
        footnotes: table.footnotes ?? [],
      },
      meta: { row_count: table.rows.length },
    };
  }

  private send(response: Response, table: ReportTable, label: string) {
    return sendWorkbook(response, table, label);
  }
}
