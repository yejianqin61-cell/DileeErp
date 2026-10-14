import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Res, UseGuards } from "@nestjs/common";
import { IsArray, IsIn, IsOptional, IsString, MaxLength, ValidateNested } from "class-validator";
import { Type } from "class-transformer";
import type { Response } from "express";
import { CurrentUser } from "../../platform/audit/current-user.decorator";
import type { CurrentUser as CurrentUserType } from "../../platform/auth/auth.service";
import { AuthenticationGuard } from "../../platform/authorization/authentication.guard";
import { ModulePermissionGuard } from "../../platform/authorization/module-permission.guard";
import { RequireModules } from "../../platform/authorization/require-modules.decorator";
import { sendWorkbook } from "./finance-report-workbook";
import { VoucherService, SOURCE_VOUCHER } from "./voucher.service";
import { buildVoucherExportTable, type VoucherExportSource } from "./voucher-workbook";

class VoucherLineDto {
  @IsIn(["debit", "credit"]) direction!: string;
  @IsOptional() @IsString() @MaxLength(200) subject_key?: string;
  @IsOptional() @IsString() @MaxLength(200) subject_label?: string;
  @IsOptional() @IsString() @MaxLength(500) summary?: string;
  @IsString() amount!: string;
  /**
   * 资金行引用的银行账户（银行账户池 `banks`）。**可选**：不带时后端按行号沿用原分录的账户，
   * 所以只有「资金行换了位置」或「新加了一条资金行」时才需要显式传。
   */
  @IsOptional() @IsString() @MaxLength(64) bank_id?: string | null;
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

/**
 * 手工新增凭证（2026-09-24）。
 *
 * `voucher_date` 必填（决定会计期间），`lines` 至少两条且必须借贷相等（服务层校验并给出可读原因）。
 * `currency` 默认 CNY；`summary` 留空时服务层按期间给一句兜底。
 */
class VoucherCreateDto {
  @IsString() @MaxLength(20) voucher_date!: string;
  @IsOptional() @IsString() @MaxLength(10) currency?: string;
  @IsOptional() @IsString() @MaxLength(500) summary?: string;
  @IsOptional() @IsString() @MaxLength(1000) remark?: string;
  @IsArray() @ValidateNested({ each: true }) @Type(() => VoucherLineDto) lines!: VoucherLineDto[];
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

  /**
   * 记账凭证导出 xlsx（2026-10-13，用户：「记账凭证中，摘要也要一并导出」）。
   *
   * **一行一条分录**（摘要与会计科目都在分录行上，凭证头只有一个总摘要），列定义见
   * `voucher-workbook.ts`。筛选与列表接口同一个 DTO（`period` / `status`），
   * 所以"导出的就是当前筛出来的"这条口径在这里同样成立。
   *
   * ⚠️ 路由名 `export.xlsx` 是**单段**路径，必须声明在 `@Get(":id")` **之前** ——
   * 排在后面会被 `:id` 当成一个凭证 id 吃掉（同 finance.controller.ts 里 import-template 的教训）。
   * 不额外加 `@RequireAdministrator()`：它与列表（同一份数据、同一道 finance 门）权限一致，
   * 导出比看到多不了一层保护 —— 真正的边界是模块权限（类级 `@RequireModules("finance")`）。
   */
  @Get("export.xlsx")
  async exportXlsx(@Query() query: VoucherListDto, @Res() response: Response) {
    const rows = await this.vouchers.list(query);
    const table = buildVoucherExportTable(rows.map((row): VoucherExportSource => ({
      voucherNo: row.voucherNo,
      voucherDate: row.voucherDate,
      period: row.period,
      statusLabel: row.status_label,
      status: row.status,
      // 来源与列表列同一句文案（凭证纸上也这么写）：收支流水号 / 红冲 / 手工。
      sourceLabel: row.source_entry
        ? `收支流水 ${row.source_entry.entryNo}`
        : row.sourceType === SOURCE_VOUCHER ? `红冲凭证 ${row.sourceId ?? ""}`.trim() : "手工",
      summary: row.summary,
      currency: row.currency,
      remark: row.remark,
      lines: row.lines.map((line) => ({ lineNo: line.lineNo, summary: line.summary, subjectLabel: line.subjectLabel, direction: line.direction, amount: line.amount })),
    })));
    return sendWorkbook(response, table, "记账凭证");
  }

  /**
   * 记账凭证模板（工资计提 / 原材料采购）。财务 2026-09-20：「我完整的一个工资是这样的，
   * 但是现在都不能改」「原材料的也是要加上应交税费」。
   *
   * ⚠️ 必须声明在 `@Get(":id")` **之前**：`templates` 是单段路径，Nest 按声明顺序匹配，
   * 排在后面会被 `:id` 当成一个凭证 id 吃掉（同 finance.controller.ts 里 import-template 的那条注释）。
   * 这里用的是两段路径 `:id/templates`，本身不会与 `:id` 冲突，但把它放在最前面仍然更安全 ——
   * 将来加一个不依赖凭证的全局模板接口时，顺序已经是对的。
   */
  @Get(":id/templates")
  async templates(@Param("id") id: string) {
    return { data: await this.vouchers.templates(id), meta: {} };
  }

  @Get(":id")
  async get(@Param("id") id: string) {
    return { data: await this.vouchers.get(id), meta: {} };
  }

  /**
   * 手工新增凭证（折旧 / 摊销 / 工资计提 / 结转成本这类**非现金分录**没有收支流水可挂）。
   *
   * 声明在 `@Get(":id")` 之前的老规矩在这里同样适用：这是 `POST` 集合路由，
   * 与 `POST :id/post` 之类不冲突，但集合路由放在最前面是这条链路上的一致做法。
   */
  @Post()
  async create(@Body() body: VoucherCreateDto, @CurrentUser() user: CurrentUserType) {
    return { data: await this.vouchers.createManual(body, user), meta: {} };
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

  /** 重新生成草稿凭证：按来源流水**现在的**内容重算（摘要/分录/银行账户/金额/期间），会覆盖手工改动。 */
  @Post(":id/regenerate")
  async regenerate(@Param("id") id: string, @CurrentUser() user: CurrentUserType) {
    return { data: await this.vouchers.regenerate(id, user), meta: {} };
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
