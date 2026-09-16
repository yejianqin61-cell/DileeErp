import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { IsArray, IsDateString, IsOptional, IsString, IsUUID, MaxLength, ValidateNested } from "class-validator";
import { Type } from "class-transformer";
import { CurrentUser } from "../../platform/audit/current-user.decorator";
import type { CurrentUser as CurrentUserType } from "../../platform/auth/auth.service";
import { AuthenticationGuard } from "../../platform/authorization/authentication.guard";
import { ModulePermissionGuard } from "../../platform/authorization/module-permission.guard";
import { RequireModules } from "../../platform/authorization/require-modules.decorator";
import { RawMaterialMovementsService } from "./raw-material-movements.service";

class IssueLineDto { @IsUUID() material_id!: string; @IsString() quantity!: string; @IsOptional() @IsString() @MaxLength(1000) remark?: string; }
class IssueDto { @IsUUID() production_order_id!: string; // 领料单只绑定生产单（一个生产单可有多张领料单），不再需要工序。
  @IsOptional() @IsDateString() business_date?: string; @IsOptional() @IsString() @MaxLength(1000) reason?: string; @IsOptional() @IsString() @MaxLength(1000) remark?: string; @IsArray() @ValidateNested({ each: true }) @Type(() => IssueLineDto) lines!: IssueLineDto[]; }
class DerivedLineDto { @IsUUID() source_issue_line_id!: string; @IsString() quantity!: string; @IsOptional() @IsString() @MaxLength(1000) remark?: string; }
// 补料单：与领料单同一套明细结构，只绑定生产单，但必须填写补料原因（坏片/生产失误等）。
class ReplenishmentDto { @IsUUID() production_order_id!: string; @IsOptional() @IsDateString() business_date?: string; @IsString() @MaxLength(1000) reason!: string; @IsOptional() @IsString() @MaxLength(1000) remark?: string; @IsArray() @ValidateNested({ each: true }) @Type(() => IssueLineDto) lines!: IssueLineDto[]; }
class DerivedDto { @IsUUID() production_order_id!: string; @IsOptional() @IsDateString() business_date?: string; @IsOptional() @IsString() @MaxLength(1000) reason?: string; @IsOptional() @IsString() @MaxLength(1000) remark?: string; @IsArray() @ValidateNested({ each: true }) @Type(() => DerivedLineDto) lines!: DerivedLineDto[]; }
class UpdateIssueDto { @IsOptional() @IsUUID() production_order_id?: string; @IsOptional() @IsDateString() business_date?: string; @IsOptional() @IsString() @MaxLength(1000) reason?: string; @IsOptional() @IsString() @MaxLength(1000) remark?: string; @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => IssueLineDto) lines?: IssueLineDto[]; }
class PostDto { @IsString() @MaxLength(200) idempotency_key!: string; }
class ReverseDto extends PostDto { @IsString() @MaxLength(1000) reason!: string; }
class ReasonOnlyDto { @IsString() @MaxLength(1000) reason!: string; }

@Controller("production/material-movements")
@UseGuards(AuthenticationGuard, ModulePermissionGuard)
@RequireModules("production")
export class RawMaterialMovementsController {
  constructor(private readonly movements: RawMaterialMovementsService) {}
  @Get() async list(@Query("order_no") orderNo?: string, @Query("production_order_id") productionOrderId?: string, @Query("production_order_operation_id") operationId?: string) { return { data: await this.movements.list(orderNo, { productionOrderId, productionOrderOperationId: operationId }), meta: {} }; }
  /**
   * 仓库的「待出库通知」：已被生产确认提交、还没实际出库的单据。
   *
   * 路由必须声明在 `@Get(":id")` **之前**：否则 "pending-outbound" 会被当成一个单据 id 去查
   * （Nest 按声明顺序匹配），返回 404 MATERIAL_MOVEMENT_NOT_FOUND。
   */
  @Get("pending-outbound") async pendingOutbound() { return { data: await this.movements.pendingOutbound(), meta: {} }; }
  @Post("issue-preview") async preview(@Body() body: IssueDto) { return { data: await this.movements.preview(body), meta: {} }; }
  @Post() async create(@Body() body: IssueDto, @CurrentUser() user: CurrentUserType) { return { data: await this.movements.createIssue(body, user), meta: {} }; }
  @Post("returns") async createReturn(@Body() body: DerivedDto, @CurrentUser() user: CurrentUserType) { return { data: await this.movements.createReturn(body, user), meta: {} }; }
  @Post("scraps") async createScrap(@Body() body: DerivedDto, @CurrentUser() user: CurrentUserType) { return { data: await this.movements.createScrap(body, user), meta: {} }; }
  @Post("replenishments") async createReplenishment(@Body() body: ReplenishmentDto, @CurrentUser() user: CurrentUserType) { return { data: await this.movements.createReplenishment(body, user), meta: {} }; }
  @Get(":id") async get(@Param("id") id: string) { return { data: await this.movements.get(id), meta: {} }; }
  @Patch(":id") async update(@Param("id") id: string, @Body() body: UpdateIssueDto, @CurrentUser() user: CurrentUserType) { return { data: await this.movements.updateIssue(id, body, user), meta: {} }; }
  @Delete(":id") async remove(@Param("id") id: string, @CurrentUser() user: CurrentUserType) { return { data: await this.movements.removeIssue(id, user), meta: {} }; }
  @Get(":id/impact-preview") async impactPreview(@Param("id") id: string) { return { data: await this.movements.impactPreview(id), meta: {} }; }
  @Get(":id/reversal-preview") async reversalPreview(@Param("id") id: string) { return { data: await this.movements.reversalPreview(id), meta: {} }; }
  @Get(":id/audit-events") async auditEvents(@Param("id") id: string) { return { data: await this.movements.auditEvents(id), meta: {} }; }
  /** 生产「确认提交」：草稿 → 待仓库出库（不动库存）。 */
  @Post(":id/submit") async submit(@Param("id") id: string, @CurrentUser() user: CurrentUserType) { return { data: await this.movements.submitOutbound(id, user), meta: {} }; }
  @Post(":id/post") async post(@Param("id") id: string, @Body() body: PostDto, @CurrentUser() user: CurrentUserType) { return { data: await this.movements.postIssue(id, body.idempotency_key, user), meta: {} }; }
  @Post(":id/post-return") async postReturn(@Param("id") id: string, @Body() body: PostDto, @CurrentUser() user: CurrentUserType) { return { data: await this.movements.postReturn(id, body.idempotency_key, user), meta: {} }; }
  @Post(":id/post-replenishment") async postReplenishment(@Param("id") id: string, @Body() body: PostDto, @CurrentUser() user: CurrentUserType) { return { data: await this.movements.postReplenishment(id, body.idempotency_key, user), meta: {} }; }
  @Post(":id/post-scrap") async postScrap(@Param("id") id: string, @Body() body: PostDto, @CurrentUser() user: CurrentUserType) { return { data: await this.movements.postScrap(id, body.idempotency_key, user), meta: {} }; }
  @Post(":id/reverse") async reverse(@Param("id") id: string, @Body() body: ReverseDto, @CurrentUser() user: CurrentUserType) { return { data: await this.movements.reverse(id, body.reason, body.idempotency_key, user), meta: {} }; }
  /** 回退草稿：已过账（写等额冲抵事实）或已提交待出库（撤回提交）的领料单/补料单退回草稿继续编辑。 */
  @Post(":id/reopen") async reopen(@Param("id") id: string, @Body() body: ReasonOnlyDto, @CurrentUser() user: CurrentUserType) { return { data: await this.movements.reopen(id, body.reason, user), meta: {} }; }
}
