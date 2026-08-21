import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { IsObject, IsOptional } from "class-validator";
import { CurrentUser } from "../../platform/audit/current-user.decorator";
import type { CurrentUser as CurrentUserType } from "../../platform/auth/auth.service";
import { AuthenticationGuard } from "../../platform/authorization/authentication.guard";
import { ModulePermissionGuard } from "../../platform/authorization/module-permission.guard";
import { RequireModules } from "../../platform/authorization/require-modules.decorator";
import { BomsService } from "./boms.service";

class BomDto { @IsOptional() @IsObject() extension_data?: Record<string, unknown>; }

@Controller("boms")
@UseGuards(AuthenticationGuard, ModulePermissionGuard)
@RequireModules("sales")
export class BomsController {
  constructor(private readonly boms: BomsService) {}
  @Get() async list(@Query("order_no") orderNo?: string) { return { data: await this.boms.list(orderNo), meta: {} }; }
  @Get(":id") async get(@Param("id") id: string) { return { data: await this.boms.get(id), meta: {} }; }
  @Post("from-sales-order/:salesOrderId") async create(@Param("salesOrderId") salesOrderId: string, @Body() body: BomDto, @CurrentUser() user: CurrentUserType) { return { data: await this.boms.createFromSalesOrder(salesOrderId, body, user), meta: {} }; }
  @Patch(":id") async update(@Param("id") id: string, @Body() body: BomDto, @CurrentUser() user: CurrentUserType) { return { data: await this.boms.update(id, body.extension_data ?? {}, user), meta: {} }; }
}
