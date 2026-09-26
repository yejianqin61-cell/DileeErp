import { Body, Controller, Get, Put, Query, UseGuards } from "@nestjs/common";
import { Type } from "class-transformer";
import { IsArray, IsIn, IsOptional, IsString, MaxLength, ValidateNested } from "class-validator";
import { CurrentUser } from "../../platform/audit/current-user.decorator";
import type { CurrentUser as CurrentUserType } from "../../platform/auth/auth.service";
import { AuthenticationGuard } from "../../platform/authorization/authentication.guard";
import { ModulePermissionGuard } from "../../platform/authorization/module-permission.guard";
import { RequireModules } from "../../platform/authorization/require-modules.decorator";
import { OpeningBalanceService } from "./opening-balance.service";

/** 一行期初余额：科目（`分类/名称`）+ 借/贷 + 正数金额。 */
class OpeningBalanceRowDto {
  @IsString() @MaxLength(200) subject_key!: string;
  @IsOptional() @IsString() @MaxLength(200) subject_label?: string;
  @IsIn(["debit", "credit"]) direction!: string;
  /** 金额是**字符串十进制**（全站约定）；具体合法性由服务层同一套判定。 */
  @IsString() @MaxLength(50) amount!: string;
  @IsOptional() @IsString() @MaxLength(1000) remark?: string;
}

class OpeningBalanceQueryDto {
  @IsOptional() @IsString() @MaxLength(20) as_of_date?: string;
  @IsOptional() @IsString() @MaxLength(10) currency?: string;
}

/**
 * 整批替换一组期初余额（建账日 + 币种）。
 *
 * 为什么是 PUT 整批而不是逐行 POST：界面上一张表就是「我现在的期初」，
 * 逐行接口会让「删掉一行」变成额外的删除动作，而财务的心智里没有这一步（见服务层注释）。
 */
class OpeningBalanceReplaceDto {
  @IsString() @MaxLength(20) as_of_date!: string;
  @IsOptional() @IsString() @MaxLength(10) currency?: string;
  @IsArray() @ValidateNested({ each: true }) @Type(() => OpeningBalanceRowDto) rows!: OpeningBalanceRowDto[];
}

/**
 * 建账期初余额（财务 2026-09-24：「1,3,4 都要」的第 ③ 件）。
 *
 * 两条路由：`GET /finance/opening-balances`（某一组的期初 + 试算平衡）、
 * `PUT /finance/opening-balances`（整批替换）。表里没有期初时，三大报表仍然只能用银行账户期初兜底
 * （差额会写进报表表尾），所以这一页是「让勾稽真正为 0」的那一步。
 */
@Controller("finance/opening-balances")
@UseGuards(AuthenticationGuard, ModulePermissionGuard)
@RequireModules("finance")
export class OpeningBalanceController {
  constructor(private readonly openings: OpeningBalanceService) {}

  @Get()
  async list(@Query() query: OpeningBalanceQueryDto) {
    return { data: await this.openings.list({ asOfDate: query.as_of_date, currency: query.currency }), meta: {} };
  }

  @Put()
  async replace(@Body() body: OpeningBalanceReplaceDto, @CurrentUser() user: CurrentUserType) {
    return { data: await this.openings.replaceAll(body, user), meta: {} };
  }
}
