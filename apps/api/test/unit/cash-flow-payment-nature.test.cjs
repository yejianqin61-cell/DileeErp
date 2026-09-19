// 收支流水的「款项性质」与「订单号」（2026-09-17 为老表「外汇一览表」加的两列）。
//
// 这两列的要害不是"能存进去"，而是三条容易做错的边界：
//   1. 非法性质必须显式 422，**不能静默当成没填** —— 财务选了「定金」却记成没标注，
//      那笔钱在外汇表里就会跑到「其他到账」里去，事后没人查得出来；
//   2. 更正时 `undefined = 不改`、空串 = 清空：不区分的话，用户只改金额就会把性质抹掉，
//      或者反过来永远清不掉一个标错的性质；
//   3. 反复点「确认应收」不该把上次标的性质抹掉（`recordConfirmation` 是累加更新，
//      不是重新建一条）。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { Prisma } = require("@prisma/client");
const { CashFlowService } = require("../../dist/modules/finance/cash-flow.service.js");
const { PAYMENT_NATURES, PAYMENT_NATURE_FORM_KEYS, isPaymentNature, paymentNatureLabel } = require("../../dist/modules/finance/payment-nature.js");

const USER = { id: "user-1" };
const audit = { create: () => ({ createdBy: "user-1", updatedBy: "user-1" }), update: () => ({ updatedBy: "user-1" }), record: async () => undefined };

function stubPrisma({ stored = null, order = { id: "order-1", orderNo: "DL260001" } } = {}) {
  const calls = { create: [], update: [], findFirst: [] };
  const state = { stored };
  const prisma = {
    accountingSubject: {
      findFirst: async () => ({ id: "subject-1", category: "损益类", name: "主营业务收入" }),
      findMany: async () => [{ id: "subject-1", name: "主营业务收入" }],
    },
    dictionaryItem: { findFirst: async () => null },
    salesOrder: { findFirst: async (args) => (args.where.orderNo === order?.orderNo ? order : null) },
    cashFlowEntry: {
      create: async (args) => {
        calls.create.push(args);
        state.stored = { id: "cf-created", ...args.data };
        return state.stored;
      },
      update: async (args) => {
        calls.update.push(args);
        state.stored = { ...(state.stored ?? {}), ...args.data, id: args.where.id };
        return state.stored;
      },
      findFirst: async (args) => {
        calls.findFirst.push(args);
        return state.stored;
      },
      findMany: async () => (state.stored ? [state.stored] : []),
    },
  };
  return { prisma, calls, state };
}

const income = (overrides = {}) => ({
  entry_date: "2026-09-14",
  counterparty_name: "中谷",
  direction: "income",
  amount: "2790",
  currency: "USD",
  subject_id: "subject-1",
  ...overrides,
});

function service(options = {}) {
  const { prisma, calls, state } = stubPrisma(options);
  return { service: new CashFlowService(prisma, audit, options.currencies), calls, state };
}

// ------------------------------------------------------------------ 目录本身

test("payment-nature：四个取值与老表「定金/货款」两列对得上，key 用英文、label 用中文", () => {
  assert.deepEqual(PAYMENT_NATURES.map((item) => [item.key, item.label]), [
    ["deposit", "定金"], ["balance", "货款"], ["final", "尾款"], ["other", "其他"],
  ]);
  assert.equal(isPaymentNature("deposit"), true);
  assert.equal(isPaymentNature("定金"), false, "库里存 key，不存中文（界面上改文案不该动历史数据）");
  assert.equal(paymentNatureLabel("final"), "尾款");
  assert.equal(paymentNatureLabel(null), null, "没标注就是 null，不编一个「其他」出来");
});

test("payment-nature：DTO 白名单额外放行空串，否则界面清空选择会被判成非法值", () => {
  assert.deepEqual(PAYMENT_NATURE_FORM_KEYS, ["deposit", "balance", "final", "other", ""]);
});

test("payment-nature：requirePaymentNature 把空值归一成 null，非法值显式 422", () => {
  const { service: cashFlow } = service();
  assert.equal(cashFlow.requirePaymentNature(undefined), null);
  assert.equal(cashFlow.requirePaymentNature(null), null);
  assert.equal(cashFlow.requirePaymentNature(""), null);
  assert.equal(cashFlow.requirePaymentNature("  "), null);
  assert.equal(cashFlow.requirePaymentNature("deposit"), "deposit");
  assert.equal(cashFlow.requirePaymentNature(" deposit "), "deposit", "去掉空格再校验");
  assert.throws(
    () => cashFlow.requirePaymentNature("定金"),
    (error) => error.getResponse().code === "PAYMENT_NATURE_INVALID",
    "非法值必须报错，静默当没填会让那笔钱在外汇表里被归错性质",
  );
});

// ------------------------------------------------------------------ 新建

test("收支流水：款项性质与订单号随流水一起落库", async () => {
  const { service: cashFlow, calls } = service();
  await cashFlow.create(income({ payment_nature: "deposit", order_no: "DL260001" }), USER);
  assert.equal(calls.create[0].data.paymentNature, "deposit");
  assert.equal(calls.create[0].data.orderNo, "DL260001");
});

test("收支流水：不填性质时落 null（不是空串、不是 'other'）", async () => {
  const { service: cashFlow, calls } = service();
  await cashFlow.create(income({ payment_nature: "" }), USER);
  assert.equal(calls.create[0].data.paymentNature, null);
  assert.equal(calls.create[0].data.orderNo, undefined);
});

test("收支流水：订单号必须真实存在 —— 写错一个字符就会让这笔钱在外汇表里归不到订单", async () => {
  const { service: cashFlow } = service();
  await assert.rejects(
    () => cashFlow.create(income({ order_no: "DL-XXX" }), USER),
    (error) => error.getResponse().code === "SALES_ORDER_NOT_FOUND",
  );
});

test("收支流水：支出方向也允许标注性质（改方向时不至于把已填的性质连带清掉）", async () => {
  const { service: cashFlow, calls } = service();
  await cashFlow.create(income({ direction: "expense", payment_nature: "other" }), USER);
  assert.equal(calls.create[0].data.paymentNature, "other");
});

// ------------------------------------------------------------------ 更正

test("更正流水：不传性质 = 不动它（只改金额不会把「定金」抹掉）", async () => {
  const existing = { id: "cf-1", status: "posted", entryDate: new Date("2026-09-14T00:00:00.000Z"), counterpartyName: "中谷", direction: "income", amount: new Prisma.Decimal("620"), currency: "USD", subjectId: "subject-1", settlementAccountId: null, bankId: null, paymentNature: "deposit", orderNo: "DL260001", remark: null };
  const { service: cashFlow, calls } = service({ stored: existing });
  await cashFlow.update("cf-1", { amount: "700" }, USER);
  const data = calls.update[0].data;
  assert.equal(data.paymentNature, "deposit");
  assert.equal(data.orderNo, "DL260001");
  assert.equal(data.amount.toString(), "700");
});

test("更正流水：传空串 = 清空（标错了要能去掉）", async () => {
  const existing = { id: "cf-1", status: "posted", entryDate: new Date("2026-09-14T00:00:00.000Z"), counterpartyName: "中谷", direction: "income", amount: new Prisma.Decimal("620"), currency: "USD", subjectId: "subject-1", settlementAccountId: null, bankId: null, paymentNature: "deposit", orderNo: "DL260001", remark: null };
  const { service: cashFlow, calls } = service({ stored: existing });
  await cashFlow.update("cf-1", { payment_nature: "", order_no: "" }, USER);
  const data = calls.update[0].data;
  assert.equal(data.paymentNature, null, "空串必须落成显式 null，否则就是「不改」——那就永远清不掉");
  assert.equal(data.orderNo, null);
});

test("更正流水：把性质改成另一个合法值时覆盖（定金改成尾款）", async () => {
  const existing = { id: "cf-1", status: "posted", entryDate: new Date("2026-09-14T00:00:00.000Z"), counterpartyName: "中谷", direction: "income", amount: new Prisma.Decimal("620"), currency: "USD", subjectId: "subject-1", settlementAccountId: null, bankId: null, paymentNature: "deposit", orderNo: null, remark: null };
  const { service: cashFlow, calls } = service({ stored: existing });
  await cashFlow.update("cf-1", { payment_nature: "final" }, USER);
  assert.equal(calls.update[0].data.paymentNature, "final");
});

// ------------------------------------------------------------------ 确认应收（累加更新）

const confirmation = (overrides = {}) => ({
  sourceType: "receivable_source",
  sourceId: "src-1",
  documentNo: "AR-1",
  entryDate: new Date("2026-09-14T00:00:00.000Z"),
  amount: new Prisma.Decimal("2790"),
  currency: "USD",
  counterpartyName: "中谷",
  direction: "income",
  subjectNames: ["主营业务收入"],
  ...overrides,
});

test("确认应收：款项性质与订单号写进新流水", async () => {
  const { service: cashFlow, calls } = service();
  await cashFlow.recordConfirmation(confirmation({ paymentNature: "balance", orderNo: "DL260002" }), USER);
  assert.equal(calls.create[0].data.paymentNature, "balance");
  assert.equal(calls.create[0].data.orderNo, "DL260002");
});

test("确认应收：不传性质时保持原值 —— 多点一次确认不该把上次标的「定金」抹掉", async () => {
  const existing = { id: "cf-1", amount: new Prisma.Decimal("620"), paymentNature: "deposit", orderNo: "DL260001" };
  const { service: cashFlow, calls } = service({ stored: existing });
  const result = await cashFlow.recordConfirmation(confirmation({ amount: new Prisma.Decimal("100") }), USER);
  assert.equal(result.created, false);
  assert.equal(result.amount.toString(), "720", "金额仍然是累加");
  const data = calls.update[0].data;
  assert.equal("paymentNature" in data, false, "没传就不该出现在 update 的 data 里");
  assert.equal("orderNo" in data, false);
});

test("确认应收：显式传 null 才清空（财务确实要去掉标错的性质）", async () => {
  const existing = { id: "cf-1", amount: new Prisma.Decimal("620"), paymentNature: "deposit", orderNo: "DL260001" };
  const { service: cashFlow, calls } = service({ stored: existing });
  await cashFlow.recordConfirmation(confirmation({ amount: new Prisma.Decimal("100"), paymentNature: null, orderNo: null }), USER);
  const data = calls.update[0].data;
  assert.equal(data.paymentNature, null);
  assert.equal(data.orderNo, null);
});

test("确认应收：非法性质在这一处统一拦下（三条确认入口都走这里，不存在漏校验的入口）", async () => {
  const { service: cashFlow } = service();
  await assert.rejects(
    () => cashFlow.recordConfirmation(confirmation({ paymentNature: "保证金" }), USER),
    (error) => error.getResponse().code === "PAYMENT_NATURE_INVALID",
  );
  // 金额为 0 时提前返回，不该因为性质非法而报错（这次什么都没记）。
  const { service: emptyFlow } = service();
  assert.equal(await emptyFlow.recordConfirmation(confirmation({ amount: new Prisma.Decimal("0"), paymentNature: "保证金" }), USER), null);
});
