import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { IsDateString, IsInt, IsOptional, IsString, IsUUID, MaxLength } from "class-validator";
import { CurrentUser } from "../../platform/audit/current-user.decorator";
import type { CurrentUser as CurrentUserType } from "../../platform/auth/auth.service";
import { AuthenticationGuard } from "../../platform/authorization/authentication.guard";
import { ModulePermissionGuard } from "../../platform/authorization/module-permission.guard";
import { RequireModules } from "../../platform/authorization/require-modules.decorator";
import { EmployeeDailyReportsService } from "./employee-daily-reports.service";

class CreateEmployeeDailyReportDto { @IsUUID() production_order_id!: string; @IsUUID() production_order_operation_id!: string; @IsUUID() employee_id!: string; @IsDateString() report_date!: string; @IsString() wage_mode!: string; @IsOptional() @IsString() quantity?: string; @IsOptional() @IsString() duration_minutes?: string; @IsOptional() @IsString() unit_price?: string; @IsOptional() @IsString() idempotency_key?: string; @IsOptional() @IsString() @MaxLength(1000) remark?: string; }
class UpdateEmployeeDailyReportDto { @IsOptional() @IsDateString() report_date?: string; @IsOptional() @IsString() wage_mode?: string; @IsOptional() @IsString() quantity?: string; @IsOptional() @IsString() duration_minutes?: string; @IsOptional() @IsString() unit_price?: string; @IsOptional() @IsInt() expected_version?: number; @IsOptional() @IsString() @MaxLength(1000) remark?: string; @IsString() reason!: string; }
class DeleteEmployeeDailyReportDto { @IsString() reason!: string; @IsOptional() @IsInt() expected_version?: number; }

@Controller()
@UseGuards(AuthenticationGuard, ModulePermissionGuard)
@RequireModules("production")
export class EmployeeDailyReportsController {
  constructor(private readonly reports: EmployeeDailyReportsService) {}
  @Get("production/employee-reports") async list(@Query() query: { employee_id?: string; order_no?: string; production_order_id?: string; production_order_operation_id?: string; report_date?: string; from?: string; to?: string; wage_mode?: string }) { return { data: await this.reports.list(query), meta: {} }; }
  @Get("production/employee-reports/:id") async get(@Param("id") id: string) { return { data: await this.reports.get(id), meta: {} }; }
  @Post("production/employee-reports") async create(@Body() body: CreateEmployeeDailyReportDto, @CurrentUser() user: CurrentUserType) { return { data: await this.reports.create(body, user), meta: {} }; }
  @Patch("production/employee-reports/:id") async update(@Param("id") id: string, @Body() body: UpdateEmployeeDailyReportDto, @CurrentUser() user: CurrentUserType) { return { data: await this.reports.update(id, body, user), meta: {} }; }
  @Delete("production/employee-reports/:id") async remove(@Param("id") id: string, @Body() body: DeleteEmployeeDailyReportDto, @CurrentUser() user: CurrentUserType) { return { data: await this.reports.remove(id, body.reason, user, body.expected_version), meta: {} }; }
  @Get("production/employee-reports/:id/impact-preview") async impactPreview(@Param("id") id: string) { return { data: await this.reports.impactPreview(id), meta: {} }; }
  @Get("production/payroll-sources") async payrollSources(@Query() query: { employee_id?: string; from: string; to: string; wage_mode?: string }) { return { data: await this.reports.payrollSources(query), meta: {} }; }
}
