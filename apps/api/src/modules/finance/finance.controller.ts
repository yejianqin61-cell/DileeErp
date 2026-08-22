import { Body, Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { IsArray, IsDateString, IsOptional, IsString, IsUUID, MaxLength } from "class-validator";
import { CurrentUser } from "../../platform/audit/current-user.decorator";
import type { CurrentUser as CurrentUserType } from "../../platform/auth/auth.service";
import { AuthenticationGuard } from "../../platform/authorization/authentication.guard";
import { ModulePermissionGuard } from "../../platform/authorization/module-permission.guard";
import { RequireModules } from "../../platform/authorization/require-modules.decorator";
import { CustomerPaymentService } from "./customer-payment.service";
import { ReceivableService } from "./receivable.service";

class SourceDto { @IsOptional() @IsString() amount?: string; @IsOptional() @IsString() @MaxLength(1000) amount_reason?: string; @IsOptional() @IsDateString() due_date?: string; @IsOptional() @IsString() remark?: string; }
class PaymentDto { @IsUUID() customer_id!: string; @IsOptional() @IsString() order_no?: string; @IsDateString() payment_date!: string; @IsString() amount!: string; @IsString() currency!: string; @IsString() payment_method!: string; @IsOptional() @IsString() bank_reference?: string; @IsOptional() @IsString() payer_name?: string; @IsOptional() attachment?: unknown[]; @IsOptional() @IsString() remark?: string; }
class AllocationDto { @IsUUID() receivable_source_id!: string; @IsString() amount!: string; }
class PostPaymentDto { @IsArray() allocations!: AllocationDto[]; }
class ReasonDto { @IsString() @MaxLength(1000) reason!: string; }

@Controller("finance")
@UseGuards(AuthenticationGuard, ModulePermissionGuard)
@RequireModules("finance")
export class FinanceController {
  constructor(private readonly receivable: ReceivableService, private readonly payments: CustomerPaymentService) {}
  @Get("receivable-sources") async listSources(@Query("order_no") orderNo?: string, @Query("customer_id") customerId?: string, @Query("status") status?: string) { return { data: await this.receivable.list(orderNo, customerId, status), meta: {} }; }
  @Get("receivable-sources/:id") async getSource(@Param("id") id: string) { return { data: await this.receivable.get(id), meta: {} }; }
  @Post("receivable-sources/from-outbound/:outboundId") async createSource(@Param("outboundId") outboundId: string, @Body() body: SourceDto, @CurrentUser() user: CurrentUserType) { return { data: await this.receivable.createFromOutbound(outboundId, body, user), meta: {} }; }
  @Post("receivable-sources/:id/confirm") async confirmSource(@Param("id") id: string, @CurrentUser() user: CurrentUserType) { return { data: await this.receivable.confirm(id, user), meta: {} }; }
  @Post("receivable-sources/:id/cancel") async cancelSource(@Param("id") id: string, @Body() body: ReasonDto, @CurrentUser() user: CurrentUserType) { return { data: await this.receivable.cancel(id, body.reason, user), meta: {} }; }
  @Get("receivable-sources/:id/impact-preview") async impact(@Param("id") id: string) { return { data: await this.receivable.impactPreview(id), meta: {} }; }
  @Get("customer-payments") async listPayments(@Query("order_no") orderNo?: string, @Query("customer_id") customerId?: string) { return { data: await this.payments.list(orderNo, customerId), meta: {} }; }
  @Get("customer-payments/:id") async getPayment(@Param("id") id: string) { return { data: await this.payments.get(id), meta: {} }; }
  @Post("customer-payments") async createPayment(@Body() body: PaymentDto, @CurrentUser() user: CurrentUserType) { return { data: await this.payments.create(body, user), meta: {} }; }
  @Post("customer-payments/:id/post") async postPayment(@Param("id") id: string, @Body() body: PostPaymentDto, @CurrentUser() user: CurrentUserType) { return { data: await this.payments.post(id, body.allocations, user), meta: {} }; }
  @Post("customer-payments/:id/reverse") async reversePayment(@Param("id") id: string, @Body() body: ReasonDto, @CurrentUser() user: CurrentUserType) { return { data: await this.payments.reverse(id, body.reason, user), meta: {} }; }
  @Get("order-summary") async orderSummary(@Query("order_no") orderNo?: string) { return { data: orderNo ? await this.payments.orderSummary(orderNo) : [], meta: {} }; }
  @Get("receivable-order-summary") async receivableOrderSummary(@Query("order_no") orderNo?: string) { return { data: orderNo ? await this.receivable.orderSummary(orderNo) : [], meta: {} }; }
}
