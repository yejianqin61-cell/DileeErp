import { Controller, Get, Query, Res, UseGuards } from "@nestjs/common";
import { IsOptional, IsString, Matches, MaxLength } from "class-validator";
import type { Response } from "express";
import { CurrentUser } from "../../platform/audit/current-user.decorator";
import type { CurrentUser as CurrentUserType } from "../../platform/auth/auth.service";
import { AuthenticationGuard } from "../../platform/authorization/authentication.guard";
import { ModulePermissionGuard } from "../../platform/authorization/module-permission.guard";
import { RequireModules } from "../../platform/authorization/require-modules.decorator";
import { ProductionPayrollExportService } from "./production-payroll-export.service";

class OperationExportDto { @IsString() operation_id!: string; @Matches(/^\d{4}-\d{2}$/) month!: string; }
class OrderExportDto { @IsString() @MaxLength(100) order_no!: string; @IsOptional() @IsString() operation_id?: string; }

@Controller()
@UseGuards(AuthenticationGuard, ModulePermissionGuard)
@RequireModules("production")
export class ProductionPayrollExportController {
  constructor(private readonly exports: ProductionPayrollExportService) {}
  @Get("production/reports/operation-payroll.xlsx") async operation(@Query() query: OperationExportDto, @CurrentUser() user: CurrentUserType, @Res() response: Response) { const body = await this.exports.exportOperation(query, user); response.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"); response.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent("迪礼ERP-工序盘点表.xlsx")}`); response.setHeader("Cache-Control", "no-store"); return response.send(body); }
  @Get("production/reports/order-operation-payroll.xlsx") async order(@Query() query: OrderExportDto, @CurrentUser() user: CurrentUserType, @Res() response: Response) { const body = await this.exports.exportOrder(query, user); response.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"); response.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent("迪礼ERP-订单号盘点表.xlsx")}`); response.setHeader("Cache-Control", "no-store"); return response.send(body); }
}
