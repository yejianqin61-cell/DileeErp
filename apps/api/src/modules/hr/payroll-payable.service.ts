import { Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { AuditService } from "../../platform/audit/audit.service";
import type { CurrentUser } from "../../platform/auth/auth.service";
import { PrismaService } from "../../platform/database/prisma.service";

type CreateInput = { order_no?: string; attachment?: unknown[]; remark?: string };

@Injectable()
export class PayrollPayableService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  async list(employeeId?: string, status?: string, orderNo?: string) {
    return this.prisma.payrollPayableEntry.findMany({
      where: { deletedAt: null, ...(employeeId ? { employeeId } : {}), ...(status ? { status } : {}), ...(orderNo ? { orderNo } : {}) },
      include: { employee: true, ledger: true },
      orderBy: { createdAt: "desc" },
    });
  }

  async get(id: string) {
    const row = await this.prisma.payrollPayableEntry.findFirst({ where: { id, deletedAt: null }, include: { employee: true, ledger: true } });
    if (!row) throw this.notFound("PAYROLL_PAYABLE_NOT_FOUND", "工资应付不存在");
    return row;
  }

  async createFromLedger(ledgerId: string, input: CreateInput, user: CurrentUser) {
    const row = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM payroll_ledgers WHERE id = ${ledgerId}::uuid FOR UPDATE`;
      const ledger = await tx.payrollLedger.findFirst({
        where: { id: ledgerId, deletedAt: null },
        include: { adjustments: { where: { deletedAt: null, status: "posted" } } },
      });
      if (!ledger) throw this.notFound("PAYROLL_LEDGER_NOT_FOUND", "薪资台账不存在");
      const existing = await tx.payrollPayableEntry.findUnique({ where: { ledgerId } });
      if (existing) {
        if (!existing.deletedAt) return existing;
        return tx.payrollPayableEntry.update({ where: { id: existing.id }, data: { deletedAt: null, deletedBy: null, ...this.audit.update(user) } });
      }
      if (ledger.status !== "confirmed") throw this.invalid("PAYROLL_LEDGER_NOT_CONFIRMED", "只有已确认工资台账可以生成工资应付");
      const amount = this.netAmount(ledger);
      if (amount.lte(0)) throw this.invalid("PAYROLL_PAYABLE_AMOUNT_INVALID", "工资应付金额必须大于零");
      return tx.payrollPayableEntry.create({
        data: {
          payableNo: this.number("PAYP"),
          ledgerId: ledger.id,
          employeeId: ledger.employeeId,
          orderNo: input.order_no,
          amount,
          currency: ledger.currency,
          sourceSnapshot: {
            ledger_no: ledger.ledgerNo,
            employee_id: ledger.employeeId,
            period_start: ledger.periodStart.toISOString().slice(0, 10),
            period_end: ledger.periodEnd.toISOString().slice(0, 10),
            base_salary: ledger.baseSalary.toString(),
            production_source_amount: ledger.productionSourceAmount.toString(),
            adjustment_amount: ledger.adjustments.reduce((sum, item) => sum.plus(item.effect === "increase" ? item.amount : item.amount.negated()), new Prisma.Decimal(0)).toString(),
            payable_amount: amount.toString(),
          } as Prisma.InputJsonValue,
          attachment: (input.attachment ?? []) as Prisma.InputJsonValue,
          remark: input.remark,
          ...this.audit.create(user),
        },
      });
    });
    await this.audit.record("payroll_payable.create", "payroll_payable", user.id, row.id, { ledger_id: row.ledgerId, amount: row.amount.toString() });
    return row;
  }

  async confirm(id: string, user: CurrentUser) {
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM payroll_payable_entries WHERE id = ${id}::uuid FOR UPDATE`;
      const current = await tx.payrollPayableEntry.findFirst({ where: { id, deletedAt: null } });
      if (!current) throw this.notFound("PAYROLL_PAYABLE_NOT_FOUND", "工资应付不存在");
      if (current.status !== "draft") throw this.invalid("PAYROLL_PAYABLE_NOT_CONFIRMABLE", "只有草稿工资应付可以确认");
      return tx.payrollPayableEntry.update({ where: { id }, data: { status: "confirmed", ...this.audit.update(user) } });
    });
    await this.audit.record("payroll_payable.confirm", "payroll_payable", user.id, id, { amount: result.amount.toString() });
    return result;
  }

  async reopen(id: string, reason: string, user: CurrentUser) {
    if (!reason?.trim()) throw this.invalid("CORRECTION_REASON_REQUIRED", "回退工资应付必须填写原因");
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM payroll_payable_entries WHERE id = ${id}::uuid FOR UPDATE`;
      const current = await tx.payrollPayableEntry.findFirst({ where: { id, deletedAt: null } });
      if (!current) throw this.notFound("PAYROLL_PAYABLE_NOT_FOUND", "工资应付不存在");
      if (current.status !== "confirmed") throw this.invalid("PAYROLL_PAYABLE_NOT_REOPENABLE", "只有未发生付款的已确认工资应付可以回退草稿");
      await this.assertNoPostedPayment(tx, current.ledgerId);
      return tx.payrollPayableEntry.update({ where: { id }, data: { status: "draft", remark: `${current.remark ?? ""}\n回退草稿：${reason.trim()}`, ...this.audit.update(user) } });
    });
    await this.audit.record("payroll_payable.reopen", "payroll_payable", user.id, id, { reason: reason.trim() });
    return result;
  }

  async reverse(id: string, reason: string, user: CurrentUser) {
    if (!reason?.trim()) throw this.invalid("REVERSAL_REASON_REQUIRED", "冲销工资应付必须填写原因");
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM payroll_payable_entries WHERE id = ${id}::uuid FOR UPDATE`;
      const current = await tx.payrollPayableEntry.findFirst({ where: { id, deletedAt: null } });
      if (!current) throw this.notFound("PAYROLL_PAYABLE_NOT_FOUND", "工资应付不存在");
      if (!["confirmed", "partially_paid", "paid"].includes(current.status)) throw this.invalid("PAYROLL_PAYABLE_NOT_REVERSIBLE", "当前工资应付不可冲销");
      await this.assertNoPostedPayment(tx, current.ledgerId);
      return tx.payrollPayableEntry.update({ where: { id }, data: { status: "reversed", remark: `${current.remark ?? ""}\n冲销：${reason.trim()}`, ...this.audit.update(user) } });
    });
    await this.audit.record("payroll_payable.reverse", "payroll_payable", user.id, id, { reason: reason.trim() });
    return result;
  }

  async refreshStatusForLedger(tx: Prisma.TransactionClient, ledgerId: string, user: CurrentUser) {
    const payable = await tx.payrollPayableEntry.findFirst({ where: { ledgerId, deletedAt: null } });
    if (!payable || ["reversed", "voided"].includes(payable.status)) return payable;
    const paid = await tx.salaryPaymentAllocation.aggregate({
      where: { ledgerId, deletedAt: null, status: "active", payment: { status: "posted" } },
      _sum: { amount: true },
    });
    const paidAmount = new Prisma.Decimal(paid._sum.amount ?? 0);
    const status = paidAmount.eq(0)
      ? (payable.status === "draft" ? "draft" : "confirmed")
      : paidAmount.gte(payable.amount) ? "paid" : "partially_paid";
    return tx.payrollPayableEntry.update({ where: { id: payable.id }, data: { status, ...this.audit.update(user) } });
  }

  private netAmount(ledger: { baseSalary: Prisma.Decimal; productionSourceAmount: Prisma.Decimal; overtimeAmount: Prisma.Decimal; attendanceDeduction: Prisma.Decimal; performanceAmount: Prisma.Decimal; allowanceAmount: Prisma.Decimal; socialInsurance: Prisma.Decimal; individualTax: Prisma.Decimal; otherAdjustment: Prisma.Decimal; adjustments: Array<{ effect: string; amount: Prisma.Decimal }> }) {
    const base = ledger.baseSalary.plus(ledger.productionSourceAmount).plus(ledger.overtimeAmount).minus(ledger.attendanceDeduction).plus(ledger.performanceAmount).plus(ledger.allowanceAmount).minus(ledger.socialInsurance).minus(ledger.individualTax).plus(ledger.otherAdjustment);
    const adjustments = ledger.adjustments.reduce((sum, item) => sum.plus(item.effect === "increase" ? item.amount : item.amount.negated()), new Prisma.Decimal(0));
    return base.plus(adjustments);
  }

  private async assertNoPostedPayment(tx: Prisma.TransactionClient, ledgerId: string) {
    const posted = await tx.salaryPaymentAllocation.findFirst({
      where: { ledgerId, deletedAt: null, status: "active", payment: { status: "posted" } },
      select: { id: true },
    });
    if (posted) throw this.invalid("PAYROLL_PAYABLE_HAS_PAYMENTS", "工资台账已有有效付款核销，必须先冲销付款");
  }

  private number(prefix: string) { return `${prefix}-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomUUID().slice(0, 8).toUpperCase()}`; }
  private notFound(code: string, message: string) { return new NotFoundException({ code, message, details: [] }); }
  private invalid(code: string, message: string) { return new UnprocessableEntityException({ code, message, details: [] }); }
}
