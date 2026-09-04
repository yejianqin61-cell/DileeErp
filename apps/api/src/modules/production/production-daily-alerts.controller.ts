import { Body, Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { IsOptional, IsString, MaxLength } from "class-validator";
import { CurrentUser } from "../../platform/audit/current-user.decorator";
import type { CurrentUser as CurrentUserType } from "../../platform/auth/auth.service";
import { AuthenticationGuard } from "../../platform/authorization/authentication.guard";
import { ModulePermissionGuard } from "../../platform/authorization/module-permission.guard";
import { RequireModules } from "../../platform/authorization/require-modules.decorator";
import { ProductionDailyAlertsService } from "./production-daily-alerts.service";

class ConfirmAlertDto { @IsString() @MaxLength(1000) remark!: string; }
class ResolveAnomalyDto { @IsString() @MaxLength(1000) remark!: string; }

@Controller()
@UseGuards(AuthenticationGuard, ModulePermissionGuard)
@RequireModules("production")
export class ProductionDailyAlertsController {
  constructor(private readonly alerts: ProductionDailyAlertsService) {}
  @Get("production/daily-alerts") async list(@Query() query: { alert_type?: string; status?: string; order_no?: string; production_order_id?: string; production_order_operation_id?: string; report_date?: string }) { return { data: await this.alerts.list(query), meta: {} }; }
  @Get("production/daily-alerts/:id") async get(@Param("id") id: string) { return { data: await this.alerts.get(id), meta: {} }; }
  @Post("production/daily-alerts/:id/confirm") async confirm(@Param("id") id: string, @Body() body: ConfirmAlertDto, @CurrentUser() user: CurrentUserType) { return { data: await this.alerts.confirm(id, body.remark, user), meta: {} }; }
  @Get("production/daily-alerts/:id/audit-events") async auditEvents(@Param("id") id: string) { return { data: await this.alerts.auditEvents(id), meta: {} }; }
  @Get("production/daily-report-merge-anomalies") async mergeAnomalies(@Query("status") status?: string) { return { data: await this.alerts.listMergeAnomalies(status), meta: {} }; }
  @Post("production/daily-report-merge-anomalies/:id/resolve") async resolveMergeAnomaly(@Param("id") id: string, @Body() body: ResolveAnomalyDto, @CurrentUser() user: CurrentUserType) { return { data: await this.alerts.resolveMergeAnomaly(id, body.remark, user), meta: {} }; }
}
