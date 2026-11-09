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
// 用 ACCOUNTING_SUBJECT_SEEDS（财务科目表 + 系统补充科目）：候选必须指向**实际种入库**的科目，
// 只看财务那张 121 行表会把 2026-09-20 新增的「工资支付」误判成不存在。
const { ACCOUNTING_SUBJECT_SEEDS, PAYMENT_SUBJECT_NAMES, DEFAULT_PAYMENT_SUBJECT_NAMES, paymentSubjectNames } = require("../../dist/modules/finance/accounting-subject-catalog.js");

const payment = { paymentNo: "SPAY-1", paymentDate: new Date("2026-09-15T00:00:00.000Z"), amount: new Prisma.Decimal("300"), currency: "CNY", counterpartyName: "晋江大田", direction: "expense", settlementMethod: "转账--农业银行5706", sourceType: "supplier_payment", sourceId: "payment-1", subjectNames: ["主营业务成本", "原材料"] };

/**
 * R3-5（契约 E）：`VoucherService.reverseBySource` 的替身。
 * 只关心「冲销链路有没有按来源调用一次、参数对不对」；真实红冲在 voucher-service.test.cjs 里测。
 */
function voucherRecorder(result = null) {
  const calls = [];
  return {
    calls,
    reverseBySource: async (...args) => { calls.push(args); return result; },
  };
}

const USER = { id: "user-1" };

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

/* --------------------------------------------------------- 收支类目（2026-10-13） */

test("收支类目：单据上写的科目写进 category_subject_id，**不动**主科目（主科目是拿去生成凭证的那个）", async () => {
  const { service, created } = cashFlowHarness(["主营业务成本"], { "subject-房租费": { id: "subject-房租费", name: "房租费" } });
  await service.autoCreateFromPayment({ ...payment, categorySubjectId: "subject-房租费", categorySubjectNames: ["管理费用"] }, { id: "user-1" });

  assert.equal(created[0].subjectId, "subject-主营业务成本", "主科目仍按候选链（已挂账的付款在这里会是「应付账款」）");
  assert.equal(created[0].categorySubjectId, "subject-房租费", "收支类目取单据上的科目");
});

test("收支类目：单据上的科目**已停用/被删**时安静退回候选链，不让一笔已经发生的付款过不了账", async () => {
  // 主科目的严格语义（选了不存在就 422）**不适用于**这一格：它来自单据，可能早就停用了。
  const { service, created } = cashFlowHarness(["主营业务成本", "管理费用"], {});
  await service.autoCreateFromPayment({ ...payment, categorySubjectId: "subject-已停用", categorySubjectNames: ["管理费用", "其他管理费用"] }, { id: "user-1" });

  assert.equal(created.length, 1, "不能因为一个分类字段就拒绝过账");
  assert.equal(created[0].categorySubjectId, "subject-管理费用", "退回候选链里第一个存在的");
  assert.equal(created[0].subjectId, "subject-主营业务成本");
});

test("收支类目：单据上没填、候选链也不存在 → 留空（不写一个瞎猜的科目，也不报错）", async () => {
  const { service, created } = cashFlowHarness(["主营业务成本"], {});
  await service.autoCreateFromPayment({ ...payment, categorySubjectId: null, categorySubjectNames: ["管理费用"] }, { id: "user-1" });

  assert.equal(created[0].categorySubjectId, null, "收支类目为空 = 报表上那一格空着，不是 0、也不是「-」");
  assert.equal(created[0].subjectId, "subject-主营业务成本", "主科目照旧");
});

test("收支类目：完全不传这两项时也留空（手工流水与老调用方不受影响）", async () => {
  const { service, created } = cashFlowHarness(["主营业务成本"]);
  await service.autoCreateFromPayment(payment, { id: "user-1" });
  assert.equal(created[0].categorySubjectId, null);
});

test("domain：收支类目取「金额最大的那条单据所填的科目」；都没填就是 null", () => {
  const { dominantDocumentSubject } = require("../../dist/modules/finance/cash-flow.domain.js");
  const row = (amount, subjectId) => ({ amount: new Prisma.Decimal(amount), subjectId });

  // 一笔付款同时核销备用金（3000）与房租（5000）：占钱最多的是房租 → 类目显示房租费。
  assert.equal(dominantDocumentSubject([row("3000", "subject-备用金"), row("5000", "subject-房租费")]), "subject-房租费");
  // 金额相同看先出现的那条（结果确定，不随查询计划漂移）。
  assert.equal(dominantDocumentSubject([row("5000", "subject-甲"), row("5000", "subject-乙")]), "subject-甲");
  // 没填科目的行不参与比较；全都没填 → null（交给候选链兜底）。
  assert.equal(dominantDocumentSubject([row("9000", null), row("100", "subject-乙")]), "subject-乙");
  assert.equal(dominantDocumentSubject([row("9000", null), row("100", null)]), null);
  assert.equal(dominantDocumentSubject([]), null);
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
  const row = { id: "cf-1", status: "posted", remark: null, entryNo: "CF-1", entryDate: new Date(), counterpartyName: "晋江大田", direction: "expense", amount: new Prisma.Decimal("300"), currency: "CNY", subjectId: "subject-1", settlementMethod: null, settlementAccountId: null };
  const prisma = {
    // 回冲按**来源**查（`reverseSourceFlowInTransaction` 用 findMany：同一来源历史上可能留下多条流水），
    // 查回来的一行带着 entryNo，供调用方在事务外记审计。
    cashFlowEntry: {
      findMany: async (args) => (args.where.sourceId === "payment-other" ? [] : [{ id: row.id, entryNo: row.entryNo, amount: row.amount, remark: row.remark }]),
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

test("R3-5 用例3：付款/收款冲销回冲流水后，按来源红冲该流水的凭证（一次、不重复）", async () => {
  const row = { id: "cf-1", status: "posted", remark: null, entryNo: "CF-1", amount: new Prisma.Decimal("300") };
  const prisma = {
    cashFlowEntry: {
      findMany: async () => [row],
      update: async ({ data }) => ({ ...row, ...data }),
    },
  };
  const vouchers = voucherRecorder({ id: "voucher-1", voucherNo: "记-2026-11-0001", redVoucherNo: "记-2026-11-0002", action: "reversed" });
  const service = new CashFlowService(prisma, { update: () => ({}), record: async () => {} }, undefined, vouchers);

  await service.autoReverseFromPayment("supplier_payment", "payment-1", "供应商付款冲销：银行退回", USER);
  assert.deepEqual(vouchers.calls, [
    ["cash_flow_entry", "cf-1", "供应商付款冲销：银行退回", USER],
  ], "契约 E：回冲流水后红冲它的凭证（按流水 id，一条一次）");

  // 同一付款再冲一次：流水已经是 reversed，findMany 口径只捞 posted → 不会再红冲第二张
  prisma.cashFlowEntry.findMany = async () => [];
  await service.autoReverseFromPayment("supplier_payment", "payment-1", "重复冲销", USER);
  assert.equal(vouchers.calls.length, 1, "重复冲销不重复红冲");
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
  const subjectNames = new Set(ACCOUNTING_SUBJECT_SEEDS.map((subject) => subject.name));
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
  // D1（2026-11-09）：原料入库先记资产类「原材料」（存货），「主营业务成本」退为兜底。
  assert.deepEqual(paymentSubjectNames("raw_material_inbound"), ["原材料", "主营业务成本"]);
  assert.deepEqual(paymentSubjectNames("purchase_receipt"), ["原材料", "主营业务成本"], "到货单来源同口径");
  assert.deepEqual(paymentSubjectNames("outsource_receipt"), ["加工费"]);
  assert.deepEqual(paymentSubjectNames("other"), ["管理费用", "其他管理费用"]);
  assert.deepEqual(paymentSubjectNames("customer_payment"), ["主营业务收入"]);
  // 2026-09-20：工资付款的候选链首位改成专门新增的「工资支付」（用户要求「确认支付工资的时候
  // 就能归类到工资支付里面。好做账，好出表」）；后两个是历史兜底，保留。
  assert.deepEqual(paymentSubjectNames("salary_payment"), ["工资支付", "临时工资", "基本生产成本"]);
  assert.ok(subjectNames.has("工资支付"), "候选指向的科目必须真的在种入清单里");
  assert.deepEqual(paymentSubjectNames("unknown_source"), DEFAULT_PAYMENT_SUBJECT_NAMES, "未知来源走兜底候选，而不是空数组");
});

/* --------------------------------------------------------- R3-5 契约 E：流水冲销 → 红冲其凭证 */

test("R3-5 用例1：冲销流水 → 按来源红冲它已过账的凭证（一次调用，原因去空白）", async () => {
  const row = { id: "cf-1", status: "posted", remark: null, entryNo: "CF-1", amount: new Prisma.Decimal("100") };
  const prisma = {
    cashFlowEntry: {
      findFirst: async () => row,
      update: async ({ data }) => ({ ...row, ...data }),
    },
  };
  const vouchers = voucherRecorder({ id: "voucher-1", voucherNo: "记-2026-11-0001", redVoucherNo: "记-2026-11-0002", action: "reversed" });
  const service = new CashFlowService(prisma, { update: () => ({}), record: async () => {} }, undefined, vouchers);

  const out = await service.reverse("cf-1", "  银行退回  ", USER);
  assert.equal(out.status, "reversed");
  assert.deepEqual(vouchers.calls, [
    ["cash_flow_entry", "cf-1", "银行退回", USER],
  ], "流水冲销后红冲它的凭证；原因 trim 后透传");
});

test("R3-5 用例4：流水没有凭证时冲销不报错（VoucherService 幂等返回 null，无红字）", async () => {
  const row = { id: "cf-1", status: "posted", remark: null, entryNo: "CF-1", amount: new Prisma.Decimal("100") };
  const prisma = {
    cashFlowEntry: {
      findFirst: async () => row,
      update: async ({ data }) => ({ ...row, ...data }),
    },
  };
  const vouchers = voucherRecorder(null); // 无有效凭证 = 幂等返回 null
  const service = new CashFlowService(prisma, { update: () => ({}), record: async () => {} }, undefined, vouchers);

  const out = await service.reverse("cf-1", "无凭证流水冲销", USER);
  assert.equal(out.status, "reversed", "流水照常冲销，不因没有凭证而报错");
  assert.equal(vouchers.calls.length, 1, "仍然查一次（幂等判断在 VoucherService 内部统一做）");
});

/* --------------------------------------------------------- R3-7 契约 F：流水编辑护栏 */

/** R3-7：`VoucherService` 在 update 路径上用到的两个方法的替身（posted 查询 + 草稿作废）。 */
function voucherGuardRecorder({ posted = null, discardResult = null } = {}) {
  const calls = [];
  return {
    calls,
    postedVoucherOf: async (...args) => { calls.push(["postedVoucherOf", ...args]); return posted; },
    discardDraftVoucherOfSource: async (...args) => { calls.push(["discardDraftVoucherOfSource", ...args]); return discardResult; },
  };
}

const editableFlow = (extra = {}) => ({
  id: "cf-1", entryNo: "CF-20261109-0001", entryDate: new Date("2026-11-09T00:00:00.000Z"),
  counterpartyName: "晋江大田", direction: "expense", amount: new Prisma.Decimal("300"), currency: "CNY",
  subjectId: "subject-1", subject: { id: "subject-1", category: "损益类", name: "主营业务成本" },
  settlementMethod: null, settlementAccountId: null, bankId: null, categorySubjectId: null,
  paymentNature: null, orderNo: null, remark: null, status: "posted",
  ...extra,
});

/** 更正路径的替身：`prepare()` 只查会计科目；流水读写都记录。 */
function updateHarness({ posted = null, discardResult = null, row = editableFlow() } = {}) {
  const writes = [];
  const prisma = {
    cashFlowEntry: {
      findFirst: async () => ({ ...row }),
      update: async ({ data }) => { writes.push(data); return { ...row, ...data }; },
    },
    accountingSubject: { findFirst: async () => ({ id: "subject-1", category: "损益类", name: "主营业务成本" }) },
  };
  const vouchers = voucherGuardRecorder({ posted, discardResult });
  const service = new CashFlowService(prisma, { update: () => ({}), record: async () => {} }, undefined, vouchers);
  return { service, writes, vouchers };
}

test("R3-7 用例3：改有已过账凭证的流水 → 422 CASH_FLOW_HAS_POSTED_VOUCHER（details 带凭证 id/号）", async () => {
  const harness = updateHarness({ posted: { id: "voucher-1", voucherNo: "记-2026-11-0001" } });
  await assert.rejects(
    () => harness.service.update("cf-1", { remark: "改备注" }, USER),
    (error) =>
      error.getResponse().code === "CASH_FLOW_HAS_POSTED_VOUCHER"
      && error.getResponse().details[0].voucher_id === "voucher-1"
      && error.getResponse().details[0].voucher_no === "记-2026-11-0001",
  );
  assert.deepEqual(harness.writes, [], "被挡下时一个字都不写流水（先冲销才能改）");
});

test("R3-7 用例4：改无凭证的流水成功；有草稿凭证时一并作废（不生成红字、不留孤儿）", async () => {
  const noVoucher = updateHarness();
  const updated = await noVoucher.service.update("cf-1", { remark: "改备注" }, USER);
  assert.equal(updated.remark, "改备注");
  assert.ok(noVoucher.vouchers.calls.some((call) => call[0] === "postedVoucherOf"), "先查已过账凭证");
  assert.ok(noVoucher.vouchers.calls.some((call) => call[0] === "discardDraftVoucherOfSource"), "草稿凭证一律作废（无则幂等返回 null）");

  const withDraft = updateHarness({ discardResult: "记-2026-11-0002" });
  await withDraft.service.update("cf-1", { amount: "350" }, USER);
  const discard = withDraft.vouchers.calls.find((call) => call[0] === "discardDraftVoucherOfSource");
  assert.equal(discard[1], "cash_flow_entry");
  assert.equal(discard[2], "cf-1");
  assert.match(discard[3], /流水更正 CF-20261109-0001/, "作废原因带流水号，审计可追溯");
});
