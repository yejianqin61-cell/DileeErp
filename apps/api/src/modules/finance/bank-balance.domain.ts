/**
 * 银行余额与账户互转的**纯计算**（不碰 Prisma、不碰 HTTP）。
 *
 * 为什么单独成模块：余额是财务对着银行对账单核的数字，算法只有一处才不会出现
 * 「列表页一个余额、互转页另一个余额」。这里的函数是唯一口径，服务层只负责取数。
 *
 * 余额公式（`docs/design/bank-balance-and-transfer-2026-09-16.md`）：
 *
 *     余额 = 期初余额 + 生效收入流水 − 生效支出流水 + 转入 − 转出
 *
 * 三条口径要记住：
 *   1. 只算 `status = posted` 的流水；已冲销（reversed）的一律不算 —— 冲销就是「这笔没发生过」。
 *   2. **只算落在本账户上的流水**（`cash_flow_entries.bank_id`）。没指定银行账户的流水仍然是
 *      收支事实（报表里有），但它不属于任何一个账户，因此不进任何账户的余额。
 *   3. 互转不是收支：它只改变余额，不进收支明细/汇总表。这是有意的，不是漏算。
 */
import { Prisma } from "@prisma/client";

export type BankBalanceParts = {
  cashIn: Prisma.Decimal;
  cashOut: Prisma.Decimal;
  transferIn: Prisma.Decimal;
  transferOut: Prisma.Decimal;
};

export type BankBalance = BankBalanceParts & {
  opening: Prisma.Decimal;
  balance: Prisma.Decimal;
};

const ZERO = new Prisma.Decimal(0);

export const emptyBankBalanceParts = (): BankBalanceParts => ({ cashIn: ZERO, cashOut: ZERO, transferIn: ZERO, transferOut: ZERO });

/** 期初 + 四路流水 → 余额（唯一算法，服务层与测试共用）。 */
export function bankBalance(opening: Prisma.Decimal | string | number, parts: BankBalanceParts): BankBalance {
  const start = new Prisma.Decimal(opening ?? 0);
  return {
    opening: start,
    ...parts,
    balance: start.plus(parts.cashIn).minus(parts.cashOut).plus(parts.transferIn).minus(parts.transferOut),
  };
}

/** 互转的一个币种方向：金额恒为正，方向由「本方/对方」决定（与收支流水同一约定）。 */
export type TransferAmounts = { fromAmount: Prisma.Decimal; toAmount: Prisma.Decimal; exchangeRate: Prisma.Decimal };

export type TransferAmountError = "INVALID_TRANSFER_AMOUNT" | "SAME_CURRENCY_AMOUNT_MISMATCH";

/**
 * 互转的双边金额校验与汇率快照。
 *
 * 同币种必须两边相等：`A 账户 −100 / B 账户 +99` 不是转账，是凭空少了 1 块钱 —— 这种「差额」
 * 只能是汇兑损益或手续费，而这两个概念本系统都还没有科目承载，所以宁可挡住也不静默接受。
 * 跨币种则必须由财务填实际到账数，汇率按 `toAmount / fromAmount` 记账（只做快照，不参与换算）。
 */
export function transferAmounts(input: {
  fromAmount: string | number | Prisma.Decimal;
  toAmount?: string | number | Prisma.Decimal | null;
  fromCurrency: string;
  toCurrency: string;
}): { ok: true; value: TransferAmounts } | { ok: false; code: TransferAmountError } {
  let from: Prisma.Decimal;
  try {
    from = new Prisma.Decimal(input.fromAmount);
    if (from.lte(0)) throw new Error("non-positive");
  } catch {
    return { ok: false, code: "INVALID_TRANSFER_AMOUNT" };
  }
  const sameCurrency = input.fromCurrency === input.toCurrency;
  // 对方金额缺省：同币种按本方金额（转账不换汇，金额必然一致）；跨币种没有默认值可言，必须显式给。
  const raw = input.toAmount === undefined || input.toAmount === null || input.toAmount === "" ? (sameCurrency ? from : null) : input.toAmount;
  if (raw === null) return { ok: false, code: "INVALID_TRANSFER_AMOUNT" };
  let to: Prisma.Decimal;
  try {
    to = new Prisma.Decimal(raw);
    if (to.lte(0)) throw new Error("non-positive");
  } catch {
    return { ok: false, code: "INVALID_TRANSFER_AMOUNT" };
  }
  if (sameCurrency && !to.eq(from)) return { ok: false, code: "SAME_CURRENCY_AMOUNT_MISMATCH" };
  return { ok: true, value: { fromAmount: from, toAmount: to, exchangeRate: to.div(from).toDecimalPlaces(6) } };
}

/** 一个账户在某次互转里的净影响（转出为负、转入为正），用于把互转折进余额。 */
export function transferEffect(bankId: string, row: { fromBankId: string; fromAmount: Prisma.Decimal; toBankId: string; toAmount: Prisma.Decimal }): Prisma.Decimal {
  let effect = new Prisma.Decimal(0);
  if (row.fromBankId === bankId) effect = effect.minus(row.fromAmount);
  if (row.toBankId === bankId) effect = effect.plus(row.toAmount);
  return effect;
}
