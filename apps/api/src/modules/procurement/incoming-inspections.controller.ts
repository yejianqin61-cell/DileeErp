import { Body, Controller, Get, Post, Query, UseGuards } from "@nestjs/common";
import { IsObject, IsOptional, IsString, IsUUID } from "class-validator";
import { CurrentUser } from "../../platform/audit/current-user.decorator";
import type { CurrentUser as CurrentUserType } from "../../platform/auth/auth.service";
import { AuthenticationGuard } from "../../platform/authorization/authentication.guard";
import { ModulePermissionGuard } from "../../platform/authorization/module-permission.guard";
import { RequireModules } from "../../platform/authorization/require-modules.decorator";
import { IncomingInspectionsService } from "./incoming-inspections.service";

class IncomingInspectionDto { @IsUUID() purchase_receipt_id!: string; @IsString() inspected_quantity!: string; @IsString() accepted_quantity!: string; @IsString() conditional_quantity!: string; @IsString() rejected_quantity!: string; @IsOptional() @IsObject() extension_data?: Record<string, unknown>; @IsOptional() @IsString() remark?: string; }
@Controller("incoming-inspections") @UseGuards(AuthenticationGuard, ModulePermissionGuard) @RequireModules("warehouse")
export class IncomingInspectionsController { constructor(private readonly inspections: IncomingInspectionsService) {} @Get() async list(@Query("order_no") orderNo?: string) { return { data: await this.inspections.list(orderNo), meta: {} }; } @Post() async create(@Body() body: IncomingInspectionDto, @CurrentUser() user: CurrentUserType) { return { data: await this.inspections.create(body, user), meta: {} }; } }
