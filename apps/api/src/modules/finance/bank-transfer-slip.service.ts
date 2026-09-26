import { Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { AuditService } from "../../platform/audit/audit.service";
import { makerStamp } from "../../platform/audit/maker-stamp";
import type { CurrentUser } from "../../platform/auth/auth.service";
import { PrismaService } from "../../platform/database/prisma.service";
import {
  bankTransferSlipFileName,
  bankTransferSlipFromTransfer,
  renderBankTransferSlipWorkbook,
  transferSlipCnyAmount,
  transferSlipWords,
  validateBankTransferSlip,
  type BankTransferSlip,
} from "./bank-transfer-slip";

/**
 * 跨行转账单的**预填与导出**（财务 2026-09-24）。
 *
 *   - `draft(id)`：按一笔互转记录预填单据（双方的全称 / 账号 / 开户行、日期、币种、汇率、
 *     原币金额、折合人民币、用途）。预填只是起点，财务在界面上改联行号、用途、签字格；
 *   - `export(slip)`：校验后渲染 xlsx 并审计。**以界面提交的内容为准**，不回头覆盖成系统算的值。
 *
 * 为什么预填放在服务端：账户名（`banks.account_name`）与汇率只有服务端读得到，
 * 而「折合人民币取哪条腿」是一条口径（外币转外币时那一格必须留空），不该在界面上再判断一次。
 *
 * 单子**不落库**：事实是 `bank_transfers` 那条记录，这张纸是交给银行的打印件（与收/付款单一致）。
 */
@Injectable()
export class BankTransferSlipService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  /** 按互转单预填一张跨行转账单。 */
  async draft(id: string, user: CurrentUser): Promise<BankTransferSlip> {
    const transfer = await this.prisma.bankTransfer.findFirst({
      where: { id, deletedAt: null },
      select: {
        transferNo: true,
        transferDate: true,
        fromCurrency: true,
        toCurrency: true,
        fromAmount: true,
        toAmount: true,
        exchangeRate: true,
        remark: true,
        fromBank: { select: { bankName: true, accountName: true, accountNumber: true } },
        toBank: { select: { bankName: true, accountName: true, accountNumber: true } },
      },
    });
    if (!transfer) throw new NotFoundException({ code: "BANK_TRANSFER_NOT_FOUND", message: "银行互转记录不存在", details: [] });
    return { ...bankTransferSlipFromTransfer(transfer, user.display_name ?? ""), transfer_id: id };
  }

  /**
   * 导出跨行转账单 xlsx。
   *
   * 校验不过 422 并一次说完（与收/付款单同一纪律）。审计落在 `bank_transfer_slip.export`，
   * entityId 记的是**来源互转单**（`transfer_id` 为空的手写单子就没有 entityId）——
   * 这样从审计能追回「这张纸是从哪笔资金动作开出来的」。
   */
  async export(slip: BankTransferSlip, user: CurrentUser): Promise<{ body: Buffer; fileName: string }> {
    const problems = validateBankTransferSlip(slip);
    if (problems.length) {
      throw new UnprocessableEntityException({
        code: problems[0].code,
        message: problems.map((problem) => problem.message).join("；"),
        details: problems.map((problem) => ({ code: problem.code, ...(problem.details[0] ?? {}) })),
      });
    }
    const body = await renderBankTransferSlipWorkbook({ ...slip, footnote: makerStamp(user) });
    await this.audit.record("bank_transfer_slip.export", "bank_transfer_slip", user.id, slip.transfer_id.trim() || undefined, {
      document_no: slip.document_no,
      currency: slip.currency,
      amount_original: slip.amount_original,
      amount_cny: transferSlipCnyAmount(slip) || null,
      amount_in_words: transferSlipWords(slip),
    });
    return { body, fileName: bankTransferSlipFileName(slip) };
  }
}
