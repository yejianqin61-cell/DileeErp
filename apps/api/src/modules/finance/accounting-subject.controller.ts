import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, MaxLength, Min } from "class-validator";
import { CurrentUser } from "../../platform/audit/current-user.decorator";
import type { CurrentUser as CurrentUserType } from "../../platform/auth/auth.service";
import { AuthenticationGuard } from "../../platform/authorization/authentication.guard";
import { ModulePermissionGuard } from "../../platform/authorization/module-permission.guard";
import { RequireAdministrator } from "../../platform/authorization/require-administrator.decorator";
import { RequireModules } from "../../platform/authorization/require-modules.decorator";
import { AccountingSubjectService } from "./accounting-subject.service";

/**
 * 会计科目（财务 → 收支管理 → 会计科目）。
 *
 * 这是**全站财务口径的唯一维护入口**：用户 2026-09-17 把「收支项目维护」与「会计科目」
 * 合并成了一个东西，所以这里不再有平行的字典接口。读走 `finance` 模块权限，
 * 写仅管理员（与既有字典维护同一约定）。
 */

class CreateSubjectDto {
  @IsString() @MaxLength(30) category!: string;
  @IsString() @MaxLength(100) name!: string;
  @IsOptional() @IsString() @MaxLength(4) balance_direction?: string;
  @IsOptional() @IsInt() @Min(0) sort_order?: number;
}

class UpdateSubjectDto {
  @IsOptional() @IsString() @MaxLength(30) category?: string;
  @IsOptional() @IsString() @MaxLength(100) name?: string;
  /** 传空串表示清空（老表里有科目没填余额方向）。 */
  @IsOptional() @IsString() @MaxLength(4) balance_direction?: string;
  @IsOptional() @IsInt() @Min(0) sort_order?: number;
  @IsOptional() @IsBoolean() is_active?: boolean;
}

class SubjectListDto {
  @IsOptional() @IsIn(["true", "false"]) include_inactive?: string;
  @IsOptional() @IsString() @MaxLength(30) category?: string;
}

@Controller("finance/accounting-subjects")
@UseGuards(AuthenticationGuard, ModulePermissionGuard)
@RequireModules("finance")
export class AccountingSubjectController {
  constructor(private readonly subjects: AccountingSubjectService) {}

  @Get() async list(@Query() query: SubjectListDto) {
    return { data: await this.subjects.list({ includeInactive: query.include_inactive === "true", category: query.category }), meta: {} };
  }

  /** 分类清单（5 类 ∪ 库里出现过的其它取值，如迁移带出来的「未分类」）。 */
  @Get("categories") async categories() {
    return { data: await this.subjects.categories(), meta: {} };
  }

  @Get(":id") async get(@Param("id") id: string) {
    return { data: await this.subjects.get(id), meta: {} };
  }

  /** 被引用次数：删除前界面要告诉财务「这个科目已经用在多少张单据上」。 */
  @Get(":id/usage") async usage(@Param("id") id: string) {
    return { data: { count: await this.subjects.usageCount(id) }, meta: {} };
  }

  @Post() @RequireAdministrator() async create(@Body() body: CreateSubjectDto, @CurrentUser() user: CurrentUserType) {
    return { data: await this.subjects.create(body, user), meta: {} };
  }

  @Patch(":id") @RequireAdministrator() async update(@Param("id") id: string, @Body() body: UpdateSubjectDto, @CurrentUser() user: CurrentUserType) {
    return { data: await this.subjects.update(id, body, user), meta: {} };
  }

  @Delete(":id") @RequireAdministrator() async remove(@Param("id") id: string, @CurrentUser() user: CurrentUserType) {
    return { data: await this.subjects.remove(id, user), meta: {} };
  }
}
