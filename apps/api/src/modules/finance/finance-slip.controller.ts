import { Body, Controller, Post, Res, UseGuards } from "@nestjs/common";
import { Type } from "class-transformer";
import { ArrayMaxSize, ArrayNotEmpty, IsArray, IsUUID, ValidateNested } from "class-validator";
import type { Response } from "express";
import { CurrentUser } from "../../platform/audit/current-user.decorator";
import type { CurrentUser as CurrentUserType } from "../../platform/auth/auth.service";
import { AuthenticationGuard } from "../../platform/authorization/authentication.guard";
import { ModulePermissionGuard } from "../../platform/authorization/module-permission.guard";
import { RequireModules } from "../../platform/authorization/require-modules.decorator";
import { financeSlipFromDto, FinanceSlipDto } from "./finance-slip.dto";
import { FinanceSlipService } from "./finance-slip.service";
import type { FinanceSlip, FinanceSlipKind } from "./finance-slip";

/**
 * 「全部导出」的入参：队列里的**全部**单子（不是单张）。
 *
 * 有长度上限（100 张）：这是打印件的队列，一次集中付款上百张一定是选错了范围；
 * 没有上限时一个超大 body 会在服务端渲染出一本几百个工作表的工作簿，那是拒绝服务而不是导出。
 */
class FinanceSlipBatchDto {
  @IsArray() @ArrayNotEmpty() @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => FinanceSlipDto) slips!: FinanceSlipDto[];
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
 * 六个路由，职责分得很清楚：
 *   - `POST /finance/payment-slips/draft`、`POST /finance/receipt-slips/draft`：按勾选的条目**预填**
 *     单子（不落库、不改任何数据）。批量勾选跨对方单位 / 跨币种时返回**多张**（`slips` 数组）——
 *     用户 2026-09-24：「还是不能实现一起付款，只能算是一起确认了，然后还是一个个的改付款单」；
 *   - `POST /finance/payment-slips.xlsx`、`POST /finance/receipt-slips.xlsx`：把界面上编辑好的**一张**
 *     渲染成 xlsx 下发；
 *   - `POST /finance/payment-slips/batch.xlsx`、`POST /finance/receipt-slips/batch.xlsx`：把队列里的
 *     **全部**张渲染成同一个工作簿（一张单子一个工作表），一次拿全。
 *
 * 为什么不合成一条：预填要读库（对方单位 / 银行 / 科目 / 单号），导出只认界面提交的内容 ——
 * 合成一条就会出现「导出的到底是我改过的，还是系统又算了一遍的」这种说不清的情况。
 * 单张与批量也不合成：单张导出保持「一个文件一张单子」这个银行认可的形态，
 * 批量导出是为了一次拿到全部（逐张下载会被浏览器拦掉）。
 *
 * **存档**（保存 / 列表 / 再打开 / 删除）不在这里：它是另一件事 ——
 * 「这张单子我改到一半，先存下来」。见 `finance-slip-store.controller.ts`。
 */
@Controller("finance")
@UseGuards(AuthenticationGuard, ModulePermissionGuard)
@RequireModules("finance")
export class FinanceSlipController {
  constructor(private readonly slips: FinanceSlipService) {}

  /** 预填：返回 `{ slips: [...] }`（一张或多张），`meta.slip_count` 给界面显示「共拆成 N 张」。 */
  @Post("payment-slips/draft")
  async draftPayment(@Body() body: PaymentSlipDraftDto, @CurrentUser() user: CurrentUserType) {
    return this.drafted(await this.slips.draft("payment", body.payable_entry_ids, user));
  }

  @Post("receipt-slips/draft")
  async draftReceipt(@Body() body: ReceiptSlipDraftDto, @CurrentUser() user: CurrentUserType) {
    return this.drafted(await this.slips.draft("receipt", body.receivable_source_ids, user));
  }

  @Post("payment-slips.xlsx")
  async exportPaymentSlip(@Body() body: FinanceSlipDto, @CurrentUser() user: CurrentUserType, @Res() response: Response) {
    return this.send(response, await this.slips.export(this.toSlip("payment", body), user));
  }

  @Post("receipt-slips.xlsx")
  async exportReceiptSlip(@Body() body: FinanceSlipDto, @CurrentUser() user: CurrentUserType, @Res() response: Response) {
    return this.send(response, await this.slips.export(this.toSlip("receipt", body), user));
  }

  @Post("payment-slips/batch.xlsx")
  async exportPaymentSlips(@Body() body: FinanceSlipBatchDto, @CurrentUser() user: CurrentUserType, @Res() response: Response) {
    return this.send(response, await this.slips.exportMany(body.slips.map((slip) => this.toSlip("payment", slip)), user));
  }

  @Post("receipt-slips/batch.xlsx")
  async exportReceiptSlips(@Body() body: FinanceSlipBatchDto, @CurrentUser() user: CurrentUserType, @Res() response: Response) {
    return this.send(response, await this.slips.exportMany(body.slips.map((slip) => this.toSlip("receipt", slip)), user));
  }

  private drafted(slips: FinanceSlip[]) {
    return { data: { slips }, meta: { slip_count: slips.length } };
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

  /** DTO → 纯函数要的形状（映射也搬到了 `finance-slip.dto.ts`：保存那条路认的是同一张单子）。 */
  private toSlip(kind: FinanceSlipKind, body: FinanceSlipDto): FinanceSlip {
    return financeSlipFromDto(kind, body);
  }
}
