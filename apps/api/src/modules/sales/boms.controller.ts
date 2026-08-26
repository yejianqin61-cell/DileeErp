import { Body, Controller, Get, Param, Patch, Post, Put, Query, UseGuards } from "@nestjs/common";
import { IsArray, IsObject, IsOptional, IsString, IsUUID } from "class-validator";
import { CurrentUser } from "../../platform/audit/current-user.decorator";
import type { CurrentUser as CurrentUserType } from "../../platform/auth/auth.service";
import { AuthenticationGuard } from "../../platform/authorization/authentication.guard";
import { ModulePermissionGuard } from "../../platform/authorization/module-permission.guard";
import { RequireModules } from "../../platform/authorization/require-modules.decorator";
import { BomsService } from "./boms.service";

class BomDto { @IsOptional() @IsObject() extension_data?: Record<string, unknown>; @IsOptional() @IsUUID() form_definition_id?: string; }
class BomItemDto {
  @IsString() material_id!: string;
  @IsOptional() @IsString() material_name?: string;
  @IsOptional() @IsString() model?: string;
  @IsOptional() @IsString() color?: string;
  @IsObject() material_snapshot!: Record<string, unknown>;
  @IsString() required_quantity!: string;
  @IsString() unit!: string;
  @IsOptional() @IsString() loss_quantity?: string;
  @IsOptional() @IsString() loss_rate?: string;
  @IsOptional() @IsObject() extension_data?: Record<string, unknown>;
}
class BomItemsDto { @IsArray() items!: BomItemDto[]; }

@Controller("boms")
@UseGuards(AuthenticationGuard, ModulePermissionGuard)
@RequireModules("procurement")
export class BomsController {
  constructor(private readonly boms: BomsService) {}
  @Get() async list(@Query("order_no") orderNo?: string) { return { data: await this.boms.list(orderNo), meta: {} }; }
  @Get(":id") async get(@Param("id") id: string) { return { data: await this.boms.get(id), meta: {} }; }
  @Post("from-sales-order/:salesOrderId") async create(@Param("salesOrderId") salesOrderId: string, @Body() body: BomDto, @CurrentUser() user: CurrentUserType) { return { data: await this.boms.createFromSalesOrder(salesOrderId, body, user), meta: {} }; }
  @Patch(":id") async update(@Param("id") id: string, @Body() body: BomDto, @CurrentUser() user: CurrentUserType) { return { data: await this.boms.update(id, body.extension_data ?? {}, user), meta: {} }; }
  @Put(":id/items") async replaceItems(@Param("id") id: string, @Body() body: BomItemsDto, @CurrentUser() user: CurrentUserType) { return { data: await this.boms.replaceItems(id, body.items, user), meta: {} }; }
  @Post(":id/publish") async publish(@Param("id") id: string, @CurrentUser() user: CurrentUserType) { return { data: await this.boms.publish(id, user), meta: {} }; }
}
