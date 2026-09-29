import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { IsArray, IsDateString, IsIn, IsObject, IsOptional, IsString, IsUUID, MaxLength, ValidateNested } from "class-validator";
import { Type } from "class-transformer";
import { CurrentUser } from "../../platform/audit/current-user.decorator";
import type { CurrentUser as CurrentUserType } from "../../platform/auth/auth.service";
import { AuthenticationGuard } from "../../platform/authorization/authentication.guard";
import { ModulePermissionGuard } from "../../platform/authorization/module-permission.guard";
import { RequireModules } from "../../platform/authorization/require-modules.decorator";
import { PurchasePlansService } from "./purchase-plans.service";

class PlanItemDto {
  /** 已有行的身份。**已下单的行必须带着它回来**（不带 = 被当成新行 = 会以 `PURCHASE_PLAN_ORDERED_LINE_REMOVED` 拒绝）。 */
  @IsOptional() @IsUUID() id?: string;
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
 * 保存计划。
 *
 * `bom_id` **不在**这里：计划一旦建好就绑死那张 BOM（"一个销售单一份 BOM 一份计划"）。
 * 换 BOM 等于换一份计划，应该删掉重建，而不是把一份计划的行与另一张 BOM 对上。
 */
class UpdatePlanDto {
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => PlanItemDto) items?: PlanItemDto[];
  @IsOptional() @IsObject() extension_data?: Record<string, unknown>;
  /** 乐观锁令牌：`GET /:id` 拿到的 `updatedAt`。不传则跳过冲突比对（兼容脚本与既有单测桩）。 */
  @IsOptional() @IsString() expected_updated_at?: string;
  @IsOptional() @IsString() @MaxLength(1000) reason?: string;
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

/** 一组 = 一张采购单（同一个供应商）。`items` 是计划行 ID；没勾的行留在计划里（多波次）。 */
class PlanOrderGroupDto {
  @IsOptional() @IsUUID() supplier_id?: string;
  /** 币种按**组**选（口径 10）：币种是"一张采购单"的属性，而一张采购单=一个供应商。 */
  @IsOptional() @IsString() @MaxLength(10) currency?: string;
  @IsOptional() @IsDateString() expected_date?: string;
  @IsOptional() @IsString() @MaxLength(1000) remark?: string;
  @IsArray() @IsUUID(undefined, { each: true }) items!: string[];
}

class PlanOrderDto {
  @IsOptional() @IsDateString() purchase_date?: string;
  @IsOptional() @IsString() @MaxLength(1000) remark?: string;
  @IsOptional() @IsObject() extension_data?: Record<string, unknown>;
  @IsArray() @ValidateNested({ each: true }) @Type(() => PlanOrderGroupDto) groups!: PlanOrderGroupDto[];
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

  @Patch(":id") async update(@Param("id") id: string, @Body() body: UpdatePlanDto, @CurrentUser() user: CurrentUserType) {
    return { data: await this.plans.update(id, body, user), meta: {} };
  }

  /** 软删。有任何一行已下单就 422 `PURCHASE_PLAN_HAS_ORDERED_LINES`。 */
  @Delete(":id") async remove(@Param("id") id: string, @CurrentUser() user: CurrentUserType) {
    return { data: await this.plans.remove(id, user), meta: {} };
  }

  /** 按供应商收束下单：一组一张采购单，没勾的行留在计划里。 */
  @Post(":id/order") async order(@Param("id") id: string, @Body() body: PlanOrderDto, @CurrentUser() user: CurrentUserType) {
    return { data: await this.plans.order(id, body, user), meta: {} };
  }

  @Get(":id") async get(@Param("id") id: string) {
    return { data: await this.plans.get(id), meta: {} };
  }
}
