import { UnprocessableEntityException } from "@nestjs/common";
import { Prisma } from "@prisma/client";

export type PayrollSource = { wage_mode: "piece" | "time"; quantity: string; duration_minutes: string; amount: string };

/** 金额既可能是 Prisma.Decimal（库读出的行），也可能是 string / number（DTO 与测试夹具）。 */
type Amount = Prisma.Decimal | string | number;
const dec = (input: Amount): Prisma.Decimal => (input instanceof Prisma.Decimal ? input : new Prisma.Decimal(input));

/**
 * 工资台账的全部类目金额，也就是应发公式的输入。
 *
 * 为什么要把它列全在一个类型里：应发公式原先在五个地方各写了一遍（列表 balances、详情 summary、
 * 付款后 refreshStatus、工资应付 netAmount、工资付款过账的内联算式）。2026-09-15 给台账加了
 * 房补与三种扣款之后，只要漏改其中一处，同一张台账就会在不同页面显示不同的应发金额。
 * 现在这五处全部调用 payrollBaseAmount，公式只有这一份实现。
 */
export type PayrollAmountFields = {
  base_salary: Amount;
  production_source_amount: Amount;
  overtime_amount: Amount;
  attendance_deduction: Amount;
  late_deduction: Amount;
  absence_deduction: Amount;
  early_leave_deduction: Amount;
  performance_amount: Amount;
  allowance_amount: Amount;
  housing_allowance: Amount;
  social_insurance: Amount;
  individual_tax: Amount;
  other_adjustment: Amount;
};

/** 类目应发（不含已过账调整）：基本工资 + 生产来源 + 加班 − 考勤扣款 + 绩效 + 补贴 + 房补 − 迟到 − 旷工 − 早退 − 社保 − 个税 + 其他调整。 */
export function payrollBaseAmount(fields: PayrollAmountFields): Prisma.Decimal {
  return dec(fields.base_salary)
    .plus(dec(fields.production_source_amount))
    .plus(dec(fields.overtime_amount))
    .minus(dec(fields.attendance_deduction))
    .minus(dec(fields.late_deduction))
    .minus(dec(fields.absence_deduction))
    .minus(dec(fields.early_leave_deduction))
    .plus(dec(fields.performance_amount))
    .plus(dec(fields.allowance_amount))
    .plus(dec(fields.housing_allowance))
    .minus(dec(fields.social_insurance))
    .minus(dec(fields.individual_tax))
    .plus(dec(fields.other_adjustment));
}

/**
 * 「基本工资」这一格的值：车间的生产工资就放在这里。
 *
 * 车间员工的生产工资存在 production_source_amount（由生产日报自动汇总，不可手改），
 * 非车间员工没有生产来源（恒为 0），所以这一格对两类员工都等于「基本工资池」的全部。
 */
export function payrollBasicSalaryAmount(fields: Pick<PayrollAmountFields, "base_salary" | "production_source_amount">): Prisma.Decimal {
  return dec(fields.base_salary).plus(dec(fields.production_source_amount));
}

/**
 * 「其他增减」这一格的值：除 6 个可编辑类目之外的历史类目净额。
 *
 * 2026-09-15 的类目清单只要求 6 个可编辑类目，但加班/考勤扣款/补贴/社保/个税/其他调整都参与应发。
 * 不把它显示出来，表上就会出现「应发 ≠ 可见列之和」的黑洞，所以单列一个只读列把它兜住。
 */
export function payrollOtherAdjustmentAmount(fields: Pick<PayrollAmountFields, "overtime_amount" | "attendance_deduction" | "allowance_amount" | "social_insurance" | "individual_tax" | "other_adjustment">): Prisma.Decimal {
  return dec(fields.overtime_amount)
    .minus(dec(fields.attendance_deduction))
    .plus(dec(fields.allowance_amount))
    .minus(dec(fields.social_insurance))
    .minus(dec(fields.individual_tax))
    .plus(dec(fields.other_adjustment));
}

export function productionSourceAmount(sources: PayrollSource[]) {
  return sources.reduce((total, source) => total.plus(new Prisma.Decimal(source.amount)), new Prisma.Decimal(0)).toString();
}

export function payrollPayableAmount(baseAmount: string, adjustments: Array<{ effect: "increase" | "decrease"; amount: string }>) {
  return adjustments.reduce((total, adjustment) => total.plus(adjustment.effect === "increase" ? adjustment.amount : new Prisma.Decimal(adjustment.amount).negated()), new Prisma.Decimal(baseAmount)).toString();
}

export function allocationRemaining(payableAmount: string, paidAmount: string, allocationAmount: string) {
  const remaining = new Prisma.Decimal(payableAmount).minus(paidAmount);
  const requested = new Prisma.Decimal(allocationAmount);
  if (requested.lte(0) || requested.gt(remaining)) throw new Error("salary allocation exceeds ledger balance");
  return remaining.minus(requested).toString();
}

export function paymentRemaining(paymentAmount: string, allocatedAmount: string, allocationAmount: string) {
  const remaining = new Prisma.Decimal(paymentAmount).minus(allocatedAmount);
  const requested = new Prisma.Decimal(allocationAmount);
  if (requested.lte(0) || requested.gt(remaining)) throw new Error("salary allocation exceeds payment balance");
  return remaining.minus(requested).toString();
}

export function payrollStatus(payableAmount: string, paidAmount: string) {
  const payable = new Prisma.Decimal(payableAmount);
  const paid = new Prisma.Decimal(paidAmount);
  return paid.eq(0) ? "confirmed" : paid.gte(payable) ? "paid" : "partially_paid";
}

export function canReopenPayroll(status: string) {
  return status === "confirmed" || status === "expired";
}

/**
 * 自然月区间（含首尾日，UTC 日界）。
 *
 * 工资按自然月结算（2026-08-20 备忘第 6 条确认「按月算」），工资台账与工资付款都要按月筛，
 * 因此这个解析只留一份：两处各写一遍就会出现「台账按 1..31、付款按 1..30」这类安静错位。
 */
export function monthRange(value: string): { from: Date; to: Date } {
  if (!/^\d{4}-\d{2}$/.test(value)) throw new UnprocessableEntityException({ code: "INVALID_MONTH", message: "月份格式为 YYYY-MM", details: [] });
  const [year, monthIndex] = value.split("-").map(Number);
  if (monthIndex < 1 || monthIndex > 12) throw new UnprocessableEntityException({ code: "INVALID_MONTH", message: "月份格式为 YYYY-MM", details: [] });
  return { from: new Date(Date.UTC(year, monthIndex - 1, 1)), to: new Date(Date.UTC(year, monthIndex, 0)) };
}
