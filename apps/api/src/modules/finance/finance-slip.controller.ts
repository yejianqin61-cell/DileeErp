import { Body, Controller, Post, Res, UseGuards } from "@nestjs/common";
import { Type } from "class-transformer";
import { ArrayNotEmpty, IsArray, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, ValidateNested } from "class-validator";
import type { Response } from "express";
import { CurrentUser } from "../../platform/audit/current-user.decorator";
import type { CurrentUser as CurrentUserType } from "../../platform/auth/auth.service";
import { AuthenticationGuard } from "../../platform/authorization/authentication.guard";
import { ModulePermissionGuard } from "../../platform/authorization/module-permission.guard";
import { RequireModules } from "../../platform/authorization/require-modules.decorator";
import { FinanceSlipService } from "./finance-slip.service";
import type { FinanceSlip, FinanceSlipKind } from "./finance-slip";

/**
 * 收/付款单的一行（模板上的六格）。
 *
 * 金额用 `@IsString()` 而不是 `@IsDecimal()`：全站金额都是**字符串十进制**（DECIMAL(18,4)），
 * 具体是不是合法金额由 `finance-slip.ts` 的同一套纯函数判定 —— 那一套前端也在用，
 * 两处口径一致才不会出现「界面说能导出、后端说不行」。
 */
class FinanceSlipLineDto {
  @IsOptional() @IsString() @MaxLength(500) summary?: string;
  @IsOptional() @IsString() @MaxLength(200) general_subject?: string;
  @IsOptional() @IsString() @MaxLength(200) detail_subject?: string;
  @IsOptional() @IsString() @MaxLength(50) debit?: string;
  @IsOptional() @IsString() @MaxLength(50) credit?: string;
  @IsOptional() @IsString() @MaxLength(500) remark?: string;
}

/**
 * 收/付款单的表头 + 明细。
 *
 * 长度上限都写了：单子是打印件，字段长度不与数据库列对齐（它不落库），但**必须有上限** ——
 * 无上限的字符串会被原样写进 xlsx 单元格，一个粘贴进来的十万字备注能把工作簿撑坏。
 */
class FinanceSlipDto {
  @IsString() @MaxLength(100) slip_no!: string;
  @IsString() @MaxLength(20) slip_date!: string;
  @IsOptional() @IsString() @MaxLength(50) slip_method?: string;
  @IsString() @MaxLength(200) counterparty_name!: string;
  @IsOptional() @IsString() @MaxLength(200) bank_name?: string;
  @IsOptional() @IsString() @MaxLength(100) bank_account?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(9999) attachment_count?: number;
  @IsOptional() @IsString() @MaxLength(1000) remark?: string;
  @IsOptional() @IsString() @MaxLength(100) maker?: string;
  @IsArray() @ValidateNested({ each: true }) @Type(() => FinanceSlipLineDto) lines!: FinanceSlipLineDto[];
}

/** 付款单预填的入参：勾选的应付条目。 */
class PaymentSlipDraftDto {
  @IsArray() @ArrayNotEmpty() @IsUUID(undefined, { each: true }) payable_entry_ids!: string[];
}

/** 收款单预填的入参：勾选的应收条目。 */
class ReceiptSlipDraftDto {
  @IsArray() @ArrayNotEmpty() @IsUUID(undefined, { each: true }) receivable_source_ids!: string[];
}

/**
 * 收/付款单（财务 2026-09-20：「付款界面能导出付款单」+「我可以自己填加行，我可以写付款备注」，
 * 随后补一句「同理，收款单的编辑和导出」）。
 *
 * 四个路由，职责分得很清楚：
 *   - `POST /finance/payment-slips/draft`、`POST /finance/receipt-slips/draft`：按勾选的条目**预填**
 *     一张单子（不落库、不改任何数据）；
 *   - `POST /finance/payment-slips.xlsx`、`POST /finance/receipt-slips.xlsx`：把界面上编辑好的那张
 *     渲染成 xlsx 下发。
 *
 * 为什么不合成一条：预填要读库（对方单位 / 银行 / 科目 / 单号），导出只认界面提交的内容 ——
 * 合成一条就会出现「导出的到底是我改过的，还是系统又算了一遍的」这种说不清的情况。
 */
@Controller("finance")
@UseGuards(AuthenticationGuard, ModulePermissionGuard)
@RequireModules("finance")
export class FinanceSlipController {
  constructor(private readonly slips: FinanceSlipService) {}

  @Post("payment-slips/draft")
  async draftPayment(@Body() body: PaymentSlipDraftDto, @CurrentUser() user: CurrentUserType) {
    return { data: await this.slips.draft("payment", body.payable_entry_ids, user), meta: {} };
  }

  @Post("receipt-slips/draft")
  async draftReceipt(@Body() body: ReceiptSlipDraftDto, @CurrentUser() user: CurrentUserType) {
    return { data: await this.slips.draft("receipt", body.receivable_source_ids, user), meta: {} };
  }

  @Post("payment-slips.xlsx")
  async exportPaymentSlip(@Body() body: FinanceSlipDto, @CurrentUser() user: CurrentUserType, @Res() response: Response) {
    return this.send(response, await this.slips.export(this.toSlip("payment", body), user));
  }

  @Post("receipt-slips.xlsx")
  async exportReceiptSlip(@Body() body: FinanceSlipDto, @CurrentUser() user: CurrentUserType, @Res() response: Response) {
    return this.send(response, await this.slips.export(this.toSlip("receipt", body), user));
  }

  /**
   * 与其余导出一致：`Content-Type` + `filename*=UTF-8''`（中文文件名）+ `no-store`
   * 三件事一处写全，否则中文文件名在部分浏览器上会乱码、或者下载被缓存住。
   */
  private send(response: Response, result: { body: Buffer; fileName: string }) {
    response.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    response.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(result.fileName)}`);
    response.setHeader("Cache-Control", "no-store");
    return response.send(result.body);
  }

  /** DTO → 纯函数要的形状：把可选字段补齐成空串（模板上「没填」就是一格空白）。 */
  private toSlip(kind: FinanceSlipKind, body: FinanceSlipDto): FinanceSlip {
    return {
      kind,
      slip_no: body.slip_no,
      slip_date: body.slip_date,
      slip_method: body.slip_method ?? "",
      counterparty_name: body.counterparty_name,
      bank_name: body.bank_name ?? "",
      bank_account: body.bank_account ?? "",
      attachment_count: body.attachment_count ?? 0,
      remark: body.remark ?? "",
      maker: body.maker ?? "",
      lines: body.lines.map((line) => ({
        summary: line.summary ?? "",
        general_subject: line.general_subject ?? "",
        detail_subject: line.detail_subject ?? "",
        debit: line.debit ?? "",
        credit: line.credit ?? "",
        remark: line.remark ?? "",
      })),
    };
  }
}
