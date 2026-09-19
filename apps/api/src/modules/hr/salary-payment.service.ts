import { HttpException, Injectable, NotFoundException, UnprocessableEntityException, Optional } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { AuditService } from "../../platform/audit/audit.service";
import type { CurrentUser } from "../../platform/auth/auth.service";
import { CurrencyService } from "../../platform/currency/currency.service";
import { PrismaService } from "../../platform/database/prisma.service";
import { paymentSubjectNames } from "../finance/accounting-subject-catalog";
import { requireActiveBank } from "../finance/bank-selection";
import { CashFlowService } from "../finance/cash-flow.service";
import { PayrollLedgerService } from "./payroll-ledger.service";
import { PayrollPayableService } from "./payroll-payable.service";
import { monthRange, payrollBaseAmount } from "./hr-payroll.domain";
import type { PayrollPaymentSheetSource } from "./payroll-payment-sheet";
import { toDateText } from "../finance/finance-report.domain";

type Input = { payment_date: string; amount: string; currency: string; payment_method: string; bank_reference?: string; bank_id?: string; attachment?: unknown[]; remark?: string };
type Allocation = { ledger_id: string; amount: string; remark?: string };
/** 批量付款的入参与逐条结果（见 `payBatch`）：金额一律十进制字符串，与全站金额口径一致。 */
type BatchItem = { ledger_id: string; amount: string };
type BatchInput = { payment_date: string; payment_method: string; bank_id?: string; currency?: string; remark?: string };

@Injectable()
export class SalaryPaymentService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly payroll: PayrollLedgerService, private readonly payables: PayrollPayableService, private readonly cashFlow: CashFlowService, @Optional() private readonly currencies?: CurrencyService) {}
  /**
   * 工资付款列表。
   *
   * 2026-09-15：工资付款也要满页表格并支持「月份 / 部门 / 岗位 / 员工」筛选（用户需求第 4 条）。
   * 月份按**付款日期**的自然月；部门/岗位按**核销到的员工**命中（`some`），即「该付款单至少有一条
   * 核销明细属于所选部门/岗位」。一张付款单可以跨多名员工核销，因此行上的金额始终是付款单总额，
   * 界面同时列出命中的员工，不折算成「筛选后金额」以免与付款事实不符。
   */
  async list(status?: string, month?: string, departmentId?: string, positionId?: string) {
    const where: Prisma.SalaryPaymentWhereInput = { deletedAt: null, ...(status ? { status } : {}) };
    if (month) { const { from, to } = monthRange(month); where.paymentDate = { gte: from, lte: to }; }
    if (departmentId || positionId) where.allocations = { some: { deletedAt: null, ledger: { deletedAt: null, employee: { ...(departmentId ? { departmentId } : {}), ...(positionId ? { positionId } : {}) } } } };
    return this.prisma.salaryPayment.findMany({ where, include: { allocations: { where: { deletedAt: null }, include: { ledger: { include: { employee: { include: { department: true, position: true } } } } } } }, orderBy: { createdAt: "desc" } });
  }
  async get(id: string) { const row = await this.prisma.salaryPayment.findFirst({ where: { id, deletedAt: null }, include: { allocations: { where: { deletedAt: null }, include: { ledger: true } } } }); if (!row) throw this.notFound("SALARY_PAYMENT_NOT_FOUND", "工资付款不存在"); return row; }

  /**
   * 工资付款表格里的「付款」：把四步链路收成一次行内操作。
   *
   * 原本要「生成工资应付 → 确认应付 → 新建付款草稿 → 核销过账」四步，表格化以后操作员只想在行上
   * 填个金额点一次。这里把四步串起来，但每一步仍然复用既有服务（不另写一套金额与状态判断）：
   *   - 先按台账实发与已付余额校验，超付直接 422，**不会留下任何单据**；
   *   - 后续任何一步失败，本次新建的付款草稿会被软删除并审计，不把失败尝试留成孤儿单据
   *     （付款单没有删除接口，只有 posting 才可冲销，孤儿草稿会一直挂在列表里）。
   */
  async payLedger(ledgerId: string, input: { amount: string; payment_date: string; payment_method: string; currency?: string; bank_id?: string; remark?: string }, user: CurrentUser) {
    const amount = this.positive(input.amount);
    // 发放银行必填，且**在生成任何单据之前**校验：发工资都是走银行发放的，
    // 半路才发现账户非法会留下刚建好的工资应付，用户还得回头清理。
    await this.requireBank(input.bank_id);
    const ledger = await this.prisma.payrollLedger.findFirst({ where: { id: ledgerId, deletedAt: null } });
    if (!ledger) throw this.notFound("PAYROLL_LEDGER_NOT_FOUND", "薪资台账不存在");
    if (!["confirmed", "partially_paid"].includes(ledger.status)) throw this.invalid("PAYROLL_NOT_ALLOCATABLE", "台账尚未确认或已结清，不能付款：请先在工资台账里确认该月台账");
    if (input.currency && input.currency !== ledger.currency) throw this.invalid("PAYROLL_CURRENCY_MISMATCH", "付款币种必须与工资台账一致");
    // 余额口径与列表/详情同源：直接取台账详情的未付金额，避免这里再算一遍应发。
    const detail = await this.payroll.get(ledgerId);
    const available = new Prisma.Decimal(detail.outstandingAmount);
    if (amount.gt(available)) throw new UnprocessableEntityException({ code: "SALARY_ALLOCATION_EXCEEDED", message: "付款金额超过该台账未付余额", details: [{ available_amount: available.toString() }] });

    const payables = this.payables;
    if (!payables) throw this.invalid("PAYROLL_PAYABLE_UNAVAILABLE", "工资应付服务不可用，无法完成付款");
    // 没有工资应付就生成、草稿就确认（核销过账只接受已确认/部分支付的应付）。
    const payable = await payables.createFromLedger(ledgerId, {}, user);
    if (["reversed", "voided"].includes(payable.status)) throw this.invalid("PAYROLL_PAYABLE_NOT_PAYABLE", "该台账的工资应付已冲销，不能再次付款；请先在工资应付里处理");
    if (payable.status === "draft") await payables.confirm(payable.id, user);

    const payment = await this.create({ payment_date: input.payment_date, amount: input.amount, currency: ledger.currency, payment_method: input.payment_method, bank_id: input.bank_id, remark: input.remark }, user);
    try {
      return await this.post(payment.id, [{ ledger_id: ledgerId, amount: input.amount }], user);
    } catch (error) {
      await this.prisma.salaryPayment.update({ where: { id: payment.id }, data: { ...this.audit.softDelete(user) } });
      await this.audit.record("salary_payment.rollback_draft", "salary_payment", user.id, payment.id, { ledger_id: ledgerId, reason: error instanceof Error ? error.message : null });
      throw error;
    }
  }

  /**
   * 工资付款表格里的「冲销」：把该台账下所有已过账的工资付款整体冲销。
   *
   * 逐张复用 reverse()（每张付款单一个事务，自己刷新台账 / 工资应付状态并回冲现金流），
   * 因此不会出现「同一张台账两边状态不一致」。
   */
  async reverseLedgerPayments(ledgerId: string, reason: string, user: CurrentUser) {
    if (!reason?.trim()) throw this.invalid("REVERSAL_REASON_REQUIRED", "冲销必须填写原因");
    const ledger = await this.prisma.payrollLedger.findFirst({ where: { id: ledgerId, deletedAt: null } });
    if (!ledger) throw this.notFound("PAYROLL_LEDGER_NOT_FOUND", "薪资台账不存在");
    const allocations = await this.prisma.salaryPaymentAllocation.findMany({ where: { ledgerId, deletedAt: null, status: "active" }, include: { payment: true } });
    const paymentIds = [...new Set(allocations.filter((item) => item.payment?.status === "posted").map((item) => item.paymentId))].sort();
    if (!paymentIds.length) throw this.invalid("SALARY_PAYMENT_NOT_REVERSIBLE", "该台账没有已过账的工资付款，无需冲销");
    const reversed: Array<{ payment_no: string; amount: string }> = [];
    for (const paymentId of paymentIds) {
      const row = await this.reverse(paymentId, reason.trim(), user);
      reversed.push({ payment_no: row.paymentNo, amount: row.amount.toString() });
    }
    return { ledger_id: ledgerId, ledger_no: ledger.ledgerNo, reversed };
  }

  /**
   * 工资付款表格的「批量付款」：勾选多人后一次提交，**一人一张付款单**。
   *
   * 用户明确决定：批量 = N 张各自独立的付款单，而不是「一张付款单核销多条台账」。
   * 理由是冲销与失败面都留在个人身上 —— 冲销是按台账整体回退的（`reverseLedgerPayments`），
   * 一张单里混进多个人以后，想退其中一个人的工资就得冲掉整张单；而一张单一次核销多人时，
   * 任何一个人核销失败都会把其他人一起拖回滚。因此这里**循环调用既有的 `payLedger`**，
   * 不另写一条金额路径，也不复用 `post()` 的多核销形态（那会让反冲销粒度变粗）。
   *
   * **串行执行**：`payLedger` 会对台账加行锁并逐个写审计，并发跑会让审计顺序不确定、
   * 还会在同一个银行账户/台账上互相等锁。批量是人工点一次的低频操作，串行的耗时可以接受。
   *
   * **失败隔离**：每条独立 try/catch。`payLedger` 在核销失败时已经把自己刚建的付款草稿软删除
   * 并写 `salary_payment.rollback_draft` 审计（见上面的 try/catch），所以失败条目不会留下孤儿单据，
   * 也不会把已经成功的其他人一起回滚 —— 这正是「一人一单」换来的可恢复性。
   *
   * **发放银行只校验一次、且在任何条目之前**（`requireBank`）：发工资必须指定银行（用户 2026-09-16），
   * 半路才发现账户非法会留下一批「先成功后全失败」的半成品批次，还不如一条都不做。
   */
  async payBatch(items: BatchItem[], input: BatchInput, user: CurrentUser) {
    const list = items ?? [];
    if (!list.length) throw this.invalid("SALARY_PAYMENT_BATCH_EMPTY", "批量付款至少要选择一名员工");
    if (new Set(list.map((item) => item.ledger_id)).size !== list.length) throw this.invalid("DUPLICATE_SALARY_ALLOCATION", "同一台账不得在一批付款里重复出现");
    const bank = await this.requireBank(input.bank_id);

    const succeeded: Array<{ ledger_id: string; employee_no: string; employee_name: string; amount: string }> = [];
    const failed: Array<{ ledger_id: string; employee_no: string; employee_name: string; amount: string; code: string; message: string }> = [];
    let total = new Prisma.Decimal(0);

    for (const item of list) {
      // 先单独查台账：失败条目也要能报出「是谁」，不能只回一个 uuid。
      // 台账本身查不到时没有姓名可用，就**明说**用台账 ID 顶替（不做静默的空白行）。
      const ledger = await this.prisma.payrollLedger.findFirst({ where: { id: item.ledger_id, deletedAt: null }, include: { employee: true } });
      const employeeNo = ledger?.employee?.employeeNo ?? item.ledger_id;
      const employeeName = ledger?.employee?.name ?? item.ledger_id;
      try {
        await this.payLedger(item.ledger_id, { amount: item.amount, payment_date: input.payment_date, payment_method: input.payment_method, currency: input.currency, bank_id: input.bank_id, remark: input.remark }, user);
        succeeded.push({ ledger_id: item.ledger_id, employee_no: employeeNo, employee_name: employeeName, amount: item.amount });
        // 只有成功的条目参与合计（失败的钱没有出去）。Decimal 累加，不做浮点求和。
        total = total.plus(new Prisma.Decimal(item.amount));
      } catch (error) {
        const reason = this.batchFailure(error, ledger ? null : "工号与姓名以台账 ID 代替");
        failed.push({ ledger_id: item.ledger_id, employee_no: employeeNo, employee_name: employeeName, amount: item.amount, code: reason.code, message: reason.message });
      }
    }

    await this.audit.record("salary_payment.pay_batch", "salary_payment", user.id, undefined, {
      requested_count: list.length,
      succeeded_count: succeeded.length,
      failed_count: failed.length,
      total_amount: total.toFixed(4),
      failed_ledger_ids: failed.map((item) => item.ledger_id),
      bank_id: bank.id,
    });
    return {
      requested_count: list.length,
      succeeded_count: succeeded.length,
      failed_count: failed.length,
      total_amount: total.toFixed(4),
      bank: { id: bank.id, bank_name: bank.bankName, account_number: bank.accountNumber },
      succeeded,
      failed,
    };
  }

  /** 把条目异常拆成「错误码 + 人话」：Service 抛的是 HttpException（body 里带 code），其余按普通异常兜底。 */
  private batchFailure(error: unknown, note: string | null) {
    const response = error instanceof HttpException ? error.getResponse() : null;
    const body = typeof response === "object" && response !== null ? response as { code?: string; message?: string | string[] } : null;
    const raw = body?.message ?? (error instanceof Error ? error.message : null);
    const message = Array.isArray(raw) ? raw.join("；") : raw;
    return { code: body?.code ?? "SALARY_PAYMENT_BATCH_ITEM_FAILED", message: message ? (note ? `${message}（${note}）` : message) : (note ?? "付款失败") };
  }

  /**
   * 工资付款按月导出的取数（口径必须与页面**同一批行**）。
   *
   * 页面的行来源是 `PayrollLedgerService.list`：期间与所选自然月**有交集**即命中，且**不按状态过滤**
   * （草稿也列出来，只是给一个「待确认」提示）。导出如果悄悄把草稿滤掉，表上的合计就与页面对不上，
   * 所以这里的 where 与它逐条对齐；自然月解析复用 `monthRange`（两处各写一遍会出现 1..31 / 1..30 的错位）。
   *
   * 金额三件套（应发/已付/未付）的算法与 `PayrollLedgerService.balances` 同源：应发 = `payrollBaseAmount`
   * （唯一一份公式）+ 已过账调整净额；已付只算「有效核销 + 付款已过账」。因此导入导出的
   * 「已付」与页面「已付」恒等，不会出现两份口径。
   */
  async paymentSheetRows(month: string, departmentId?: string, positionId?: string): Promise<PayrollPaymentSheetSource[]> {
    const { from, to } = monthRange(month);
    const employeeWhere: Prisma.EmployeeWhereInput = { ...(departmentId ? { departmentId } : {}), ...(positionId ? { positionId } : {}) };
    const rows = await this.prisma.payrollLedger.findMany({
      where: {
        deletedAt: null,
        AND: [{ periodStart: { lte: to } }, { periodEnd: { gte: from } }],
        ...(Object.keys(employeeWhere).length ? { employee: employeeWhere } : {}),
      },
      include: {
        employee: { include: { department: true, position: true } },
        adjustments: { where: { deletedAt: null } },
        // 付款明细要带 bank：导出的「发放银行」列是 `银行名（账号）`，只有 payment.bank 才有账号。
        allocations: { where: { deletedAt: null, status: "active" }, include: { payment: { include: { bank: true } } } },
      },
    });
    return rows
      .map((row): PayrollPaymentSheetSource => {
        const payable = payrollBaseAmount({
          base_salary: row.baseSalary,
          production_source_amount: row.productionSourceAmount,
          overtime_amount: row.overtimeAmount,
          attendance_deduction: row.attendanceDeduction,
          late_deduction: row.lateDeduction,
          absence_deduction: row.absenceDeduction,
          early_leave_deduction: row.earlyLeaveDeduction,
          performance_amount: row.performanceAmount,
          allowance_amount: row.allowanceAmount,
          housing_allowance: row.housingAllowance,
          social_insurance: row.socialInsurance,
          individual_tax: row.individualTax,
          other_adjustment: row.otherAdjustment,
        }).plus(row.adjustments.filter((item) => item.status === "posted").reduce((sum, item) => sum.plus(item.effect === "increase" ? item.amount : item.amount.negated()), new Prisma.Decimal(0)));
        const payments: PayrollPaymentSheetSource["payments"] = [];
        for (const allocation of row.allocations) {
          const payment = allocation.payment;
          if (payment?.status !== "posted") continue;
          payments.push({ paymentNo: payment.paymentNo, paymentDate: payment.paymentDate, paymentMethod: payment.paymentMethod, bankName: payment.bank?.bankName ?? null, accountNumber: payment.bank?.accountNumber ?? null });
        }
        const paid = row.allocations.filter((allocation) => allocation.payment?.status === "posted").reduce((sum, allocation) => sum.plus(allocation.amount), new Prisma.Decimal(0));
        return {
          // 月份取台账期间起始月（真值）；期间缺失时退回落成导出所选月份，不留空。
          month: toDateText(row.periodStart)?.slice(0, 7) ?? month,
          employeeNo: row.employee.employeeNo,
          employeeName: row.employee.name,
          departmentName: row.employee.department?.name ?? null,
          positionName: row.employee.position?.name ?? null,
          employeeType: row.employee.employeeType,
          currency: row.currency,
          payableAmount: payable,
          paidAmount: paid,
          outstandingAmount: payable.minus(paid),
          status: row.status,
          remark: row.remark,
          payments,
        };
      })
      // 按工号排序：导出表是给人对账看的，人员顺序与台账页的「工号/姓名」列一致才扫得快。
      .sort((left, right) => left.employeeNo.localeCompare(right.employeeNo) || (left.month ?? "").localeCompare(right.month ?? ""));
  }
  async create(input: Input, user: CurrentUser) { await this.currencies?.assertSupported(input.currency, "工资付款币种"); const amount = this.positive(input.amount); const bank = await this.requireBank(input.bank_id); const row = await this.prisma.salaryPayment.create({ data: { paymentNo: this.number("SALARY"), paymentDate: this.date(input.payment_date), amount, currency: input.currency, paymentMethod: input.payment_method, bankReference: input.bank_reference, bankId: bank.id, attachment: (input.attachment ?? []) as Prisma.InputJsonValue, remark: input.remark, ...this.audit.create(user) } }); await this.audit.record("salary_payment.create", "salary_payment", user.id, row.id, { amount: row.amount.toString(), bank_id: bank.id }); return row; }
  async updateDraft(id: string, input: { amount?: string; payment_date?: string; payment_method?: string; bank_reference?: string; bank_id?: string | null; remark?: string }, user: CurrentUser) {
    // bank_id 传 null / 空串表示**清空**（选错了要能去掉），传 undefined 表示不改 —— 与收付款草稿同一约定。
    // 但草稿「没有银行」是暂时的：过账/发放前服务层仍会要求一个可用账户（`requireBank`）。
    if (input.bank_id) await this.requireBank(input.bank_id);
    const row = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM salary_payments WHERE id = ${id}::uuid FOR UPDATE`;
      const current = await tx.salaryPayment.findFirst({ where: { id, deletedAt: null } });
      if (!current) throw this.notFound("SALARY_PAYMENT_NOT_FOUND", "工资付款不存在");
      if (current.status !== "draft") throw this.invalid("SALARY_PAYMENT_NOT_EDITABLE", "只有草稿工资付款可以编辑");
      const amount = input.amount === undefined ? current.amount : this.positive(input.amount);
      const bankId = input.bank_id === undefined ? current.bankId : (input.bank_id || null);
      return tx.salaryPayment.update({ where: { id }, data: { amount, paymentDate: input.payment_date ? this.date(input.payment_date) : current.paymentDate, paymentMethod: input.payment_method ?? current.paymentMethod, bankReference: input.bank_reference ?? current.bankReference, bankId, remark: input.remark ?? current.remark, ...this.audit.update(user) } });
    });
    await this.audit.record("salary_payment.update", "salary_payment", user.id, id, { amount: row.amount.toString() });
    return row;
  }

  /**
   * 发放银行（必填）。
   *
   * 用户要求：「工资支付那边也是全部要加上银行账户，因为发工资都是要用银行账户发放的工资」。
   * 与收付款选银行同一套 `requireActiveBank` 口径（存在 + 未删除 + **未停用**；
   * 外键拦不住「停用」，只靠前端下拉过滤也不够 —— 接口可以被直接调用）。
   * 缺了它这笔支出不会落到任何账户上，银行余额会与真实银行账永久对不上。
   */
  private async requireBank(bankId: string | null | undefined) {
    const id = bankId?.trim();
    if (!id) throw this.invalid("SALARY_PAYMENT_BANK_REQUIRED", "工资付款必须指定发放银行（发工资都是通过银行账户发放的），请先在【财务 → 银行账户】确认账户");
    const bank = await requireActiveBank(this.prisma, id, "发放银行不存在或已停用");
    if (!bank) throw this.invalid("SALARY_PAYMENT_BANK_REQUIRED", "工资付款必须指定发放银行");
    return bank;
  }
  async post(id: string, allocations: Allocation[], user: CurrentUser) { const current = await this.prisma.salaryPayment.findFirst({ where: { id, deletedAt: null } }); if (!current) throw this.notFound("SALARY_PAYMENT_NOT_FOUND", "工资付款不存在"); if (current.status !== "draft") throw this.invalid("SALARY_PAYMENT_NOT_POSTABLE", "只有草稿工资付款可以过账"); const bank = await this.requireBank(current.bankId); const items = allocations ?? []; if (!items.length) throw this.invalid("PAYMENT_ALLOCATION_REQUIRED", "工资付款过账至少需要核销一条有效工资台账"); if (new Set(items.map((item) => item.ledger_id)).size !== items.length) throw this.invalid("DUPLICATE_SALARY_ALLOCATION", "同一付款不得重复核销同一台账"); const result = await this.prisma.$transaction(async (tx) => { await tx.$queryRaw`SELECT id FROM salary_payments WHERE id = ${id}::uuid FOR UPDATE`; const lockedPayment = await tx.salaryPayment.findFirst({ where: { id, deletedAt: null } }); if (!lockedPayment || lockedPayment.status !== "draft") throw this.invalid("SALARY_PAYMENT_NOT_POSTABLE", "只有草稿工资付款可以过账"); let total = new Prisma.Decimal(0); for (const item of items) { const amount = this.positive(item.amount); await tx.$queryRaw`SELECT id FROM payroll_ledgers WHERE id = ${item.ledger_id}::uuid FOR UPDATE`; const ledger = await tx.payrollLedger.findFirst({ where: { id: item.ledger_id, deletedAt: null } }); if (!ledger || ledger.currency !== lockedPayment.currency || !["confirmed", "partially_paid"].includes(ledger.status)) throw this.invalid("PAYROLL_NOT_ALLOCATABLE", "台账不存在、币种不一致或尚未确认"); const payable = await tx.payrollPayableEntry.findFirst({ where: { ledgerId: ledger.id, deletedAt: null } }); if (!payable) throw this.invalid("PAYROLL_PAYABLE_REQUIRED", "工资付款必须核销已生成的工资应付"); if (!["confirmed", "partially_paid"].includes(payable.status)) throw this.invalid("PAYROLL_PAYABLE_NOT_ALLOCATABLE", "工资应付尚未确认或已关闭"); const base = payrollBaseAmount({ base_salary: ledger.baseSalary, production_source_amount: ledger.productionSourceAmount, overtime_amount: ledger.overtimeAmount, attendance_deduction: ledger.attendanceDeduction, late_deduction: ledger.lateDeduction, absence_deduction: ledger.absenceDeduction, early_leave_deduction: ledger.earlyLeaveDeduction, performance_amount: ledger.performanceAmount, allowance_amount: ledger.allowanceAmount, housing_allowance: ledger.housingAllowance, social_insurance: ledger.socialInsurance, individual_tax: ledger.individualTax, other_adjustment: ledger.otherAdjustment }); const adjustments = await tx.payrollAdjustment.findMany({ where: { ledgerId: ledger.id, deletedAt: null, status: "posted" } }); const net = base.plus(adjustments.reduce((sum, row) => sum.plus(row.effect === "increase" ? row.amount : row.amount.negated()), new Prisma.Decimal(0))); if (!payable.amount.eq(net)) throw this.invalid("PAYROLL_PAYABLE_AMOUNT_MISMATCH", "工资应付金额与台账实发金额不一致，请先重新生成工资应付"); const paid = await tx.salaryPaymentAllocation.aggregate({ where: { ledgerId: ledger.id, deletedAt: null, status: "active", payment: { status: "posted" } }, _sum: { amount: true } }); const available = net.minus(paid._sum.amount ?? 0); if (amount.gt(available)) throw new UnprocessableEntityException({ code: "SALARY_ALLOCATION_EXCEEDED", message: "核销金额超过薪资未付余额", details: [{ available_amount: available.toString() }] }); total = total.plus(amount); await tx.salaryPaymentAllocation.create({ data: { paymentId: id, ledgerId: ledger.id, payrollPayableId: payable.id, employeeId: ledger.employeeId, amount, currency: lockedPayment.currency, remark: item.remark, ...this.audit.create(user) } }); } if (total.gt(lockedPayment.amount)) throw new UnprocessableEntityException({ code: "SALARY_PAYMENT_ALLOCATION_EXCEEDED", message: "核销金额超过工资付款金额", details: [] }); const payment = await tx.salaryPayment.update({ where: { id }, data: { status: "posted", ...this.audit.update(user) } }); for (const item of items) await this.payroll.refreshStatus(tx, item.ledger_id, user); if (this.payables) for (const item of items) await this.payables.refreshStatusForLedger(tx, item.ledger_id, user); return payment; }); await this.audit.record("salary_payment.post", "salary_payment", user.id, id, { allocation_count: items.length }); for (const item of items) await this.audit.record("salary_payment_allocation.create", "salary_payment_allocation", user.id, id, { ledger_id: item.ledger_id, amount: item.amount }); await this.cashFlow.autoCreateFromPayment({ paymentNo: result.paymentNo, paymentDate: result.paymentDate, amount: result.amount, currency: result.currency, counterpartyName: `工资付款 ${result.paymentNo}`, direction: "expense", settlementMethod: result.paymentMethod, settlementAccountId: null, bankId: bank.id, sourceType: "salary_payment", sourceId: result.id, subjectNames: paymentSubjectNames("salary_payment"), remark: result.remark ?? undefined }, user); return result; }
  async reverse(id: string, reason: string, user: CurrentUser) { if (!reason?.trim()) throw new UnprocessableEntityException({ code: "REVERSAL_REASON_REQUIRED", message: "冲销必须填写原因", details: [] }); const result = await this.prisma.$transaction(async (tx) => { await tx.$queryRaw`SELECT id FROM salary_payments WHERE id = ${id}::uuid FOR UPDATE`; const locked = await tx.salaryPayment.findFirst({ where: { id, deletedAt: null } }); if (!locked) throw this.notFound("SALARY_PAYMENT_NOT_FOUND", "工资付款不存在"); if (locked.status !== "posted") throw this.invalid("SALARY_PAYMENT_NOT_REVERSIBLE", "当前工资付款不可冲销"); const allocations = await tx.salaryPaymentAllocation.findMany({ where: { paymentId: id, deletedAt: null, status: "active" } }); for (const ledgerId of [...new Set(allocations.map((item) => item.ledgerId))].sort()) await tx.$queryRaw`SELECT id FROM payroll_ledgers WHERE id = ${ledgerId}::uuid FOR UPDATE`; await tx.salaryPaymentAllocation.updateMany({ where: { paymentId: id, deletedAt: null, status: "active" }, data: { status: "reversed", ...this.audit.update(user) } }); const payment = await tx.salaryPayment.update({ where: { id }, data: { status: "reversed", remark: `${locked.remark ?? ""}\n冲销：${reason.trim()}`, ...this.audit.update(user) } }); for (const item of allocations) await this.payroll.refreshStatus(tx, item.ledgerId, user); if (this.payables) for (const ledgerId of [...new Set(allocations.map((item) => item.ledgerId))]) await this.payables.refreshStatusForLedger(tx, ledgerId, user); return { payment, allocations }; }); await this.audit.record("salary_payment.reverse", "salary_payment", user.id, id, { reason }); await this.cashFlow.autoReverseFromPayment("salary_payment", id, "工资付款冲销：" + reason, user); for (const item of result.allocations) await this.audit.record("salary_payment_allocation.reverse", "salary_payment_allocation", user.id, item.id, { payment_id: id, ledger_id: item.ledgerId, reason }); return result.payment; }
  private positive(value: string) { try { const n = new Prisma.Decimal(value); if (!n.gt(0)) throw new Error(); return n; } catch { throw this.invalid("INVALID_AMOUNT", "金额必须是大于零的十进制数"); } }
  private date(value: string) { const d = new Date(`${value}T00:00:00.000Z`); if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(d.valueOf())) throw this.invalid("INVALID_PAYMENT_DATE", "付款日期无效"); return d; }
  private number(prefix: string) { return `${prefix}-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomUUID().slice(0, 8).toUpperCase()}`; }
  private notFound(code: string, message: string) { return new NotFoundException({ code, message, details: [] }); }
  private invalid(code: string, message: string) { return new UnprocessableEntityException({ code, message, details: [] }); }
}