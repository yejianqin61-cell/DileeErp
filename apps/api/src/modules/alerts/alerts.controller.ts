import { Body, Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { IsIn, IsOptional, IsString, MaxLength } from "class-validator";
import { CurrentUser } from "../../platform/audit/current-user.decorator";
import type { CurrentUser as User } from "../../platform/auth/auth.service";
import { AuthenticationGuard } from "../../platform/authorization/authentication.guard";
import { ModulePermissionGuard } from "../../platform/authorization/module-permission.guard";
import { RequireAnyModules } from "../../platform/authorization/require-any-modules.decorator";
import { AlertsService } from "./alerts.service";
class AlertQuery { @IsOptional() @IsString() alert_type?: string; @IsOptional() @IsIn(["pending", "acknowledged", "resolved"]) status?: string; @IsOptional() @IsString() order_no?: string; @IsOptional() @IsIn(["high", "medium", "low"]) severity?: string; @IsOptional() page = 1; @IsOptional() page_size = 20; }
class HandleAlert { @IsIn(["acknowledged", "resolved"]) status!: "acknowledged" | "resolved"; @IsString() @MaxLength(1000) remark!: string; }
@Controller("alerts") @UseGuards(AuthenticationGuard, ModulePermissionGuard) @RequireAnyModules("sales", "procurement", "production", "warehouse", "finance", "hr")
export class AlertsController { constructor(private readonly alerts: AlertsService) {} @Get() async list(@Query() q: AlertQuery) { const r = await this.alerts.list(q); return { data: r.data, meta: { page: q.page, page_size: q.page_size, total: r.total } }; } @Post(":id/handle") async handle(@Param("id") id: string, @Body() body: HandleAlert, @CurrentUser() user: User) { return { data: await this.alerts.handle(id, body.status, body.remark, user), meta: {} }; } }
