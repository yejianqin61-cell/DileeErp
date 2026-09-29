import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { Type } from "class-transformer";
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from "class-validator";
import { CurrentUser } from "../../platform/audit/current-user.decorator";
import type { CurrentUser as CurrentUserType } from "../../platform/auth/auth.service";
import { AuthenticationGuard } from "../../platform/authorization/authentication.guard";
import { ModulePermissionGuard } from "../../platform/authorization/module-permission.guard";
import { RequireModules } from "../../platform/authorization/require-modules.decorator";
import { FinanceSlipSaveDto, financeSlipFromDto } from "./finance-slip.dto";
import { FinanceSlipStoreService } from "./finance-slip-store.service";

class FinanceSlipListDto {
  @IsOptional() @IsIn(["payment", "receipt"]) kind?: "payment" | "receipt";
  /** 对方单位的关键字（模糊，不区分大小写）。 */
  @IsOptional() @IsString() @MaxLength(100) counterparty?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) page_size = 20;
}

class ReasonDto {
  @IsString() @MaxLength(1000) reason!: string;
}

/**
 * 收/付款单的存档（保存 / 列表 / 再打开 / 删除）。
 *
 * 单独一个控制器而不是往 `finance-slip.controller.ts` 里塞：那一个负责的是
 * 「按条目预填」与「导出 xlsx」——**都不落库**；这一个负责「这张单子存下来」。
 * 两件事的权限、失败方式与测试都不同，混在一个文件里最后会变成一份什么都干的控制器。
 *
 * 路由独立成 `finance/slips`：`finance/payment-slips.xlsx` 那一族是**导出**，
 * `finance/slips` 是**存档**，两者在地址上就不该看起来像同一条路
 * （否则「我存的是哪张」这种问题只能靠读代码回答）。
 *
 * 读写都用 `finance` 模块权限（**不额外要求管理员**）：出单、存档、作废是财务的本职动作，
 * 一天要做十几次，锁管理员等于把这条链掐断。真正的账务动作（确认付款/生成凭证）仍是另一条链。
 */
@Controller("finance/slips")
@UseGuards(AuthenticationGuard, ModulePermissionGuard)
@RequireModules("finance")
export class FinanceSlipStoreController {
  constructor(private readonly slips: FinanceSlipStoreService) {}

  @Get()
  async list(@Query() query: FinanceSlipListDto) {
    return this.slips.list({ kind: query.kind, page: query.page, pageSize: query.page_size, counterparty: query.counterparty });
  }

  @Get(":id")
  async get(@Param("id") id: string) {
    return { data: { slip: await this.slips.get(id) }, meta: {} };
  }

  /**
   * 保存一张新单子。
   *
   * 返回 `{ slip }` 而不是裸对象：前端拿到它之后要**把 id 记回编辑器**（第二次保存就是覆盖这一张），
   * 包一层让「这条路的返回值是什么」在调用处一眼可见（与预填接口的 `{ slips: [...] }` 同一种写法）。
   */
  @Post()
  async create(@Body() body: FinanceSlipSaveDto, @CurrentUser() user: CurrentUserType) {
    return { data: { slip: await this.slips.save(financeSlipFromDto(body.kind, body), body.source_entry_ids, user) }, meta: {} };
  }

  /** 覆盖保存已存在的单子（编辑器里再点一次保存）。 */
  @Patch(":id")
  async update(@Param("id") id: string, @Body() body: FinanceSlipSaveDto, @CurrentUser() user: CurrentUserType) {
    return { data: { slip: await this.slips.save(financeSlipFromDto(body.kind, body), body.source_entry_ids, user, id) }, meta: {} };
  }

  /** 作废一张单子（逻辑删除，原因必填）。 */
  @Delete(":id")
  async remove(@Param("id") id: string, @Body() body: ReasonDto, @CurrentUser() user: CurrentUserType) {
    return { data: await this.slips.remove(id, body.reason, user), meta: {} };
  }
}
