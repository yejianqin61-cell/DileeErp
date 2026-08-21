import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { IsDateString, IsOptional, IsString, IsUUID, MaxLength } from "class-validator";
import { CurrentUser } from "../../platform/audit/current-user.decorator";
import type { CurrentUser as CurrentUserType } from "../../platform/auth/auth.service";
import { AuthenticationGuard } from "../../platform/authorization/authentication.guard";
import { ModulePermissionGuard } from "../../platform/authorization/module-permission.guard";
import { RequireModules } from "../../platform/authorization/require-modules.decorator";
import { ProductionOrdersService } from "./production-orders.service";
class ProductionOrderDto { @IsString() order_no!: string; @IsUUID() bom_id!: string; bom_version!: number; @IsOptional() @IsString() production_order_type?: string; @IsOptional() @IsUUID() parent_production_order_id?: string; @IsString() execution_mode!: string; @IsUUID() execution_location_id!: string; @IsString() planned_quantity!: string; @IsUUID() unit_id!: string; @IsOptional() @IsString() @MaxLength(1000) product_specification?: string; @IsOptional() @IsString() @MaxLength(2000) production_process_note?: string; @IsOptional() @IsDateString() planned_started_on?: string; @IsOptional() @IsDateString() delivery_due_on?: string; @IsOptional() @IsString() @MaxLength(1000) remark?: string; }
class OperationDto { @IsUUID() operation_id!: string; sequence_no!: number; @IsString() target_quantity!: string; @IsOptional() @IsUUID() unit_id?: string; }
class TransitionDto { @IsString() target!: string; @IsOptional() @IsString() reason?: string; }
class CancelOperationDto { @IsString() reason!: string; }
@Controller("production/orders")
@UseGuards(AuthenticationGuard, ModulePermissionGuard)
@RequireModules("production")
export class ProductionOrdersController {
  constructor(private readonly orders: ProductionOrdersService) {}
  @Get() async list(@Query("order_no") orderNo?: string) { return { data: await this.orders.list(orderNo), meta: {} }; }
  @Get(":id") async get(@Param("id") id: string) { return { data: await this.orders.get(id), meta: {} }; }
  @Post() async create(@Body() body: ProductionOrderDto, @CurrentUser() user: CurrentUserType) { return { data: await this.orders.create(body, user), meta: {} }; }
  @Patch(":id") async update(@Param("id") id: string, @Body() body: Partial<ProductionOrderDto>, @CurrentUser() user: CurrentUserType) { return { data: await this.orders.update(id, body, user), meta: {} }; }
  @Delete(":id") async remove(@Param("id") id: string, @CurrentUser() user: CurrentUserType) { return { data: await this.orders.delete(id, user), meta: {} }; }
  @Post(":id/operations") async addOperation(@Param("id") id: string, @Body() body: OperationDto, @CurrentUser() user: CurrentUserType) { return { data: await this.orders.addOperation(id, body, user), meta: {} }; }
  @Patch(":id/operations/:operationId") async updateOperation(@Param("id") id: string, @Param("operationId") operationId: string, @Body() body: Partial<OperationDto>, @CurrentUser() user: CurrentUserType) { return { data: await this.orders.updateOperation(id, operationId, body, user), meta: {} }; }
  @Post(":id/operations/:operationId/cancel") async cancelOperation(@Param("id") id: string, @Param("operationId") operationId: string, @Body() body: CancelOperationDto, @CurrentUser() user: CurrentUserType) { return { data: await this.orders.cancelOperation(id, operationId, body.reason, user), meta: {} }; }
  @Post(":id/transition") async transition(@Param("id") id: string, @Body() body: TransitionDto, @CurrentUser() user: CurrentUserType) { return { data: await this.orders.transition(id, body.target, body.reason, user), meta: {} }; }
}
