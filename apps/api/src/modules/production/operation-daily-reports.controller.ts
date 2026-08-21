import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { IsDateString, IsOptional, IsString, IsUUID, MaxLength } from "class-validator";
import { CurrentUser } from "../../platform/audit/current-user.decorator";
import type { CurrentUser as CurrentUserType } from "../../platform/auth/auth.service";
import { AuthenticationGuard } from "../../platform/authorization/authentication.guard";
import { ModulePermissionGuard } from "../../platform/authorization/module-permission.guard";
import { RequireModules } from "../../platform/authorization/require-modules.decorator";
import { OperationDailyReportsService } from "./operation-daily-reports.service";

class CreateOperationDailyReportDto { @IsUUID() production_order_id!: string; @IsUUID() production_order_operation_id!: string; @IsDateString() report_date!: string; @IsString() completed_quantity!: string; @IsOptional() @IsString() @MaxLength(1000) remark?: string; }
class UpdateOperationDailyReportDto { @IsOptional() @IsDateString() report_date?: string; @IsOptional() @IsString() completed_quantity?: string; @IsOptional() @IsString() @MaxLength(1000) remark?: string; @IsString() reason!: string; }
class DeleteOperationDailyReportDto { @IsString() reason!: string; }

@Controller()
@UseGuards(AuthenticationGuard, ModulePermissionGuard)
@RequireModules("production")
export class OperationDailyReportsController {
  constructor(private readonly reports: OperationDailyReportsService) {}
  @Get("production/operation-reports") async list(@Query() query: { order_no?: string; production_order_id?: string; production_order_operation_id?: string; report_date?: string }) { return { data: await this.reports.list(query), meta: {} }; }
  @Get("production/operation-reports/:id") async get(@Param("id") id: string) { return { data: await this.reports.get(id), meta: {} }; }
  @Post("production/operation-reports") async create(@Body() body: CreateOperationDailyReportDto, @CurrentUser() user: CurrentUserType) { return { data: await this.reports.create(body, user), meta: {} }; }
  @Patch("production/operation-reports/:id") async update(@Param("id") id: string, @Body() body: UpdateOperationDailyReportDto, @CurrentUser() user: CurrentUserType) { return { data: await this.reports.update(id, body, user), meta: {} }; }
  @Delete("production/operation-reports/:id") async remove(@Param("id") id: string, @Body() body: DeleteOperationDailyReportDto, @CurrentUser() user: CurrentUserType) { return { data: await this.reports.remove(id, body.reason, user), meta: {} }; }
  @Get("production/operation-reports/:id/impact-preview") async impactPreview(@Param("id") id: string) { return { data: await this.reports.impactPreview(id), meta: {} }; }
  @Get("production/orders/:id/progress") async progress(@Param("id") id: string) { return { data: await this.reports.progress(id), meta: {} }; }
}
