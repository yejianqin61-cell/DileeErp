import { Controller, Get, Query, Res, UseGuards } from "@nestjs/common";
import { IsOptional, IsString, Matches, MaxLength } from "class-validator";
import type { Response } from "express";
import { CurrentUser } from "../../platform/audit/current-user.decorator";
import type { CurrentUser as CurrentUserType } from "../../platform/auth/auth.service";
import { AuthenticationGuard } from "../../platform/authorization/authentication.guard";
import { ModulePermissionGuard } from "../../platform/authorization/module-permission.guard";
import { RequireModules } from "../../platform/authorization/require-modules.decorator";
import { RequireAdministrator } from "../../platform/authorization/require-administrator.decorator";
import { ProductionPayrollExportService } from "./production-payroll-export.service";

class OperationExportDto { @IsString() operation_id!: string; @Matches(/^\d{4}-\d{2}$/) month!: string; }
class OrderExportDto { @IsString() @MaxLength(100) order_no!: string; @IsOptional() @IsString() operation_id?: string; @IsOptional() @Matches(/^\d{4}-\d{2}$/) month?: string; }
/**
 * 生产进度表：`operation_order` 是用户在导出面板里拖拽过的工序列顺序（逗号分隔的工序 id）。
 * 单独一个 DTO 而不是加在 OrderExportDto 上：原料对应表/订单号盘点表不认这个参数，
 * 让它们收到就 400 白名单报错，好过「传了但被静默忽略」——那种沉默会让人以为列序生效了。
 */
class ProgressExportDto { @IsString() @MaxLength(100) order_no!: string; @IsOptional() @IsString() @MaxLength(4000) operation_order?: string; }
class MonthlyExportDto { @Matches(/^\d{4}-\d{2}$/) month!: string; }

@Controller()
@UseGuards(AuthenticationGuard, ModulePermissionGuard)
@RequireModules("production")
export class ProductionPayrollExportController {
  constructor(private readonly exports: ProductionPayrollExportService) {}
  @Get("production/reports/operation-payroll.xlsx") @RequireAdministrator() async operation(@Query() query: OperationExportDto, @CurrentUser() user: CurrentUserType, @Res() response: Response) { const body = await this.exports.exportOperation(query, user); response.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"); response.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent("迪礼ERP-工序盘点表.xlsx")}`); response.setHeader("Cache-Control", "no-store"); return response.send(body); }
  @Get("production/reports/order-operation-payroll.xlsx") @RequireAdministrator() async order(@Query() query: OrderExportDto, @CurrentUser() user: CurrentUserType, @Res() response: Response) { const body = await this.exports.exportOrder(query, user); response.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"); response.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent("迪礼ERP-订单号盘点表.xlsx")}`); response.setHeader("Cache-Control", "no-store"); return response.send(body); }
  @Get("production/reports/monthly-operations-payroll.xlsx") @RequireAdministrator() async monthly(@Query() query: MonthlyExportDto, @CurrentUser() user: CurrentUserType, @Res() response: Response) { const body = await this.exports.exportMonthlyOperations(query, user); response.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"); response.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent("迪礼ERP-当月工序明细总表.xlsx")}`); response.setHeader("Cache-Control", "no-store"); return response.send(body); }
  @Get("production/reports/order-material-production.xlsx") @RequireAdministrator() async materialProduction(@Query() query: OrderExportDto, @CurrentUser() user: CurrentUserType, @Res() response: Response) { const body = await this.exports.exportMaterialProduction(query, user); response.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"); response.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent("迪礼ERP-材料与车间生产对应表.xlsx")}`); response.setHeader("Cache-Control", "no-store"); return response.send(body); }
  // 拆表后的两个独立导出：原料对应表（原上表）、生产进度表（原下表）。
  @Get("production/reports/material-reference.xlsx") @RequireAdministrator() async materialReference(@Query() query: OrderExportDto, @CurrentUser() user: CurrentUserType, @Res() response: Response) { const body = await this.exports.exportMaterialReference(query, user); response.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"); response.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent("迪礼ERP-原料对应表.xlsx")}`); response.setHeader("Cache-Control", "no-store"); return response.send(body); }
  @Get("production/reports/production-progress.xlsx") @RequireAdministrator() async productionProgress(@Query() query: ProgressExportDto, @CurrentUser() user: CurrentUserType, @Res() response: Response) { const body = await this.exports.exportProductionProgress(query, user); response.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"); response.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent("迪礼ERP-生产进度表.xlsx")}`); response.setHeader("Cache-Control", "no-store"); return response.send(body); }
}
