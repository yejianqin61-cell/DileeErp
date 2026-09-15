// 收付款自动写收支流水的行为测试（不连数据库）。
//
// 为什么单独一个文件：这条链路是「全部收支都要进流水」的关键，而它此前有两个致命问题：
//   1. **静默跳过**：供应商付款写死收支项目 key「外加工费」，字典里只有「外加工费 晋江大田工资」，
//      于是每一笔供应商付款都不写流水（收支流水只剩客户货款与工资付款）；
//   2. **冲销不回冲**：付款冲销后流水里那笔支出一直留着，收支汇总比银行账多一笔。
const assert = require("node:assert/strict");
const test = require("node:test");
const { Prisma } = require("@prisma/client");
const { CashFlowService } = require("../../dist/modules/finance/cash-flow.service.js");
const { PAYMENT_ITEM_KEYS, DEFAULT_PAYMENT_ITEM_KEYS, DEFAULT_CASH_FLOW_ITEMS, paymentItemKeys } = require("../../dist/modules/finance/cash-flow-catalog.js");

const payment = { paymentNo: "SPAY-1", paymentDate: new Date("2026-09-15T00:00:00.000Z"), amount: new Prisma.Decimal("300"), currency: "CNY", counterpartyName: "晋江大田", direction: "expense", settlementMethod: "转账--农业银行5706", sourceType: "supplier_payment", sourceId: "payment-1", itemKeys: ["原材料 成本", "货款"] };

/** 字典替身：只有 keys 里的项目存在。 */
function cashFlowHarness(existingKeys) {
  const created = [];
  const prisma = {
    cashFlowEntry: {
      findFirst: async () => null,
      create: async ({ data }) => { created.push(data); return { id: "cf-1", ...data }; },
      update: async ({ data }) => ({ id: "cf-1", ...data }),
    },
    dictionaryItem: { findMany: async ({ where }) => where.key.in.filter((key) => existingKeys.includes(key)).map((key) => ({ id: `item-${key}`, key })) },
  };
  const service = new CashFlowService(prisma, { create: () => ({}), update: () => ({}), record: async () => {} });
  return { service, created };
}

test("自动写流水按候选链取第一个存在的收支项目（不再依赖写死的单个 key）", async () => {
  const { service, created } = cashFlowHarness(["货款"]);
  await service.autoCreateFromPayment(payment, { id: "user-1" });
  assert.equal(created.length, 1);
  assert.equal(created[0].itemId, "item-货款", "首选「原材料 成本」不存在时应退到候选链里的「货款」");
  assert.equal(created[0].direction, "expense");
  assert.equal(created[0].settlementMethod, "转账--农业银行5706");
  assert.equal(created[0].sourceType, "supplier_payment");
});

test("候选链全都不存在时显式报错，绝不静默跳过（这正是供应商付款当年全部丢失的原因）", async () => {
  const { service, created } = cashFlowHarness([]);
  await assert.rejects(
    () => service.autoCreateFromPayment(payment, { id: "user-1" }),
    (error) => error.getResponse().code === "CASH_FLOW_ITEM_NOT_FOUND" && /原材料 成本/.test(error.getResponse().message),
  );
  assert.deepEqual(created, []);
});

test("同来源已写过流水时不重复创建（幂等）", async () => {
  const created = [];
  const prisma = {
    cashFlowEntry: { findFirst: async () => ({ id: "cf-existing" }), create: async ({ data }) => { created.push(data); return data; } },
    dictionaryItem: { findMany: async () => [{ id: "item-1", key: "原材料 成本" }] },
  };
  const service = new CashFlowService(prisma, { create: () => ({}), record: async () => {} });
  assert.equal(await service.autoCreateFromPayment(payment, { id: "user-1" }), null);
  assert.deepEqual(created, []);
});

test("冲销收付款时回冲对应流水；没有对应流水时返回 null 且不阻断冲销", async () => {
  const reversed = [];
  const row = { id: "cf-1", status: "posted", remark: null, entryDate: new Date(), counterpartyName: "晋江大田", direction: "expense", amount: new Prisma.Decimal("300"), currency: "CNY", itemId: "item-1", settlementMethod: null, settlementAccountId: null };
  const prisma = {
    // autoReverseFromPayment 按来源查、reverse() 内部按 id 查，两种查法都要能命中同一行。
    cashFlowEntry: {
      findFirst: async (args) => (args.where.sourceId === "payment-other" ? null : row),
      update: async ({ data }) => { reversed.push(data); return { ...row, ...data }; },
    },
    dictionaryItem: { findFirst: async () => ({ id: "item-1" }) },
  };
  const service = new CashFlowService(prisma, { update: () => ({}), record: async () => {} });
  const reversedRow = await service.autoReverseFromPayment("supplier_payment", "payment-1", "供应商付款冲销：银行退回", { id: "user-1" });
  assert.equal(reversedRow.status, "reversed");
  assert.match(reversed[0].remark, /银行退回/);
  assert.equal(await service.autoReverseFromPayment("supplier_payment", "payment-other", "x", { id: "user-1" }), null);
});

test("结算账户按账号匹配到字典项；匹配不上就留空（不造假的关联）", async () => {
  const accounts = [
    { id: "acc-1", label: "农业银行5706" },
    { id: "acc-2", label: "中国银行（美元）7624" },
  ];
  const harness = (hint) => {
    const created = [];
    const prisma = {
      cashFlowEntry: { findFirst: async () => null, create: async ({ data }) => { created.push(data); return { id: "cf-1", ...data }; } },
      dictionaryItem: { findMany: async ({ where }) => (where.key ? [{ id: "item-1", key: "原材料 成本" }] : accounts) },
    };
    const service = new CashFlowService(prisma, { create: () => ({}), record: async () => {} });
    return { service, created, hint };
  };
  // 银行名与账号都能对上 → 带上字典项
  const matched = harness({ bankName: "农业银行", accountNumber: "5706" });
  await matched.service.autoCreateFromPayment({ ...payment, settlementAccountHint: matched.hint }, { id: "user-1" });
  assert.equal(matched.created[0].settlementAccountId, "acc-1");
  // 字典里带币种后缀（中国银行（美元）7624）时按账号数字 + 银行名匹配
  const usd = harness({ bankName: "中国银行", accountNumber: "7624" });
  await usd.service.autoCreateFromPayment({ ...payment, settlementAccountHint: usd.hint }, { id: "user-1" });
  assert.equal(usd.created[0].settlementAccountId, "acc-2");
  // 账号对不上 → 留空，而不是随便挂一个账户
  const unmatched = harness({ bankName: "工商银行", accountNumber: "9999" });
  await unmatched.service.autoCreateFromPayment({ ...payment, settlementAccountHint: unmatched.hint }, { id: "user-1" });
  assert.equal(unmatched.created[0].settlementAccountId, undefined);
  // 没有银行信息（如客户收款只有流水号）→ 同样留空
  const none = harness(null);
  await none.service.autoCreateFromPayment({ ...payment, settlementAccountHint: none.hint }, { id: "user-1" });
  assert.equal(none.created[0].settlementAccountId, undefined);
});

test("收支项目映射覆盖每一种资金动账来源，且候选 key 都真的在老表 37 项字典里", () => {
  const dictionaryKeys = new Set(DEFAULT_CASH_FLOW_ITEMS.map((item) => item.key));
  for (const [source, keys] of Object.entries(PAYMENT_ITEM_KEYS)) {
    assert.ok(keys.length > 0, `${source} 必须有收支项目候选`);
    assert.ok(keys.some((key) => dictionaryKeys.has(key)), `${source} 至少要有一个候选存在于内置字典（否则过账后会 422）`);
    for (const key of keys) assert.equal(key, key.trim().replace(/\s+/g, " "), `${source} 的候选 key 必须与字典的归一化规则一致`);
  }
  // 用户反馈的缺陷：供应商付款写死的「外加工费」并不在字典里，而映射给出的候选必须在。
  assert.equal(dictionaryKeys.has("外加工费"), false, "字典里没有「外加工费」这一项（只有「外加工费 晋江大田工资」）");
  assert.ok(dictionaryKeys.has("原材料 成本"));
  assert.ok(dictionaryKeys.has("成品外加工费"));
  assert.ok(dictionaryKeys.has("管理费用"));
  assert.ok(dictionaryKeys.has("人 工费"));
  assert.deepEqual(paymentItemKeys("raw_material_inbound"), ["原材料 成本", "货款"]);
  assert.deepEqual(paymentItemKeys("outsource_receipt"), ["成品外加工费", "加工费"]);
  assert.deepEqual(paymentItemKeys("other"), ["管理费用", "杂费车间装修费"]);
  assert.deepEqual(paymentItemKeys("customer_payment"), ["货款"]);
  assert.deepEqual(paymentItemKeys("unknown_source"), DEFAULT_PAYMENT_ITEM_KEYS, "未知来源走兜底候选，而不是空数组");
});
