// 银行账户池（banks）取用助手。
//
// 背景：财务的收付款与对账都要指明「钱走哪个账户」，账户主数据只有一处（财务 → 银行账户，GET /finance/banks）。
// 因此所有写入 bank_id 的路径都必须先校验：账户存在、未删除、且**未停用**。
// 为什么不能只靠外键：停用的账户仍然在库里，FK 不会拦；只靠前端下拉过滤也不够（接口可以被直接调用）。
// 校验失败一律 404 + BANK_NOT_FOUND，与应付对账（SupplierPayableReconciliationService.create）保持一致。
import { NotFoundException } from "@nestjs/common";

export type BankRef = { id: string; bankName: string; accountNumber: string };

/** 结构化入参：既能接受 PrismaService，也能接受 $transaction 里的 tx 客户端。 */
type BankReader = { bank: { findFirst: (args: any) => Promise<any> } };

/**
 * 校验并取回可用的银行账户。
 *
 * @param bankId 为空（undefined / null / 空串）时视为「不选银行」，直接返回 null —— 银行是可选字段。
 */
export async function requireActiveBank(client: BankReader, bankId: string | null | undefined, message = "支付银行不存在或已停用"): Promise<BankRef | null> {
  const id = bankId?.trim();
  if (!id) return null;
  const bank = await client.bank.findFirst({ where: { id, deletedAt: null, isActive: true }, select: { id: true, bankName: true, accountNumber: true } });
  if (!bank) throw new NotFoundException({ code: "BANK_NOT_FOUND", message, details: [] });
  return bank as BankRef;
}
