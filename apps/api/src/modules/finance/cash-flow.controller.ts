import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { IsDateString, IsIn, IsOptional, IsString, IsUUID, MaxLength } from "class-validator";
import { CurrentUser } from "../../platform/audit/current-user.decorator";
import type { CurrentUser as CurrentUserType } from "../../platform/auth/auth.service";
import { AuthenticationGuard } from "../../platform/authorization/authentication.guard";
import { ModulePermissionGuard } from "../../platform/authorization/module-permission.guard";
import { RequireModules } from "../../platform/authorization/require-modules.decorator";
import { CashFlowService } from "./cash-flow.service";
import { PAYMENT_NATURE_FORM_KEYS } from "./payment-nature";

/**
 * 收支流水（「收支管理」板块）。
 *
 * 会计科目**不在这里维护**：用户 2026-09-17 把「收支项目维护」与「会计科目」合并成了一个东西，
 * 走 `/finance/accounting-subjects`（见 accounting-subject.controller.ts）。
 * 结算账户仍是 `dictionary_types` 下的普通字典，直接用既有的
 * `/dictionaries/settlement_account/items`，不另造一套平行接口。
 */

class CashFlowEntryDto {
  @IsDateString() entry_date!: string;
  @IsString() @MaxLength(200) counterparty_name!: string;
  @IsIn(["income", "expense"]) direction!: string;
  @IsString() amount!: string;
  @IsString() @MaxLength(10) currency!: string;
  /** 会计科目（分类 = 科目类别，项目 = 科目名称）。 */
  @IsUUID() subject_id!: string;
  @IsOptional() @IsString() @MaxLength(50) settlement_method?: string;
  @IsOptional() @IsUUID() settlement_account_id?: string;
  /** 资金实际所在的银行账户（财务 → 银行账户）；填了才算进该账户余额。 */
  @IsOptional() @IsUUID() bank_id?: string;
  /**
   * 款项性质（定金/货款/尾款/其他）。定金这类**出货前**收到的钱没有应收来源可挂，
   * 只能作为手工收入流水录进来，这一列就是老表「外汇一览表」里定金/货款两列的来源。
   */
  @IsOptional() @IsIn(PAYMENT_NATURE_FORM_KEYS) payment_nature?: string;
  /**
   * 订单号：把收入流水挂到具体订单（外汇一览表按它归集）。
   * 填了必须真实存在 —— 写错一个字符，这笔钱在外汇一览表里就掉进「无法归属」，
   * 与其让报表事后吞掉一笔钱，不如建单时就报错。
   */
  @IsOptional() @IsString() @MaxLength(100) order_no?: string;
  @IsOptional() @IsString() @MaxLength(1000) remark?: string;
}

class CashFlowEntryUpdateDto {
  @IsOptional() @IsDateString() entry_date?: string;
  @IsOptional() @IsString() @MaxLength(200) counterparty_name?: string;
  @IsOptional() @IsIn(["income", "expense"]) direction?: string;
  @IsOptional() @IsString() amount?: string;
  @IsOptional() @IsString() @MaxLength(10) currency?: string;
  @IsOptional() @IsUUID() subject_id?: string;
  @IsOptional() @IsString() @MaxLength(50) settlement_method?: string;
  @IsOptional() @IsUUID() settlement_account_id?: string;
  @IsOptional() @IsUUID() bank_id?: string;
  /** 传空串表示**清空**（标错了要能去掉），传 undefined 表示不改 —— 与银行账户同一约定。 */
  @IsOptional() @IsIn(PAYMENT_NATURE_FORM_KEYS) payment_nature?: string;
  @IsOptional() @IsString() @MaxLength(100) order_no?: string;
  @IsOptional() @IsString() @MaxLength(1000) remark?: string;
}

class CashFlowListDto {
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
  @IsOptional() @IsUUID() subject_id?: string;
  /** 分类（科目类别）筛选。 */
  @IsOptional() @IsString() @MaxLength(30) category?: string;
  @IsOptional() @IsString() @MaxLength(10) currency?: string;
  @IsOptional() @IsIn(["income", "expense"]) direction?: string;
  @IsOptional() @IsUUID() bank_id?: string;
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
        subjectId: query.subject_id,
        category: query.category,
        currency: query.currency,
        direction: query.direction,
        bankId: query.bank_id,
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
