import { Body, Controller, Get, Put, Query, UseGuards } from "@nestjs/common";
import { Type } from "class-transformer";
import { IsArray, IsOptional, IsString, MaxLength, ValidateNested } from "class-validator";
import { CurrentUser } from "../../platform/audit/current-user.decorator";
import type { CurrentUser as CurrentUserType } from "../../platform/auth/auth.service";
import { AuthenticationGuard } from "../../platform/authorization/authentication.guard";
import { ModulePermissionGuard } from "../../platform/authorization/module-permission.guard";
import { RequireModules } from "../../platform/authorization/require-modules.decorator";
import { ExchangeRateService } from "./exchange-rate.service";

/** 一行汇率：币种 + `1 外币 = rate 人民币`。 */
class ExchangeRateRowDto {
  @IsString() @MaxLength(10) currency!: string;
  /** 汇率是**字符串十进制**（全站约定）；具体合法性由服务层同一套判定。 */
  @IsString() @MaxLength(30) rate!: string;
  @IsOptional() @IsString() @MaxLength(1000) remark?: string;
}

class ExchangeRateQueryDto {
  @IsOptional() @IsString() @MaxLength(20) period?: string;
}

/**
 * 整批替换一个期间的汇率。
 *
 * 为什么是 PUT 整批而不是逐行 POST：界面上一张表就是「这个月的汇率」，
 * 逐行接口会让「删掉一行」变成额外的删除动作，而财务的心智里没有这一步（见服务层注释）。
 */
class ExchangeRateReplaceDto {
  @IsString() @MaxLength(20) period!: string;
  @IsArray() @ValidateNested({ each: true }) @Type(() => ExchangeRateRowDto) rows!: ExchangeRateRowDto[];
}

/**
 * 期末汇率（财务 2026-09-24：「1,3,4 都要」的第 ④ 件）。
 *
 * 两条路由：`GET /finance/exchange-rates`（某一期间的汇率 + 已维护过的期间）、
 * `PUT /finance/exchange-rates`（整批替换该期间）。没有汇率的外币凭证不会静默丢掉：
 * 三大报表会把「哪些币种因为没维护汇率而没折算进来」写进表尾。
 */
@Controller("finance/exchange-rates")
@UseGuards(AuthenticationGuard, ModulePermissionGuard)
@RequireModules("finance")
export class ExchangeRateController {
  constructor(private readonly rates: ExchangeRateService) {}

  @Get()
  async list(@Query() query: ExchangeRateQueryDto) {
    return { data: await this.rates.list({ period: query.period }), meta: {} };
  }

  @Put()
  async replace(@Body() body: ExchangeRateReplaceDto, @CurrentUser() user: CurrentUserType) {
    return { data: await this.rates.replaceAll(body, user), meta: {} };
  }
}
