import { Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { IsOptional, IsString, MaxLength } from "class-validator";
import { CurrentUser } from "../../platform/audit/current-user.decorator";
import type { CurrentUser as CurrentUserType } from "../../platform/auth/auth.service";
import { AuthenticationGuard } from "../../platform/authorization/authentication.guard";
import { ModulePermissionGuard } from "../../platform/authorization/module-permission.guard";
import { RequireModules } from "../../platform/authorization/require-modules.decorator";
import { OverheadAllocationService } from "./overhead-allocation.service";

/**
 * 月度管理费分摊登记（财务 → 财务报表 → 核算表）。
 *
 * 读走 `finance` 模块权限；写也走 `finance`（**不额外要求管理员**）：录管理费是财务的本职动作，
 * 一个月一次，锁管理员等于把这条链掐断。与「会计科目维护」不同 —— 科目表是全站口径的基础数据，
 * 改它会影响所有报表；而某个月的管理费只是一条业务输入，改错了当场就能改回来（有审计）。
 */

class OverheadAllocationListDto {
  @IsOptional() @IsString() @MaxLength(7) period?: string;
}

class ResolvedOverheadDto {
  @IsString() @MaxLength(7) period!: string;
}

class UpsertOverheadDto {
  @IsString() @MaxLength(7) period!: string;
  @IsString() @MaxLength(30) amount!: string;
  @IsString() @MaxLength(30) unit!: string;
  /** 分摊数量的人工覆盖值。**不传等于「用自动汇总值」**，传空串等于清掉覆盖。 */
  @IsOptional() @IsString() @MaxLength(30) quantity_override?: string | null;
  @IsOptional() @IsString() @MaxLength(1000) remark?: string;
}

@Controller("finance/overhead-allocations")
@UseGuards(AuthenticationGuard, ModulePermissionGuard)
@RequireModules("finance")
export class OverheadAllocationController {
  constructor(private readonly allocations: OverheadAllocationService) {}

  @Get() async list(@Query() query: OverheadAllocationListDto) {
    return { data: await this.allocations.list(query.period), meta: {} };
  }

  /**
   * 某期间现在的分摊口径（含自动汇总数量与费率）。期间没有登记时返回 `record: null` 而不是 404 ——
   * 「还没录」是面板的初始状态，不是错误。
   *
   * ⚠️ 本路由必须是 `@Get(":id")` 之前声明；本控制器**故意不提供** `@Get(":id")`：
   * 分摊记录的唯一自然键是期间，按 id 取一条在业务上没有用处，留着只会多一条会被 `resolved` 吃掉的路径。
   */
  @Get("resolved") async resolved(@Query() query: ResolvedOverheadDto) {
    return { data: await this.allocations.resolved(query.period), meta: {} };
  }

  /** 登记 / 修改某个月的管理费（按期间 upsert，幂等）。 */
  @Post() async upsert(@Body() body: UpsertOverheadDto, @CurrentUser() user: CurrentUserType) {
    return { data: await this.allocations.upsert(body, user), meta: {} };
  }

  @Delete(":id") async remove(@Param("id") id: string, @CurrentUser() user: CurrentUserType) {
    return { data: await this.allocations.remove(id, user), meta: {} };
  }
}
