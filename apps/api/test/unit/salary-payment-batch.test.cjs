const assert = require("node:assert/strict");
const { test } = require("node:test");
const { NotFoundException, UnprocessableEntityException } = require("@nestjs/common");
const { Prisma } = require("@prisma/client");
const { SalaryPaymentService } = require("../../dist/modules/hr/salary-payment.service.js");

/**
 * 批量付款（`SalaryPaymentService.payBatch`）的编排测试。
 *
 * 用户决定：批量 = **N 张各自独立的付款单**（一人一张），不是「一张付款单核销多人」。
 * 因此这一组钉住的是编排本身：串行、逐条隔离、合计只算成功的人、银行先校验一次。
 * 「一行内付款」自己的金额/状态校验与失败软删草稿，由 `salary-payment-service.test.cjs` 负责，
 * 这里把 `payLedger` 换成协作者（下面另有一条真实路径的用例，专门验「失败只软删自己那张草稿」）。
 */

const bank = { id: "bank-1", bankName: "农业银行", accountNumber: "5706" };
const user = { id: "user-1" };

/** 三张可付款台账（含员工，供「失败也要报出是谁」用）。 */
const ledgerRows = {
  "ledger-1": { id: "ledger-1", ledgerNo: "PAYROLL-1", status: "confirmed", currency: "CNY", deletedAt: null, employee: { employeeNo: "E-001", name: "张三" } },
  "ledger-2": { id: "ledger-2", ledgerNo: "PAYROLL-2", status: "confirmed", currency: "CNY", deletedAt: null, employee: { employeeNo: "E-002", name: "李四" } },
  "ledger-3": { id: "ledger-3", ledgerNo: "PAYROLL-3", status: "partially_paid", currency: "CNY", deletedAt: null, employee: { employeeNo: "E-003", name: "王五" } },
};

/**
 * 批量 fixture：`payLedger` 被替换成记录调用并可逐条注入失败的协作者。
 * `missing` 里的台账在库里查不到（模拟「勾选的人已被删/不存在」）。
 */
function batchFixture({ missing = [], failures = {}, bankRow = bank } = {}) {
  const calls = [];
  const audits = [];
  const prisma = {
    bank: { findFirst: async () => bankRow },
    payrollLedger: { findFirst: async ({ where }) => (missing.includes(where.id) ? null : ledgerRows[where.id] ?? null) },
  };
  const audit = { create: () => ({}), update: () => ({}), softDelete: () => ({}), record: async (...args) => { audits.push(args); } };
  const service = new SalaryPaymentService(prisma, audit, {});
  service.payLedger = async (id, input) => {
    calls.push([id, input]);
    if (failures[id]) throw failures[id];
    return { id: `payment-${id}`, paymentNo: `SALARY-${id}`, status: "posted" };
  };
  return { service, calls, audits };
}

const batchInput = { payment_date: "2026-03-25", payment_method: "银行转账", bank_id: "bank-1" };
const items = [
  { ledger_id: "ledger-1", amount: "100" },
  { ledger_id: "ledger-2", amount: "200.5" },
  { ledger_id: "ledger-3", amount: "300" },
];

test("批量付款：勾选几人就串行调用几次行内付款（一人一张付款单，不是一张单核销多人）", async () => {
  const { service, calls } = batchFixture();
  const result = await service.payBatch(items, batchInput, user);
  assert.deepEqual(calls.map((item) => item[0]), ["ledger-1", "ledger-2", "ledger-3"], "必须串行、按提交顺序：payLedger 会加台账行锁并写审计，并发会让审计顺序不确定");
  assert.deepEqual(calls[0][1], { amount: "100", payment_date: "2026-03-25", payment_method: "银行转账", currency: undefined, bank_id: "bank-1", remark: undefined });
  assert.equal(result.requested_count, 3);
  assert.equal(result.succeeded_count, 3);
  assert.equal(result.failed_count, 0);
  assert.equal(result.total_amount, "600.5000");
  assert.deepEqual(result.bank, { id: "bank-1", bank_name: "农业银行", account_number: "5706" });
  assert.deepEqual(result.succeeded.map((item) => [item.ledger_id, item.employee_no, item.employee_name, item.amount]), [
    ["ledger-1", "E-001", "张三", "100"],
    ["ledger-2", "E-002", "李四", "200.5"],
    ["ledger-3", "E-003", "王五", "300"],
  ]);
});

test("批量付款：某一条失败只影响本人，其余照付，合计只算成功的金额", async () => {
  const { service, calls } = batchFixture({
    failures: { "ledger-2": new UnprocessableEntityException({ code: "PAYROLL_NOT_ALLOCATABLE", message: "台账尚未确认或已结清，不能付款", details: [] }) },
  });
  const result = await service.payBatch(items, batchInput, user);
  assert.equal(calls.length, 3, "失败之后必须继续处理后面的人（一个人的失败不能把整批拖停）");
  assert.equal(result.succeeded_count, 2);
  assert.equal(result.failed_count, 1);
  assert.equal(result.total_amount, "400.0000", "合计只统计真正付出去的钱（失败的那 200.5 不计）");
  assert.deepEqual(result.failed.map((item) => [item.ledger_id, item.employee_no, item.employee_name, item.amount, item.code]), [
    ["ledger-2", "E-002", "李四", "200.5", "PAYROLL_NOT_ALLOCATABLE"],
  ]);
  assert.equal(result.failed[0].message, "台账尚未确认或已结清，不能付款");
});

test("批量付款：台账查不到时也用台账 ID 顶替工号/姓名，并说明「台账不存在」", async () => {
  const { service } = batchFixture({
    missing: ["ledger-9"],
    failures: { "ledger-9": new NotFoundException({ code: "PAYROLL_LEDGER_NOT_FOUND", message: "薪资台账不存在", details: [] }) },
  });
  const result = await service.payBatch([...items, { ledger_id: "ledger-9", amount: "50" }], batchInput, user);
  const failed = result.failed.find((item) => item.ledger_id === "ledger-9");
  assert.equal(failed.employee_no, "ledger-9");
  assert.equal(failed.employee_name, "ledger-9");
  assert.equal(failed.code, "PAYROLL_LEDGER_NOT_FOUND");
  assert.equal(failed.message, "薪资台账不存在（工号与姓名以台账 ID 代替）", "失败的条目也要能报出「是谁」，查不到人时明说用 ID 顶替");
});

test("批量付款：空列表 422，不会打款", async () => {
  const { service, calls } = batchFixture();
  await assert.rejects(() => service.payBatch([], batchInput, user), (error) => error.getResponse().code === "SALARY_PAYMENT_BATCH_EMPTY");
  assert.deepEqual(calls, []);
});

test("批量付款：同一台账重复出现 422（同一张台账不该在一个批次里付两次）", async () => {
  const { service, calls } = batchFixture();
  await assert.rejects(
    () => service.payBatch([{ ledger_id: "ledger-1", amount: "100" }, { ledger_id: "ledger-1", amount: "50" }], batchInput, user),
    (error) => error.getResponse().code === "DUPLICATE_SALARY_ALLOCATION",
  );
  assert.deepEqual(calls, []);
});

test("批量付款：发放银行缺失/非法时，在付任何一条之前就 422/404（不产生半成品批次）", async () => {
  const noBank = batchFixture({ bankRow: null });
  await assert.rejects(
    () => noBank.service.payBatch(items, { payment_date: "2026-03-25", payment_method: "银行转账" }, user),
    (error) => error.getResponse().code === "SALARY_PAYMENT_BANK_REQUIRED",
  );
  assert.deepEqual(noBank.calls, [], "银行必须整批只校验一次、且在任何条目之前：半路失败会剩下一批「先成功后全失败」的半成品");

  // 传了一个池子里没有（或已停用）的账户：`requireActiveBank` 按 BANK_NOT_FOUND 拒收。
  // 前端下拉只列启用中的账户，接口被直接调用时才走这条路径。
  const deadBank = batchFixture({ bankRow: null });
  await assert.rejects(
    () => deadBank.service.payBatch(items, { ...batchInput, bank_id: "bank-dead" }, user),
    (error) => error.getResponse().code === "BANK_NOT_FOUND",
  );
  assert.deepEqual(deadBank.calls, []);
});

test("批量付款：写一条 salary_payment.pay_batch 审计，带批次数与失败的台账 id", async () => {
  const { service, audits } = batchFixture({ failures: { "ledger-3": new UnprocessableEntityException({ code: "PAYROLL_NOT_ALLOCATABLE", message: "台账尚未确认或已结清，不能付款", details: [] }) } });
  await service.payBatch(items, batchInput, user);
  const batch = audits.find((args) => args[0] === "salary_payment.pay_batch");
  assert.ok(batch, "批量付款必须留审计：一次操作动了多人多单，出问题要能回答「这一批都做了什么」");
  assert.equal(batch[1], "salary_payment");
  assert.equal(batch[2], "user-1");
  assert.deepEqual(batch[4].failed_ledger_ids, ["ledger-3"]);
  assert.equal(batch[4].requested_count, 3);
  assert.equal(batch[4].succeeded_count, 2);
  assert.equal(batch[4].failed_count, 1);
  assert.equal(batch[4].total_amount, "300.5000");
  assert.equal(batch[4].bank_id, "bank-1");
});

/**
 * 真实路径：不替换 `payLedger`，只把 `create` / `post` 换成可控协作者。
 *
 * 这一条验的是「失败必须什么都不留下」这句承诺在**批量**里也成立：失败那条自己的付款草稿被软删，
 * 同一批里已经成功的付款不受影响（它只软删自己那一张）。
 */
test("批量付款：核销失败的那一条只软删自己的付款草稿，同批成功的人不受影响", async () => {
  const softDeleted = [];
  const created = [];
  const prisma = {
    bank: { findFirst: async () => bank },
    payrollLedger: { findFirst: async ({ where }) => ledgerRows[where.id] ?? null },
    salaryPayment: { update: async ({ where }) => { softDeleted.push(where.id); return {}; } },
  };
  const audit = { create: () => ({}), update: () => ({}), softDelete: (actor) => ({ deletedAt: new Date(), deletedBy: actor.id }), record: async () => {} };
  const payroll = { get: async () => ({ payableAmount: "1000.0000", paidAmount: "0.0000", outstandingAmount: "1000.0000" }) };
  const payables = { createFromLedger: async () => ({ id: "payable-1", status: "confirmed" }), confirm: async (id) => ({ id, status: "confirmed" }) };
  const service = new SalaryPaymentService(prisma, audit, payroll, payables, {});
  service.create = async (input) => { created.push(input); return { id: `payment-${created.length}`, status: "draft", amount: new Prisma.Decimal(input.amount) }; };
  service.post = async (id) => {
    if (id === "payment-2") throw new UnprocessableEntityException({ code: "SALARY_PAYMENT_ALLOCATION_EXCEEDED", message: "核销金额超过工资付款金额", details: [] });
    return { id, status: "posted" };
  };
  const result = await service.payBatch([{ ledger_id: "ledger-1", amount: "100" }, { ledger_id: "ledger-2", amount: "200" }], batchInput, user);
  assert.equal(created.length, 2, "两人各建一张付款单");
  assert.deepEqual(softDeleted, ["payment-2"], "只有失败的那张草稿被软删（付款单没有删除接口，孤儿草稿会一直挂在列表里）");
  assert.equal(result.succeeded_count, 1);
  assert.equal(result.failed_count, 1);
  assert.equal(result.total_amount, "100.0000");
});
