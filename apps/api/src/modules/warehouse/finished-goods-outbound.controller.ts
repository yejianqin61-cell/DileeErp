import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { IsDateString, IsIn, IsOptional, IsString, IsUUID, MaxLength } from "class-validator";
import { CurrentUser } from "../../platform/audit/current-user.decorator";
import type { CurrentUser as CurrentUserType } from "../../platform/auth/auth.service";
import { AuthenticationGuard } from "../../platform/authorization/authentication.guard";
import { ModulePermissionGuard } from "../../platform/authorization/module-permission.guard";
import { RequireModules } from "../../platform/authorization/require-modules.decorator";
import { FinishedGoodsOutboundService } from "./finished-goods-outbound.service";

class OutboundDto { @IsUUID() sales_order_id!: string; @IsUUID() production_order_id!: string; @IsString() quantity!: string; @IsOptional() @IsString() idempotency_key?: string; @IsOptional() @IsString() @MaxLength(1000) risk_reason?: string; @IsOptional() @IsString() @MaxLength(1000) remark?: string; @IsOptional() attachment?: unknown[]; }
class ShippingDto { @IsOptional() @IsDateString() shipment_date?: string; @IsOptional() @IsString() carrier?: string; @IsOptional() @IsString() tracking_no?: string; @IsOptional() @IsString() packing_list_no?: string; @IsOptional() @IsString() invoice_no?: string; @IsOptional() attachment?: unknown[]; }
class SignDto { @IsDateString() signed_at!: string; @IsOptional() @IsString() @MaxLength(500) signature_reference?: string; @IsOptional() attachment?: unknown[]; }
class ReturnDto { @IsUUID() sales_order_id!: string; @IsUUID() production_order_id!: string; @IsString() quantity!: string; @IsDateString() return_date!: string; @IsIn(["finished_goods", "defective_goods"]) destination!: "finished_goods" | "defective_goods"; @IsString() @MaxLength(1000) reason!: string; @IsOptional() @IsString() idempotency_key?: string; @IsOptional() @IsString() @MaxLength(1000) remark?: string; @IsOptional() attachment?: unknown[]; }
class ReasonDto { @IsString() @MaxLength(1000) reason!: string; }

@Controller("finished-goods")
@UseGuards(AuthenticationGuard, ModulePermissionGuard)
@RequireModules("warehouse")
export class FinishedGoodsOutboundController {
  constructor(private readonly outbound: FinishedGoodsOutboundService) {}
  @Get("outbounds") async listOutbounds(@Query("order_no") orderNo?: string) { return { data: await this.outbound.listOutbounds(orderNo), meta: {} }; }
  @Get("outbounds/:id") async getOutbound(@Param("id") id: string) { return { data: await this.outbound.getOutbound(id), meta: {} }; }
  @Post("outbounds") async createOutbound(@Body() body: OutboundDto, @CurrentUser() user: CurrentUserType) { return { data: await this.outbound.createOutbound(body, user), meta: {} }; }
  @Post("outbounds/:id/post") async postOutbound(@Param("id") id: string, @CurrentUser() user: CurrentUserType) { return { data: await this.outbound.postOutbound(id, user), meta: {} }; }
  @Patch("outbounds/:id/shipping") async shipping(@Param("id") id: string, @Body() body: ShippingDto, @CurrentUser() user: CurrentUserType) { return { data: await this.outbound.updateShipping(id, body, user), meta: {} }; }
  @Post("outbounds/:id/sign") async sign(@Param("id") id: string, @Body() body: SignDto, @CurrentUser() user: CurrentUserType) { return { data: await this.outbound.signOutbound(id, body, user), meta: {} }; }
  @Post("outbounds/:id/reverse") async reverseOutbound(@Param("id") id: string, @Body() body: ReasonDto, @CurrentUser() user: CurrentUserType) { return { data: await this.outbound.reverseOutbound(id, body.reason, user), meta: {} }; }
  @Get("customer-returns") async listReturns(@Query("order_no") orderNo?: string) { return { data: await this.outbound.listReturns(orderNo), meta: {} }; }
  @Get("customer-returns/:id") async getReturn(@Param("id") id: string) { return { data: await this.outbound.getReturn(id), meta: {} }; }
  @Post("customer-returns") async createReturn(@Body() body: ReturnDto, @CurrentUser() user: CurrentUserType) { return { data: await this.outbound.createReturn(body, user), meta: {} }; }
  @Post("customer-returns/:id/post") async postReturn(@Param("id") id: string, @CurrentUser() user: CurrentUserType) { return { data: await this.outbound.postReturn(id, user), meta: {} }; }
  @Post("customer-returns/:id/reverse") async reverseReturn(@Param("id") id: string, @Body() body: ReasonDto, @CurrentUser() user: CurrentUserType) { return { data: await this.outbound.reverseReturn(id, body.reason, user), meta: {} }; }
}
