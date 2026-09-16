const assert = require("node:assert/strict");
const { test } = require("node:test");
const { UnprocessableEntityException } = require("@nestjs/common");
const { Prisma } = require("@prisma/client");
const { SalaryPaymentService } = require("../../dist/modules/hr/salary-payment.service.js");

/**
 * 发放银行替身（2026-09-16）：用户要求「工资支付那边也是全部要加上银行账户」，
 * 服务层在过账/建单前会校验这个账户存在且启用（`requireActiveBank`）。
 */
const bank = { id: "bank-1", bankName: "农业银行", accountNumber: "5706" };
const bankStub = { findFirst: async () => bank };
const user = { id: "user-1" };

test("salary payment posting locks the payment before allocation checks", async () => {
  const calls = [];
  const current = { id: "payment-1", status: "draft", amount: "10", currency: "CNY", bankId: "bank-1" };
  const prisma = {
    bank: bankStub,
    salaryPayment: { findFirst: async () => current },
    $transaction: async (fn) => fn({
      $queryRaw: async () => { calls.push("lock"); },
      salaryPayment: { findFirst: async () => ({ ...current, status: "posted" }) },
    }),
  };
  const service = new SalaryPaymentService(prisma, {}, {});
  await assert.rejects(() => service.post(current.id, [{ ledger_id: "ledger-1", amount: "10" }], { id: "user-1" }), (error) => error instanceof UnprocessableEntityException && error.getResponse().code === "SALARY_PAYMENT_NOT_POSTABLE");
  assert.deepEqual(calls, ["lock"]);
});

test("salary payment draft update locks and rechecks current status", async () => {
  let lockCount = 0;
  let updateCount = 0;
  const row = { id: "payment-1", status: "posted", amount: "10", paymentDate: new Date(), paymentMethod: "bank", remark: null };
  const prisma = { bank: bankStub, salaryPayment: { findFirst: async () => row, update: async () => { updateCount += 1; return row; } }, $transaction: async (fn) => fn({ $queryRaw: async () => { lockCount += 1; }, salaryPayment: prisma.salaryPayment }) };
  const service = new SalaryPaymentService(prisma, { update: () => ({}), record: async () => {} }, {});
  await assert.rejects(() => service.updateDraft("payment-1", { amount: "12" }, { id: "user-1" }), (error) => error.getResponse().code === "SALARY_PAYMENT_NOT_EDITABLE");
  assert.equal(lockCount, 1); assert.equal(updateCount, 0);
});


test("salary payment posting requires a confirmed payroll payable", async () => {
  const payment = { id: "payment-1", status: "draft", amount: "10", currency: "CNY", bankId: "bank-1" };
  const ledger = { id: "ledger-1", employeeId: "employee-1", currency: "CNY", status: "confirmed", baseSalary: "10" };
  const tx = {
    $queryRaw: async () => [],
    salaryPayment: { findFirst: async () => ({ ...payment, status: "draft" }) },
    payrollLedger: { findFirst: async () => ledger },
    payrollPayableEntry: { findFirst: async () => null },
  };
  const prisma = { bank: bankStub, salaryPayment: { findFirst: async () => payment }, $transaction: async (fn) => fn(tx) };
  const audit = { create: () => ({}), update: () => ({}), record: async () => {} };
  const service = new SalaryPaymentService(prisma, audit, {});
  await assert.rejects(
    () => service.post("payment-1", [{ ledger_id: "ledger-1", amount: "10" }], { id: "user-1" }),
    (error) => error.getResponse().code === "PAYROLL_PAYABLE_REQUIRED",
  );
});


test("salary payment posting requires a confirmed payroll payable status", async () => {
  const payment = { id: "payment-1", status: "draft", amount: "10", currency: "CNY", bankId: "bank-1" };
  const ledger = { id: "ledger-1", employeeId: "employee-1", currency: "CNY", status: "confirmed", baseSalary: "10" };
  const tx = {
    $queryRaw: async () => [],
    salaryPayment: { findFirst: async () => ({ ...payment, status: "draft" }) },
    payrollLedger: { findFirst: async () => ledger },
    payrollPayableEntry: { findFirst: async () => ({ id: "payable-1", ledgerId: "ledger-1", status: "draft", amount: "10" }) },
  };
  const prisma = { bank: bankStub, salaryPayment: { findFirst: async () => payment }, $transaction: async (fn) => fn(tx) };
  const audit = { create: () => ({}), update: () => ({}), record: async () => {} };
  const service = new SalaryPaymentService(prisma, audit, {});
  await assert.rejects(
    () => service.post("payment-1", [{ ledger_id: "ledger-1", amount: "10" }], { id: "user-1" }),
    (error) => error.getResponse().code === "PAYROLL_PAYABLE_NOT_ALLOCATABLE",
  );
});


test("salary payment posting rejects payroll payable amount mismatch", async () => {
  const payment = { id: "payment-1", status: "draft", amount: "10", currency: "CNY", bankId: "bank-1" };
  const ledger = {
    id: "ledger-1", employeeId: "employee-1", currency: "CNY", status: "confirmed",
    baseSalary: new Prisma.Decimal("10"), productionSourceAmount: new Prisma.Decimal("0"),
    overtimeAmount: new Prisma.Decimal("0"), attendanceDeduction: new Prisma.Decimal("0"),
    lateDeduction: new Prisma.Decimal("0"), absenceDeduction: new Prisma.Decimal("0"), earlyLeaveDeduction: new Prisma.Decimal("0"),
    performanceAmount: new Prisma.Decimal("0"), allowanceAmount: new Prisma.Decimal("0"),
    housingAllowance: new Prisma.Decimal("0"),
    socialInsurance: new Prisma.Decimal("0"), individualTax: new Prisma.Decimal("0"),
    otherAdjustment: new Prisma.Decimal("0"),
  };
  const tx = {
    $queryRaw: async () => [],
    salaryPayment: { findFirst: async () => ({ ...payment, status: "draft" }) },
    payrollLedger: { findFirst: async () => ledger },
    payrollPayableEntry: { findFirst: async () => ({ id: "payable-1", ledgerId: "ledger-1", status: "confirmed", amount: new Prisma.Decimal("9") }) },
    payrollAdjustment: { findMany: async () => [] },
    salaryPaymentAllocation: { aggregate: async () => ({ _sum: { amount: null } }) },
  };
  const prisma = { bank: bankStub, salaryPayment: { findFirst: async () => payment }, $transaction: async (fn) => fn(tx) };
  const audit = { create: () => ({}), update: () => ({}), record: async () => {} };
  const service = new SalaryPaymentService(prisma, audit, {});
  await assert.rejects(
    () => service.post("payment-1", [{ ledger_id: "ledger-1", amount: "10" }], { id: "user-1" }),
    (error) => error.getResponse().code === "PAYROLL_PAYABLE_AMOUNT_MISMATCH",
  );
});

// 2026-09-15：工资台账新增房补与迟到/旷工/早退扣款。付款过账时的实发校验必须走同一份公式，
// 否则新类目会被静默忽略（工资应付 10、实发 19 却照样按 10 核销）。
function postingFixture({ housing = "15", late = "1", absence = "2", early = "3", payableAmount = "10" } = {}) {
  const payment = { id: "payment-1", status: "draft", amount: "100", currency: "CNY", bankId: "bank-1", paymentNo: "SALARY-1", paymentDate: new Date("2026-09-05"), paymentMethod: "bank", remark: null };
  const ledger = {
    id: "ledger-1", employeeId: "employee-1", currency: "CNY", status: "confirmed",
    baseSalary: new Prisma.Decimal("10"), productionSourceAmount: new Prisma.Decimal("0"),
    overtimeAmount: new Prisma.Decimal("0"), attendanceDeduction: new Prisma.Decimal("0"),
    lateDeduction: new Prisma.Decimal(late), absenceDeduction: new Prisma.Decimal(absence), earlyLeaveDeduction: new Prisma.Decimal(early),
    performanceAmount: new Prisma.Decimal("0"), allowanceAmount: new Prisma.Decimal("0"),
    housingAllowance: new Prisma.Decimal(housing),
    socialInsurance: new Prisma.Decimal("0"), individualTax: new Prisma.Decimal("0"),
    otherAdjustment: new Prisma.Decimal("0"),
  };
  const created = [];
  const tx = {
    $queryRaw: async () => [],
    salaryPayment: { findFirst: async () => ({ ...payment, status: "draft" }), update: async () => ({ ...payment, status: "posted" }) },
    payrollLedger: { findFirst: async () => ledger },
    payrollPayableEntry: { findFirst: async () => ({ id: "payable-1", ledgerId: "ledger-1", status: "confirmed", amount: new Prisma.Decimal(payableAmount) }) },
    payrollAdjustment: { findMany: async () => [] },
    salaryPaymentAllocation: { aggregate: async () => ({ _sum: { amount: null } }), create: async ({ data }) => { created.push(data); return data; } },
  };
  const prisma = { bank: bankStub, salaryPayment: { findFirst: async () => payment }, $transaction: async (fn) => fn(tx) };
  const audit = { create: () => ({}), update: () => ({}), record: async () => {} };
  const cashFlowCalls = [];
  const service = new SalaryPaymentService(prisma, audit, { refreshStatus: async () => {} }, undefined, { autoCreateFromPayment: async (input) => { cashFlowCalls.push(input); return { id: "cf-1" }; } });
  return { service, created, cashFlowCalls };
}

// ---------------------------------------------------------------------------
// 2026-09-16（用户要求「工资支付那边也是全部要加上银行账户，因为发工资都是要用银行账户发放的工资」）：
//   工资付款必须指定发放银行，过账时把银行写进收支流水 —— 否则这笔支出不进任何银行账户余额，
//   银行余额与真实银行账会永久差一笔工资。
// ---------------------------------------------------------------------------

test("工资付款建单：不指定发放银行直接 422（发工资都是走银行发放的）", async () => {
  let created = 0;
  const prisma = { bank: bankStub, salaryPayment: { create: async () => { created += 1; return {}; } } };
  const service = new SalaryPaymentService(prisma, { create: () => ({}), record: async () => {} }, {});
  await assert.rejects(
    () => service.create({ payment_date: "2026-09-05", amount: "100", currency: "CNY", payment_method: "银行转账" }, user),
    (error) => error.getResponse().code === "SALARY_PAYMENT_BANK_REQUIRED",
  );
  assert.equal(created, 0, "被拒绝时不得落库");
});

test("工资付款建单：银行不在池子里或已停用 → BANK_NOT_FOUND（外键拦不住「停用」）", async () => {
  let created = 0;
  const lookups = [];
  const prisma = {
    bank: { findFirst: async ({ where }) => { lookups.push(where); return null; } },
    salaryPayment: { create: async () => { created += 1; return {}; } },
  };
  const service = new SalaryPaymentService(prisma, { create: () => ({}), record: async () => {} }, {});
  await assert.rejects(
    () => service.create({ payment_date: "2026-09-05", amount: "100", currency: "CNY", payment_method: "银行转账", bank_id: "bank-dead" }, user),
    (error) => error.getResponse().code === "BANK_NOT_FOUND",
  );
  assert.deepEqual(lookups, [{ id: "bank-dead", deletedAt: null, isActive: true }]);
  assert.equal(created, 0);
});

test("工资付款建单：发放银行落库并写进审计", async () => {
  let created = null;
  const audits = [];
  const prisma = { bank: bankStub, salaryPayment: { create: async ({ data }) => { created = data; return { id: "payment-2", ...data }; } } };
  const service = new SalaryPaymentService(prisma, { create: () => ({}), record: async (...args) => audits.push(args) }, {});
  await service.create({ payment_date: "2026-09-05", amount: "100", currency: "CNY", payment_method: "银行转账", bank_id: "bank-1" }, user);
  assert.equal(created.bankId, "bank-1");
  assert.equal(audits[0][4].bank_id, "bank-1", "审计要能回答「这笔工资从哪个账户发的」");
});

test("编辑工资付款草稿：bank_id 传 null 表示清空发放银行，不传则不动", async () => {
  const current = { id: "payment-1", status: "draft", amount: new Prisma.Decimal("100"), currency: "CNY", bankId: "bank-1", paymentDate: new Date("2026-09-05"), paymentMethod: "转账", bankReference: null, remark: null };
  const updates = [];
  const tx = { $queryRaw: async () => [], salaryPayment: { findFirst: async () => current, update: async ({ data }) => { updates.push(data); return { ...current, ...data }; } } };
  const prisma = { bank: bankStub, $transaction: async (fn) => fn(tx) };
  const service = new SalaryPaymentService(prisma, { update: () => ({}), record: async () => {} }, {});

  await service.updateDraft("payment-1", { bank_id: null }, user);
  assert.equal(updates[0].bankId, null, "选错了要能去掉");
  await service.updateDraft("payment-1", { amount: "120" }, user);
  assert.equal(updates[1].bankId, "bank-1", "不传 = 不改");
});

test("工资付款过账：发放银行写进收支流水的 bankId（否则这笔支出不动任何账户余额）", async () => {
  // 该 fixture 的台账实发 = 10 + 房补 15 − 迟到 1 − 旷工 2 − 早退 3 = 19，应付金额必须跟它一致。
  const { service, cashFlowCalls } = postingFixture({ payableAmount: "19" });
  await service.post("payment-1", [{ ledger_id: "ledger-1", amount: "19" }], { id: "user-1" });
  assert.equal(cashFlowCalls.length, 1);
  assert.equal(cashFlowCalls[0].direction, "expense");
  assert.equal(cashFlowCalls[0].bankId, "bank-1", "有 bankId 才会动银行余额");
  assert.equal(cashFlowCalls[0].sourceType, "salary_payment");
});

test("工资付款过账：草稿上没有发放银行时拒绝（历史草稿不能静默出一笔无归属的支出）", async () => {
  const payment = { id: "payment-1", status: "draft", amount: "100", currency: "CNY", bankId: null, paymentNo: "SALARY-1", paymentDate: new Date("2026-09-05"), paymentMethod: "bank", remark: null };
  const prisma = { bank: bankStub, salaryPayment: { findFirst: async () => payment } };
  const service = new SalaryPaymentService(prisma, { create: () => ({}), record: async () => {} }, {});
  await assert.rejects(
    () => service.post("payment-1", [{ ledger_id: "ledger-1", amount: "10" }], { id: "user-1" }),
    (error) => error.getResponse().code === "SALARY_PAYMENT_BANK_REQUIRED",
  );
});

test("行内付款：不指定发放银行时在建任何单据之前就 422", async () => {
  const prisma = { bank: bankStub, payrollLedger: { findFirst: async () => ({ id: "ledger-1", status: "confirmed", currency: "CNY", deletedAt: null }) } };
  const service = new SalaryPaymentService(prisma, { record: async () => {} }, {});
  await assert.rejects(
    () => service.payLedger("ledger-1", { amount: "100", payment_date: "2026-03-05", payment_method: "银行转账" }, { id: "user-1" }),
    (error) => error.getResponse().code === "SALARY_PAYMENT_BANK_REQUIRED",
  );
});

test("房补与三种扣款参与过账的实发金额校验：应付 10 而实发 19 时拒绝核销", async () => {
  const { service, created } = postingFixture();
  await assert.rejects(
    () => service.post("payment-1", [{ ledger_id: "ledger-1", amount: "10" }], { id: "user-1" }),
    (error) => error.getResponse().code === "PAYROLL_PAYABLE_AMOUNT_MISMATCH",
  );
  assert.equal(created.length, 0, "金额不一致时不得落任何核销明细");
});

test("实发金额与新增类目一致时允许核销（10 + 房补 15 − 迟到 1 − 旷工 2 − 早退 3 = 19）", async () => {
  const { service, created } = postingFixture({ payableAmount: "19" });
  const result = await service.post("payment-1", [{ ledger_id: "ledger-1", amount: "19" }], { id: "user-1" });
  assert.equal(result.status, "posted");
  assert.equal(created.length, 1);
  assert.equal(created[0].amount.toString(), "19");
});

test("工资付款按月份/部门/岗位筛选（用户需求第 4 条）", async () => {
  let captured;
  const prisma = { bank: bankStub, salaryPayment: { findMany: async (args) => { captured = args; return []; } } };
  const service = new SalaryPaymentService(prisma, {}, {});
  await service.list(undefined, "2026-09", "dep-1", "pos-1");
  assert.equal(captured.where.paymentDate.gte.toISOString(), "2026-09-01T00:00:00.000Z");
  assert.equal(captured.where.paymentDate.lte.toISOString(), "2026-09-30T00:00:00.000Z");
  assert.deepEqual(captured.where.allocations, { some: { deletedAt: null, ledger: { deletedAt: null, employee: { departmentId: "dep-1", positionId: "pos-1" } } } });
  assert.equal(captured.include.allocations.include.ledger.include.employee.include.department, true, "部门/岗位筛的是核销员工，界面还要显示名称");
  assert.equal(captured.include.allocations.include.ledger.include.employee.include.position, true);
});

test("工资付款没有筛选条件时不加 paymentDate / allocations 过滤（避免过滤掉任何付款单）", async () => {
  let captured;
  const prisma = { bank: bankStub, salaryPayment: { findMany: async (args) => { captured = args; return []; } } };
  const service = new SalaryPaymentService(prisma, {}, {});
  await service.list("posted");
  assert.equal(captured.where.status, "posted");
  assert.equal(captured.where.paymentDate, undefined);
  assert.equal(captured.where.allocations, undefined);
});

test("工资付款非法月份返回 422，而不是静默返回全部付款", async () => {
  const service = new SalaryPaymentService({ salaryPayment: { findMany: async () => [] } }, {}, {});
  await assert.rejects(() => service.list(undefined, "2026/09"), (error) => error.getResponse().code === "INVALID_MONTH");
});

// ------------------------------------------------------------------ 工资付款表格里的行内付款／冲销
//
// 这一组测的是**编排**：四步链路（应付 → 付款 → 核销）的顺序、守卫与失败回滚。
// 各步自己的金额/状态校验由上面那些用例与 payroll-payable-service.test.cjs 负责，这里把它们当协作者替换掉。

function payFixture({ ledgerStatus = "confirmed", outstanding = "100", payableStatus = "confirmed", postFails = false } = {}) {
  const calls = [];
  const prisma = {
    bank: bankStub,
    payrollLedger: { findFirst: async () => ({ id: "ledger-1", ledgerNo: "PAYROLL-1", employeeId: "employee-1", status: ledgerStatus, currency: "CNY", deletedAt: null }) },
    salaryPayment: { update: async ({ where, data }) => { calls.push(["softDelete", where.id, data]); return {}; } },
  };
  const audit = {
    create: () => ({}), update: () => ({}),
    softDelete: (user) => ({ deletedAt: new Date(), deletedBy: user.id }),
    record: async (...args) => { calls.push(["audit", args[0]]); },
  };
  const payroll = { get: async () => ({ payableAmount: outstanding, paidAmount: "0.0000", outstandingAmount: outstanding }) };
  const payables = {
    createFromLedger: async () => { calls.push(["createPayable"]); return { id: "payable-1", status: payableStatus }; },
    confirm: async (id) => { calls.push(["confirmPayable", id]); return { id, status: "confirmed" }; },
  };
  const service = new SalaryPaymentService(prisma, audit, payroll, payables, { autoCreateFromPayment: async () => {} });
  service.create = async (input) => { calls.push(["createPayment", input]); return { id: "payment-1", paymentNo: "SALARY-1", amount: input.amount, currency: input.currency, status: "draft" }; };
  service.post = async (id, allocations) => {
    calls.push(["post", id, allocations]);
    if (postFails) throw new UnprocessableEntityException({ code: "SALARY_PAYMENT_ALLOCATION_EXCEEDED", message: "核销金额超过工资付款金额", details: [] });
    return { id, paymentNo: "SALARY-1", status: "posted" };
  };
  return { service, calls };
}

const payInput = { amount: "100", payment_date: "2026-03-05", payment_method: "银行转账", bank_id: "bank-1" };

test("行内付款：一次调用完成「生成应付 → 建付款 → 核销过账」，币种跟随台账", async () => {
  const { service, calls } = payFixture();
  const result = await service.payLedger("ledger-1", payInput, { id: "user-1" });
  assert.equal(result.status, "posted");
  assert.deepEqual(calls.map((item) => item[0]), ["createPayable", "createPayment", "post"]);
  assert.equal(calls[1][1].currency, "CNY", "付款币种由台账决定，避免币种不一致导致核销被拒");
  assert.deepEqual(calls[2][2], [{ ledger_id: "ledger-1", amount: "100" }]);
});

test("行内付款：草稿工资应付会自动确认（过账只接受已确认/部分支付的应付）", async () => {
  const { service, calls } = payFixture({ payableStatus: "draft" });
  await service.payLedger("ledger-1", payInput, { id: "user-1" });
  assert.deepEqual(calls.map((item) => item[0]), ["createPayable", "confirmPayable", "createPayment", "post"]);
  assert.equal(calls[1][1], "payable-1");
});

test("行内付款：超过未付余额时 422，且不产生任何单据", async () => {
  const { service, calls } = payFixture({ outstanding: "99.9999" });
  await assert.rejects(
    () => service.payLedger("ledger-1", payInput, { id: "user-1" }),
    (error) => error.getResponse().code === "SALARY_ALLOCATION_EXCEEDED",
  );
  assert.deepEqual(calls, [], "余额不足必须在写任何单据之前就拒绝");
});

test("行内付款：台账未确认/已结清时 422，币种与台账不一致时 422", async () => {
  const draft = payFixture({ ledgerStatus: "draft" });
  await assert.rejects(() => draft.service.payLedger("ledger-1", payInput, { id: "user-1" }), (error) => error.getResponse().code === "PAYROLL_NOT_ALLOCATABLE");
  assert.deepEqual(draft.calls, []);
  const mismatch = payFixture();
  await assert.rejects(() => mismatch.service.payLedger("ledger-1", { ...payInput, currency: "USD" }, { id: "user-1" }), (error) => error.getResponse().code === "PAYROLL_CURRENCY_MISMATCH");
  assert.deepEqual(mismatch.calls, []);
});

test("行内付款：台账的工资应付已冲销时 422（不能静默当作已付）", async () => {
  const { service, calls } = payFixture({ payableStatus: "reversed" });
  await assert.rejects(() => service.payLedger("ledger-1", payInput, { id: "user-1" }), (error) => error.getResponse().code === "PAYROLL_PAYABLE_NOT_PAYABLE");
  assert.deepEqual(calls.map((item) => item[0]), ["createPayable"], "只应生成/读取应付，不建付款单");
});

test("行内付款：核销失败时把本次付款草稿软删除，不留孤儿单据", async () => {
  const { service, calls } = payFixture({ postFails: true });
  await assert.rejects(() => service.payLedger("ledger-1", payInput, { id: "user-1" }), (error) => error.getResponse().code === "SALARY_PAYMENT_ALLOCATION_EXCEEDED");
  const softDeleted = calls.find((item) => item[0] === "softDelete");
  assert.ok(softDeleted, "失败尝试必须回滚付款草稿（付款单没有删除接口，孤儿草稿会一直挂在列表里）");
  assert.equal(softDeleted[1], "payment-1");
  assert.ok(softDeleted[2].deletedAt instanceof Date);
  assert.ok(calls.some((item) => item[0] === "audit" && item[1] === "salary_payment.rollback_draft"));
});

test("行内冲销：把该台账下所有已过账的付款逐张冲销", async () => {
  const reversed = [];
  const prisma = {
    payrollLedger: { findFirst: async () => ({ id: "ledger-1", ledgerNo: "PAYROLL-1", deletedAt: null }) },
    salaryPaymentAllocation: {
      findMany: async () => [
        { paymentId: "payment-1", payment: { status: "posted" } },
        { paymentId: "payment-2", payment: { status: "draft" } },
        { paymentId: "payment-2", payment: { status: "draft" } },
      ],
    },
  };
  const service = new SalaryPaymentService(prisma, { record: async () => {} }, {}, {});
  service.reverse = async (id, reason) => { reversed.push([id, reason]); return { paymentNo: `SALARY-${id}`, amount: "50" }; };
  const result = await service.reverseLedgerPayments("ledger-1", "银行退回", { id: "user-1" });
  assert.deepEqual(reversed, [["payment-1", "银行退回"]], "只冲销已过账的付款，草稿不动");
  assert.deepEqual(result.reversed, [{ payment_no: "SALARY-payment-1", amount: "50" }]);
});

test("行内冲销：没有已过账付款时 422；缺原因时 422", async () => {
  const prisma = {
    payrollLedger: { findFirst: async () => ({ id: "ledger-1", ledgerNo: "PAYROLL-1", deletedAt: null }) },
    salaryPaymentAllocation: { findMany: async () => [{ paymentId: "payment-2", payment: { status: "draft" } }] },
  };
  const service = new SalaryPaymentService(prisma, { record: async () => {} }, {}, {});
  await assert.rejects(() => service.reverseLedgerPayments("ledger-1", "退回", { id: "user-1" }), (error) => error.getResponse().code === "SALARY_PAYMENT_NOT_REVERSIBLE");
  await assert.rejects(() => service.reverseLedgerPayments("ledger-1", "  ", { id: "user-1" }), (error) => error.getResponse().code === "REVERSAL_REASON_REQUIRED");
});
