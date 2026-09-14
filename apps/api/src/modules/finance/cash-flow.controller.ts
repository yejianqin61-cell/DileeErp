import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { IsDateString, IsIn, IsOptional, IsString, IsUUID, MaxLength } from "class-validator";
import { CurrentUser } from "../../platform/audit/current-user.decorator";
import type { CurrentUser as CurrentUserType } from "../../platform/auth/auth.service";
import { AuthenticationGuard } from "../../platform/authorization/authentication.guard";
import { ModulePermissionGuard } from "../../platform/authorization/module-permission.guard";
import { RequireModules } from "../../platform/authorization/require-modules.decorator";
import { CashFlowService } from "./cash-flow.service";

/**
 * 收支流水（「收支管理」板块）。
 *
 * 收支项目 / 结算账户两个字典**不在这里维护**：它们是 `dictionary_types` 下的普通字典，
 * 直接用既有的 `/dictionaries/cash_flow_item/items`、`/dictionaries/settlement_account/items`
 * （新建/改名/停用已经齐全，且写操作仅管理员），不再造一套平行的字典接口。
 */

class CashFlowEntryDto {
  @IsDateString() entry_date!: string;
  @IsString() @MaxLength(200) counterparty_name!: string;
  @IsIn(["income", "expense"]) direction!: string;
  @IsString() amount!: string;
  @IsString() @MaxLength(10) currency!: string;
  @IsUUID() item_id!: string;
  @IsOptional() @IsString() @MaxLength(50) settlement_method?: string;
  @IsOptional() @IsUUID() settlement_account_id?: string;
  @IsOptional() @IsString() @MaxLength(1000) remark?: string;
}

class CashFlowEntryUpdateDto {
  @IsOptional() @IsDateString() entry_date?: string;
  @IsOptional() @IsString() @MaxLength(200) counterparty_name?: string;
  @IsOptional() @IsIn(["income", "expense"]) direction?: string;
  @IsOptional() @IsString() amount?: string;
  @IsOptional() @IsString() @MaxLength(10) currency?: string;
  @IsOptional() @IsUUID() item_id?: string;
  @IsOptional() @IsString() @MaxLength(50) settlement_method?: string;
  @IsOptional() @IsUUID() settlement_account_id?: string;
  @IsOptional() @IsString() @MaxLength(1000) remark?: string;
}

class CashFlowListDto {
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
  @IsOptional() @IsUUID() item_id?: string;
  @IsOptional() @IsString() @MaxLength(10) currency?: string;
  @IsOptional() @IsIn(["income", "expense"]) direction?: string;
  /** 是否包含已冲销的流水（默认只给生效的）。 */
  @IsOptional() @IsIn(["true", "false"]) include_reversed?: string;
}

class ReasonDto {
  @IsString() @MaxLength(1000) reason!: string;
}

@Controller("finance/cash-flow-entries")
@UseGuards(AuthenticationGuard, ModulePermissionGuard)
@RequireModules("finance")
export class CashFlowController {
  constructor(private readonly cashFlow: CashFlowService) {}

  @Get() async list(@Query() query: CashFlowListDto) {
    return {
      data: await this.cashFlow.list({
        from: query.from,
        to: query.to,
        itemId: query.item_id,
        currency: query.currency,
        direction: query.direction,
        includeReversed: query.include_reversed === "true",
      }),
      meta: {},
    };
  }

  @Get(":id") async get(@Param("id") id: string) {
    return { data: await this.cashFlow.get(id), meta: {} };
  }

  @Post() async create(@Body() body: CashFlowEntryDto, @CurrentUser() user: CurrentUserType) {
    return { data: await this.cashFlow.create(body, user), meta: {} };
  }

  @Patch(":id") async update(@Param("id") id: string, @Body() body: CashFlowEntryUpdateDto, @CurrentUser() user: CurrentUserType) {
    return { data: await this.cashFlow.update(id, body, user), meta: {} };
  }

  /** 冲销：保留整行（已报过表的数字不能凭空消失），报表默认不计入。 */
  @Post(":id/reverse") async reverse(@Param("id") id: string, @Body() body: ReasonDto, @CurrentUser() user: CurrentUserType) {
    return { data: await this.cashFlow.reverse(id, body.reason, user), meta: {} };
  }
}
