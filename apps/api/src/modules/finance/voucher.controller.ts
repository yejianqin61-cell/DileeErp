import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { IsArray, IsIn, IsOptional, IsString, MaxLength, ValidateNested } from "class-validator";
import { Type } from "class-transformer";
import { CurrentUser } from "../../platform/audit/current-user.decorator";
import type { CurrentUser as CurrentUserType } from "../../platform/auth/auth.service";
import { AuthenticationGuard } from "../../platform/authorization/authentication.guard";
import { ModulePermissionGuard } from "../../platform/authorization/module-permission.guard";
import { RequireModules } from "../../platform/authorization/require-modules.decorator";
import { VoucherService } from "./voucher.service";

class VoucherLineDto {
  @IsIn(["debit", "credit"]) direction!: string;
  @IsOptional() @IsString() @MaxLength(200) subject_key?: string;
  @IsOptional() @IsString() @MaxLength(200) subject_label?: string;
  @IsOptional() @IsString() @MaxLength(500) summary?: string;
  @IsString() amount!: string;
}

class VoucherUpdateDto {
  @IsOptional() @IsString() @MaxLength(500) summary?: string;
  @IsOptional() @IsString() @MaxLength(1000) remark?: string;
  /** 整组分录（要改就整组提交，避免「改了一半」的半平衡状态）。 */
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => VoucherLineDto) lines?: VoucherLineDto[];
}

class VoucherListDto {
  @IsOptional() @IsString() @MaxLength(7) period?: string;
  @IsOptional() @IsIn(["draft", "posted", "reversed"]) status?: string;
}

class ReasonDto {
  @IsString() @MaxLength(1000) reason!: string;
}

@Controller("finance/vouchers")
@UseGuards(AuthenticationGuard, ModulePermissionGuard)
@RequireModules("finance")
export class VoucherController {
  constructor(private readonly vouchers: VoucherService) {}

  @Get()
  async list(@Query() query: VoucherListDto) {
    return { data: await this.vouchers.list(query), meta: {} };
  }

  @Get(":id")
  async get(@Param("id") id: string) {
    return { data: await this.vouchers.get(id), meta: {} };
  }

  /** 由一条收支流水生成凭证（幂等：该流水已有凭证就返回原凭证）。 */
  @Post("from-cash-flow/:entryId")
  async createFromCashFlowEntry(@Param("entryId") entryId: string, @CurrentUser() user: CurrentUserType) {
    return { data: await this.vouchers.createFromCashFlowEntry(entryId, user), meta: {} };
  }

  @Patch(":id")
  async update(@Param("id") id: string, @Body() body: VoucherUpdateDto, @CurrentUser() user: CurrentUserType) {
    return { data: await this.vouchers.update(id, body, user), meta: {} };
  }

  @Post(":id/post")
  async post(@Param("id") id: string, @CurrentUser() user: CurrentUserType) {
    return { data: await this.vouchers.post(id, user), meta: {} };
  }

  @Post(":id/reverse")
  async reverse(@Param("id") id: string, @Body() body: ReasonDto, @CurrentUser() user: CurrentUserType) {
    return { data: await this.vouchers.reverse(id, body.reason, user), meta: {} };
  }

  @Delete(":id")
  async remove(@Param("id") id: string, @CurrentUser() user: CurrentUserType) {
    return { data: await this.vouchers.remove(id, user), meta: {} };
  }
}
