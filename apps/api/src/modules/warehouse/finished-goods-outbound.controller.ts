import { Body, Controller, Get, Param, Patch, Post, Query, Res, UseGuards } from "@nestjs/common";
import { IsDateString, IsIn, IsOptional, IsString, IsUUID, MaxLength } from "class-validator";
import type { Response } from "express";
import { CurrentUser } from "../../platform/audit/current-user.decorator";
import type { CurrentUser as CurrentUserType } from "../../platform/auth/auth.service";
import { AuthenticationGuard } from "../../platform/authorization/authentication.guard";
import { ModulePermissionGuard } from "../../platform/authorization/module-permission.guard";
import { RequireModules } from "../../platform/authorization/require-modules.decorator";
import { FinishedGoodsOutboundService } from "./finished-goods-outbound.service";
import { FinishedGoodsOutboundExportService } from "./finished-goods-outbound-export.service";

class OutboundDto { @IsUUID() sales_order_id!: string; @IsUUID() production_order_id!: string; @IsString() quantity!: string; @IsOptional() @IsString() @MaxLength(200) idempotency_key?: string; @IsOptional() @IsString() @MaxLength(1000) risk_reason?: string; @IsOptional() @IsString() @MaxLength(1000) remark?: string; @IsOptional() attachment?: unknown[]; }
class ShippingDto { @IsOptional() @IsDateString() shipment_date?: string; @IsOptional() @IsString() carrier?: string; @IsOptional() @IsString() tracking_no?: string; @IsOptional() @IsString() packing_list_no?: string; @IsOptional() @IsString() invoice_no?: string; @IsOptional() attachment?: unknown[]; }
class SignDto { @IsDateString() signed_at!: string; @IsOptional() @IsString() @MaxLength(500) signature_reference?: string; @IsOptional() attachment?: unknown[]; }
class ReturnDto { @IsUUID() sales_order_id!: string; @IsUUID() production_order_id!: string; @IsString() quantity!: string; @IsDateString() return_date!: string; @IsIn(["finished_goods", "defective_goods"]) destination!: "finished_goods" | "defective_goods"; @IsString() @MaxLength(1000) reason!: string; @IsOptional() @IsString() @MaxLength(200) idempotency_key?: string; @IsOptional() @IsString() @MaxLength(1000) remark?: string; @IsOptional() attachment?: unknown[]; }
class ReasonDto { @IsString() @MaxLength(1000) reason!: string; }
// 按出库通知建出库单：quantity 可选（分批出库）；不传就出完剩余量。
// idempotency_key 由仓库页面随请求带来：同一次提交的网络重试必须命中同一张出库单，
// 否则每次重试都会再建一张草稿（服务端只用随机后缀兜底，等于没有幂等）。
// 上限 150：落库键是 `notice:<36 位通知 id>:<key>`（最长 44 + 150 = 194 ≤ VarChar(200)），
// 不加限会在超长时落到 P2000 → 500。
export class NoticeOutboundDto { @IsOptional() @IsString() quantity?: string; @IsOptional() @IsString() @MaxLength(150) idempotency_key?: string; }

@Controller("finished-goods")
@UseGuards(AuthenticationGuard, ModulePermissionGuard)
@RequireModules("warehouse")
export class FinishedGoodsOutboundController {
  constructor(private readonly outbound: FinishedGoodsOutboundService, private readonly exports: FinishedGoodsOutboundExportService) {}
  // 出库通知：销售在销售页「通知仓库出库」后，仓库在这里看到，并可按剩余量分批生成出库单。
  @Get("outbound-notices") async listOutboundNotices(@Query("order_no") orderNo?: string, @Query("status") status?: string) { return { data: await this.outbound.listOutboundNotices(orderNo, status), meta: {} }; }
  @Post("outbound-notices/:id/create-outbound") async createOutboundFromNotice(@Param("id") id: string, @Body() body: NoticeOutboundDto, @CurrentUser() user: CurrentUserType) { return { data: await this.outbound.createOutboundFromNotice(id, body, user), meta: {} }; }
  @Get("outbounds") async listOutbounds(@Query("order_no") orderNo?: string) { return { data: await this.outbound.listOutbounds(orderNo), meta: {} }; }
  /**
   * 成品出库单的**打印件数据**（用户 2026-11-02：「出库单要支持导出 excel，支持打印」）。
   *
   * 与下面的 xlsx 导出共用 `FinishedGoodsOutboundExportService.buildDocument`：
   * 屏幕上的打印视图与导出的 Excel 必须是同一份数据，否则「纸上有、屏幕上少一行」只有仓库对货时才会发现。
   *
   * 路径两段（`outbounds/:id/slip-document`），不会被单段的 `@Get("outbounds/:id")` 吃掉；
   * 模块权限沿用类级的 `warehouse`——打这张单的人是仓库。
   */
  @Get("outbounds/:id/slip-document") async outboundSlipDocument(@Param("id") id: string) { return { data: await this.exports.buildDocument(id), meta: {} }; }
  /** 成品出库单导出 xlsx：A4 竖版、与打印件逐行同一版式（可直接打印这张 xlsx）。 */
  @Get("outbounds/:id/export.xlsx") async outboundExport(@Param("id") id: string, @Res() response: Response) {
    const { buffer, outboundNo } = await this.exports.exportDocument(id);
    response.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    response.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(`迪礼ERP-成品出库单-${outboundNo}.xlsx`)}`);
    response.setHeader("Cache-Control", "no-store");
    return response.send(buffer);
  }
  @Get("outbounds/:id") async getOutbound(@Param("id") id: string) { return { data: await this.outbound.getOutbound(id), meta: {} }; }
  @Post("outbounds") async createOutbound(@Body() body: OutboundDto, @CurrentUser() user: CurrentUserType) { return { data: await this.outbound.createOutbound(body, user), meta: {} }; }
  @Post("outbounds/:id/post") async postOutbound(@Param("id") id: string, @CurrentUser() user: CurrentUserType) { return { data: await this.outbound.postOutbound(id, user), meta: {} }; }
  // 草稿出库单取消：库存变化导致过账失败时必须有出路，否则通知+出库单会永久卡住。
  @Post("outbounds/:id/cancel") async cancelOutbound(@Param("id") id: string, @Body() body: ReasonDto, @CurrentUser() user: CurrentUserType) { return { data: await this.outbound.cancelOutbound(id, body.reason, user), meta: {} }; }
  @Patch("outbounds/:id/shipping") async shipping(@Param("id") id: string, @Body() body: ShippingDto, @CurrentUser() user: CurrentUserType) { return { data: await this.outbound.updateShipping(id, body, user), meta: {} }; }
  @Post("outbounds/:id/sign") async sign(@Param("id") id: string, @Body() body: SignDto, @CurrentUser() user: CurrentUserType) { return { data: await this.outbound.signOutbound(id, body, user), meta: {} }; }
  @Post("outbounds/:id/reverse") async reverseOutbound(@Param("id") id: string, @Body() body: ReasonDto, @CurrentUser() user: CurrentUserType) { return { data: await this.outbound.reverseOutbound(id, body.reason, user), meta: {} }; }
  @Get("customer-returns") async listReturns(@Query("order_no") orderNo?: string) { return { data: await this.outbound.listReturns(orderNo), meta: {} }; }
  @Get("customer-returns/:id") async getReturn(@Param("id") id: string) { return { data: await this.outbound.getReturn(id), meta: {} }; }
  @Post("customer-returns") async createReturn(@Body() body: ReturnDto, @CurrentUser() user: CurrentUserType) { return { data: await this.outbound.createReturn(body, user), meta: {} }; }
  @Post("customer-returns/:id/post") async postReturn(@Param("id") id: string, @CurrentUser() user: CurrentUserType) { return { data: await this.outbound.postReturn(id, user), meta: {} }; }
  @Post("customer-returns/:id/reverse") async reverseReturn(@Param("id") id: string, @Body() body: ReasonDto, @CurrentUser() user: CurrentUserType) { return { data: await this.outbound.reverseReturn(id, body.reason, user), meta: {} }; }
}
