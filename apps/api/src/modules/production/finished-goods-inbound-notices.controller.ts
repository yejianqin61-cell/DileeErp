import { Body, Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { IsDateString, IsOptional, IsString, IsUUID, MaxLength } from "class-validator";
import { CurrentUser } from "../../platform/audit/current-user.decorator";
import type { CurrentUser as CurrentUserType } from "../../platform/auth/auth.service";
import { AuthenticationGuard } from "../../platform/authorization/authentication.guard";
import { ModulePermissionGuard } from "../../platform/authorization/module-permission.guard";
import { RequireModules } from "../../platform/authorization/require-modules.decorator";
import { FinishedGoodsInboundNoticesService } from "./finished-goods-inbound-notices.service";

class CreateInboundNoticeDto { @IsUUID() production_order_id!: string; @IsString() notice_quantity!: string; @IsDateString() notice_date!: string; @IsOptional() @IsString() @MaxLength(100) batch_no?: string; @IsOptional() @IsString() @MaxLength(1000) remark?: string; @IsOptional() @IsString() idempotency_key?: string; }
class CancelInboundNoticeDto { @IsString() @MaxLength(1000) reason!: string; }

/**
 * 生产侧：发/查/取消成品入库通知，并暴露生产单的成品存量汇总。
 * 权限：production。仓库侧只需要只读视图（见 WarehouseFinishedGoodsInboundNoticeController），
 * 因此这里不能放宽成 ANY，避免仓库误改生产事实。
 */
@Controller()
@UseGuards(AuthenticationGuard, ModulePermissionGuard)
@RequireModules("production")
export class FinishedGoodsInboundNoticesController {
  constructor(private readonly notices: FinishedGoodsInboundNoticesService) {}
  @Get("production/finished-goods-inbound-notices") async list(@Query() query: { order_no?: string; production_order_id?: string; status?: string }) { return { data: await this.notices.list(query), meta: {} }; }
  @Get("production/finished-goods-inbound-notices/:id") async get(@Param("id") id: string) { return { data: await this.notices.get(id), meta: {} }; }
  @Post("production/finished-goods-inbound-notices") async create(@Body() body: CreateInboundNoticeDto, @CurrentUser() user: CurrentUserType) { return { data: await this.notices.create(body, user), meta: {} }; }
  @Post("production/finished-goods-inbound-notices/:id/cancel") async cancel(@Param("id") id: string, @Body() body: CancelInboundNoticeDto, @CurrentUser() user: CurrentUserType) { return { data: await this.notices.cancel(id, body.reason, user), meta: {} }; }
  /** 生产单成品存量/入库进度汇总（生产单详情与工作台共用同一口径）。 */
  @Get("production/orders/:id/finished-goods-summary") async orderSummary(@Param("id") id: string) { return { data: await this.notices.orderSummary(id), meta: {} }; }
}

/** 仓库侧：只读查看入库通知（成品存量管理页要按通知核对待送检/在途入库）。 */
@Controller()
@UseGuards(AuthenticationGuard, ModulePermissionGuard)
@RequireModules("warehouse")
export class WarehouseFinishedGoodsInboundNoticeController {
  constructor(private readonly notices: FinishedGoodsInboundNoticesService) {}
  @Get("finished-goods/inbound-notices") async list(@Query() query: { order_no?: string; production_order_id?: string; status?: string }) { return { data: await this.notices.list(query), meta: {} }; }
  @Get("finished-goods/inbound-notices/:id") async get(@Param("id") id: string) { return { data: await this.notices.get(id), meta: {} }; }
}
