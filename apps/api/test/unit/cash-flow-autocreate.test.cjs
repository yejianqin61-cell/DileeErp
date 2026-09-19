// 收付款自动写收支流水的行为测试（不连数据库）。
//
// 为什么单独一个文件：这条链路是「全部收支都要进流水」的关键，而它此前有两个致命问题：
//   1. **静默跳过**：供应商付款写死收支项目 key「外加工费」，字典里只有「外加工费 晋江大田工资」，
//      于是每一笔供应商付款都不写流水（收支流水只剩客户货款与工资付款）；
//   2. **冲销不回冲**：付款冲销后流水里那笔支出一直留着，收支汇总比银行账多一笔。
// 2026-09-17 起分类口径从「收支项目字典」换成**会计科目**：候选链给的是科目**名称**。
const assert = require("node:assert/strict");
const test = require("node:test");
const { Prisma } = require("@prisma/client");
const { CashFlowService } = require("../../dist/modules/finance/cash-flow.service.js");
const { ACCOUNTING_SUBJECTS, PAYMENT_SUBJECT_NAMES, DEFAULT_PAYMENT_SUBJECT_NAMES, paymentSubjectNames } = require("../../dist/modules/finance/accounting-subject-catalog.js");

const payment = { paymentNo: "SPAY-1", paymentDate: new Date("2026-09-15T00:00:00.000Z"), amount: new Prisma.Decimal("300"), currency: "CNY", counterpartyName: "晋江大田", direction: "expense", settlementMethod: "转账--农业银行5706", sourceType: "supplier_payment", sourceId: "payment-1", subjectNames: ["主营业务成本", "原材料"] };

/** 会计科目替身：只有 existingNames 里的科目存在；`subjectsById` 模拟「人工选定的科目 id → 是否存在且启用」。 */
function cashFlowHarness(existingNames, subjectsById = {}) {
  const created = [];
  const prisma = {
    cashFlowEntry: {
      findFirst: async () => null,
      create: async ({ data }) => { created.push(data); return { id: "cf-1", ...data }; },
      update: async ({ data }) => ({ id: "cf-1", ...data }),
    },
    accountingSubject: {
      // 候选链按名称批量查：替身返回的每行必须是 { id, name } 两列（服务端按名称顺序挑）。
      findMany: async ({ where }) => where.name.in.filter((name) => existingNames.includes(name)).map((name) => ({ id: `subject-${name}`, name })),
      // 按 id 查的那条路要求「存在 + 启用」，替身用一张表模拟。
      findFirst: async ({ where }) => subjectsById[where.id] ?? null,
    },
  };
  const service = new CashFlowService(prisma, { create: () => ({}), update: () => ({}), record: async () => {} });
  return { service, created };
}

test("自动写流水按候选链取第一个存在的会计科目（不再依赖写死的单个 key）", async () => {
  const { service, created } = cashFlowHarness(["原材料"]);
  await service.autoCreateFromPayment(payment, { id: "user-1" });
  assert.equal(created.length, 1);
  assert.equal(created[0].subjectId, "subject-原材料", "首选「主营业务成本」不存在时应退到候选链里的「原材料」");
  assert.equal(created[0].direction, "expense");
  assert.equal(created[0].settlementMethod, "转账--农业银行5706");
  assert.equal(created[0].sourceType, "supplier_payment");
});

test("候选链全都不存在时显式报错，绝不静默跳过（这正是供应商付款当年全部丢失的原因）", async () => {
  const { service, created } = cashFlowHarness([]);
  await assert.rejects(
    () => service.autoCreateFromPayment(payment, { id: "user-1" }),
    (error) => error.getResponse().code === "ACCOUNTING_SUBJECT_NOT_FOUND" && /主营业务成本/.test(error.getResponse().message),
  );
  assert.deepEqual(created, []);
});

test("过账时人工选定的会计科目优先于候选链（财务选「管理费用」就必须记成管理费用）", async () => {
  // 候选链本来会命中「主营业务成本」，但人工选了「管理费用」，结果必须是管理费用。
  const { service, created } = cashFlowHarness(["主营业务成本", "原材料"], { "subject-管理费用": { id: "subject-管理费用", name: "管理费用" } });
  await service.autoCreateFromPayment({ ...payment, subjectId: "subject-管理费用" }, { id: "user-1" });
  assert.equal(created.length, 1);
  assert.equal(created[0].subjectId, "subject-管理费用", "人工选择必须压过候选链，否则「选了管理费用却记成别的科目」在账面上看不出来");
});

test("人工选定的会计科目不存在或已停用时 422，不会悄悄换成候选链里的其它科目", async () => {
  // subjectsById 为空 = 该 id 查不到（不存在 / 已停用，两种都走这里）
  const { service, created } = cashFlowHarness(["主营业务成本"], {});
  await assert.rejects(
    () => service.autoCreateFromPayment({ ...payment, subjectId: "subject-已停用" }, { id: "user-1" }),
    (error) => error.getResponse().code === "ACCOUNTING_SUBJECT_NOT_FOUND" && /选择的会计科目/.test(error.getResponse().message),
  );
  assert.deepEqual(created, [], "选了不存在的科目时不能退回候选链偷偷写一条");
});

test("不传人工选择时仍按来源候选链归类（回归保护：默认路径没被改坏）", async () => {
  const { service, created } = cashFlowHarness(["原材料"], { "subject-管理费用": { id: "subject-管理费用", name: "管理费用" } });
  await service.autoCreateFromPayment({ ...payment, subjectId: null }, { id: "user-1" });
  assert.equal(created[0].subjectId, "subject-原材料");
});

test("同来源已写过流水时不重复创建（幂等）", async () => {  const created = [];
  const prisma = {
    cashFlowEntry: { findFirst: async () => ({ id: "cf-existing" }), create: async ({ data }) => { created.push(data); return data; } },
    accountingSubject: { findMany: async () => [{ id: "subject-1", name: "主营业务成本" }] },
  };
  const service = new CashFlowService(prisma, { create: () => ({}), record: async () => {} });
  assert.equal(await service.autoCreateFromPayment(payment, { id: "user-1" }), null);
  assert.deepEqual(created, []);
});

test("冲销收付款时回冲对应流水；没有对应流水时返回 null 且不阻断冲销", async () => {
  const reversed = [];
  const row = { id: "cf-1", status: "posted", remark: null, entryDate: new Date(), counterpartyName: "晋江大田", direction: "expense", amount: new Prisma.Decimal("300"), currency: "CNY", subjectId: "subject-1", settlementMethod: null, settlementAccountId: null };
  const prisma = {
    // autoReverseFromPayment 按来源查、reverse() 内部按 id 查，两种查法都要能命中同一行。
    cashFlowEntry: {
      findFirst: async (args) => (args.where.sourceId === "payment-other" ? null : row),
      update: async ({ data }) => { reversed.push(data); return { ...row, ...data }; },
    },
    accountingSubject: { findFirst: async () => ({ id: "subject-1" }) },
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
      // 科目查的是 accountingSubject，字典查询只剩结算账户一条路径。
      accountingSubject: { findMany: async () => [{ id: "subject-1", name: "主营业务成本" }] },
      dictionaryItem: { findMany: async () => accounts },
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

test("会计科目候选覆盖每一种资金动账来源，且候选名称都真的在科目表里", () => {
  const subjectNames = new Set(ACCOUNTING_SUBJECTS.map((subject) => subject.name));
  for (const [source, names] of Object.entries(PAYMENT_SUBJECT_NAMES)) {
    assert.ok(names.length > 0, `${source} 必须有会计科目候选`);
    assert.ok(names.some((name) => subjectNames.has(name)), `${source} 至少要有一个候选存在于科目表（否则过账后会 422）`);
    for (const name of names) assert.equal(name, name.trim().replace(/\s+/g, " "), `${source} 的候选名称必须与科目表的归一化规则一致`);
  }
  // 用户反馈的缺陷：供应商付款当年写死过一个字典里不存在的 key；映射给出的候选必须在科目表里。
  assert.equal(subjectNames.has("外加工费"), false, "科目表里没有「外加工费」这一项（只有成本类的「加工费」）");
  assert.ok(subjectNames.has("主营业务成本"));
  assert.ok(subjectNames.has("加工费"));
  assert.ok(subjectNames.has("管理费用"));
  assert.ok(subjectNames.has("基本生产成本"));
  assert.deepEqual(paymentSubjectNames("raw_material_inbound"), ["主营业务成本", "原材料"]);
  assert.deepEqual(paymentSubjectNames("outsource_receipt"), ["加工费"]);
  assert.deepEqual(paymentSubjectNames("other"), ["管理费用", "其他管理费用"]);
  assert.deepEqual(paymentSubjectNames("customer_payment"), ["主营业务收入"]);
  assert.deepEqual(paymentSubjectNames("salary_payment"), ["临时工资", "基本生产成本"]);
  assert.deepEqual(paymentSubjectNames("unknown_source"), DEFAULT_PAYMENT_SUBJECT_NAMES, "未知来源走兜底候选，而不是空数组");
});
