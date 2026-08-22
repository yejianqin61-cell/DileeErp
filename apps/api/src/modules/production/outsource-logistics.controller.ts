import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { IsDateString, IsOptional, IsString, IsUUID, MaxLength } from "class-validator";
import { CurrentUser } from "../../platform/audit/current-user.decorator";
import type { CurrentUser as CurrentUserType } from "../../platform/auth/auth.service";
import { AuthenticationGuard } from "../../platform/authorization/authentication.guard";
import { ModulePermissionGuard } from "../../platform/authorization/module-permission.guard";
import { RequireModules } from "../../platform/authorization/require-modules.decorator";
import { OutsourceLogisticsService } from "./outsource-logistics.service";

class CreateBatchDto { @IsUUID() production_order_id!: string; @IsUUID() purchase_order_item_id!: string; @IsString() planned_quantity!: string; @IsOptional() @IsString() @MaxLength(1000) remark?: string; }
class UpdateBatchDto { @IsOptional() @IsString() planned_quantity?: string; @IsOptional() @IsString() @MaxLength(1000) remark?: string; }
class DispatchDto { @IsString() quantity!: string; @IsDateString() dispatch_date!: string; @IsString() @MaxLength(1000) proof_remark!: string; }
class ReceiptDto { @IsString() quantity!: string; @IsDateString() receipt_date!: string; @IsOptional() @IsString() @MaxLength(100) receiver_name?: string; @IsString() @MaxLength(1000) proof_remark!: string; }
class ReasonDto { @IsString() @MaxLength(1000) reason!: string; }
class MaterialReturnDto { @IsUUID() production_order_id!: string; @IsUUID() logistics_batch_id!: string; @IsUUID() material_id!: string; @IsUUID() unit_id!: string; @IsString() quantity!: string; @IsDateString() transfer_date!: string; @IsOptional() @IsString() @MaxLength(1000) remark?: string; }
class FinishedReturnDto { @IsUUID() production_order_id!: string; @IsUUID() unit_id!: string; @IsString() @MaxLength(500) product_description!: string; @IsString() quantity!: string; @IsDateString() transfer_date!: string; @IsOptional() @IsString() @MaxLength(1000) remark?: string; }
class DirectShipmentDto { @IsUUID() production_order_id!: string; @IsUUID() unit_id!: string; @IsString() @MaxLength(500) product_description!: string; @IsString() quantity!: string; @IsDateString() shipment_date!: string; @IsString() @MaxLength(500) logistics_reference!: string; @IsOptional() @IsString() @MaxLength(1000) remark?: string; }

@Controller("production/outsource-logistics-batches")
@UseGuards(AuthenticationGuard, ModulePermissionGuard)
@RequireModules("production")
export class OutsourceLogisticsController {
  constructor(private readonly logistics: OutsourceLogisticsService) {}
  @Get() async list(@Query("order_no") orderNo?: string) { return { data: await this.logistics.list(orderNo), meta: {} }; }
  @Get("payable-sources") @RequireModules("finance") async payableSources(@Query("order_no") orderNo?: string) { return { data: await this.logistics.payableSources(orderNo), meta: {} }; }
  @Get(":id/impact-preview") async impact(@Param("id") id: string) { return { data: await this.logistics.impactPreview(id), meta: {} }; }
  @Get(":id/audit-events") async audit(@Param("id") id: string) { return { data: await this.logistics.auditEvents(id), meta: {} }; }
  @Get("returns") async returns(@Query("order_no") orderNo?: string) { return { data: await this.logistics.listReturns(orderNo), meta: {} }; }
  @Get("direct-shipments") async directShipments(@Query("order_no") orderNo?: string) { return { data: await this.logistics.listDirectShipments(orderNo), meta: {} }; }
  @Get(":id") async get(@Param("id") id: string) { return { data: await this.logistics.get(id), meta: {} }; }
  @Post() async create(@Body() body: CreateBatchDto, @CurrentUser() user: CurrentUserType) { return { data: await this.logistics.create(body, user), meta: {} }; }
  @Post(":id/dispatch") async dispatch(@Param("id") id: string, @Body() body: DispatchDto, @CurrentUser() user: CurrentUserType) { return { data: await this.logistics.dispatch(id, body, user), meta: {} }; }
  @Post(":id/receipts") async receipt(@Param("id") id: string, @Body() body: ReceiptDto, @CurrentUser() user: CurrentUserType) { return { data: await this.logistics.receipt(id, body, user), meta: {} }; }
  @Post("receipts/:receiptId/reverse") async reverseReceipt(@Param("receiptId") receiptId: string, @Body() body: ReasonDto, @CurrentUser() user: CurrentUserType) { return { data: await this.logistics.reverseReceipt(receiptId, body.reason, user), meta: {} }; }
  @Post(":id/cancel-dispatch") async cancelDispatch(@Param("id") id: string, @Body() body: ReasonDto, @CurrentUser() user: CurrentUserType) { return { data: await this.logistics.cancelDispatch(id, body.reason, user), meta: {} }; }
  @Post("returns/material") async createMaterialReturn(@Body() body: MaterialReturnDto, @CurrentUser() user: CurrentUserType) { return { data: await this.logistics.createMaterialReturn(body, user), meta: {} }; }
  @Post("returns/:id/submit-for-qc") async submitReturnForQc(@Param("id") id: string, @CurrentUser() user: CurrentUserType) { return { data: await this.logistics.submitReturnForQc(id, user), meta: {} }; }
  @Post("returns/finished-goods") async createFinishedReturn(@Body() body: FinishedReturnDto, @CurrentUser() user: CurrentUserType) { return { data: await this.logistics.createFinishedReturn(body, user), meta: {} }; }
  @Post("returns/:id/submit-finished-for-qc") async submitFinishedReturnForQc(@Param("id") id: string, @CurrentUser() user: CurrentUserType) { return { data: await this.logistics.submitFinishedReturnForQc(id, user), meta: {} }; }
  @Post("direct-shipments") async createDirectShipment(@Body() body: DirectShipmentDto, @CurrentUser() user: CurrentUserType) { return { data: await this.logistics.createDirectShipment(body, user), meta: {} }; }
  @Post("direct-shipments/:id/dispatch") async dispatchDirectShipment(@Param("id") id: string, @CurrentUser() user: CurrentUserType) { return { data: await this.logistics.dispatchDirectShipment(id, user), meta: {} }; }
  @Post("direct-shipments/:id/reverse") async reverseDirectShipment(@Param("id") id: string, @Body() body: ReasonDto, @CurrentUser() user: CurrentUserType) { return { data: await this.logistics.reverseDirectShipment(id, body.reason, user), meta: {} }; }
  @Patch(":id") async update(@Param("id") id: string, @Body() body: UpdateBatchDto, @CurrentUser() user: CurrentUserType) { return { data: await this.logistics.update(id, body, user), meta: {} }; }
  @Delete(":id") async remove(@Param("id") id: string, @CurrentUser() user: CurrentUserType) { return { data: await this.logistics.remove(id, user), meta: {} }; }
}
