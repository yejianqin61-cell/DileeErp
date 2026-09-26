import { Body, Controller, Get, Param, Post, Res, UseGuards } from "@nestjs/common";
import { IsDateString, IsOptional, IsString, MaxLength } from "class-validator";
import type { Response } from "express";
import { CurrentUser } from "../../platform/audit/current-user.decorator";
import type { CurrentUser as CurrentUserType } from "../../platform/auth/auth.service";
import { AuthenticationGuard } from "../../platform/authorization/authentication.guard";
import { ModulePermissionGuard } from "../../platform/authorization/module-permission.guard";
import { RequireModules } from "../../platform/authorization/require-modules.decorator";
import { BankTransferSlipService } from "./bank-transfer-slip.service";
import type { BankTransferSlip } from "./bank-transfer-slip";

/**
 * 跨行转账单的格子（字段名 = 财务给的 `example/财务/跨行转账单.html` 里的 `data-docx-field`）。
 *
 * 长度上限都写了：单子是打印件，字段不与数据库列对齐（它不落库），但无上限的字符串会被原样
 * 写进 xlsx 单元格 —— 一个粘贴进来的十万字附言能把工作簿撑坏（与收/付款单同一条理由）。
 */
class BankTransferSlipDto {
  /** 来源互转单 id：**不校验成 UUID**（手写单子没有来源），只用于审计追源。 */
  @IsOptional() @IsString() @MaxLength(64) transfer_id?: string;
  @IsString() @MaxLength(100) document_no!: string;
  @IsString() @MaxLength(200) payer_name!: string;
  @IsString() @MaxLength(100) payer_account!: string;
  @IsOptional() @IsString() @MaxLength(200) payer_bank?: string;
  @IsString() @MaxLength(200) payee_name!: string;
  @IsString() @MaxLength(100) payee_account!: string;
  @IsOptional() @IsString() @MaxLength(200) payee_bank?: string;
  @IsOptional() @IsString() @MaxLength(50) payee_bank_no?: string;
  @IsDateString() transfer_date!: string;
  @IsOptional() @IsString() @MaxLength(10) currency?: string;
  @IsOptional() @IsString() @MaxLength(30) exchange_rate?: string;
  @IsString() @MaxLength(30) amount_original!: string;
  @IsOptional() @IsString() @MaxLength(30) amount_cny?: string;
  @IsOptional() @IsString() @MaxLength(200) amount_in_words?: string;
  @IsOptional() @IsString() @MaxLength(500) remark?: string;
  @IsOptional() @IsString() @MaxLength(100) maker?: string;
  @IsOptional() @IsString() @MaxLength(100) reviewer?: string;
  @IsOptional() @IsString() @MaxLength(100) cashier?: string;
  @IsOptional() @IsString() @MaxLength(100) approver?: string;
}

/**
 * 跨行转账单（财务 2026-09-24：「银行账户互转的时候，跨行转账单，支持编辑这个样式的表单，
 * 并且支持导出打印」）。
 *
 * 两条路由：
 *   - `GET /finance/bank-transfers/:id/slip`：按互转单预填（不落库、不改任何数据）；
 *   - `POST /finance/bank-transfer-slips.xlsx`：把界面上编辑好的单子渲染成 xlsx 下发。
 *
 * 为什么导出不带 `:id`：导出的内容**完全以界面提交的为准**（财务改了联行号/用途/收款人，
 * 出的就该是她改过的那张）。带上 id 只会让人以为「服务端会拿库里的值覆盖我填的东西」。
 * 来源关系走请求体里的 `transfer_id`，只进审计。
 *
 * 挂在与 `BankTransferController` 同一个前缀下但不放进那个文件：那张表是**资金动作**
 * （改动余额、可冲销），这张单子是**打印件**（不改任何数据）—— 放一起会让人以为导出也会入账。
 */
@Controller("finance")
@UseGuards(AuthenticationGuard, ModulePermissionGuard)
@RequireModules("finance")
export class BankTransferSlipController {
  constructor(private readonly slips: BankTransferSlipService) {}

  @Get("bank-transfers/:id/slip")
  async draft(@Param("id") id: string, @CurrentUser() user: CurrentUserType) {
    return { data: await this.slips.draft(id, user), meta: {} };
  }

  @Post("bank-transfer-slips.xlsx")
  async export(@Body() body: BankTransferSlipDto, @CurrentUser() user: CurrentUserType, @Res() response: Response) {
    const result = await this.slips.export(this.toSlip(body), user);
    response.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    response.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(result.fileName)}`);
    response.setHeader("Cache-Control", "no-store");
    return response.send(result.body);
  }

  /** DTO → 纯函数要的形状：可选字段补齐成空串（模板上「没填」就是一格空白）。 */
  private toSlip(body: BankTransferSlipDto): BankTransferSlip {
    return {
      transfer_id: body.transfer_id ?? "",
      document_no: body.document_no,
      payer_name: body.payer_name,
      payer_account: body.payer_account,
      payer_bank: body.payer_bank ?? "",
      payee_name: body.payee_name,
      payee_account: body.payee_account,
      payee_bank: body.payee_bank ?? "",
      payee_bank_no: body.payee_bank_no ?? "",
      transfer_date: body.transfer_date,
      currency: body.currency ?? "",
      exchange_rate: body.exchange_rate ?? "",
      amount_original: body.amount_original,
      amount_cny: body.amount_cny ?? "",
      amount_in_words: body.amount_in_words ?? "",
      remark: body.remark ?? "",
      maker: body.maker ?? "",
      reviewer: body.reviewer ?? "",
      cashier: body.cashier ?? "",
      approver: body.approver ?? "",
    };
  }
}
