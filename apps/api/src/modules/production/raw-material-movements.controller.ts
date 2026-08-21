import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { IsArray, IsDateString, IsOptional, IsString, IsUUID, MaxLength } from "class-validator";
import { CurrentUser } from "../../platform/audit/current-user.decorator";
import type { CurrentUser as CurrentUserType } from "../../platform/auth/auth.service";
import { AuthenticationGuard } from "../../platform/authorization/authentication.guard";
import { ModulePermissionGuard } from "../../platform/authorization/module-permission.guard";
import { RequireModules } from "../../platform/authorization/require-modules.decorator";
import { RawMaterialMovementsService } from "./raw-material-movements.service";

class IssueLineDto { @IsUUID() material_id!: string; @IsString() quantity!: string; @IsOptional() @IsString() @MaxLength(1000) remark?: string; }
class IssueDto { @IsUUID() production_order_id!: string; @IsOptional() @IsDateString() business_date?: string; @IsOptional() @IsString() @MaxLength(1000) reason?: string; @IsOptional() @IsString() @MaxLength(1000) remark?: string; @IsArray() lines!: IssueLineDto[]; }
class DerivedLineDto { @IsUUID() source_issue_line_id!: string; @IsString() quantity!: string; @IsOptional() @IsString() @MaxLength(1000) remark?: string; }
class DerivedDto { @IsUUID() production_order_id!: string; @IsOptional() @IsDateString() business_date?: string; @IsOptional() @IsString() @MaxLength(1000) reason?: string; @IsOptional() @IsString() @MaxLength(1000) remark?: string; @IsArray() lines!: DerivedLineDto[]; }
class PostDto { @IsString() @MaxLength(200) idempotency_key!: string; }
class ReverseDto extends PostDto { @IsString() @MaxLength(1000) reason!: string; }

@Controller("production/material-movements")
@UseGuards(AuthenticationGuard, ModulePermissionGuard)
@RequireModules("production")
export class RawMaterialMovementsController {
  constructor(private readonly movements: RawMaterialMovementsService) {}
  @Get() async list(@Query("order_no") orderNo?: string) { return { data: await this.movements.list(orderNo), meta: {} }; }
  @Post("issue-preview") async preview(@Body() body: IssueDto) { return { data: await this.movements.preview(body), meta: {} }; }
  @Post() async create(@Body() body: IssueDto, @CurrentUser() user: CurrentUserType) { return { data: await this.movements.createIssue(body, user), meta: {} }; }
  @Post("returns") async createReturn(@Body() body: DerivedDto, @CurrentUser() user: CurrentUserType) { return { data: await this.movements.createReturn(body, user), meta: {} }; }
  @Post("scraps") async createScrap(@Body() body: DerivedDto, @CurrentUser() user: CurrentUserType) { return { data: await this.movements.createScrap(body, user), meta: {} }; }
  @Get(":id") async get(@Param("id") id: string) { return { data: await this.movements.get(id), meta: {} }; }
  @Patch(":id") async update(@Param("id") id: string, @Body() body: Partial<IssueDto>, @CurrentUser() user: CurrentUserType) { return { data: await this.movements.updateIssue(id, body, user), meta: {} }; }
  @Delete(":id") async remove(@Param("id") id: string, @CurrentUser() user: CurrentUserType) { return { data: await this.movements.removeIssue(id, user), meta: {} }; }
  @Get(":id/impact-preview") async impactPreview(@Param("id") id: string) { return { data: await this.movements.impactPreview(id), meta: {} }; }
  @Get(":id/reversal-preview") async reversalPreview(@Param("id") id: string) { return { data: await this.movements.reversalPreview(id), meta: {} }; }
  @Get(":id/audit-events") async auditEvents(@Param("id") id: string) { return { data: await this.movements.auditEvents(id), meta: {} }; }
  @Post(":id/post") async post(@Param("id") id: string, @Body() body: PostDto, @CurrentUser() user: CurrentUserType) { return { data: await this.movements.postIssue(id, body.idempotency_key, user), meta: {} }; }
  @Post(":id/post-return") async postReturn(@Param("id") id: string, @Body() body: PostDto, @CurrentUser() user: CurrentUserType) { return { data: await this.movements.postReturn(id, body.idempotency_key, user), meta: {} }; }
  @Post(":id/post-scrap") async postScrap(@Param("id") id: string, @Body() body: PostDto, @CurrentUser() user: CurrentUserType) { return { data: await this.movements.postScrap(id, body.idempotency_key, user), meta: {} }; }
  @Post(":id/reverse") async reverse(@Param("id") id: string, @Body() body: ReverseDto, @CurrentUser() user: CurrentUserType) { return { data: await this.movements.reverse(id, body.reason, body.idempotency_key, user), meta: {} }; }
}
