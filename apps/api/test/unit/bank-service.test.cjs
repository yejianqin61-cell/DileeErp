// BankService：期初余额校验 + 账户余额聚合（不连数据库，用记账式 Prisma 替身）。
//
// 为什么余额聚合值得单独测：它跨三张表（banks / cash_flow_entries / bank_transfers），
// 而三条口径最容易在实现里被悄悄写错 ——
//   1. 只算 `status = posted` 的流水与互转（冲销过的不算）；
//   2. 只算**落在本账户上**的流水（没指定 bank_id 的流水是收支事实，但不属于任何账户）；
//   3. 互转不是收支，只在余额里体现，不能混进 cash_in/cash_out。
const assert = require("node:assert/strict");
const test = require("node:test");
const { Prisma } = require("@prisma/client");
const { BankService } = require("../../dist/modules/finance/bank.service.js");

const dec = (value) => new Prisma.Decimal(value);
const audit = { create: () => ({ createdBy: "user-1", updatedBy: "user-1" }), update: () => ({ updatedBy: "user-1" }), record: async () => {} };

const bankRow = (id, openingBalance, extra = {}) => ({
  id,
  bankCode: `B-${id}`,
  bankName: `银行${id}`,
  accountName: "迪礼",
  accountNumber: `5706${id}`,
  currency: "CNY",
  openingBalance: dec(openingBalance),
  isActive: true,
  ...extra,
});

/** 余额聚合的 Prisma 替身：三个查询各自记录参数并返回预设结果。 */
function balanceHarness({ banks = [], grouped = [], transfers = [], counts = [] } = {}) {
  const calls = { groupBy: [], transfers: [] };
  const prisma = {
    bank: { findMany: async () => banks },
    cashFlowEntry: {
      groupBy: async (args) => {
        calls.groupBy.push(args);
        // 第一次 groupBy 是「账户 × 方向」求和，第二次是「账户」计数（由 by 字段区分）。
        return args.by.length > 1 ? grouped : counts;
      },
    },
    bankTransfer: { findMany: async (args) => { calls.transfers.push(args); return transfers; } },
  };
  return { prisma, calls };
}

test("余额 = 期初 + 收入 − 支出 + 转入 − 转出，并带出五个分量", async () => {
  const { prisma } = balanceHarness({
    banks: [bankRow("b1", "1000")],
    grouped: [{ bankId: "b1", direction: "income", _sum: { amount: dec("500") } }, { bankId: "b1", direction: "expense", _sum: { amount: dec("200.5") } }],
    transfers: [{ fromBankId: "b1", fromAmount: dec("100.25"), toBankId: "b2", toAmount: dec("100.25") }],
    counts: [{ bankId: "b1", _count: { _all: 3 } }],
  });
  const rows = await new BankService(prisma, audit).balances();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].opening_balance, "1000.0000");
  assert.equal(rows[0].cash_in, "500.0000");
  assert.equal(rows[0].cash_out, "200.5000");
  assert.equal(rows[0].transfer_in, "0.0000");
  assert.equal(rows[0].transfer_out, "100.2500");
  assert.equal(rows[0].balance, "1199.2500");
  assert.equal(rows[0].cash_flow_count, 3, "条数一并给出：财务要能看出「这个余额是几条流水撑起来的」");
  assert.equal(rows[0].currency, "CNY");
});

test("互转只算净额，绝不进 cash_in / cash_out（否则收支口径被污染）", async () => {
  const { prisma } = balanceHarness({
    banks: [bankRow("b1", "0"), bankRow("b2", "0")],
    transfers: [{ fromBankId: "b1", fromAmount: dec("300"), toBankId: "b2", toAmount: dec("300") }],
  });
  const rows = await new BankService(prisma, audit).balances();
  const from = rows.find((row) => row.id === "b1");
  const to = rows.find((row) => row.id === "b2");
  assert.equal(from.balance, "-300.0000");
  assert.equal(from.cash_out, "0.0000", "互转不是支出");
  assert.equal(to.balance, "300.0000");
  assert.equal(to.cash_in, "0.0000", "互转不是收入");
});

test("只统计 status=posted 的流水与未删除的互转（冲销过的不算）", async () => {
  const { prisma, calls } = balanceHarness({ banks: [bankRow("b1", "0")] });
  await new BankService(prisma, audit).balances();
  assert.equal(calls.groupBy[0].where.status, "posted");
  assert.equal(calls.groupBy[0].where.deletedAt, null);
  assert.deepEqual(calls.groupBy[0].where.bankId, { in: ["b1"] }, "只算落在本账户上的流水");
  assert.equal(calls.transfers[0].where.status, "posted");
  assert.equal(calls.transfers[0].where.deletedAt, null);
  assert.deepEqual(calls.transfers[0].where.OR, [{ fromBankId: { in: ["b1"] } }, { toBankId: { in: ["b1"] } }]);
});

test("asOf 传日期时按当天 23:59:59.999 截断（含当天），流水与互转都要截", async () => {
  const { prisma, calls } = balanceHarness({ banks: [bankRow("b1", "0")] });
  await new BankService(prisma, audit).balances("2026-09-30");
  assert.equal(calls.groupBy[0].where.entryDate.lte.toISOString(), "2026-09-30T23:59:59.999Z");
  assert.equal(calls.transfers[0].where.transferDate.lte.toISOString(), "2026-09-30T23:59:59.999Z", "互转也必须截断，否则「上月底余额」会把下月的互转算进去");
});

test("asOf 格式非法直接 422，不去猜财务想查哪一天", async () => {
  const { prisma } = balanceHarness({ banks: [bankRow("b1", "0")] });
  await assert.rejects(
    () => new BankService(prisma, audit).balances("2026/09/30"),
    (error) => error.getResponse().code === "INVALID_AS_OF_DATE",
  );
});

test("没有账户时不查流水（一次查询都不发）", async () => {
  const { prisma, calls } = balanceHarness({ banks: [] });
  assert.deepEqual(await new BankService(prisma, audit).balances(), []);
  assert.equal(calls.groupBy.length, 0);
  assert.equal(calls.transfers.length, 0);
});

test("期初余额：允许 0 与非负小数，负数/非法值一律 422", async () => {
  const created = [];
  const prisma = {
    bank: { findFirst: async () => null, create: async ({ data }) => { created.push(data); return { id: "b-new", ...data }; } },
  };
  const service = new BankService(prisma, audit);
  const input = { bank_code: "ABC", bank_name: "农业银行", account_name: "迪礼", account_number: "5706", currency: "CNY" };
  await service.create({ ...input, opening_balance: "1234.56" }, { id: "user-1" });
  assert.equal(created[0].openingBalance.toFixed(4), "1234.5600");
  await service.create(input, { id: "user-1" });
  assert.equal(created[1].openingBalance.toFixed(4), "0.0000", "不填就是 0，不是 NULL（NULL 会让余额算不出来）");
  assert.equal(created[1].bankCode, "ABC");
  // 空串按 0 处理：表单里清空期初余额提交的是空串。
  await service.create({ ...input, opening_balance: "" }, { id: "user-1" });
  assert.equal(created[2].openingBalance.toFixed(4), "0.0000");
  for (const bad of ["-1", "abc"]) {
    await assert.rejects(
      () => service.create({ ...input, opening_balance: bad }, { id: "user-1" }),
      (error) => error.getResponse().code === "INVALID_OPENING_BALANCE",
      `期初余额 ${bad} 必须被拒绝：负期初只可能来自透支或历史错误，本系统没有承载它的科目`,
    );
  }
});

test("编辑账户可以改期初余额", async () => {
  let updated = null;
  const current = bankRow("b1", "0");
  const prisma = {
    bank: { findFirst: async () => current, update: async ({ data }) => { updated = data; return { ...current, ...data }; } },
  };
  await new BankService(prisma, audit).update("b1", { opening_balance: "888" }, { id: "user-1" });
  assert.equal(updated.openingBalance.toFixed(4), "888.0000");
});

test("单个账户余额：账户不存在时不返回一个看起来正常的 0", async () => {
  const { prisma } = balanceHarness({ banks: [] });
  prisma.bank.findFirst = async () => null;
  await assert.rejects(
    () => new BankService(prisma, audit).balanceOf("bank-missing"),
    (error) => error.getResponse().code === "BANK_NOT_FOUND",
  );
});
