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
class ReceivableDraftUpdateDto { @IsOptional() @IsString() amount?: string; @IsOptional() @IsDateString() due_date?: string; @IsOptional() @IsString() @MaxLength(1000) amount_reason?: string; @IsOptional() @IsString() currency?: string; @IsOptional() @IsString() @MaxLength(1000) remark?: string; }
class PaymentDto { @IsUUID() customer_id!: string; @IsOptional() @IsString() order_no?: string; @IsDateString() payment_date!: string; @IsString() amount!: string; @IsString() currency!: string; @IsString() payment_method!: string; @IsOptional() @IsString() bank_reference?: string; @IsOptional() @IsString() payer_name?: string; @IsOptional() @IsUUID() bank_id?: string; @IsOptional() @IsUUID() cash_flow_item_id?: string; @IsOptional() attachment?: unknown[]; @IsOptional() @IsString() @MaxLength(200) idempotency_key?: string; @IsOptional() @IsString() remark?: string; }
class AllocationDto { @IsUUID() receivable_source_id!: string; @IsString() amount!: string; }
/**
 * 过账请求。
 *
 * `cash_flow_item_id`：**人工选定**的收支项目（可选，留空则按来源自动归类）。
 * 之所以放在过账而不是建单：收支流水只在过账那一刻产生，草稿阶段选项目没有落点。
 */
class PostPaymentDto { @IsArray() allocations!: AllocationDto[]; @IsOptional() @IsUUID() cash_flow_item_id?: string; }
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
/**
 * 应收对账：主键是「客户 + 期间」。
 *
 * `customer_id` 与 `order_no` 至少给一个：给 order_no 时客户由销售单反查（兼容按订单建对账的旧调用方）；
 * 两个都给时必须指向同一客户，否则 RECONCILIATION_CUSTOMER_MISMATCH。
 */
class ReconciliationDto {
  @IsOptional() @IsString() order_no?: string;
  @IsOptional() @IsUUID() customer_id?: string;
  @IsDateString() period_start!: string;
  @IsDateString() period_end!: string;
  @IsString() external_balance!: string;
  @IsString() currency!: string;
  @IsOptional() @IsUUID() bank_id?: string;
  /** 收支项目（收支管理 → 收支项目）：确认应收时按它写入收支流水。 */
  @IsOptional() @IsUUID() cash_flow_item_id?: string;
  @IsOptional() @IsArray() attachment?: unknown[];
  @IsOptional() @IsString() @MaxLength(1000) remark?: string;
}
class ResolutionDto { @IsString() @MaxLength(1000) resolution_remark!: string; }
class SupplierPaymentDto {
  @IsUUID() supplier_id!: string;
  @IsOptional() @IsString() order_no?: string;
  @IsDateString() payment_date!: string;
  @IsString() amount!: string;
  @IsString() currency!: string;
  @IsString() payment_method!: string;
  @IsOptional() @IsString() bank_reference?: string;
  @IsOptional() @IsString() payee_name?: string;
  @IsOptional() @IsUUID() bank_id?: string;
  @IsOptional() @IsUUID() cash_flow_item_id?: string;
  @IsOptional() @IsArray() attachment?: unknown[];
  @IsOptional() @IsString() @MaxLength(200) idempotency_key?: string;
  @IsOptional() @IsString() remark?: string;
}
class SupplierAllocationDto { @IsUUID() payable_entry_id!: string; @IsString() amount!: string; @IsOptional() @IsString() remark?: string; }
class SupplierPostPaymentDto { @IsArray() allocations!: SupplierAllocationDto[]; @IsOptional() @IsUUID() cash_flow_item_id?: string; }
/**
 * 草稿类单据（收款 / 付款 / 应付）的编辑入参。
 *
 * `currency` 允许改：草稿还没发生核销，改币种是安全的业务动作（「都要支持选择币种、编辑币种」）。
 * `bank_id` 允许传 null / 空串表示**清空**银行，传 undefined 表示不改（银行是可选字段，选错了要能去掉）。
 */
class DraftFinanceUpdateDto { @IsOptional() @IsString() amount?: string; @IsOptional() @IsDateString() payment_date?: string; @IsOptional() @IsDateString() confirmation_date?: string; @IsOptional() @IsString() payment_method?: string; @IsOptional() @IsString() currency?: string; @IsOptional() @IsUUID() bank_id?: string | null; @IsOptional() @IsUUID() cash_flow_item_id?: string | null; @IsOptional() @IsString() @MaxLength(1000) remark?: string; }
class SupplierReconciliationDto { @IsUUID() supplier_id!: string; @IsOptional() @IsString() order_no?: string; @IsOptional() @IsUUID() purchase_order_id?: string; @IsDateString() period_start!: string; @IsDateString() period_end!: string; @IsString() external_balance!: string; @IsString() currency!: string; @IsOptional() @IsUUID() bank_id?: string; @IsOptional() @IsUUID() cash_flow_item_id?: string; @IsOptional() @IsArray() attachment?: unknown[]; @IsOptional() @IsString() remark?: string; }

/**
 * 「一键确认应收 / 应付」的入参。
 *
 * 允许在确认时**补/改**银行账户与收支项目：确认这一步才是钱真正进出的时刻，而历史对账单
 * （或建单时没填的单子）可能没有银行/项目。给了就覆盖并**回写到对账单上**（后续查看与实际一致），
 * 没给就用单子上已有的。两者都缺时仍然确认成功，只是这笔流水不进任何账户余额 —— 不静默，
 * 响应里带 `bank_missing` 让界面明确提示。
 */
class ConfirmReconciliationDto { @IsOptional() @IsUUID() bank_id?: string | null; @IsOptional() @IsUUID() cash_flow_item_id?: string | null; }

/**
 * 逐条确认应收 / 应付的入参。
 *
 * 与对账确认同一套字段：确认这一步才是钱真正进出的时刻，所以要能指定**入账/支付银行**与**收支项目**。
 * 两者都可空（历史数据、以及「先把应收确认了、银行回头再定」），此时响应带 `bank_missing`，
 * 界面必须明确提示「这笔已记入收支流水，但不体现在任何银行余额里」。
 */
class ConfirmSourceDto {
  /** 确认应收（逐条）：批量按订单确认时 `order_no` 必填。 */
  @IsOptional() @IsString() order_no?: string;
  @IsOptional() @IsUUID() bank_id?: string | null;
  @IsOptional() @IsUUID() cash_flow_item_id?: string | null;
}

class SupplierOtherPayableDto {
  @IsUUID() supplier_id!: string;
  @IsString() amount!: string;
  @IsString() currency!: string;
  @IsString() @MaxLength(200) description!: string;
  @IsOptional() @IsDateString() confirmation_date?: string;
  @IsOptional() @IsArray() attachment?: unknown[];
  @IsOptional() @IsString() @MaxLength(1000) remark?: string;
}

@Controller("finance")
@UseGuards(AuthenticationGuard, ModulePermissionGuard)
@RequireModules("finance")
export class FinanceController {
  constructor(private readonly receivable: ReceivableService, private readonly payments: CustomerPaymentService, private readonly adjustments: ReceivableAdjustmentService, private readonly reconciliations: ReconciliationService, private readonly payable: SupplierPayableService, private readonly supplierPayments: SupplierPaymentService, private readonly supplierReconciliations: SupplierPayableReconciliationService) {}
  @Get("receivable-sources") async listSources(@Query("order_no") orderNo?: string, @Query("customer_id") customerId?: string, @Query("status") status?: string) { return { data: await this.receivable.list(orderNo, customerId, status), meta: {} }; }
  @Get("receivable-sources/:id") async getSource(@Param("id") id: string) { return { data: await this.receivable.get(id), meta: {} }; }
  @Post("receivable-sources/from-outbound/:outboundId") async createSource(@Param("outboundId") outboundId: string, @Body() body: SourceDto, @CurrentUser() user: CurrentUserType) { return { data: await this.receivable.createFromOutbound(outboundId, body, user), meta: {} }; }
  @Post("receivable-sources/:id/confirm") async confirmSource(@Param("id") id: string, @Body() body: ConfirmSourceDto, @CurrentUser() user: CurrentUserType) { return { data: await this.receivable.confirm(id, user, body ?? {}), meta: {} }; }
  @Post("receivable-sources/batch-confirm-by-order") async batchConfirmByOrder(@Body() body: ConfirmSourceDto, @CurrentUser() user: CurrentUserType) { return { data: await this.receivable.batchConfirmByOrder(body.order_no ?? "", user, body), meta: {} }; }
  @Patch("receivable-sources/:id") async updateReceivableSource(@Param("id") id: string, @Body() body: ReceivableDraftUpdateDto, @CurrentUser() user: CurrentUserType) { return { data: await this.receivable.updateDraft(id, body, user), meta: {} }; }
  @Post("receivable-sources/:id/reopen") async reopenReceivableSource(@Param("id") id: string, @Body() body: ReasonDto, @CurrentUser() user: CurrentUserType) { return { data: await this.receivable.reopen(id, body.reason, user), meta: {} }; }
  @Post("receivable-sources/:id/cancel") async cancelSource(@Param("id") id: string, @Body() body: ReasonDto, @CurrentUser() user: CurrentUserType) { return { data: await this.receivable.cancel(id, body.reason, user), meta: {} }; }
  @Get("receivable-sources/:id/impact-preview") async impact(@Param("id") id: string) { return { data: await this.receivable.impactPreview(id), meta: {} }; }
  @Get("customer-payments") async listPayments(@Query("order_no") orderNo?: string, @Query("customer_id") customerId?: string) { return { data: await this.payments.list(orderNo, customerId), meta: {} }; }
  @Get("customer-payments/:id") async getPayment(@Param("id") id: string) { return { data: await this.payments.get(id), meta: {} }; }
  @Post("customer-payments") async createPayment(@Body() body: PaymentDto, @CurrentUser() user: CurrentUserType) { return { data: await this.payments.create(body, user), meta: {} }; }
  @Patch("customer-payments/:id") async updateCustomerPayment(@Param("id") id: string, @Body() body: DraftFinanceUpdateDto, @CurrentUser() user: CurrentUserType) { return { data: await this.payments.updateDraft(id, body, user), meta: {} }; }
  @Post("customer-payments/:id/post") async postPayment(@Param("id") id: string, @Body() body: PostPaymentDto, @CurrentUser() user: CurrentUserType) { return { data: await this.payments.post(id, body.allocations, user, body.cash_flow_item_id), meta: {} }; }
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
  // 「先对账、再确认应收」：对账对平（或差异已处理）后，一次性确认该对账范围内的草稿应收。
  @Post("reconciliations/:id/confirm-receivables") async confirmReconciliationReceivables(@Param("id") id: string, @Body() body: ConfirmReconciliationDto, @CurrentUser() user: CurrentUserType) { return { data: await this.reconciliations.confirmReceivables(id, user, body ?? {}), meta: {} }; }
  @Get("order-close-preview") async orderClosePreview(@Query("order_no") orderNo?: string) { return { data: orderNo ? await this.reconciliations.orderClosePreview(orderNo) : [], meta: {} }; }
  // 采购通知财务付款需要的两个接口（GET payable-entries / POST payable-entries/from-source）
  // 已移到 PayableNotificationController：类级 @RequireModules("finance") 会先于方法级 ANY 校验，
  // 挂在这里的方法级放宽无效。其余财务接口仍然只对 finance 模块开放。
  @Get("payable-entries/:id") async getPayableEntry(@Param("id") id: string) { return { data: await this.payable.get(id), meta: {} }; }
  @Post("payable-entries/other") async createOtherPayableEntry(@Body() body: SupplierOtherPayableDto, @CurrentUser() user: CurrentUserType) { return { data: await this.payable.createOther(body, user), meta: {} }; }
  @Post("payable-entries/:id/confirm") async confirmPayableEntry(@Param("id") id: string, @Body() body: ConfirmSourceDto, @CurrentUser() user: CurrentUserType) { return { data: await this.payable.confirm(id, user, body ?? {}), meta: {} }; }
  @Patch("payable-entries/:id") async updatePayableEntry(@Param("id") id: string, @Body() body: DraftFinanceUpdateDto, @CurrentUser() user: CurrentUserType) { return { data: await this.payable.updateDraft(id, body, user), meta: {} }; }
  @Post("payable-entries/:id/reopen") async reopenPayableEntry(@Param("id") id: string, @Body() body: ReasonDto, @CurrentUser() user: CurrentUserType) { return { data: await this.payable.reopen(id, body.reason, user), meta: {} }; }
  @Post("payable-entries/:id/reverse") async reversePayableEntry(@Param("id") id: string, @Body() body: ReasonDto, @CurrentUser() user: CurrentUserType) { return { data: await this.payable.reverse(id, body.reason, user), meta: {} }; }
  @Get("supplier-payments") async listSupplierPayments(@Query("order_no") orderNo?: string, @Query("supplier_id") supplierId?: string, @Query("status") status?: string) { return { data: await this.supplierPayments.list(orderNo, supplierId, status), meta: {} }; }
  @Get("supplier-payments/:id") async getSupplierPayment(@Param("id") id: string) { return { data: await this.supplierPayments.get(id), meta: {} }; }
  @Post("supplier-payments") async createSupplierPayment(@Body() body: SupplierPaymentDto, @CurrentUser() user: CurrentUserType) { return { data: await this.supplierPayments.create(body, user), meta: {} }; }
  @Patch("supplier-payments/:id") async updateSupplierPayment(@Param("id") id: string, @Body() body: DraftFinanceUpdateDto, @CurrentUser() user: CurrentUserType) { return { data: await this.supplierPayments.updateDraft(id, body, user), meta: {} }; }
  @Post("supplier-payments/:id/post") async postSupplierPayment(@Param("id") id: string, @Body() body: SupplierPostPaymentDto, @CurrentUser() user: CurrentUserType) { return { data: await this.supplierPayments.post(id, body.allocations, user, body.cash_flow_item_id), meta: {} }; }
  @Post("supplier-payments/:id/reverse") async reverseSupplierPayment(@Param("id") id: string, @Body() body: ReasonDto, @CurrentUser() user: CurrentUserType) { return { data: await this.supplierPayments.reverse(id, body.reason, user), meta: {} }; }
  @Get("payable-order-summary") async payableOrderSummary(@Query("order_no") orderNo?: string) { return { data: orderNo ? await this.supplierPayments.orderSummary(orderNo) : [], meta: {} }; }
  @Get("supplier-payable-reconciliations") async listSupplierReconciliations(@Query("supplier_id") supplierId?: string, @Query("order_no") orderNo?: string, @Query("status") status?: string) { return { data: await this.supplierReconciliations.list(supplierId, orderNo, status), meta: {} }; }
  @Get("supplier-payable-reconciliations/:id") async getSupplierReconciliation(@Param("id") id: string) { return { data: await this.supplierReconciliations.get(id), meta: {} }; }
  @Post("supplier-payable-reconciliations") async createSupplierReconciliation(@Body() body: SupplierReconciliationDto, @CurrentUser() user: CurrentUserType) { return { data: await this.supplierReconciliations.create(body, user), meta: {} }; }
  @Post("supplier-payable-reconciliations/:id/resolve") async resolveSupplierReconciliation(@Param("id") id: string, @Body() body: ResolutionDto, @CurrentUser() user: CurrentUserType) { return { data: await this.supplierReconciliations.resolve(id, body.resolution_remark, user), meta: {} }; }
  // 「先对账、再确认应付」：对账对平（或差异已处理）后，一次性确认该对账范围内的草稿应付。
  @Post("supplier-payable-reconciliations/:id/confirm-payables") async confirmReconciliationPayables(@Param("id") id: string, @Body() body: ConfirmReconciliationDto, @CurrentUser() user: CurrentUserType) { return { data: await this.supplierReconciliations.confirmPayables(id, user, body ?? {}), meta: {} }; }
}