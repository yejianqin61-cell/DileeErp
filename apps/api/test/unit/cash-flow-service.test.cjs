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

// ---------------------------------------------------------------------------
// 2026-09-16：银行账户 —— 流水要落在具体账户上，余额才算得出来。
//   `settlement_account_id`（老表「结算方式」字典）是给人看的文本；
//   `bank_id`（银行账户池）才是账。两者都存在，各管一件事。
// ---------------------------------------------------------------------------

test("finance-report.cash-flow：录入流水可以指定银行账户，bankId 落库", async () => {
  const { prisma, calls } = stubPrisma();
  prisma.bank = { findFirst: async (args) => { calls.bank = args; return { id: "bank-1", bankName: "农业银行", accountNumber: "5706" }; } };
  const cashFlow = new CashFlowService(prisma, audit);
  await cashFlow.create(input({ bank_id: "bank-1" }), USER);
  assert.deepEqual(calls.bank.where, { id: "bank-1", deletedAt: null, isActive: true }, "停用的银行账户不能被选中");
  assert.equal(calls.create[0].data.bankId, "bank-1");
});

test("finance-report.cash-flow：不选银行账户时不查银行、bankId 不写（历史流水与「不确定走哪张卡」）", async () => {
  const { prisma, calls } = stubPrisma();
  prisma.bank = { findFirst: async () => { throw new Error("未选银行时不应查询银行账户"); } };
  const cashFlow = new CashFlowService(prisma, audit);
  await cashFlow.create(input(), USER);
  assert.equal(calls.create[0].data.bankId, undefined);
});

test("finance-report.cash-flow：银行账户不存在或已停用 → BANK_NOT_FOUND", async () => {
  const { prisma } = stubPrisma();
  prisma.bank = { findFirst: async () => null };
  await assert.rejects(
    () => new CashFlowService(prisma, audit).create(input({ bank_id: "bank-dead" }), USER),
    (error) => error.getResponse().code === "BANK_NOT_FOUND",
  );
});

test("finance-report.cash-flow：列表可以按银行账户筛选", async () => {
  const { service: cashFlow, calls } = service({ stored: entryRow() });
  await cashFlow.list({ bankId: "bank-1" });
  assert.equal(calls.findMany[0].where.bankId, "bank-1");
});

test("finance-report.cash-flow：更正时 bank_id 传 null 表示清空银行账户（选错了要能去掉）", async () => {
  const { prisma, calls } = stubPrisma({ stored: entryRow({ bankId: "bank-1" }) });
  prisma.bank = { findFirst: async () => { throw new Error("清空银行账户不应查询银行"); } };
  const cashFlow = new CashFlowService(prisma, audit);
  await cashFlow.update("cf-1", { bank_id: null }, USER);
  assert.equal(calls.update[0].data.bankId, null);
});

test("finance-report.cash-flow：更正时不传 bank_id 就不动已有的银行账户", async () => {
  const { prisma, calls } = stubPrisma({ stored: entryRow({ bankId: "bank-1" }) });
  prisma.bank = { findFirst: async ({ where }) => ({ id: where.id }) };
  const cashFlow = new CashFlowService(prisma, audit);
  await cashFlow.update("cf-1", { amount: "100" }, USER);
  assert.equal(calls.update[0].data.bankId, "bank-1", "不传 = 不改（与收付款草稿的编辑同一约定）");
});

// ---------------------------------------------------------------------------
// `recordConfirmation`：确认应收/应付专用。**同来源只有一条流水，金额是累计确认额。**
//   为什么不能用 `autoCreateFromPayment` 的「已存在就跳过」：对账范围是**活范围**
//   （同客户/供应商 + 币种 + 期间），确认一次后同期间新进来的草稿还能再确认一次。
//   跳过就等于「银行账永远停在第一次确认的数字上」，钱对不上还查不出原因。
//   为什么是累加而不是覆盖：同一条应收既可能被「一键确认应收」记进对账单那条流水，
//   也可能被行内「确认应收」单独记一条；覆盖会让对账单流水被后来的小批次改写，总额凭空变少。
// ---------------------------------------------------------------------------

function syncHarness({ existing = null, stored = true } = {}) {
  const calls = { create: [], update: [], findFirst: [] };
  const prisma = {
    dictionaryItem: { findFirst: async (args) => (args?.where?.id ? { id: args.where.id, key: "货款" } : { id: "item-1", key: "货款" }), findMany: async () => [{ id: "item-1", key: "货款" }] },
    cashFlowEntry: {
      findFirst: async (args) => { calls.findFirst.push(args); return existing; },
      create: async (args) => { calls.create.push(args); return stored ? { id: "cf-new", ...args.data } : null; },
      update: async (args) => { calls.update.push(args); return { id: args.where.id, ...args.data }; },
    },
  };
  return { service: new CashFlowService(prisma, audit), calls };
}

const confirmation = (overrides = {}) => ({
  sourceType: "receivable_reconciliation",
  sourceId: "recon-1",
  documentNo: "REC-1",
  entryDate: new Date("2026-09-16T00:00:00.000Z"),
  amount: new Prisma.Decimal("1500.5"),
  currency: "CNY",
  counterpartyName: "香港迪礼",
  direction: "income",
  itemKeys: ["货款"],
  bankId: "bank-1",
  ...overrides,
});

test("recordConfirmation：没有既有流水时新建一条，并带上银行账户与来源", async () => {
  const { service: cashFlow, calls } = syncHarness();
  const result = await cashFlow.recordConfirmation(confirmation(), USER);
  assert.equal(result.created, true);
  const data = calls.create[0].data;
  assert.equal(data.sourceType, "receivable_reconciliation");
  assert.equal(data.sourceId, "recon-1");
  assert.equal(data.direction, "income");
  assert.equal(data.amount.toString(), "1500.5");
  assert.equal(data.bankId, "bank-1", "没有 bankId 这笔钱不进任何账户余额 —— 用户要求确认应收就要进账户");
  assert.equal(data.itemId, "item-1");
  assert.match(data.remark, /自动生成：receivable_reconciliation \/ REC-1/);
  assert.match(data.entryNo, /^CF-\d{8}-[0-9A-F]{8}$/);
});

test("recordConfirmation：已有流水时**累加**而不是跳过或覆盖（同期间后续草稿再确认，金额必须跟上）", async () => {
  const { service: cashFlow, calls } = syncHarness({ existing: { id: "cf-existing", amount: new Prisma.Decimal("1500.5") } });
  const result = await cashFlow.recordConfirmation(confirmation({ amount: new Prisma.Decimal("2000") }), USER);
  assert.equal(result.created, false);
  assert.equal(result.id, "cf-existing");
  assert.equal(result.amount.toString(), "3500.5", "累计确认额 = 原额 + 本次");
  assert.equal(result.added.toString(), "2000");
  assert.equal(calls.create.length, 0, "不能又建一条（同来源只应有一条收支流水）");
  assert.equal(calls.update.length, 1);
  assert.equal(calls.update[0].where.id, "cf-existing");
  assert.equal(calls.update[0].data.amount.toString(), "3500.5", "覆盖会让「先按对账确认、再逐条确认」的总额凭空变少");
  assert.equal(calls.update[0].data.bankId, "bank-1", "银行账户取最新一次（财务最近一次选的那个才是钱实际走的地方）");
  assert.equal(calls.update[0].data.entryDate, undefined, "日期保持首次确认日：一条累计流水只有一个日期，不能被后来的确认推到别的期间");
});

test("recordConfirmation：金额为 0 时什么都不做（不建一条 0 元流水）", async () => {
  const { service: cashFlow, calls } = syncHarness();
  assert.equal(await cashFlow.recordConfirmation(confirmation({ amount: new Prisma.Decimal("0") }), USER), null);
  assert.equal(calls.create.length, 0);
  assert.equal(calls.update.length, 0);
});

test("recordConfirmation：没指定银行账户时 bankId 写 null（流水照写，但明确不进任何账户）", async () => {
  const { service: cashFlow, calls } = syncHarness();
  await cashFlow.recordConfirmation(confirmation({ bankId: null }), USER);
  assert.equal(calls.create[0].data.bankId, null);
});

test("recordConfirmation：人工选的项目不存在时显式 422，绝不静默换成候选项目", async () => {
  const { service: cashFlow } = syncHarness();
  const prisma = { dictionaryItem: { findFirst: async () => null, findMany: async () => [] }, cashFlowEntry: { findFirst: async () => null, create: async () => ({}) } };
  const failing = new CashFlowService(prisma, audit);
  await assert.rejects(
    () => failing.recordConfirmation(confirmation({ itemId: "item-dead" }), USER),
    (error) => error.getResponse().code === "CASH_FLOW_ITEM_NOT_FOUND",
  );
  // 候选链一个都不存在时同样显式报错（历史缺陷：静默跳过会让整笔资金动账从流水里消失）。
  await assert.rejects(
    () => failing.recordConfirmation(confirmation({ itemKeys: ["不存在的项目"] }), USER),
    (error) => error.getResponse().code === "CASH_FLOW_ITEM_NOT_FOUND" && /不存在的项目/.test(error.getResponse().message),
  );
});

test("requireItem：空值视为「不指定」，非法值 422", async () => {
  const { service: cashFlow } = syncHarness();
  assert.equal(await cashFlow.requireItem(undefined), null);
  assert.equal(await cashFlow.requireItem("  "), null);
  const prisma = { dictionaryItem: { findFirst: async () => null, findMany: async () => [] } };
  await assert.rejects(
    () => new CashFlowService(prisma, audit).requireItem("item-dead", "收支项目不存在或已停用，请在「收支管理 → 收支项目」里确认"),
    (error) => error.getResponse().code === "CASH_FLOW_ITEM_NOT_FOUND" && error.getResponse().message.includes("收支管理"),
  );
});
