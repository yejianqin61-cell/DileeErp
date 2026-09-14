import { Body, Controller, Get, Param, Patch, Post, Put, Query, UseGuards } from "@nestjs/common";
import { IsArray, IsDateString, IsObject, IsOptional, IsString, IsUUID } from "class-validator";
import { CurrentUser } from "../../platform/audit/current-user.decorator";
import type { CurrentUser as CurrentUserType } from "../../platform/auth/auth.service";
import { AuthenticationGuard } from "../../platform/authorization/authentication.guard";
import { ModulePermissionGuard } from "../../platform/authorization/module-permission.guard";
import { RequireAnyModules } from "../../platform/authorization/require-any-modules.decorator";
import { BomsService } from "./boms.service";

/**
 * 并发令牌：客户端把「打开 BOM 时拿到的 updatedAt」原样回传，
 * 服务端在事务里比对，不一致就拒绝保存（乐观锁，见 boms.service.ts）。
 * 缺省时不做比对，保证老的调用方仍然可用。
 */
class BomDto { @IsOptional() @IsObject() extension_data?: Record<string, unknown>; @IsOptional() @IsUUID() form_definition_id?: string; @IsOptional() @IsDateString() expected_updated_at?: string; }
class BomItemDto {
  @IsString() material_id!: string;
  @IsOptional() @IsString() material_name?: string;
  @IsOptional() @IsString() model?: string;
  @IsOptional() @IsString() specification_model?: string;
  @IsOptional() @IsString() color?: string;
  @IsObject() material_snapshot!: Record<string, unknown>;
  @IsString() required_quantity!: string;
  @IsOptional() @IsString() production_batch_base?: string;
  @IsOptional() @IsString() base_usage?: string;
  @IsString() unit!: string;
  @IsOptional() @IsUUID() unit_id?: string;
  @IsOptional() @IsString() loss_quantity?: string;
  @IsOptional() @IsString() loss_rate?: string;
  @IsOptional() @IsObject() extension_data?: Record<string, unknown>;
}
class BomItemsDto { @IsArray() items!: BomItemDto[]; @IsOptional() @IsDateString() expected_updated_at?: string; }

/**
 * BOM 表由**采购**和**生产**两个模块共同操作：
 * 采购按 BOM 下单、生产按 BOM 建生产单并领料，两边都需要根据现场情况维护用量与明细。
 * 因此这里用 ANY(procurement, production)，而不是只锁 procurement。
 * 两个模块同时编辑时的并发控制不靠「谁最后保存谁赢」，而是乐观锁（expected_updated_at），
 * 见 boms.service.ts 的 assertNotStale。
 */
@Controller("boms")
@UseGuards(AuthenticationGuard, ModulePermissionGuard)
@RequireAnyModules("procurement", "production")
export class BomsController {
  constructor(private readonly boms: BomsService) {}
  @Get() async list(@Query("order_no") orderNo?: string) { return { data: await this.boms.list(orderNo), meta: {} }; }
  @Get(":id") async get(@Param("id") id: string) { return { data: await this.boms.get(id), meta: {} }; }
  @Post("from-sales-order/:salesOrderId") async create(@Param("salesOrderId") salesOrderId: string, @Body() body: BomDto, @CurrentUser() user: CurrentUserType) { return { data: await this.boms.createFromSalesOrder(salesOrderId, body, user), meta: {} }; }
  @Patch(":id") async update(@Param("id") id: string, @Body() body: BomDto, @CurrentUser() user: CurrentUserType) { return { data: await this.boms.update(id, body.extension_data ?? {}, user, body.expected_updated_at), meta: {} }; }
  @Put(":id/items") async replaceItems(@Param("id") id: string, @Body() body: BomItemsDto, @CurrentUser() user: CurrentUserType) { return { data: await this.boms.replaceItems(id, body.items, user, body.expected_updated_at), meta: {} }; }
}
