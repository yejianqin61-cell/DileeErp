import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { IsBoolean, IsOptional, IsString, IsUUID, MaxLength } from "class-validator";
import { CurrentUser } from "../../platform/audit/current-user.decorator";
import type { CurrentUser as CurrentUserType } from "../../platform/auth/auth.service";
import { AuthenticationGuard } from "../../platform/authorization/authentication.guard";
import { ModulePermissionGuard } from "../../platform/authorization/module-permission.guard";
import { RequireModules } from "../../platform/authorization/require-modules.decorator";
import { BankService } from "./bank.service";

class BankDto {
  @IsString() @MaxLength(80) bank_code!: string;
  @IsString() @MaxLength(200) bank_name!: string;
  @IsString() @MaxLength(200) account_name!: string;
  @IsString() @MaxLength(100) account_number!: string;
  @IsString() @MaxLength(10) currency!: string;
  @IsOptional() @IsString() @MaxLength(50) swift_code?: string;
  /** 建账期初余额（非负十进制字符串，默认 0）。 */
  @IsOptional() @IsString() opening_balance?: string;
  @IsOptional() @IsString() @MaxLength(1000) remark?: string;
}

class BankUpdateDto {
  @IsOptional() @IsString() @MaxLength(80) bank_code?: string;
  @IsOptional() @IsString() @MaxLength(200) bank_name?: string;
  @IsOptional() @IsString() @MaxLength(200) account_name?: string;
  @IsOptional() @IsString() @MaxLength(100) account_number?: string;
  @IsOptional() @IsString() @MaxLength(10) currency?: string;
  @IsOptional() @IsString() @MaxLength(50) swift_code?: string;
  @IsOptional() @IsString() opening_balance?: string;
  @IsOptional() @IsString() @MaxLength(1000) remark?: string;
}

class BankToggleDto {
  @IsBoolean() is_active!: boolean;
}

class BankBalanceQueryDto {
  /** 截止日期（YYYY-MM-DD，含当天）：财务对账常问「上月底余额是多少」。 */
  @IsOptional() @IsString() as_of?: string;
}

@Controller("finance/banks")
@UseGuards(AuthenticationGuard, ModulePermissionGuard)
@RequireModules("finance")
export class BankController {
  constructor(private readonly bank: BankService) {}

  @Get()
  async list() {
    return { data: await this.bank.list(), meta: {} };
  }

  /**
   * 每个账户的余额明细（期初 + 收 − 付 + 转入 − 转出）。
   *
   * 路由必须排在 `@Get(":id")` **之前**：否则 "balances" 会被当成一个账户 id 去查，
   * 返回 404 BANK_NOT_FOUND（Nest 按声明顺序匹配）。
   */
  @Get("balances")
  async balances(@Query() query: BankBalanceQueryDto) {
    return { data: await this.bank.balances(query.as_of), meta: {} };
  }

  @Get(":id")
  async get(@Param("id") id: string) {
    return { data: await this.bank.get(id), meta: {} };
  }

  @Get(":id/balance")
  async balance(@Param("id") id: string, @Query() query: BankBalanceQueryDto) {
    return { data: await this.bank.balanceOf(id, query.as_of), meta: {} };
  }

  @Post()
  async create(@Body() body: BankDto, @CurrentUser() user: CurrentUserType) {
    return { data: await this.bank.create(body, user), meta: {} };
  }

  @Patch(":id")
  async update(@Param("id") id: string, @Body() body: BankUpdateDto, @CurrentUser() user: CurrentUserType) {
    return { data: await this.bank.update(id, body, user), meta: {} };
  }

  @Patch(":id/toggle")
  async toggle(@Param("id") id: string, @Body() body: BankToggleDto, @CurrentUser() user: CurrentUserType) {
    return { data: await this.bank.toggleActive(id, body.is_active, user), meta: {} };
  }

  @Delete(":id")
  async remove(@Param("id") id: string, @CurrentUser() user: CurrentUserType) {
    return { data: await this.bank.remove(id, user), meta: {} };
  }
}