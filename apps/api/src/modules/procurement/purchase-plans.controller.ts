import { Body, Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { IsArray, IsDateString, IsIn, IsObject, IsOptional, IsString, IsUUID, MaxLength, ValidateNested } from "class-validator";
import { Type } from "class-transformer";
import { CurrentUser } from "../../platform/audit/current-user.decorator";
import type { CurrentUser as CurrentUserType } from "../../platform/auth/auth.service";
import { AuthenticationGuard } from "../../platform/authorization/authentication.guard";
import { ModulePermissionGuard } from "../../platform/authorization/module-permission.guard";
import { RequireModules } from "../../platform/authorization/require-modules.decorator";
import { PurchasePlansService } from "./purchase-plans.service";

class PlanItemDto {
  @IsUUID() material_id!: string;
  @IsUUID() unit_id!: string;
  @IsOptional() @IsUUID() bom_item_id?: string;
  @IsOptional() @IsUUID() supplier_id?: string;
  @IsOptional() @IsString() @MaxLength(200) model?: string;
  @IsString() quantity!: string;
  @IsString() unit_price!: string;
  @IsOptional() @IsDateString() expected_date?: string;
  @IsOptional() @IsObject() extension_data?: Record<string, unknown>;
}

class CreatePlanDto {
  @IsUUID() bom_id!: string;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => PlanItemDto) items?: PlanItemDto[];
  @IsOptional() @IsObject() extension_data?: Record<string, unknown>;
}

/**
 * 计划列表的筛选。货号与状态在服务层内存里筛（货号必须按 `itemNoKey` 归一后比）。
 *
 * `status` 收 `all`：界面上那一排筛选按钮的第一个就是「全部」，服务层见到 `all` 等于不筛。
 */
class PlanListQueryDto {
  @IsOptional() @IsString() @MaxLength(100) order_no?: string;
  @IsOptional() @IsString() @MaxLength(100) item_no?: string;
  @IsOptional() @IsIn(["all", "unordered", "partial", "completed"]) status?: string;
  @IsOptional() @IsString() @MaxLength(100) q?: string;
}

/**
 * 采购计划（2026-09-27）。
 *
 * 与采购单同一道门（`@RequireModules("procurement")`）：计划是采购员的日常工作面，
 * 不是另一个角色的东西，不新增模块键。
 */
@Controller("purchase-plans")
@UseGuards(AuthenticationGuard, ModulePermissionGuard)
@RequireModules("procurement")
export class PurchasePlansController {
  constructor(private readonly plans: PurchasePlansService) {}

  @Get() async list(@Query() query: PlanListQueryDto) {
    return { data: await this.plans.list(query), meta: {} };
  }

  // 必须声明在 `@Get(":id")` **之前**：否则 "candidates" 会被当成一个计划 id 吃掉
  // （Nest 按声明顺序匹配；`purchase-orders.controller.ts` 的 `bom-item-status` 有同样的注释）。
  @Get("candidates") async candidates() {
    return { data: await this.plans.candidates(), meta: {} };
  }

  @Post() async create(@Body() body: CreatePlanDto, @CurrentUser() user: CurrentUserType) {
    return { data: await this.plans.create(body, user), meta: {} };
  }

  @Get(":id") async get(@Param("id") id: string) {
    return { data: await this.plans.get(id), meta: {} };
  }
}
