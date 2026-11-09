import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from "@nestjs/common";
import { IsInt, IsOptional, IsString, MaxLength, Min } from "class-validator";
import { CurrentUser } from "../../platform/audit/current-user.decorator";
import type { CurrentUser as CurrentUserType } from "../../platform/auth/auth.service";
import { AuthenticationGuard } from "../../platform/authorization/authentication.guard";
import { ModulePermissionGuard } from "../../platform/authorization/module-permission.guard";
import { RequireAdministrator } from "../../platform/authorization/require-administrator.decorator";
import { RequireModules } from "../../platform/authorization/require-modules.decorator";
import { AccountingSubjectCategoryService } from "./accounting-subject-category.service";

/**
 * 会计科目类目维护（2026-11-07）。
 *
 * 与会计科目主数据同一约定：读走 `finance` 模块权限，**写仅管理员** —— 类目是
 * 「科目分类」的唯一清单，任何客户端都能随便增删会让全站财务口径不可信。
 *
 * 为什么单独一个控制器而不是挂在 `/accounting-subjects` 下：类目是独立实体（有自己的 id /
 * 排序 / 内置保护），路径 `/finance/accounting-subject-categories` 与设计文档 §3 一致。
 */
class CreateCategoryDto {
  @IsString() @MaxLength(30) name!: string;
  /** 可省略：默认接在现有最大权重之后 +10。 */
  @IsOptional() @IsInt() @Min(0) sort_order?: number;
}

class UpdateCategoryDto {
  @IsOptional() @IsString() @MaxLength(30) name?: string;
  @IsOptional() @IsInt() @Min(0) sort_order?: number;
}

@Controller("finance/accounting-subject-categories")
@UseGuards(AuthenticationGuard, ModulePermissionGuard)
@RequireModules("finance")
export class AccountingSubjectCategoryController {
  constructor(private readonly categories: AccountingSubjectCategoryService) {}

  /** 类目列表：含科目计数、内置标记、创建人/最后修改人（由响应出口的 AuditActorInterceptor 换姓名）。 */
  @Get() async list() {
    return { data: await this.categories.list(), meta: {} };
  }

  @Post() @RequireAdministrator() async create(@Body() body: CreateCategoryDto, @CurrentUser() user: CurrentUserType) {
    return { data: await this.categories.create(body, user), meta: {} };
  }

  @Patch(":id") @RequireAdministrator() async update(@Param("id") id: string, @Body() body: UpdateCategoryDto, @CurrentUser() user: CurrentUserType) {
    return { data: await this.categories.update(id, body, user), meta: {} };
  }

  @Delete(":id") @RequireAdministrator() async remove(@Param("id") id: string, @CurrentUser() user: CurrentUserType) {
    return { data: await this.categories.remove(id, user), meta: {} };
  }
}
