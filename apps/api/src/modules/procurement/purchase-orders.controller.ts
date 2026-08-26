import { Body, Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { IsArray, IsDateString, IsOptional, IsObject, IsString, IsUUID, ValidateNested } from "class-validator";
import { Type } from "class-transformer";
import { CurrentUser } from "../../platform/audit/current-user.decorator";
import type { CurrentUser as CurrentUserType } from "../../platform/auth/auth.service";
import { AuthenticationGuard } from "../../platform/authorization/authentication.guard";
import { ModulePermissionGuard } from "../../platform/authorization/module-permission.guard";
import { RequireModules } from "../../platform/authorization/require-modules.decorator";
import { PurchaseOrdersService } from "./purchase-orders.service";

class ItemDto { @IsUUID() material_id!: string; @IsUUID() unit_id!: string; @IsOptional() @IsUUID() bom_item_id?: string; @IsOptional() @IsString() model?: string; @IsString() quantity!: string; @IsString() unit_price!: string; @IsOptional() @IsString() tax_rate?: string; @IsOptional() @IsString() extra_fee?: string; @IsOptional() @IsObject() extension_data?: Record<string, unknown>; }
class PurchaseOrderDto { @IsString() order_no!: string; @IsUUID() bom_id!: string; @IsOptional() bom_version?: number; @IsUUID() supplier_id!: string; @IsDateString() purchase_date!: string; @IsOptional() @IsDateString() expected_date?: string; @IsString() currency!: string; @IsOptional() @IsString() remark?: string; @IsOptional() @IsObject() extension_data?: Record<string, unknown>; @IsArray() @ValidateNested({ each: true }) @Type(() => ItemDto) items!: ItemDto[]; }
class ReceiptDto { @IsString() quantity!: string; @IsDateString() received_date!: string; @IsOptional() @IsString() reference_no?: string; @IsOptional() @IsString() remark?: string; }

@Controller("purchase-orders")
@UseGuards(AuthenticationGuard, ModulePermissionGuard)
@RequireModules("procurement")
export class PurchaseOrdersController {
  constructor(private readonly orders: PurchaseOrdersService) {}
  @Get() async list(@Query("order_no") orderNo?: string) { return { data: await this.orders.list(orderNo), meta: {} }; }
  @Post() async create(@Body() body: PurchaseOrderDto, @CurrentUser() user: CurrentUserType) { return { data: await this.orders.create(body, user), meta: {} }; }
  @Get(":id") async get(@Param("id") id: string) { return { data: await this.orders.get(id), meta: {} }; }
  @Get(":id/impact-preview") async impact(@Param("id") id: string) { return { data: await this.orders.impactPreview(id), meta: {} }; }
  @Post(":id/order") async order(@Param("id") id: string, @CurrentUser() user: CurrentUserType) { return { data: await this.orders.order(id, user), meta: {} }; }
  @Post(":id/cancel") async cancel(@Param("id") id: string, @CurrentUser() user: CurrentUserType) { return { data: await this.orders.cancel(id, user), meta: {} }; }
  @Post(":id/items/:itemId/receipts") async receipt(@Param("id") id: string, @Param("itemId") itemId: string, @Body() body: ReceiptDto, @CurrentUser() user: CurrentUserType) { return { data: await this.orders.receipt(id, itemId, body, user), meta: {} }; }
}
