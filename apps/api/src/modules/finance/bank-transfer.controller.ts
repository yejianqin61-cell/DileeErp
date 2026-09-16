import { Body, Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { IsDateString, IsOptional, IsString, IsUUID, MaxLength } from "class-validator";
import { CurrentUser } from "../../platform/audit/current-user.decorator";
import type { CurrentUser as CurrentUserType } from "../../platform/auth/auth.service";
import { AuthenticationGuard } from "../../platform/authorization/authentication.guard";
import { ModulePermissionGuard } from "../../platform/authorization/module-permission.guard";
import { RequireModules } from "../../platform/authorization/require-modules.decorator";
import { BankTransferService } from "./bank-transfer.service";

/**
 * 银行余额互转（财务 → 银行余额互转）。
 *
 * 表单字段就是用户点名的四项：本方账户 / 本方币种 / 对方账户 / 对方币种，
 * 加金额（跨币种时两个）与备注。币种默认取账户币种，传了就必须与账户一致 —— 见服务层注释。
 */
class BankTransferDto {
  @IsDateString() transfer_date!: string;
  @IsUUID() from_bank_id!: string;
  @IsOptional() @IsString() @MaxLength(10) from_currency?: string;
  @IsUUID() to_bank_id!: string;
  @IsOptional() @IsString() @MaxLength(10) to_currency?: string;
  @IsString() from_amount!: string;
  @IsOptional() @IsString() to_amount?: string;
  @IsOptional() @IsString() @MaxLength(1000) remark?: string;
}

class BankTransferListDto {
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
  @IsOptional() @IsUUID() bank_id?: string;
}

class ReasonDto {
  @IsString() @MaxLength(500) reason!: string;
}

@Controller("finance/bank-transfers")
@UseGuards(AuthenticationGuard, ModulePermissionGuard)
@RequireModules("finance")
export class BankTransferController {
  constructor(private readonly transfers: BankTransferService) {}

  @Get() async list(@Query() query: BankTransferListDto) {
    return { data: await this.transfers.list({ from: query.from, to: query.to, bankId: query.bank_id }), meta: {} };
  }

  @Get(":id") async get(@Param("id") id: string) {
    return { data: await this.transfers.get(id), meta: {} };
  }

  @Post() async create(@Body() body: BankTransferDto, @CurrentUser() user: CurrentUserType) {
    return { data: await this.transfers.create(body, user), meta: {} };
  }

  /** 冲销：保留整行，置 reversed 后不再计入余额。 */
  @Post(":id/reverse") async reverse(@Param("id") id: string, @Body() body: ReasonDto, @CurrentUser() user: CurrentUserType) {
    return { data: await this.transfers.reverse(id, body.reason, user), meta: {} };
  }
}
