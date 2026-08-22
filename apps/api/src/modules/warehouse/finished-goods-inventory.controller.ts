import { Body, Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { IsOptional, IsString, IsUUID, MaxLength } from "class-validator";
import { CurrentUser } from "../../platform/audit/current-user.decorator";
import type { CurrentUser as CurrentUserType } from "../../platform/auth/auth.service";
import { AuthenticationGuard } from "../../platform/authorization/authentication.guard";
import { ModulePermissionGuard } from "../../platform/authorization/module-permission.guard";
import { RequireModules } from "../../platform/authorization/require-modules.decorator";
import { FinishedGoodsInventoryService } from "./finished-goods-inventory.service";

class InventoryDto { @IsUUID() qc_record_id!: string; @IsString() quantity!: string; @IsOptional() @IsString() idempotency_key?: string; @IsOptional() @IsString() @MaxLength(1000) remark?: string; }
class ReasonDto { @IsString() @MaxLength(1000) reason!: string; }

@Controller("finished-goods")
@UseGuards(AuthenticationGuard, ModulePermissionGuard)
export class FinishedGoodsInventoryController {
  constructor(private readonly inventory: FinishedGoodsInventoryService) {}
  @Get("inbounds") @RequireModules("warehouse") async listInbounds(@Query("order_no") orderNo?: string) { return { data: await this.inventory.listInbounds(orderNo), meta: {} }; }
  @Post("inbounds") @RequireModules("warehouse") async createInbound(@Body() body: InventoryDto, @CurrentUser() user: CurrentUserType) { return { data: await this.inventory.createInbound(body, user), meta: {} }; }
  @Post("inbounds/:id/post") @RequireModules("warehouse") async postInbound(@Param("id") id: string, @CurrentUser() user: CurrentUserType) { return { data: await this.inventory.postInbound(id, user), meta: {} }; }
  @Post("inbounds/:id/reverse") @RequireModules("warehouse") async reverseInbound(@Param("id") id: string, @Body() body: ReasonDto, @CurrentUser() user: CurrentUserType) { return { data: await this.inventory.reverseInbound(id, body, user), meta: {} }; }
  @Get("defectives") @RequireModules("warehouse") async listDefectives(@Query("order_no") orderNo?: string) { return { data: await this.inventory.listDefectives(orderNo), meta: {} }; }
  @Post("defectives") @RequireModules("warehouse") async createDefective(@Body() body: InventoryDto, @CurrentUser() user: CurrentUserType) { return { data: await this.inventory.createDefective(body, user), meta: {} }; }
  @Post("defectives/:id/post") @RequireModules("warehouse") async postDefective(@Param("id") id: string, @CurrentUser() user: CurrentUserType) { return { data: await this.inventory.postDefective(id, user), meta: {} }; }
  @Post("defectives/:id/reverse") @RequireModules("warehouse") async reverseDefective(@Param("id") id: string, @Body() body: ReasonDto, @CurrentUser() user: CurrentUserType) { return { data: await this.inventory.reverseDefective(id, body, user), meta: {} }; }
}
