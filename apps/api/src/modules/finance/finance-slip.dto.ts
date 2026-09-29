import { Type } from "class-transformer";
import { ArrayMaxSize, IsArray, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, ValidateNested } from "class-validator";
import type { FinanceSlip, FinanceSlipKind } from "./finance-slip";

/**
 * 收/付款单的入参 DTO（**导出与保存共用一份**）。
 *
 * 为什么从控制器里搬出来单独成文件（2026-09-26）：这一轮多了「保存」这条路，
 * 而保存与导出认的是**同一张单子**。字段清单抄成两份的那天起，「导出能过的单子存不下来」
 * （或反过来）就只是时间问题 —— 而两处的 422 文案还不一样，用户没法自己看出来。
 *
 * 金额一律 `@IsString()`：全站金额都是**字符串十进制**（DECIMAL(18,4)），
 * 具体是不是合法金额由 `finance-slip.ts` 的同一套纯函数判定 —— 那一套前端也在用，
 * 两处口径一致才不会出现「界面说能导出、后端说不行」。
 */
export class FinanceSlipLineDto {
  @IsOptional() @IsString() @MaxLength(500) summary?: string;
  @IsOptional() @IsString() @MaxLength(200) general_subject?: string;
  @IsOptional() @IsString() @MaxLength(200) detail_subject?: string;
  @IsOptional() @IsString() @MaxLength(50) debit?: string;
  @IsOptional() @IsString() @MaxLength(50) credit?: string;
  @IsOptional() @IsString() @MaxLength(500) remark?: string;
}

export class FinanceSlipDto {
  @IsString() @MaxLength(100) slip_no!: string;
  @IsString() @MaxLength(20) slip_date!: string;
  @IsOptional() @IsString() @MaxLength(50) slip_method?: string;
  @IsString() @MaxLength(200) counterparty_name!: string;
  /**
   * 我方 / 对方各两格（用户 2026-09-24：「付款单/收款单上，我方和对方账户都分别设置对应的字段」）。
   *
   * 原来的 `bank_name` / `bank_account` **已删除**，不是改名：它的语义本来就是错的
   * （预填塞的是我方账户，而模板上那是对方的栏位）。留着旧字段只会让「填到哪一格」继续含糊，
   * 所以这是一次有意的破坏性改动 —— 前端同一提交内改完，契约测试钉住新字段名。
   */
  @IsOptional() @IsString() @MaxLength(200) our_bank_name?: string;
  @IsOptional() @IsString() @MaxLength(100) our_bank_account?: string;
  @IsOptional() @IsString() @MaxLength(200) counterparty_bank_name?: string;
  @IsOptional() @IsString() @MaxLength(100) counterparty_bank_account?: string;
  /** 币种（模板上没有这一格，只用于界面上「哪张是哪张」与审计）。 */
  @IsOptional() @IsString() @MaxLength(10) currency?: string;
  /** 汇率（人民币付款留空）。精度由 `finance-slip.ts` 的 `toRateUnits` 判定（≤8 位小数）。 */
  @IsOptional() @IsString() @MaxLength(30) exchange_rate?: string;
  /** 折合人民币（**手填**，系统不自动折算）。 */
  @IsOptional() @IsString() @MaxLength(30) amount_cny?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(9999) attachment_count?: number;
  @IsOptional() @IsString() @MaxLength(1000) remark?: string;
  @IsOptional() @IsString() @MaxLength(100) maker?: string;
  /**
   * 分录行。**有上限**（100 行）：单子是打印件，一张单子几十行已经到顶，而没有上限的数组
   * 会被原样渲染出一张几百行的表（那是拒绝服务，不是导出）。
   */
  @IsArray() @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => FinanceSlipLineDto) lines!: FinanceSlipLineDto[];
}

/** 保存一张单子的入参：单子的内容 + 它是哪种单据（导出走两条路径，种类在 URL 里）。 */
export class FinanceSlipSaveDto extends FinanceSlipDto {
  @IsIn(["payment", "receipt"]) kind!: FinanceSlipKind;
  /**
   * 预填时勾选的条目 id（付款单 = 应付条目、收款单 = 应收来源）。
   * 只是**追溯**用：保存不校验它们还在不在（条目可以被删掉，而单子已经打出去了）。
   */
  @IsOptional() @IsArray() @ArrayMaxSize(500) @IsUUID(undefined, { each: true }) source_entry_ids?: string[];
}

/** DTO → 纯函数要的形状：把可选字段补齐成空串（模板上「没填」就是一格空白）。 */
export function financeSlipFromDto(kind: FinanceSlipKind, body: FinanceSlipDto): FinanceSlip {
  return {
    kind,
    slip_no: body.slip_no,
    slip_date: body.slip_date,
    slip_method: body.slip_method ?? "",
    counterparty_name: body.counterparty_name,
    our_bank_name: body.our_bank_name ?? "",
    our_bank_account: body.our_bank_account ?? "",
    counterparty_bank_name: body.counterparty_bank_name ?? "",
    counterparty_bank_account: body.counterparty_bank_account ?? "",
    currency: body.currency ?? "",
    exchange_rate: body.exchange_rate ?? "",
    amount_cny: body.amount_cny ?? "",
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
