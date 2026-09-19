import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { IsArray, IsBoolean, IsDateString, IsOptional, IsObject, IsString, IsUUID, MaxLength, ValidateNested } from "class-validator";
import { Type } from "class-transformer";
import { CurrentUser } from "../../platform/audit/current-user.decorator";
import type { CurrentUser as CurrentUserType } from "../../platform/auth/auth.service";
import { AuthenticationGuard } from "../../platform/authorization/authentication.guard";
import { ModulePermissionGuard } from "../../platform/authorization/module-permission.guard";
import { RequireModules } from "../../platform/authorization/require-modules.decorator";
import { PurchaseOrdersService } from "./purchase-orders.service";

class ItemDto { @IsUUID() material_id!: string; @IsUUID() unit_id!: string; @IsOptional() @IsUUID() bom_item_id?: string; @IsUUID() supplier_id!: string; @IsOptional() @IsDateString() expected_date?: string; @IsOptional() @IsString() model?: string; @IsString() quantity!: string; @IsString() unit_price!: string; @IsOptional() @IsString() tax_rate?: string; @IsOptional() @IsString() extra_fee?: string; @IsOptional() @IsObject() extension_data?: Record<string, unknown>; }
class PurchaseOrderDto { @IsString() order_no!: string; @IsOptional() @IsUUID() bom_id?: string; @IsOptional() bom_version?: number; @IsOptional() @IsUUID() supplier_id?: string; @IsOptional() @IsDateString() purchase_date?: string; @IsOptional() @IsDateString() expected_date?: string; @IsOptional() @IsString() currency?: string; @IsOptional() @IsString() remark?: string; @IsOptional() @IsObject() extension_data?: Record<string, unknown>; @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => ItemDto) items?: ItemDto[]; }
class ReceiptDto { @IsString() quantity!: string; @IsDateString() received_date!: string; @IsOptional() @IsString() reference_no?: string; @IsOptional() @IsString() remark?: string; @IsOptional() @IsString() idempotency_key?: string; @IsOptional() @IsString() over_receipt_reason?: string; }
// 按供应商拆分下单：groups 里每一组生成一张采购单（同供应商的物料合在一张单上）。
class SplitGroupDto { @IsUUID() supplier_id!: string; @IsOptional() @IsString() @MaxLength(10) currency?: string; @IsOptional() @IsDateString() expected_date?: string; @IsOptional() @IsString() @MaxLength(1000) remark?: string; @IsArray() @ValidateNested({ each: true }) @Type(() => ItemDto) items!: ItemDto[]; }
class PurchaseOrderSplitDto { @IsString() order_no!: string; @IsOptional() @IsUUID() bom_id?: string; @IsOptional() @IsDateString() purchase_date?: string; @IsOptional() @IsString() @MaxLength(10) currency?: string; @IsOptional() @IsString() @MaxLength(1000) remark?: string; @IsOptional() @IsBoolean() place_order?: boolean; @IsOptional() @IsObject() extension_data?: Record<string, unknown>; @IsArray() @ValidateNested({ each: true }) @Type(() => SplitGroupDto) groups!: SplitGroupDto[]; }
class ReceiptUpdateDto { @IsString() quantity!: string; @IsOptional() @IsString() reference_no?: string; @IsOptional() @IsString() remark?: string; @IsOptional() @IsString() over_receipt_reason?: string; @IsString() reason!: string; }
class ReasonDto { @IsString() @MaxLength(1000) reason!: string; }

/**
 * 采购单打印表上的字段（用户 2026-09-16：「系统中采购单也要支持对这些字段进行填写和设置」）。
 *
 * 全是可选的：只传要改的那几格。`expected_date` / `remark` 传 `null` 表示清空这一格；
 * 其余文本传空串同样按清除处理（服务层 optionalText）。付款方式**不做枚举校验**：
 * 业务给的是「月结30天 / 月结60天 / 当月付款」三项，存文本则以后加「月结90天」不用改后端。
 */
class PrintFieldsDto {
  @IsOptional() @IsString() @MaxLength(50) payment_terms?: string | null;
  @IsOptional() @IsString() @MaxLength(1000) delivery_terms?: string | null;
  @IsOptional() @IsString() @MaxLength(300) delivery_address?: string | null;
  @IsOptional() @IsDateString() expected_date?: string | null;
  @IsOptional() @IsString() @MaxLength(1000) remark?: string | null;
  @IsOptional() @IsString() @MaxLength(1000) supplier_reply?: string | null;
  @IsOptional() @IsString() @MaxLength(200) supplier_signed?: string | null;
  @IsOptional() @IsString() @MaxLength(200) supervisor_signature?: string | null;
}

@Controller("purchase-orders")
@UseGuards(AuthenticationGuard, ModulePermissionGuard)
@RequireModules("procurement")
export class PurchaseOrdersController {
  constructor(private readonly orders: PurchaseOrdersService) {}
  @Get() async list(@Query("order_no") orderNo?: string) { return { data: await this.orders.list(orderNo), meta: {} }; }
  @Post() async create(@Body() body: PurchaseOrderDto, @CurrentUser() user: CurrentUserType) { return { data: await this.orders.create(body, user), meta: {} }; }
  // 必须声明在 @Post(":id/...") 之前语义上更清晰；本例路径为单段 "split"，与 ":id" 的 POST 不冲突。
  @Post("split") async split(@Body() body: PurchaseOrderSplitDto, @CurrentUser() user: CurrentUserType) { return { data: await this.orders.createSplit(body, user), meta: {} }; }
  @Patch(":id") async update(@Param("id") id: string, @Body() body: PurchaseOrderDto, @CurrentUser() user: CurrentUserType) { return { data: await this.orders.update(id, body, user), meta: {} }; }
  // 打印信息（付款方式/交期条款/交货地址/交货日期/备注/回签三格）：**任何未取消的状态**都能改，
  // 因为厂家回签本来就是下单之后才发生的；它不碰明细与金额，所以不走「草稿才可整体编辑」那道门。
  @Patch(":id/print-fields") async updatePrintFields(@Param("id") id: string, @Body() body: PrintFieldsDto, @CurrentUser() user: CurrentUserType) { return { data: await this.orders.updatePrintFields(id, body, user), meta: {} }; }
  @Get(":id") async get(@Param("id") id: string) { return { data: await this.orders.get(id), meta: {} }; }
  @Get(":id/impact-preview") async impact(@Param("id") id: string) { return { data: await this.orders.impactPreview(id), meta: {} }; }
  @Post(":id/order") async order(@Param("id") id: string, @CurrentUser() user: CurrentUserType) { return { data: await this.orders.order(id, user), meta: {} }; }
  @Post(":id/revert-draft") async revertDraft(@Param("id") id: string, @Body() body: ReasonDto, @CurrentUser() user: CurrentUserType) { return { data: await this.orders.revertToDraft(id, body.reason, user), meta: {} }; }
  @Post(":id/cancel") async cancel(@Param("id") id: string, @CurrentUser() user: CurrentUserType) { return { data: await this.orders.cancel(id, user), meta: {} }; }
  @Post(":id/revert-arrivals") async revertArrivals(@Param("id") id: string, @Body() body: ReasonDto, @CurrentUser() user: CurrentUserType) { return { data: await this.orders.revertArrivals(id, body.reason, user), meta: {} }; }
  @Post(":id/close-arrivals") async closeArrivals(@Param("id") id: string, @CurrentUser() user: CurrentUserType) { return { data: await this.orders.closeArrivalsV2(id, user), meta: {} }; }
  @Post(":id/items/:itemId/receipts") async receipt(@Param("id") id: string, @Param("itemId") itemId: string, @Body() body: ReceiptDto, @CurrentUser() user: CurrentUserType) { return { data: await this.orders.receiptV2(id, itemId, body, user), meta: {} }; }
  @Patch("receipts/:receiptId") async updateReceipt(@Param("receiptId") receiptId: string, @Body() body: ReceiptUpdateDto, @CurrentUser() user: CurrentUserType) { return { data: await this.orders.updateReceiptV2(receiptId, body, user), meta: {} }; }
  @Post("receipts/:receiptId/cancel") async cancelReceipt(@Param("receiptId") receiptId: string, @Body("reason") reason: string, @CurrentUser() user: CurrentUserType) { return { data: await this.orders.cancelReceiptV2(receiptId, reason, user), meta: {} }; }
}
