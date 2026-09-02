import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { IsArray, IsDateString, IsIn, IsOptional, IsString, IsUUID, MaxLength } from "class-validator";
import { CurrentUser } from "../../platform/audit/current-user.decorator";
import type { CurrentUser as CurrentUserType } from "../../platform/auth/auth.service";
import { AuthenticationGuard } from "../../platform/authorization/authentication.guard";
import { ModulePermissionGuard } from "../../platform/authorization/module-permission.guard";
import { RequireModules } from "../../platform/authorization/require-modules.decorator";
import { CustomerPaymentService } from "./customer-payment.service";
import { ReceivableAdjustmentService } from "./receivable-adjustment.service";
import { ReconciliationService } from "./reconciliation.service";
import { ReceivableService } from "./receivable.service";
import { SupplierPayableService } from "./supplier-payable.service";
import { SupplierPaymentService } from "./supplier-payment.service";
import { SupplierPayableReconciliationService } from "./supplier-payable-reconciliation.service";

class SourceDto { @IsOptional() @IsString() amount?: string; @IsOptional() @IsString() @MaxLength(1000) amount_reason?: string; @IsOptional() @IsDateString() due_date?: string; @IsOptional() @IsString() remark?: string; }
class ReceivableDraftUpdateDto { @IsOptional() @IsString() amount?: string; @IsOptional() @IsDateString() due_date?: string; @IsOptional() @IsString() @MaxLength(1000) amount_reason?: string; @IsOptional() @IsString() @MaxLength(1000) remark?: string; }
class PaymentDto { @IsUUID() customer_id!: string; @IsOptional() @IsString() order_no?: string; @IsDateString() payment_date!: string; @IsString() amount!: string; @IsString() currency!: string; @IsString() payment_method!: string; @IsOptional() @IsString() bank_reference?: string; @IsOptional() @IsString() payer_name?: string; @IsOptional() attachment?: unknown[]; @IsOptional() @IsString() remark?: string; }
class AllocationDto { @IsUUID() receivable_source_id!: string; @IsString() amount!: string; }
class PostPaymentDto { @IsArray() allocations!: AllocationDto[]; }
class ReasonDto { @IsString() @MaxLength(1000) reason!: string; }
class AdjustmentDto {
  @IsOptional() @IsString() order_no?: string;
  @IsOptional() @IsUUID() customer_id?: string;
  @IsOptional() @IsUUID() receivable_source_id?: string;
  @IsIn(["refund", "red_credit", "discount", "bad_debt", "correction"]) adjustment_type!: string;
  @IsIn(["increase", "decrease"]) effect!: string;
  @IsString() amount!: string;
  @IsString() currency!: string;
  @IsString() @MaxLength(1000) reason!: string;
  @IsDateString() adjustment_date!: string;
  @IsOptional() @IsArray() attachment?: unknown[];
  @IsOptional() @IsString() @MaxLength(1000) remark?: string;
}
class ReconciliationDto {
  @IsString() order_no!: string;
  @IsDateString() period_start!: string;
  @IsDateString() period_end!: string;
  @IsString() external_balance!: string;
  @IsString() currency!: string;
  @IsOptional() @IsArray() attachment?: unknown[];
  @IsOptional() @IsString() @MaxLength(1000) remark?: string;
}
class ResolutionDto { @IsString() @MaxLength(1000) resolution_remark!: string; }
class PayableEntryDto {
  @IsIn(["raw_material_inbound", "purchase_receipt", "outsource_receipt"]) source_type!: "raw_material_inbound" | "purchase_receipt" | "outsource_receipt";
  @IsUUID() source_id!: string;
  @IsOptional() @IsString() amount?: string;
  @IsOptional() @IsString() @MaxLength(1000) amount_reason?: string;
  @IsOptional() @IsDateString() confirmation_date?: string;
  @IsOptional() @IsArray() attachment?: unknown[];
  @IsOptional() @IsString() @MaxLength(1000) remark?: string;
}
class SupplierPaymentDto {
  @IsUUID() supplier_id!: string;
  @IsOptional() @IsString() order_no?: string;
  @IsDateString() payment_date!: string;
  @IsString() amount!: string;
  @IsString() currency!: string;
  @IsString() payment_method!: string;
  @IsOptional() @IsString() bank_reference?: string;
  @IsOptional() @IsString() payee_name?: string;
  @IsOptional() @IsArray() attachment?: unknown[];
  @IsOptional() @IsString() remark?: string;
}
class SupplierAllocationDto { @IsUUID() payable_entry_id!: string; @IsString() amount!: string; @IsOptional() @IsString() remark?: string; }
class SupplierPostPaymentDto { @IsArray() allocations!: SupplierAllocationDto[]; }
class DraftFinanceUpdateDto { @IsOptional() @IsString() amount?: string; @IsOptional() @IsDateString() payment_date?: string; @IsOptional() @IsDateString() confirmation_date?: string; @IsOptional() @IsString() payment_method?: string; @IsOptional() @IsString() @MaxLength(1000) remark?: string; }
class SupplierReconciliationDto { @IsUUID() supplier_id!: string; @IsOptional() @IsString() order_no?: string; @IsOptional() @IsUUID() purchase_order_id?: string; @IsDateString() period_start!: string; @IsDateString() period_end!: string; @IsString() external_balance!: string; @IsString() currency!: string; @IsOptional() @IsArray() attachment?: unknown[]; @IsOptional() @IsString() remark?: string; }

@Controller("finance")
@UseGuards(AuthenticationGuard, ModulePermissionGuard)
@RequireModules("finance")
export class FinanceController {
  constructor(private readonly receivable: ReceivableService, private readonly payments: CustomerPaymentService, private readonly adjustments: ReceivableAdjustmentService, private readonly reconciliations: ReconciliationService, private readonly payable: SupplierPayableService, private readonly supplierPayments: SupplierPaymentService, private readonly supplierReconciliations: SupplierPayableReconciliationService) {}
  @Get("receivable-sources") async listSources(@Query("order_no") orderNo?: string, @Query("customer_id") customerId?: string, @Query("status") status?: string) { return { data: await this.receivable.list(orderNo, customerId, status), meta: {} }; }
  @Get("receivable-sources/:id") async getSource(@Param("id") id: string) { return { data: await this.receivable.get(id), meta: {} }; }
  @Post("receivable-sources/from-outbound/:outboundId") async createSource(@Param("outboundId") outboundId: string, @Body() body: SourceDto, @CurrentUser() user: CurrentUserType) { return { data: await this.receivable.createFromOutbound(outboundId, body, user), meta: {} }; }
  @Post("receivable-sources/:id/confirm") async confirmSource(@Param("id") id: string, @CurrentUser() user: CurrentUserType) { return { data: await this.receivable.confirm(id, user), meta: {} }; }
  @Patch("receivable-sources/:id") async updateReceivableSource(@Param("id") id: string, @Body() body: ReceivableDraftUpdateDto, @CurrentUser() user: CurrentUserType) { return { data: await this.receivable.updateDraft(id, body, user), meta: {} }; }
  @Post("receivable-sources/:id/cancel") async cancelSource(@Param("id") id: string, @Body() body: ReasonDto, @CurrentUser() user: CurrentUserType) { return { data: await this.receivable.cancel(id, body.reason, user), meta: {} }; }
  @Get("receivable-sources/:id/impact-preview") async impact(@Param("id") id: string) { return { data: await this.receivable.impactPreview(id), meta: {} }; }
  @Get("customer-payments") async listPayments(@Query("order_no") orderNo?: string, @Query("customer_id") customerId?: string) { return { data: await this.payments.list(orderNo, customerId), meta: {} }; }
  @Get("customer-payments/:id") async getPayment(@Param("id") id: string) { return { data: await this.payments.get(id), meta: {} }; }
  @Post("customer-payments") async createPayment(@Body() body: PaymentDto, @CurrentUser() user: CurrentUserType) { return { data: await this.payments.create(body, user), meta: {} }; }
  @Patch("customer-payments/:id") async updateCustomerPayment(@Param("id") id: string, @Body() body: DraftFinanceUpdateDto, @CurrentUser() user: CurrentUserType) { return { data: await this.payments.updateDraft(id, body, user), meta: {} }; }
  @Post("customer-payments/:id/post") async postPayment(@Param("id") id: string, @Body() body: PostPaymentDto, @CurrentUser() user: CurrentUserType) { return { data: await this.payments.post(id, body.allocations, user), meta: {} }; }
  @Post("customer-payments/:id/reverse") async reversePayment(@Param("id") id: string, @Body() body: ReasonDto, @CurrentUser() user: CurrentUserType) { return { data: await this.payments.reverse(id, body.reason, user), meta: {} }; }
  @Get("order-summary") async orderSummary(@Query("order_no") orderNo?: string) { return { data: orderNo ? await this.payments.orderSummary(orderNo) : [], meta: {} }; }
  @Get("receivable-order-summary") async receivableOrderSummary(@Query("order_no") orderNo?: string) { return { data: orderNo ? await this.receivable.orderSummary(orderNo) : [], meta: {} }; }
  @Get("receivable-adjustments") async listAdjustments(@Query("order_no") orderNo?: string, @Query("customer_id") customerId?: string, @Query("status") status?: string) { return { data: await this.adjustments.list(orderNo, customerId, status), meta: {} }; }
  @Get("receivable-adjustments/:id") async getAdjustment(@Param("id") id: string) { return { data: await this.adjustments.get(id), meta: {} }; }
  @Post("receivable-adjustments") async createAdjustment(@Body() body: AdjustmentDto, @CurrentUser() user: CurrentUserType) { return { data: await this.adjustments.create(body, user), meta: {} }; }
  @Post("receivable-adjustments/:id/post") async postAdjustment(@Param("id") id: string, @CurrentUser() user: CurrentUserType) { return { data: await this.adjustments.post(id, user), meta: {} }; }
  @Post("receivable-adjustments/:id/reverse") async reverseAdjustment(@Param("id") id: string, @Body() body: ReasonDto, @CurrentUser() user: CurrentUserType) { return { data: await this.adjustments.reverse(id, body.reason, user), meta: {} }; }
  @Get("reconciliations") async listReconciliations(@Query("order_no") orderNo?: string, @Query("customer_id") customerId?: string, @Query("status") status?: string) { return { data: await this.reconciliations.list(orderNo, customerId, status), meta: {} }; }
  @Get("reconciliations/:id") async getReconciliation(@Param("id") id: string) { return { data: await this.reconciliations.get(id), meta: {} }; }
  @Post("reconciliations") async createReconciliation(@Body() body: ReconciliationDto, @CurrentUser() user: CurrentUserType) { return { data: await this.reconciliations.create(body, user), meta: {} }; }
  @Post("reconciliations/:id/resolve") async resolveReconciliation(@Param("id") id: string, @Body() body: ResolutionDto, @CurrentUser() user: CurrentUserType) { return { data: await this.reconciliations.resolve(id, body.resolution_remark, user), meta: {} }; }
  @Get("order-close-preview") async orderClosePreview(@Query("order_no") orderNo?: string) { return { data: orderNo ? await this.reconciliations.orderClosePreview(orderNo) : [], meta: {} }; }
  @Get("payable-entries") async listPayableEntries(@Query("order_no") orderNo?: string, @Query("supplier_id") supplierId?: string, @Query("status") status?: string) { return { data: await this.payable.list(orderNo, supplierId, status), meta: {} }; }
  @Get("payable-entries/:id") async getPayableEntry(@Param("id") id: string) { return { data: await this.payable.get(id), meta: {} }; }
  @Post("payable-entries/from-source") async createPayableEntry(@Body() body: PayableEntryDto, @CurrentUser() user: CurrentUserType) { return { data: await this.payable.createFromSource(body, user), meta: {} }; }
  @Post("payable-entries/:id/confirm") async confirmPayableEntry(@Param("id") id: string, @CurrentUser() user: CurrentUserType) { return { data: await this.payable.confirm(id, user), meta: {} }; }
  @Patch("payable-entries/:id") async updatePayableEntry(@Param("id") id: string, @Body() body: DraftFinanceUpdateDto, @CurrentUser() user: CurrentUserType) { return { data: await this.payable.updateDraft(id, body, user), meta: {} }; }
  @Post("payable-entries/:id/reverse") async reversePayableEntry(@Param("id") id: string, @Body() body: ReasonDto, @CurrentUser() user: CurrentUserType) { return { data: await this.payable.reverse(id, body.reason, user), meta: {} }; }
  @Get("supplier-payments") async listSupplierPayments(@Query("order_no") orderNo?: string, @Query("supplier_id") supplierId?: string, @Query("status") status?: string) { return { data: await this.supplierPayments.list(orderNo, supplierId, status), meta: {} }; }
  @Get("supplier-payments/:id") async getSupplierPayment(@Param("id") id: string) { return { data: await this.supplierPayments.get(id), meta: {} }; }
  @Post("supplier-payments") async createSupplierPayment(@Body() body: SupplierPaymentDto, @CurrentUser() user: CurrentUserType) { return { data: await this.supplierPayments.create(body, user), meta: {} }; }
  @Patch("supplier-payments/:id") async updateSupplierPayment(@Param("id") id: string, @Body() body: DraftFinanceUpdateDto, @CurrentUser() user: CurrentUserType) { return { data: await this.supplierPayments.updateDraft(id, body, user), meta: {} }; }
  @Post("supplier-payments/:id/post") async postSupplierPayment(@Param("id") id: string, @Body() body: SupplierPostPaymentDto, @CurrentUser() user: CurrentUserType) { return { data: await this.supplierPayments.post(id, body.allocations, user), meta: {} }; }
  @Post("supplier-payments/:id/reverse") async reverseSupplierPayment(@Param("id") id: string, @Body() body: ReasonDto, @CurrentUser() user: CurrentUserType) { return { data: await this.supplierPayments.reverse(id, body.reason, user), meta: {} }; }
  @Get("payable-order-summary") async payableOrderSummary(@Query("order_no") orderNo?: string) { return { data: orderNo ? await this.supplierPayments.orderSummary(orderNo) : [], meta: {} }; }
  @Get("supplier-payable-reconciliations") async listSupplierReconciliations(@Query("supplier_id") supplierId?: string, @Query("order_no") orderNo?: string, @Query("status") status?: string) { return { data: await this.supplierReconciliations.list(supplierId, orderNo, status), meta: {} }; }
  @Get("supplier-payable-reconciliations/:id") async getSupplierReconciliation(@Param("id") id: string) { return { data: await this.supplierReconciliations.get(id), meta: {} }; }
  @Post("supplier-payable-reconciliations") async createSupplierReconciliation(@Body() body: SupplierReconciliationDto, @CurrentUser() user: CurrentUserType) { return { data: await this.supplierReconciliations.create(body, user), meta: {} }; }
  @Post("supplier-payable-reconciliations/:id/resolve") async resolveSupplierReconciliation(@Param("id") id: string, @Body() body: ResolutionDto, @CurrentUser() user: CurrentUserType) { return { data: await this.supplierReconciliations.resolve(id, body.resolution_remark, user), meta: {} }; }
}
