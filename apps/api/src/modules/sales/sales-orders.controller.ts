import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { IsDateString, IsDecimal, IsObject, IsOptional, IsString, MaxLength } from "class-validator";
import { CurrentUser } from "../../platform/audit/current-user.decorator";
import type { CurrentUser as CurrentUserType } from "../../platform/auth/auth.service";
import { AuthenticationGuard } from "../../platform/authorization/authentication.guard";
import { ModulePermissionGuard } from "../../platform/authorization/module-permission.guard";
import { RequireModules } from "../../platform/authorization/require-modules.decorator";
import { PaginationQueryDto } from "../../platform/http/pagination-query.dto";
import { EmptyStringToUndefined } from "../../platform/http/empty-string-to-undefined.decorator";
import { SalesOrdersService } from "./sales-orders.service";

// 导出以便契约测试直接用真实 ValidationPipe 校验前端请求体。
export class SalesOrderDto {
  @IsString() @MaxLength(100) order_no!: string;
  @IsString() customer_id!: string;
  @IsOptional() @IsString() contact_id?: string;
  @IsOptional() @IsString() @MaxLength(100) customer_po_no?: string;
  @IsOptional() @IsString() @MaxLength(100) external_contract_no?: string;
  @IsDateString() order_date!: string;
  @IsString() @MaxLength(200) product_name!: string;
  @IsOptional() @IsString() @MaxLength(1000) product_spec?: string;
  @IsDecimal() quantity!: string;
  @IsString() @MaxLength(30) unit!: string;
  @IsOptional() @IsDateString() delivery_date?: string;
  @IsString() @MaxLength(10) currency!: string;
  // 单价/金额/税率留空时前端会提交 ""：先归一成 undefined，否则 @IsOptional() 不跳过空串 → 400。
  @IsOptional() @EmptyStringToUndefined() @IsDecimal() unit_price?: string;
  @IsOptional() @EmptyStringToUndefined() @IsDecimal() total_amount?: string;
  @IsOptional() @EmptyStringToUndefined() @IsDecimal() tax_rate?: string;
  @IsOptional() @IsObject() extension_data?: Record<string, unknown>;
}
export class UpdateSalesOrderDto {
  @IsOptional() @IsString() contact_id?: string;
  @IsOptional() @IsString() @MaxLength(100) customer_po_no?: string;
  @IsOptional() @IsString() @MaxLength(100) external_contract_no?: string;
  @IsOptional() @IsDateString() order_date?: string;
  @IsOptional() @IsString() @MaxLength(200) product_name?: string;
  @IsOptional() @IsString() @MaxLength(1000) product_spec?: string;
  @IsOptional() @IsDecimal() quantity?: string;
  @IsOptional() @IsString() @MaxLength(30) unit?: string;
  @IsOptional() @IsDateString() delivery_date?: string;
  @IsOptional() @IsString() @MaxLength(10) currency?: string;
  @IsOptional() @EmptyStringToUndefined() @IsDecimal() unit_price?: string;
  @IsOptional() @EmptyStringToUndefined() @IsDecimal() total_amount?: string;
  @IsOptional() @EmptyStringToUndefined() @IsDecimal() tax_rate?: string;
  @IsOptional() @IsObject() extension_data?: Record<string, unknown>;
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}
class SalesOrderQueryDto extends PaginationQueryDto {
  @IsOptional() @IsString() status?: string;
}
class ReasonDto { @IsString() @MaxLength(1000) reason!: string; }

@Controller("sales-orders")
@UseGuards(AuthenticationGuard, ModulePermissionGuard)
@RequireModules("sales")
export class SalesOrdersController {
  constructor(private readonly orders: SalesOrdersService) {}
  @Get() async list(@Query() query: SalesOrderQueryDto) { const result = await this.orders.list(query.page, query.page_size, query.search, query.status); return { data: result.data, meta: { page: query.page, page_size: query.page_size, total: result.total } }; }
  @Post() async create(@Body() body: SalesOrderDto, @CurrentUser() user: CurrentUserType) { return { data: await this.orders.create(body, user), meta: {} }; }
  @Get(":id/impact-preview") async impactPreview(@Param("id") id: string) { return { data: await this.orders.impactPreview(id), meta: {} }; }
  @Get(":id") async get(@Param("id") id: string) { return { data: await this.orders.get(id), meta: {} }; }
  @Patch(":id") async update(@Param("id") id: string, @Body() body: UpdateSalesOrderDto, @CurrentUser() user: CurrentUserType) { return { data: await this.orders.update(id, body, user), meta: {} }; }
  @Post(":id/confirm") async confirm(@Param("id") id: string, @CurrentUser() user: CurrentUserType) { return { data: await this.orders.confirm(id, user), meta: {} }; }
  @Post(":id/revert-draft") async revertDraft(@Param("id") id: string, @Body() body: ReasonDto, @CurrentUser() user: CurrentUserType) { return { data: await this.orders.revertToDraft(id, body.reason, user), meta: {} }; }
  @Post(":id/close") async close(@Param("id") id: string, @CurrentUser() user: CurrentUserType) { return { data: await this.orders.close(id, user), meta: {} }; }
}
