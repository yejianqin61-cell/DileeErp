// 收支流水服务测试（R6：手工录入资金流水 + 可配置项目字典）。
//
// 这一层的核心不是"能存进去"，而是**不合法的东西不能存进去**：
// 金额必须为正（方向由 direction 决定，负数金额在库层会被 CHECK 拦住）、
// 项目与结算账户必须是启用中的字典项、币种要走币种字典。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { Prisma } = require("@prisma/client");
const { CashFlowService } = require("../../dist/modules/finance/cash-flow.service.js");

const USER = { id: "user-1" };
const audit = { create: () => ({ createdBy: "user-1", updatedBy: "user-1" }), update: () => ({ updatedBy: "user-1" }), record: async () => undefined };

function entryRow(overrides = {}) {
  return {
    id: "cf-1",
    entryNo: "CF-20260914-ABCD1234",
    entryDate: new Date("2026-09-14T00:00:00.000Z"),
    counterpartyName: "兴田",
    direction: "expense",
    amount: new Prisma.Decimal("2900"),
    currency: "CNY",
    itemId: "item-1",
    settlementMethod: "转账",
    settlementAccountId: "acct-1",
    status: "posted",
    remark: null,
    ...overrides,
  };
}

/** 内存桩：够用的字典查项 + 流水读写。 */
function stubPrisma({ item = { id: "item-1" }, account = { id: "acct-1" }, stored = null } = {}) {
  const calls = { create: [], update: [], findMany: [] };
  const state = { stored };
  const prisma = {
    dictionaryItem: {
      findFirst: async (args) => {
        const key = args?.where?.type?.key;
        if (key === "cash_flow_item") return item;
        if (key === "settlement_account") return account;
        return null;
      },
    },
    cashFlowEntry: {
      create: async (args) => {
        calls.create.push(args);
        state.stored = { id: "cf-created", ...args.data };
        return state.stored;
      },
      update: async (args) => {
        calls.update.push(args);
        state.stored = { ...(state.stored ?? entryRow()), ...args.data, id: args.where.id };
        return state.stored;
      },
      findFirst: async () => state.stored,
      findMany: async (args) => {
        calls.findMany.push(args);
        return state.stored ? [state.stored] : [];
      },
    },
  };
  return { prisma, calls, state };
}

const input = (overrides = {}) => ({
  entry_date: "2026-09-14",
  counterparty_name: "兴田",
  direction: "expense",
  amount: "2900",
  currency: "CNY",
  item_id: "item-1",
  settlement_method: "转账",
  settlement_account_id: "acct-1",
  ...overrides,
});

function service(options = {}) {
  const { prisma, calls, state } = stubPrisma(options);
  return { service: new CashFlowService(prisma, audit, options.currencies), calls, state };
}

test("finance-report.cash-flow：录入一条支出流水，字段与单号正确", async () => {
  const { service: cashFlow, calls } = service();
  const row = await cashFlow.create(input(), USER);
  const data = calls.create[0].data;
  assert.equal(data.entryDate.toISOString(), "2026-09-14T00:00:00.000Z");
  assert.equal(data.counterpartyName, "兴田");
  assert.equal(data.direction, "expense");
  assert.equal(data.amount.toString(), "2900", "金额按正数存，方向由 direction 决定");
  assert.equal(data.currency, "CNY");
  assert.equal(data.itemId, "item-1");
  assert.equal(data.settlementAccountId, "acct-1");
  assert.match(row.entryNo, /^CF-\d{8}-[0-9A-F]{8}$/, "单号形如 CF-YYYYMMDD-XXXXXXXX");
});

test("finance-report.cash-flow：不选结算账户时不写该列（可空关联）", async () => {
  const { service: cashFlow, calls } = service();
  await cashFlow.create(input({ settlement_account_id: undefined }), USER);
  assert.equal(calls.create[0].data.settlementAccountId, undefined);
});

test("finance-report.cash-flow：金额必须大于零（0 与负数都拒绝）", async () => {
  for (const amount of ["0", "-1", "0.0000", "abc"]) {
    const { service: cashFlow } = service();
    await assert.rejects(
      () => cashFlow.create(input({ amount }), USER),
      (error) => error.getResponse().code === "INVALID_CASH_FLOW_AMOUNT",
      `金额 ${amount} 必须被拒绝：库层还有 amount > 0 的 CHECK 约束兜底`,
    );
  }
});

test("finance-report.cash-flow：方向只能是 income / expense", async () => {
  const { service: cashFlow } = service();
  await assert.rejects(() => cashFlow.create(input({ direction: "transfer" }), USER), (error) => error.getResponse().code === "INVALID_CASH_FLOW_DIRECTION");
});

test("finance-report.cash-flow：对方名称必填", async () => {
  const { service: cashFlow } = service();
  await assert.rejects(() => cashFlow.create(input({ counterparty_name: "   " }), USER), (error) => error.getResponse().code === "COUNTERPARTY_REQUIRED");
});

test("finance-report.cash-flow：日期格式非法时报错而不是把坏日期丢给数据库", async () => {
  const { service: cashFlow } = service();
  await assert.rejects(() => cashFlow.create(input({ entry_date: "2026/09/14" }), USER), (error) => error.getResponse().code === "INVALID_CASH_FLOW_DATE");
});

test("finance-report.cash-flow：收支项目必须是启用中的字典项", async () => {
  const { service: cashFlow } = service({ item: null });
  await assert.rejects(() => cashFlow.create(input(), USER), (error) => error.getResponse().code === "CASH_FLOW_ITEM_NOT_FOUND");
});

test("finance-report.cash-flow：结算账户必须是启用中的字典项", async () => {
  const { service: cashFlow } = service({ account: null });
  await assert.rejects(() => cashFlow.create(input(), USER), (error) => error.getResponse().code === "SETTLEMENT_ACCOUNT_NOT_FOUND");
});

test("finance-report.cash-flow：币种走币种字典（未启用币种被拒）", async () => {
  const currencies = { assertSupported: async (code) => { if (code === "XYZ") throw Object.assign(new Error("unsupported"), { getResponse: () => ({ code: "CURRENCY_NOT_SUPPORTED" }) }); } };
  const { service: cashFlow } = service({ currencies });
  await assert.rejects(() => cashFlow.create(input({ currency: "XYZ" }), USER), (error) => error.getResponse().code === "CURRENCY_NOT_SUPPORTED");
});

test("finance-report.cash-flow：更正时未给的字段保持原值（不会被打成空）", async () => {
  const stored = entryRow();
  const { service: cashFlow, calls } = service({ stored });
  await cashFlow.update("cf-1", { amount: "3000" }, USER);
  const data = calls.update[0].data;
  assert.equal(data.amount.toString(), "3000");
  assert.equal(data.counterpartyName, "兴田");
  assert.equal(data.direction, "expense");
  assert.equal(data.itemId, "item-1");
  assert.equal(data.entryDate.toISOString(), "2026-09-14T00:00:00.000Z");
});

test("finance-report.cash-flow：已冲销的流水不可再编辑", async () => {
  const { service: cashFlow } = service({ stored: entryRow({ status: "reversed" }) });
  await assert.rejects(() => cashFlow.update("cf-1", { amount: "3000" }, USER), (error) => error.getResponse().code === "CASH_FLOW_ENTRY_NOT_EDITABLE");
});

test("finance-report.cash-flow：冲销必须填原因，成功后置为 reversed 并把原因写进备注", async () => {
  const { service: cashFlow, calls } = service({ stored: entryRow() });
  await assert.rejects(() => cashFlow.reverse("cf-1", "  ", USER), (error) => error.getResponse().code === "REVERSAL_REASON_REQUIRED");
  const row = await cashFlow.reverse("cf-1", "对方名称填错", USER);
  assert.equal(calls.update[0].data.status, "reversed");
  assert.match(calls.update[0].data.remark, /冲销：对方名称填错/);
  assert.equal(row.status, "reversed");
});

test("finance-report.cash-flow：已冲销的流水不可重复冲销", async () => {
  const { service: cashFlow } = service({ stored: entryRow({ status: "reversed" }) });
  await assert.rejects(() => cashFlow.reverse("cf-1", "再冲一次", USER), (error) => error.getResponse().code === "CASH_FLOW_ENTRY_NOT_REVERSIBLE");
});

test("finance-report.cash-flow：不存在的流水报 CASH_FLOW_ENTRY_NOT_FOUND", async () => {
  const { service: cashFlow } = service({ stored: null });
  await assert.rejects(() => cashFlow.get("cf-missing"), (error) => error.getResponse().code === "CASH_FLOW_ENTRY_NOT_FOUND");
});

test("finance-report.cash-flow：列表默认只给生效流水，并支持期间/项目/币种/方向筛选", async () => {
  const { service: cashFlow, calls } = service({ stored: entryRow() });
  await cashFlow.list({});
  assert.equal(calls.findMany[0].where.status, "posted");
  assert.equal(calls.findMany[0].where.deletedAt, null);

  await cashFlow.list({ from: "2026-09-01", to: "2026-09-30", itemId: "item-1", currency: "USD", direction: "income", includeReversed: true });
  const where = calls.findMany[1].where;
  assert.equal(where.status, undefined, "include_reversed=true 时不再限制状态");
  assert.equal(where.itemId, "item-1");
  assert.equal(where.currency, "USD");
  assert.equal(where.direction, "income");
  assert.equal(where.entryDate.gte.toISOString(), "2026-09-01T00:00:00.000Z");
  assert.equal(where.entryDate.lte.toISOString(), "2026-09-30T23:59:59.999Z", "截止当天必须包含当天");
});

test("finance-report.cash-flow：期间非法时报 INVALID_REPORT_PERIOD（与报表同一套期间口径）", async () => {
  const { service: cashFlow } = service();
  await assert.rejects(() => cashFlow.list({ from: "2026-13-45" }), (error) => error.getResponse().code === "INVALID_REPORT_PERIOD");
});
