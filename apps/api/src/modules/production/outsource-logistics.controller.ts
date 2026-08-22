import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { IsOptional, IsString, IsUUID, MaxLength } from "class-validator";
import { CurrentUser } from "../../platform/audit/current-user.decorator";
import type { CurrentUser as CurrentUserType } from "../../platform/auth/auth.service";
import { AuthenticationGuard } from "../../platform/authorization/authentication.guard";
import { ModulePermissionGuard } from "../../platform/authorization/module-permission.guard";
import { RequireModules } from "../../platform/authorization/require-modules.decorator";
import { OutsourceLogisticsService } from "./outsource-logistics.service";

class CreateBatchDto { @IsUUID() production_order_id!: string; @IsUUID() purchase_order_item_id!: string; @IsString() planned_quantity!: string; @IsOptional() @IsString() @MaxLength(1000) remark?: string; }
class UpdateBatchDto { @IsOptional() @IsString() planned_quantity?: string; @IsOptional() @IsString() @MaxLength(1000) remark?: string; }

@Controller("production/outsource-logistics-batches")
@UseGuards(AuthenticationGuard, ModulePermissionGuard)
@RequireModules("production")
export class OutsourceLogisticsController {
  constructor(private readonly logistics: OutsourceLogisticsService) {}
  @Get() async list(@Query("order_no") orderNo?: string) { return { data: await this.logistics.list(orderNo), meta: {} }; }
  @Get(":id") async get(@Param("id") id: string) { return { data: await this.logistics.get(id), meta: {} }; }
  @Post() async create(@Body() body: CreateBatchDto, @CurrentUser() user: CurrentUserType) { return { data: await this.logistics.create(body, user), meta: {} }; }
  @Patch(":id") async update(@Param("id") id: string, @Body() body: UpdateBatchDto, @CurrentUser() user: CurrentUserType) { return { data: await this.logistics.update(id, body, user), meta: {} }; }
  @Delete(":id") async remove(@Param("id") id: string, @CurrentUser() user: CurrentUserType) { return { data: await this.logistics.remove(id, user), meta: {} }; }
}
