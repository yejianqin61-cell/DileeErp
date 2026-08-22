import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { IsDateString, IsOptional, IsString, IsUUID, MaxLength } from "class-validator";
import { CurrentUser } from "../../platform/audit/current-user.decorator";
import type { CurrentUser as CurrentUserType } from "../../platform/auth/auth.service";
import { AuthenticationGuard } from "../../platform/authorization/authentication.guard";
import { ModulePermissionGuard } from "../../platform/authorization/module-permission.guard";
import { RequireModules } from "../../platform/authorization/require-modules.decorator";
import { FinishedGoodsQcService } from "./finished-goods-qc.service";

class SubmissionDto { @IsUUID() production_order_id!: string; @IsString() source_type!: "in_house_completion" | "outsource_finished_goods_return"; @IsUUID() source_id!: string; @IsString() submitted_quantity!: string; @IsDateString() submission_date!: string; @IsOptional() @IsString() @MaxLength(1000) remark?: string; }
class UpdateSubmissionDto { @IsOptional() @IsString() submitted_quantity?: string; @IsOptional() @IsDateString() submission_date?: string; @IsOptional() @IsString() @MaxLength(1000) remark?: string; @IsString() reason!: string; @IsOptional() expected_version?: number; }
class ReasonDto { @IsString() @MaxLength(1000) reason!: string; }

@Controller("finished-goods")
@UseGuards(AuthenticationGuard, ModulePermissionGuard)
export class FinishedGoodsQcController {
  constructor(private readonly qc: FinishedGoodsQcService) {}
  @Get("qc/sources") @RequireModules("warehouse") async sources(@Query("order_no") orderNo?: string, @Query("production_order_id") productionOrderId?: string, @Query("source_type") sourceType?: "in_house_completion" | "outsource_finished_goods_return") { return { data: await this.qc.listSources(orderNo, productionOrderId, sourceType), meta: {} }; }
  @Get("inspection-submissions") @RequireModules("warehouse") async list(@Query("order_no") orderNo?: string) { return { data: await this.qc.listSubmissions(orderNo), meta: {} }; }
  @Get("inspection-submissions/:id") @RequireModules("warehouse") async get(@Param("id") id: string) { return { data: await this.qc.getSubmission(id), meta: {} }; }
  @Post("inspection-submissions") @RequireModules("warehouse") async create(@Body() body: SubmissionDto, @CurrentUser() user: CurrentUserType) { return { data: await this.qc.createSubmission(body, user), meta: {} }; }
  @Patch("inspection-submissions/:id") @RequireModules("warehouse") async update(@Param("id") id: string, @Body() body: UpdateSubmissionDto, @CurrentUser() user: CurrentUserType) { return { data: await this.qc.updateSubmission(id, body, user), meta: {} }; }
  @Post("inspection-submissions/:id/submit") @RequireModules("warehouse") async submit(@Param("id") id: string, @CurrentUser() user: CurrentUserType) { return { data: await this.qc.submit(id, user), meta: {} }; }
  @Post("inspection-submissions/:id/cancel") @RequireModules("warehouse") async cancel(@Param("id") id: string, @Body() body: ReasonDto, @CurrentUser() user: CurrentUserType) { return { data: await this.qc.cancel(id, body.reason, user), meta: {} }; }
}
