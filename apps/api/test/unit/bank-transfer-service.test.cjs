// BankTransferService：银行余额互转的建单与冲销（不连数据库）。
//
// 为什么这些断言重要：互转直接改两个账户的余额，是最容易把账搞乱的操作之一。
// 四条硬规则必须在接口层挡住（库层的 CHECK 只是最后一道兜底）：
//   1. 两个账户都必须存在、未删除、**未停用**；
//   2. 不能自己转给自己；
//   3. 币种必须与所选账户的币种一致（账户只对应一个币种）；
//   4. 同币种两边金额必须相等 —— 差额没有科目承载。
const assert = require("node:assert/strict");
const test = require("node:test");
const { Prisma } = require("@prisma/client");
const { BankTransferService } = require("../../dist/modules/finance/bank-transfer.service.js");

const dec = (value) => new Prisma.Decimal(value);
const audit = { create: () => ({ createdBy: "user-1", updatedBy: "user-1" }), update: () => ({ updatedBy: "user-1" }), record: async () => {} };
const banksById = {
  "bank-cny": { id: "bank-cny", currency: "CNY" },
  "bank-usd": { id: "bank-usd", currency: "USD" },
  "bank-other": { id: "bank-other", currency: "CNY" },
};

/** 银行余额查询的替身（建单后会读一次余额用于「会不会转成负数」的提示）。 */
const banksStub = () => ({ balances: async () => [{ id: "bank-cny", balance: "1000.0000" }, { id: "bank-usd", balance: "0.0000" }, { id: "bank-other", balance: "0.0000" }] });

function harness({ created, transferRows = [] } = {}) {
  const calls = { bankFindFirst: [], create: null };
  const prisma = {
    bank: { findFirst: async (args) => { calls.bankFindFirst.push(args); return banksById[args.where.id] ?? null; } },
    bankTransfer: {
      findMany: async () => transferRows,
      findFirst: async () => transferRows[0] ?? null,
      create: async ({ data }) => { calls.create = data; return { id: "tr-1", ...data }; },
      update: async ({ data }) => ({ id: "tr-1", ...data }),
    },
    $transaction: async (fn) => fn({
      $queryRaw: async () => [],
      bankTransfer: {
        findFirst: async () => ({ id: "tr-1", status: "posted", transferNo: "BTR-1" }),
        update: async ({ data }) => ({ id: "tr-1", transferNo: "BTR-1", ...data }),
      },
    }),
  };
  if (created) prisma.bankTransfer.create = async ({ data }) => { created.push(data); return { id: "tr-1", ...data }; };
  return { prisma, calls, service: new BankTransferService(prisma, audit, banksStub()) };
}

const transferInput = (extra = {}) => ({ transfer_date: "2026-09-16", from_bank_id: "bank-cny", to_bank_id: "bank-usd", from_amount: "1000", to_amount: "140", ...extra });

test("同币种互转：不填对方金额时默认等于本方金额，汇率记 1", async () => {
  const created = [];
  const { service } = harness({ created });
  await service.create(transferInput({ to_bank_id: "bank-other", to_amount: undefined }), { id: "user-1" });
  assert.equal(created.length, 1);
  assert.equal(created[0].fromCurrency, "CNY");
  assert.equal(created[0].fromAmount.toFixed(4), "1000.0000");
  assert.equal(created[0].toAmount.toFixed(4), "1000.0000");
  assert.equal(created[0].exchangeRate.toFixed(6), "1.000000");
  assert.equal(created[0].status, "posted");
  assert.match(created[0].transferNo, /^BTR-\d{8}-[0-9A-F]{8}$/);
});

test("跨币种互转：币种取账户币种，两边金额与汇率都要落库", async () => {
  const created = [];
  const { service } = harness({ created });
  await service.create(transferInput(), { id: "user-1" });
  assert.equal(created[0].fromCurrency, "CNY");
  assert.equal(created[0].toCurrency, "USD");
  assert.equal(created[0].toAmount.toFixed(4), "140.0000");
  assert.equal(created[0].exchangeRate.toFixed(6), "0.140000");
});

test("币种必须与所选账户一致（人民币户不能转出美元）", async () => {
  const { service } = harness({ created: [] });
  await assert.rejects(
    () => service.create(transferInput({ from_currency: "USD" }), { id: "user-1" }),
    (error) => error.getResponse().code === "TRANSFER_CURRENCY_MISMATCH",
  );
});

test("自己转给自己被拒绝（库层还有 CHECK 兜底）", async () => {
  const { service } = harness({ created: [] });
  await assert.rejects(
    () => service.create(transferInput({ to_bank_id: "bank-cny", to_amount: undefined }), { id: "user-1" }),
    (error) => error.getResponse().code === "TRANSFER_SAME_BANK",
  );
});

test("同币种两边金额不等被拒绝（差额没有科目承载）", async () => {
  const { service } = harness({ created: [] });
  await assert.rejects(
    () => service.create(transferInput({ to_bank_id: "bank-other", to_amount: "999" }), { id: "user-1" }),
    (error) => error.getResponse().code === "SAME_CURRENCY_AMOUNT_MISMATCH",
  );
});

test("账户不存在或已停用 → BANK_NOT_FOUND（停用账户外键拦不住）", async () => {
  const { service } = harness({ created: [] });
  await assert.rejects(
    () => service.create(transferInput({ from_bank_id: "bank-dead" }), { id: "user-1" }),
    (error) => error.getResponse().code === "BANK_NOT_FOUND",
  );
  await assert.rejects(
    () => service.create(transferInput({ to_bank_id: "bank-dead" }), { id: "user-1" }),
    (error) => error.getResponse().code === "BANK_NOT_FOUND",
  );
});

test("账户 id 缺失直接 422（表单没选账户时不该变成一次全表查询）", async () => {
  const { service, calls } = harness({ created: [] });
  await assert.rejects(
    () => service.create(transferInput({ from_bank_id: "  " }), { id: "user-1" }),
    (error) => error.getResponse().code === "BANK_REQUIRED",
  );
  assert.equal(calls.bankFindFirst.length, 0);
});

test("金额非法（0/负数/非数字）一律 422", async () => {
  const { service } = harness({ created: [] });
  for (const bad of ["0", "-5", "abc"]) {
    await assert.rejects(
      () => service.create(transferInput({ from_amount: bad }), { id: "user-1" }),
      (error) => error.getResponse().code === "INVALID_TRANSFER_AMOUNT",
      `金额 ${bad} 必须被拒绝`,
    );
  }
});

test("转出会透支时只提示不拦截：回报 source_balance_after 与 insufficient_balance", async () => {
  const created = [];
  const { service } = harness({ created });
  const result = await service.create(transferInput({ from_amount: "5000", to_amount: "700" }), { id: "user-1" });
  assert.equal(result.source_balance_before, "1000.0000");
  assert.equal(result.source_balance_after, "-4000.0000");
  assert.equal(result.insufficient_balance, true, "余额不足必须回报给界面提示（硬拦会挡住银行到账时间差等真实业务）");
  assert.equal(created.length, 1, "但仍然落库：财务确认过的资金动作不能被系统擅自拒绝");
});

test("冲销：只有 posted 可以冲销，且必须填原因", async () => {
  const { service } = harness({ created: [] });
  await assert.rejects(
    () => service.reverse("tr-1", "   ", { id: "user-1" }),
    (error) => error.getResponse().code === "REVERSAL_REASON_REQUIRED",
  );
  const row = await service.reverse("tr-1", "填错账户", { id: "user-1" });
  assert.equal(row.status, "reversed");
  assert.equal(row.reversalReason, "填错账户");
});

test("列表：按期间与账户筛选，账户筛选是「本方或对方」", async () => {
  const { prisma, service } = harness({ created: [], transferRows: [] });
  let captured = null;
  prisma.bankTransfer.findMany = async (args) => { captured = args; return []; };
  await service.list({ from: "2026-09-01", to: "2026-09-30", bankId: "bank-cny" });
  assert.equal(captured.where.transferDate.gte.toISOString(), "2026-09-01T00:00:00.000Z");
  assert.equal(captured.where.transferDate.lte.toISOString(), "2026-09-30T00:00:00.000Z");
  assert.deepEqual(captured.where.OR, [{ fromBankId: "bank-cny" }, { toBankId: "bank-cny" }], "查某个账户的互转要同时看转出与转入");
});

test("列表：开始日期晚于结束日期直接拒绝", async () => {
  const { service } = harness({ created: [] });
  await assert.rejects(
    () => service.list({ from: "2026-09-30", to: "2026-09-01" }),
    (error) => error.getResponse().code === "INVALID_TRANSFER_RANGE",
  );
});
