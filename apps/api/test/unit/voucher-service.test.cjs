// 凭证服务：从收支流水生成（幂等）、过账、编辑、删除、红冲。
//
// 无可用 PostgreSQL，因此这些用例用手写 Prisma 替身验证**服务层的业务规则**（谁被写、谁被拦），
// 不验证 SQL 本身；真实库上的外键/唯一索引行为见 docs/log 的「未执行」清单。
const assert = require("node:assert/strict");
const test = require("node:test");
const { Prisma } = require("@prisma/client");
const { VoucherService } = require("../../dist/modules/finance/voucher.service.js");

const audit = () => ({
  create: () => ({ createdBy: "user-1", updatedBy: "user-1" }),
  update: () => ({ updatedBy: "user-1" }),
  softDelete: () => ({ deletedAt: new Date("2026-09-15"), deletedBy: "user-1" }),
  record: async () => {},
});

const cashFlowEntry = (extra = {}) => ({
  id: "cf-1", entryNo: "CF-20260915-0001", entryDate: new Date("2026-09-15T00:00:00.000Z"),
  counterpartyName: "香港迪礼", direction: "income", amount: new Prisma.Decimal("14310.0000"), currency: "USD",
  settlementMethod: "转账--农业银行5706", settlementAccountId: null, status: "posted", remark: null,
  subject: { id: "subject-1", category: "损益类", name: "主营业务收入" }, settlementAccount: { id: "acc-1", key: "农业银行5706", label: "农业银行5706" },
  ...extra,
});

/** 生成路径的替身：记录被写入的凭证与分录。 */
function createHarness({ entry = cashFlowEntry(), existing = null, occupied = null, siblingCodes = [] } = {}) {
  const vouchers = [];
  const lines = [];
  const revivals = [];
  const tx = {
    $queryRaw: async () => [],
    voucher: {
      findMany: async () => siblingCodes.map((voucherNo) => ({ voucherNo })),
      create: async ({ data }) => { vouchers.push(data); return { id: "voucher-new", ...data }; },
      // 幂等判断（带 `deletedAt: null`）用 `existing`；「占位复活」查的是**含软删除**的那一行，用 `occupied`。
      findFirst: async () => occupied ?? existing,
      update: async ({ data }) => { revivals.push(data); return { id: "voucher-deleted", ...data }; },
    },
    voucherLine: {
      createMany: async ({ data }) => { lines.push(...(Array.isArray(data) ? data : [data])); return { count: 1 }; },
      deleteMany: async ({ where }) => { revivals.push({ deletedLinesOf: where.voucherId }); },
    },
  };
  const prisma = {
    cashFlowEntry: { findFirst: async () => entry },
    voucher: { findFirst: async () => existing, findMany: async () => [] },
    $transaction: async (fn) => fn(tx),
  };
  const service = new VoucherService(prisma, audit());
  // get(id) 在 create 之后被调用：直接回放刚写入的凭据，避免再搭一套查询替身
  service.get = async (id) => ({ id, ...vouchers[0], lines });
  return { service, vouchers, lines, revivals };
}

test("由收支流水生成凭证：凭证号按期间顺延，两条分录金额相等且方向正确", async () => {
  const { service, vouchers, lines } = createHarness({ siblingCodes: ["记-2026-09-0001", "记-2026-09-0003"] });
  const row = await service.createFromCashFlowEntry("cf-1", { id: "user-1" });
  assert.equal(vouchers.length, 1);
  assert.equal(vouchers[0].voucherNo, "记-2026-09-0004", "取同期间已有编号的最大值 +1（不是按张数，跳号也不重号）");
  assert.equal(vouchers[0].period, "2026-09");
  assert.equal(vouchers[0].sourceType, "cash_flow_entry");
  assert.equal(vouchers[0].sourceId, "cf-1");
  assert.equal(vouchers[0].status, "draft");
  assert.equal(vouchers[0].debitTotal.toString(), "14310");
  assert.equal(vouchers[0].creditTotal.toString(), "14310");
  assert.equal(row.voucherNo, "记-2026-09-0004");
  assert.equal(lines.length, 2);
  assert.deepEqual(lines.map((line) => [line.lineNo, line.direction, line.subjectLabel]), [
    [1, "debit", "银行存款"],
    [2, "credit", "主营业务收入"],
  ]);
  assert.equal(lines[1].subjectKey, "损益类/主营业务收入", "业务科目的科目编码 = 分类/项目");
  assert.equal(lines[0].cashFlowEntryId, "cf-1", "分录回指来源流水");
});

test("生成是幂等的：该流水已有凭证就返回原凭证，不再新建一张", async () => {
  const existing = { id: "voucher-9", voucherNo: "记-202609-0009", status: "draft", sourceType: "cash_flow_entry", sourceId: "cf-1", lines: [] };
  const { service, vouchers, lines } = createHarness({ existing });
  const row = await service.createFromCashFlowEntry("cf-1", { id: "user-1" });
  assert.equal(row.id, "voucher-9");
  assert.equal(vouchers.length, 0, "已有凭证时不得再写一张");
  assert.equal(lines.length, 0);
});

/**
 * 2026-10-16：`vouchers(source_type, source_id)` 是**全量**唯一索引（软删除的行照样占着键），
 * 所以「删掉草稿凭证 → 再点一次生成」不能 INSERT 新行 —— 那会撞唯一键，用户看到的是数据库报错。
 * 现在改为**原地复活**那一行：清掉软删标记、按现在的内容重写分录、状态回草稿、凭证号沿用原号。
 *
 * 这条路径在「资金搬运凭证纠正」之后必然会被走到：那次纠正会删掉草稿挂账凭证，
 * 财务若把那条应付回退成草稿再确认一次，走的就是它。
 */
test("删掉草稿凭证后重新生成：原地复活那一行（不新建、不撞唯一键）", async () => {
  const { service, vouchers, lines, revivals } = createHarness({ occupied: { id: "voucher-deleted", voucherNo: "记-2026-09-0002" } });
  const row = await service.createFromCashFlowEntry("cf-1", { id: "user-1" });

  assert.equal(vouchers.length, 0, "不得新建一行（同一个来源只允许一行）");
  assert.equal(row.id, "voucher-deleted");
  const update = revivals.find((item) => item.deletedAt !== undefined);
  assert.equal(update.deletedAt, null, "清掉软删标记（这一行重新生效）");
  assert.equal(update.deletedBy, null);
  assert.equal(update.status, "draft");
  assert.equal(update.voucherNo, "记-2026-09-0002", "凭证号沿用原号：换号会让被删掉的那张在审计里对不上");
  assert.deepEqual(revivals.find((item) => item.deletedLinesOf), { deletedLinesOf: "voucher-deleted" }, "旧分录先清掉");
  assert.equal(lines.length, 2, "再按现在的内容写两条分录");
  assert.deepEqual(lines.map((line) => [line.direction, line.subjectLabel]), [["debit", "银行存款"], ["credit", "主营业务收入"]]);
});

test("已冲销的收支流水不能生成凭证（钱没真的动过）", async () => {
  const { service } = createHarness({ entry: cashFlowEntry({ status: "reversed" }) });
  await assert.rejects(() => service.createFromCashFlowEntry("cf-1", { id: "user-1" }), (error) => error.getResponse().code === "CASH_FLOW_ENTRY_NOT_VOUCHERABLE");
});

test("流水不存在时 404，而不是建一张没有来源的凭证", async () => {
  const { service } = createHarness({ entry: null });
  await assert.rejects(() => service.createFromCashFlowEntry("cf-x", { id: "user-1" }), (error) => error.getResponse().code === "CASH_FLOW_ENTRY_NOT_FOUND");
});

// ---------------------------------------------------------------- 过账 / 编辑 / 删除 / 红冲

/**
 * 已有凭证的操作替身。
 *
 * `findFirst` 要按查询形状分两路（它们问的是不同的问题）：
 *   - `where.id` → 行锁校验（返回这张凭证）；
 *   - `where.sourceType + where.sourceId` → 「这个来源有没有占着唯一键的那一行」：
 *     本组用例都没有软删过的红字凭证，回 null = 走新建分支。
 */
function voucherHarness({ voucher, redLines } = {}) {
  const updated = [];
  const createdVouchers = [];
  const createdLines = [];
  const tx = {
    $queryRaw: async () => [],
    voucher: {
      findFirst: async ({ where } = {}) => (where && where.sourceType ? null : voucher),
      findMany: async () => [],
      create: async ({ data }) => { createdVouchers.push(data); return { id: "red-1", ...data }; },
      update: async ({ data }) => { updated.push(data); return { id: voucher?.id ?? "voucher-1", ...data }; },
    },
    voucherLine: {
      deleteMany: async () => ({ count: 0 }),
      createMany: async ({ data }) => { createdLines.push(...(Array.isArray(data) ? data : [data])); return { count: 1 }; },
    },
  };
  const prisma = {
    voucher: { findFirst: async () => voucher, findMany: async () => [] },
    $transaction: async (fn) => fn(tx),
  };
  const service = new VoucherService(prisma, audit());
  service.get = async (id) => ({ id, ...voucher, lines: redLines ?? voucher?.lines ?? [] });
  return { service, updated, createdVouchers, createdLines };
}

const draftVoucher = (extra = {}) => ({
  id: "voucher-1", voucherNo: "记-202609-0001", period: "2026-09", status: "draft", currency: "USD",
  // 真实凭证总有来源：`cash_flow_entry`（从流水生成）或 `voucher`（红冲）。重新生成只对前者开放。
  sourceType: "cash_flow_entry", sourceId: "cf-1",
  debitTotal: new Prisma.Decimal("100"), creditTotal: new Prisma.Decimal("100"), summary: "香港迪礼 · 主营业务收入", remark: null,
  lines: [
    { lineNo: 1, direction: "debit", subjectKey: "银行存款", subjectLabel: "银行存款", summary: "s", amount: new Prisma.Decimal("100"), currency: "USD", cashFlowEntryId: "cf-1" },
    { lineNo: 2, direction: "credit", subjectKey: "损益类/主营业务收入", subjectLabel: "主营业务收入", summary: "s", amount: new Prisma.Decimal("100"), currency: "USD", cashFlowEntryId: "cf-1" },
  ],
  ...extra,
});

test("过账：草稿 → 已过账并留审计；已过账的再点一次被拦下", async () => {
  const { service, updated } = voucherHarness({ voucher: draftVoucher() });
  await service.post("voucher-1", { id: "user-1" });
  assert.equal(updated[0].status, "posted");

  const already = voucherHarness({ voucher: draftVoucher({ status: "posted" }) });
  await assert.rejects(() => already.service.post("voucher-1", { id: "user-1" }), (error) => error.getResponse().code === "VOUCHER_NOT_POSTABLE");
});

test("过账前复核借贷平衡：不平的凭证拒绝过账", async () => {
  const unbalanced = draftVoucher({ lines: [
    { lineNo: 1, direction: "debit", subjectKey: "银行存款", subjectLabel: "银行存款", summary: "s", amount: new Prisma.Decimal("100"), currency: "USD" },
    { lineNo: 2, direction: "credit", subjectKey: "损益类/主营业务收入", subjectLabel: "主营业务收入", summary: "s", amount: new Prisma.Decimal("99.9999"), currency: "USD" },
  ] });
  const { service } = voucherHarness({ voucher: unbalanced });
  await assert.rejects(() => service.post("voucher-1", { id: "user-1" }), (error) => error.getResponse().code === "VOUCHER_NOT_BALANCED");
});

test("编辑草稿分录：整组替换并重算借贷合计（允许人工改科目）", async () => {
  const { service, createdLines, updated } = voucherHarness({ voucher: draftVoucher() });
  await service.update("voucher-1", { lines: [
    { direction: "debit", subject_label: "库存现金", amount: "60" },
    { direction: "credit", subject_label: "主营业务收入", amount: "40" },
    { direction: "credit", subject_label: "其他业务收入", amount: "20" },
  ] }, { id: "user-1" });
  assert.equal(createdLines.length, 3, "原先的 2 行被整组替换成 3 行");
  assert.deepEqual(createdLines.map((line) => line.lineNo), [1, 2, 3], "line_no 按提交顺序重排");
  assert.equal(updated[0].debitTotal.toString(), "60");
  assert.equal(updated[0].creditTotal.toString(), "60", "40 + 20 = 60，借贷相等才允许保存");
});

test("编辑分录时借贷不平时 422，且不改动原凭证", async () => {
  const { service, createdLines, updated } = voucherHarness({ voucher: draftVoucher() });
  await assert.rejects(
    () => service.update("voucher-1", { lines: [{ direction: "debit", subject_label: "银行存款", amount: "10" }, { direction: "credit", subject_label: "主营业务收入", amount: "9" }] }, { id: "user-1" }),
    (error) => error.getResponse().code === "VOUCHER_NOT_BALANCED",
  );
  assert.equal(createdLines.length, 0);
  assert.equal(updated.length, 0);
});

test("编辑分录：方向非法 / 科目为空 / 金额非正 都被拦下", async () => {
  const { service } = voucherHarness({ voucher: draftVoucher() });
  const cases = [
    [{ lines: [{ direction: "both", subject_label: "x", amount: "1" }] }, "INVALID_VOUCHER_DIRECTION"],
    [{ lines: [{ direction: "debit", subject_label: "  ", amount: "1" }] }, "VOUCHER_SUBJECT_REQUIRED"],
    [{ lines: [{ direction: "debit", subject_label: "x", amount: "0" }] }, "INVALID_VOUCHER_AMOUNT"],
    [{ lines: [] }, "VOUCHER_LINE_REQUIRED"],
  ];
  for (const [body, code] of cases) {
    await assert.rejects(() => service.update("voucher-1", body, { id: "user-1" }), (error) => error.getResponse().code === code, code);
  }
});

test("已过账的凭证不能编辑、不能删除（只能红冲）", async () => {
  const { service } = voucherHarness({ voucher: draftVoucher({ status: "posted" }) });
  await assert.rejects(() => service.update("voucher-1", { summary: "改摘要" }, { id: "user-1" }), (error) => error.getResponse().code === "VOUCHER_NOT_EDITABLE");
  await assert.rejects(() => service.remove("voucher-1", { id: "user-1" }), (error) => error.getResponse().code === "VOUCHER_NOT_DELETABLE");
});

test("删除只针对草稿，且是软删除（保留审计）", async () => {
  const { service } = voucherHarness({ voucher: draftVoucher() });
  await service.remove("voucher-1", { id: "user-1" });
  const posted = voucherHarness({ voucher: draftVoucher({ status: "posted" }) });
  await assert.rejects(() => posted.service.remove("voucher-1", { id: "user-1" }), (error) => error.getResponse().code === "VOUCHER_NOT_DELETABLE");
});

test("红冲：另开一张红字凭证（借贷对调）并把原凭证标为已红冲", async () => {
  const { service, createdVouchers, createdLines, updated } = voucherHarness({ voucher: draftVoucher({ status: "posted" }) });
  await service.reverse("voucher-1", "科目挂错", { id: "user-1" });
  assert.equal(createdVouchers.length, 1);
  assert.equal(createdVouchers[0].sourceType, "voucher", "红字凭证的来源是被红冲的凭证");
  assert.equal(createdVouchers[0].sourceId, "voucher-1");
  assert.equal(createdVouchers[0].status, "posted", "红字凭证同事务直接过账，避免出现「原凭证已红冲、对冲凭证未过账」的空档");
  assert.equal(createdVouchers[0].summary, "红冲 记-202609-0001：科目挂错");
  assert.deepEqual(createdLines.map((line) => line.direction), ["credit", "debit"], "借/贷对调");
  assert.equal(updated[0].status, "reversed");
});

test("红冲：已红冲的不能再红冲；不填原因不发请求", async () => {
  const done = voucherHarness({ voucher: draftVoucher({ status: "reversed" }) });
  await assert.rejects(() => done.service.reverse("voucher-1", "again", { id: "user-1" }), (error) => error.getResponse().code === "VOUCHER_NOT_REVERSIBLE");
  const posted = voucherHarness({ voucher: draftVoucher({ status: "posted" }) });
  await assert.rejects(() => posted.service.reverse("voucher-1", "   ", { id: "user-1" }), (error) => error.getResponse().code === "REVERSAL_REASON_REQUIRED");
  assert.equal(posted.createdVouchers.length, 0);
});

// ---------------------------------------------------------------------------
// 2026-09-16（用户要求）：
//   ①「现在要支持凭证重新生成」；
//   ②「凭证中的会计科目银行存款，要引用具体的银行账户」。
//   两条是连着的：生成是幂等的，流水后来补了银行账户/改了项目，就得能把凭证按现在的流水重算一遍
//   —— 老凭证不重算就永远带不上账户。
// ---------------------------------------------------------------------------

const bankedEntry = (extra = {}) => cashFlowEntry({
  bank: { id: "bank-1", bankName: "农业银行", accountNumber: "5706" },
  ...extra,
});

/** 重新生成的替身：记录分录的删除/重建与凭证头的更新。 */
function regenerateHarness({ voucher = draftVoucher(), entry = bankedEntry() } = {}) {
  const deleted = [];
  const createdLines = [];
  const updates = [];
  const tx = {
    $queryRaw: async () => [],
    voucher: {
      findFirst: async () => voucher,
      update: async ({ data }) => { updates.push(data); return { id: voucher.id, ...data }; },
    },
    voucherLine: {
      deleteMany: async (args) => { deleted.push(args); return { count: voucher.lines.length }; },
      createMany: async ({ data }) => { createdLines.push(...(Array.isArray(data) ? data : [data])); return { count: 1 }; },
    },
  };
  const prisma = {
    voucher: { findFirst: async () => voucher },
    cashFlowEntry: { findFirst: async () => entry },
    $transaction: async (fn) => fn(tx),
  };
  const service = new VoucherService(prisma, audit());
  service.get = async (id) => ({ id, ...voucher, lines: createdLines.length ? createdLines.map((line, index) => ({ lineNo: index + 1, ...line })) : voucher.lines });
  return { service, deleted, createdLines, updates };
}

test("重新生成草稿凭证：按来源流水现在的科目与银行账户重算分录，并覆盖手工改动", async () => {
  // 旧凭证是「还没带账户」的那一版（本次改动之前生成的），分录也被人手工改过科目。
  const stale = draftVoucher({ lines: [
    { lineNo: 1, direction: "debit", subjectKey: "银行存款", subjectLabel: "银行存款", summary: "手工改的摘要", amount: new Prisma.Decimal("100"), currency: "USD", cashFlowEntryId: "cf-1", bankId: null },
    { lineNo: 2, direction: "credit", subjectKey: "损益类/管理费用", subjectLabel: "管理费用", summary: "手工改的摘要", amount: new Prisma.Decimal("100"), currency: "USD", cashFlowEntryId: "cf-1", bankId: null },
  ] });
  const harness = regenerateHarness({ voucher: stale });
  const result = await harness.service.regenerate("voucher-1", { id: "user-1" });

  assert.equal(harness.deleted.length, 1, "整组分录重建（重新生成就是按流水重来）");
  assert.equal(harness.createdLines.length, 2);
  assert.equal(harness.createdLines[0].subjectLabel, "银行存款—农业银行5706", "银行存款要带上具体账户");
  assert.equal(harness.createdLines[0].bankId, "bank-1");
  assert.equal(harness.createdLines[1].subjectLabel, "主营业务收入", "手工改过的业务科目被流水上的会计科目覆盖");
  assert.equal(harness.createdLines[1].bankId, null);
  // 凭证头也按流水重算（摘要/币种/金额/期间），凭证号不变
  assert.equal(harness.updates.length, 1);
  assert.equal(harness.updates[0].summary, "香港迪礼 · 主营业务收入");
  assert.equal(harness.updates[0].debitTotal.toString(), "14310");
  assert.equal(harness.updates[0].period, "2026-09");
  assert.equal(result.regenerated, true);
});

test("重新生成：只对草稿开放 —— 已过账的凭证只能红冲", async () => {
  const posted = regenerateHarness({ voucher: draftVoucher({ status: "posted" }) });
  await assert.rejects(
    () => posted.service.regenerate("voucher-1", { id: "user-1" }),
    (error) => error.getResponse().code === "VOUCHER_NOT_REGENERABLE",
  );
  assert.equal(posted.deleted.length, 0, "被拦下时不能动任何分录");
});

test("重新生成：红冲凭证不能重新生成（它的内容由被红冲的凭证决定）", async () => {
  const red = regenerateHarness({ voucher: draftVoucher({ sourceType: "voucher" }) });
  await assert.rejects(
    () => red.service.regenerate("voucher-1", { id: "user-1" }),
    (error) => error.getResponse().code === "VOUCHER_NOT_REGENERABLE",
  );
});

test("重新生成：来源流水不存在 / 已冲销时拒绝（钱没真的动过就不能有凭证）", async () => {
  const missing = regenerateHarness({ entry: null });
  await assert.rejects(
    () => missing.service.regenerate("voucher-1", { id: "user-1" }),
    (error) => error.getResponse().code === "VOUCHER_SOURCE_MISSING",
  );
  const reversedFlow = regenerateHarness({ entry: bankedEntry({ status: "reversed" }) });
  await assert.rejects(
    () => reversedFlow.service.regenerate("voucher-1", { id: "user-1" }),
    (error) => error.getResponse().code === "CASH_FLOW_ENTRY_NOT_VOUCHERABLE",
  );
});

test("由收支流水生成凭证时就把银行账户写进资金分录", async () => {
  const { service, lines } = createHarness({ entry: bankedEntry() });
  await service.createFromCashFlowEntry("cf-1", { id: "user-1" });
  assert.equal(lines[0].subjectLabel, "银行存款—农业银行5706");
  assert.equal(lines[0].bankId, "bank-1");
  assert.equal(lines[1].bankId, null, "业务科目不挂银行账户");
});

// ---------------------------------------------------------------------------
// 2026-09-20（财务要求）：
//   「我完整的一个工资是这样的：借 应付职工薪酬——工资（应发）；贷 其他应付款——社保（个人部分）、
//     应交税费——应交个人所得税、银行存款（实发）。但是现在都不能改」
//   「原材料的也是要加上应交税费：借 原材料 18000 / 应交税费——应交增值税（进项税额）；贷 应付账款」
//   「现在自动生成的不能改、。这是什么意思？」
//
// 两件事：① 分录要能真的改（增删行、改方向 —— 服务层的 `update` 本来支持整组替换，
// 缺的是页面；这里的用例把「四行一借三贷」「三行两借一贷」钉住，防止以后有人按「一借一贷」的
// 老假设给 update 加限制）；② 模板要让财务一键得到这两套结构，且**金额留空**（不按税率自动拆，
// 普票不抵扣 / 优惠税率会自动填错）。
// ---------------------------------------------------------------------------

/** 模板解析的替身：只用到 voucher.findFirst 与 accountingSubject.findMany。 */
function templateHarness({ voucher = draftVoucher(), subjects = [] } = {}) {
  const prisma = {
    voucher: { findFirst: async () => voucher },
    accountingSubject: { findMany: async () => subjects },
  };
  return new VoucherService(prisma, audit());
}

const subjectRows = [
  { id: "sub-salary", category: "负债类", name: "应付职工薪酬", isActive: true },
  { id: "sub-other", category: "负债类", name: "其他应付款", isActive: true },
  { id: "sub-tax", category: "负债类", name: "应交税费", isActive: true },
  { id: "sub-input", category: "负债类", name: "应交税费-进项税", isActive: true },
  { id: "sub-material", category: "资产类", name: "原材料", isActive: true },
  { id: "sub-payable", category: "负债类", name: "应付账款", isActive: true },
  { id: "sub-bank", category: "资产类", name: "银行存款", isActive: true },
  { id: "sub-retired", category: "损益类", name: "销售费 运费", isActive: false },
];

test("凭证模板：工资计提是「一借三贷」，科目按候选名解析到科目表，金额一律留空", async () => {
  const service = templateHarness({ subjects: subjectRows });
  const templates = await service.templates("voucher-1");
  const salary = templates.find((template) => template.key === "salary-accrual");
  assert.ok(salary, "必须提供「工资计提」模板");
  assert.deepEqual(salary.lines.map((line) => [line.direction, line.subject_label]), [
    ["debit", "应付职工薪酬"],
    ["credit", "其他应付款"],
    // 科目表里没有「应交个人所得税」，候选退到「应交税费」——让整行仍有科目可选，
    // 否则财务填金额时会被「每条分录都必须填科目」挡住，还得先去建科目才能保存。
    ["credit", "应交税费"],
    ["credit", "银行存款"],
  ]);
  assert.equal(salary.lines[0].subject_id, "sub-salary");
  assert.equal(salary.lines[0].subject_key, "负债类/应付职工薪酬", "科目编码快照 = 分类/名称");
  assert.equal(salary.lines.some((line) => line.amount !== undefined), false, "模板不带金额");
  assert.deepEqual(salary.lines.map((line) => line.role), ["business", "business", "business", "fund"]);
});

test("凭证模板：原材料采购是「两借一贷」，进项税落到「应交税费-进项税」", async () => {
  const service = templateHarness({ subjects: subjectRows });
  const templates = await service.templates("voucher-1");
  const material = templates.find((template) => template.key === "raw-material-purchase");
  assert.deepEqual(material.lines.map((line) => [line.direction, line.subject_label]), [
    ["debit", "原材料"],
    ["debit", "应交税费-进项税"],
    ["credit", "应付账款"],
  ]);
});

test("凭证模板：交税是「借 应交税费 / 贷 银行存款」（用户 2026-09-26 要的那一项）", async () => {
  const service = templateHarness({ subjects: subjectRows });
  const templates = await service.templates("voucher-1");
  const tax = templates.find((template) => template.key === "tax-payment");
  assert.ok(tax, "必须提供「交税」模板（用户原话：「生成凭证时要有交税的那一项」）");
  assert.equal(tax.name, "交税");
  assert.deepEqual(tax.lines.map((line) => [line.direction, line.subject_label]), [
    ["debit", "应交税费"],
    ["credit", "银行存款"],
  ]);
  // 资金行只是标记（不带金额）：科目与银行账户由被套用的那张凭证决定。
  assert.deepEqual(tax.lines.map((line) => line.role), ["business", "fund"]);
  assert.equal(tax.lines.some((line) => line.amount !== undefined), false, "模板不带金额（交多少税只有财务知道）");
  // 科目表里没有「应交税费」时退到建议名，而不是编一个 id（与另外两张模板同一条纪律）。
  const empty = templateHarness({ subjects: [] });
  const fallback = (await empty.templates("voucher-1")).find((template) => template.key === "tax-payment");
  assert.equal(fallback.lines[0].subject_id, null);
  assert.equal(fallback.lines[0].subject_label, "应交税费");
});

test("凭证模板：候选一个都不命中时 subject_id 为 null 并给出建议名（不编一个科目 id）", async () => {
  const service = templateHarness({ subjects: [] });
  const templates = await service.templates("voucher-1");
  const salary = templates.find((template) => template.key === "salary-accrual");
  assert.equal(salary.lines[0].subject_id, null);
  assert.equal(salary.lines[0].subject_label, "应付职工薪酬——工资", "落空时给财务看的建议名");
  assert.equal(salary.lines[0].subject_key, salary.lines[0].subject_label);
});

test("凭证模板：资金行沿用本凭证的科目与银行账户（钱在哪张卡上是已确认的事实）", async () => {
  const voucher = draftVoucher({ lines: [
    { lineNo: 1, direction: "credit", subjectKey: "资产类/银行存款", subjectLabel: "银行存款—农业银行5706", summary: "s", amount: new Prisma.Decimal("100"), currency: "CNY", bankId: "bank-1", bank: { id: "bank-1", bankName: "农业银行", accountNumber: "5706" } },
    { lineNo: 2, direction: "debit", subjectKey: "损益类/管理费用", subjectLabel: "管理费用", summary: "s", amount: new Prisma.Decimal("100"), currency: "CNY", bankId: null },
  ] });
  const subjects = [...subjectRows, { id: "sub-bank", category: "资产类", name: "银行存款", isActive: true }];
  const service = templateHarness({ voucher, subjects });
  const templates = await service.templates("voucher-1");
  const fund = templates.find((template) => template.key === "salary-accrual").lines.find((line) => line.role === "fund");
  assert.equal(fund.subject_label, "银行存款—农业银行5706", "沿用原资金行的科目快照（含具体账户）");
  assert.equal(fund.bank_id, "bank-1");
  assert.equal(fund.bank_label, "农业银行5706");
  // 非资金行不带账户
  assert.equal(templates.find((template) => template.key === "salary-accrual").lines[0].bank_id, null);
});

test("编辑分录：一借三贷的工资凭证能整组保存（系统原来的一借一贷做不出这个形状）", async () => {
  const { service, createdLines, updated } = voucherHarness({ voucher: draftVoucher({ currency: "CNY" }) });
  await service.update("voucher-1", { lines: [
    { direction: "debit", subject_label: "应付职工薪酬", amount: "12000", summary: "计提工资（应发）" },
    { direction: "credit", subject_label: "其他应付款", amount: "1800", summary: "代扣社保（个人部分）" },
    { direction: "credit", subject_label: "应交税费", amount: "200", summary: "代扣个人所得税" },
    { direction: "credit", subject_label: "银行存款", amount: "10000", summary: "实发工资" },
  ] }, { id: "user-1" });
  assert.equal(createdLines.length, 4);
  assert.equal(updated[0].debitTotal.toString(), "12000");
  assert.equal(updated[0].creditTotal.toString(), "12000", "1800 + 200 + 10000 = 12000");
  assert.deepEqual(createdLines.map((line) => line.direction), ["debit", "credit", "credit", "credit"]);
});

test("编辑分录：两借一贷的原材料采购能保存，进项税与原材料合计等于应付账款", async () => {
  const { service, updated } = voucherHarness({ voucher: draftVoucher({ currency: "CNY" }) });
  await service.update("voucher-1", { lines: [
    { direction: "debit", subject_label: "原材料", amount: "15929.2035" },
    { direction: "debit", subject_label: "应交税费-进项税", amount: "2070.7965" },
    { direction: "credit", subject_label: "应付账款", amount: "18000" },
  ] }, { id: "user-1" });
  assert.equal(updated[0].debitTotal.toString(), "18000");
  assert.equal(updated[0].creditTotal.toString(), "18000");
});

test("编辑分录：显式带的 bank_id 优先，显式 null 表示这行不挂账户（不再按行号沿用）", async () => {
  const voucher = draftVoucher({ lines: [
    { lineNo: 1, direction: "debit", subjectKey: "银行存款", subjectLabel: "银行存款", summary: "s", amount: new Prisma.Decimal("100"), currency: "CNY", bankId: "bank-1" },
    { lineNo: 2, direction: "credit", subjectKey: "损益类/主营业务收入", subjectLabel: "主营业务收入", summary: "s", amount: new Prisma.Decimal("100"), currency: "CNY", bankId: null },
  ] });
  const createdLines = [];
  const tx = {
    $queryRaw: async () => [],
    voucher: { findFirst: async () => voucher, update: async ({ data }) => ({ id: voucher.id, ...data }) },
    voucherLine: {
      deleteMany: async () => ({ count: 2 }),
      createMany: async ({ data }) => { createdLines.push(...(Array.isArray(data) ? data : [data])); return { count: data.length }; },
    },
  };
  const prisma = {
    voucher: { findFirst: async () => voucher },
    bank: { findMany: async () => [{ id: "bank-2" }] },
    $transaction: async (fn) => fn(tx),
  };
  const service = new VoucherService(prisma, audit());
  service.get = async (id) => ({ id, ...voucher, lines: createdLines });
  await service.update("voucher-1", { lines: [
    // 原来是「借 银行存款」在第 1 行；现在第 1 行变成业务行，**显式 null** 才不会被行号沿用误伤
    // （否则那张卡会挂到这一行上，银行存款明细账从此对不上）。
    { direction: "debit", subject_label: "原材料", amount: "100", bank_id: null },
    { direction: "credit", subject_label: "银行存款", amount: "100", bank_id: "bank-2" },
  ] }, { id: "user-1" });
  assert.equal(createdLines[0].bankId, null, "业务行不能被行号沿用挂上原资金行的账户");
  assert.equal(createdLines[1].bankId, "bank-2", "显式带的账户以它为准");
});

test("编辑分录：完全没传 bank_id 时仍按行号沿用原分录的账户（兼容旧调用方）", async () => {
  const voucher = draftVoucher({ lines: [
    { lineNo: 1, direction: "debit", subjectKey: "银行存款", subjectLabel: "银行存款", summary: "s", amount: new Prisma.Decimal("100"), currency: "CNY", bankId: "bank-1" },
    { lineNo: 2, direction: "credit", subjectKey: "损益类/主营业务收入", subjectLabel: "主营业务收入", summary: "s", amount: new Prisma.Decimal("100"), currency: "CNY", bankId: null },
  ] });
  const createdLines = [];
  const tx = {
    $queryRaw: async () => [],
    voucher: { findFirst: async () => voucher, update: async ({ data }) => ({ id: voucher.id, ...data }) },
    voucherLine: { deleteMany: async () => ({ count: 2 }), createMany: async ({ data }) => { createdLines.push(...data); return { count: data.length }; } },
  };
  const prisma = { voucher: { findFirst: async () => voucher }, $transaction: async (fn) => fn(tx) };
  const service = new VoucherService(prisma, audit());
  service.get = async (id) => ({ id, ...voucher, lines: createdLines });
  await service.update("voucher-1", { lines: [
    { direction: "debit", subject_label: "银行存款", amount: "120" },
    { direction: "credit", subject_label: "主营业务收入", amount: "120" },
  ] }, { id: "user-1" });
  assert.equal(createdLines[0].bankId, "bank-1", "旧调用方只改金额时，「钱在哪张卡上」不该被丢掉");
});

test("编辑分录：引用不存在的银行账户时 422（而不是让外键在提交时抛数据库错误）", async () => {
  const createdLines = [];
  const tx = {
    $queryRaw: async () => [],
    voucher: { findFirst: async () => draftVoucher(), update: async ({ data }) => ({ id: "voucher-1", ...data }) },
    voucherLine: { deleteMany: async () => ({ count: 0 }), createMany: async ({ data }) => { createdLines.push(...data); return { count: data.length }; } },
  };
  const prisma = {
    voucher: { findFirst: async () => draftVoucher() },
    bank: { findMany: async () => [{ id: "bank-1" }] },
    $transaction: async (fn) => fn(tx),
  };
  const service = new VoucherService(prisma, audit());
  await assert.rejects(
    () => service.update("voucher-1", { lines: [
      { direction: "debit", subject_label: "原材料", amount: "100" },
      { direction: "credit", subject_label: "银行存款", amount: "100", bank_id: "bank-gone" },
    ] }, { id: "user-1" }),
    (error) => error.getResponse().code === "VOUCHER_BANK_NOT_FOUND",
  );
  assert.equal(createdLines.length, 0);
});

/* ------------------------------------------------------------ 手工新增凭证（2026-09-24） */

/**
 * 折旧 / 摊销 / 工资计提 / 结转成本这些**非现金分录**没有收支流水可挂，
 * 而凭证原先只能由流水生成 —— 于是它们在系统里无处可录，三大报表的固定资产/累计折旧/
 * 应付职工薪酬等行永远填不上（用户 2026-09-24 确认「都要」的第 ① 件）。
 *
 * 这里钉四件事：来源标记（manual + null）、期间与编号、借贷校验、以及银行账户引用。
 */
function manualHarness({ siblingCodes = [], banks = [{ id: "bank-1" }], events = [] } = {}) {
  const vouchers = [];
  const lines = [];
  const tx = {
    voucher: {
      findMany: async () => siblingCodes.map((voucherNo) => ({ voucherNo })),
      create: async ({ data }) => { vouchers.push(data); return { id: "voucher-manual", ...data }; },
    },
    voucherLine: { createMany: async ({ data }) => { lines.push(...(Array.isArray(data) ? data : [data])); return { count: 1 }; } },
  };
  const prisma = {
    bank: { findMany: async () => banks },
    voucher: { findFirst: async () => null, findMany: async () => [] },
    $transaction: async (fn) => fn(tx),
  };
  const service = new VoucherService(prisma, { ...audit(), record: async (...args) => events.push(args) });
  service.get = async (id) => ({ id, ...vouchers[0], lines });
  return { service, vouchers, lines, events };
}

const MANUAL_USER = { id: "user-1", username: "caiwu", display_name: "小叶" };
const depreciationLines = () => [
  { direction: "debit", subject_key: "损益类/管理费用", subject_label: "管理费用", amount: "2500" },
  { direction: "credit", subject_key: "资产类/累计折旧", subject_label: "累计折旧", amount: "2500" },
];

test("手工新增凭证：来源标记 manual + source_id 为空，期间取自日期，编号在期间内顺延", async () => {
  const { service, vouchers, lines, events } = manualHarness({ siblingCodes: ["记-2026-09-0001"] });
  const created = await service.createManual({ voucher_date: "2026-09-30", summary: "计提 9 月折旧", lines: depreciationLines() }, MANUAL_USER);

  assert.equal(vouchers[0].sourceType, "manual", "手工凭证的来源类型是 manual");
  assert.equal(vouchers[0].sourceId, null, "手工凭证没有来源单据 —— source_id 必须是 null（不是编一个随机 id）");
  assert.equal(vouchers[0].period, "2026-09");
  assert.match(vouchers[0].voucherNo, /^记-2026-09-0002$/, "同一期间里顺延（已有 0001）");
  assert.equal(vouchers[0].status, "draft", "新建是草稿：核对后再过账（过账后只能红冲）");
  assert.equal(vouchers[0].debitTotal.toString(), "2500");
  assert.equal(vouchers[0].creditTotal.toString(), "2500");
  assert.equal(vouchers[0].currency, "CNY", "币种默认本币");
  assert.equal(vouchers[0].summary, "计提 9 月折旧");
  assert.equal(lines.length, 2);
  assert.deepEqual(lines.map((line) => [line.direction, line.subjectLabel, line.amount.toString()]), [["debit", "管理费用", "2500"], ["credit", "累计折旧", "2500"]]);
  assert.equal(lines[0].cashFlowEntryId, null, "手工凭证的分录不挂任何流水");
  assert.equal(events.length, 1);
  assert.equal(events[0][0], "voucher.create");
  assert.equal(events[0][4].source_type, "manual");
  assert.equal(created.id, "voucher-manual");
});

test("手工新增凭证：借贷必须相等、至少一借一贷、金额与日期都校验（给出的原因是人话）", async () => {
  const { service } = manualHarness();
  const unbalanced = [
    { direction: "debit", subject_label: "管理费用", amount: "100" },
    { direction: "credit", subject_label: "累计折旧", amount: "99" },
  ];
  await assert.rejects(
    () => service.createManual({ voucher_date: "2026-09-30", lines: unbalanced }, MANUAL_USER),
    (error) => error.getResponse().code === "VOUCHER_NOT_BALANCED" && /借方 100/.test(error.getResponse().message),
  );
  await assert.rejects(
    () => service.createManual({ voucher_date: "2026-09-30", lines: [depreciationLines()[0]] }, MANUAL_USER),
    (error) => error.getResponse().code === "VOUCHER_LINE_REQUIRED",
  );
  await assert.rejects(
    () => service.createManual({ voucher_date: "2026-09-30", lines: [] }, MANUAL_USER),
    (error) => error.getResponse().code === "VOUCHER_LINE_REQUIRED",
  );
  await assert.rejects(
    () => service.createManual({ voucher_date: "2026-09-30", lines: [
      { direction: "debit", subject_label: "管理费用", amount: "0" },
      { direction: "credit", subject_label: "累计折旧", amount: "0" },
    ] }, MANUAL_USER),
    (error) => error.getResponse().code === "INVALID_VOUCHER_AMOUNT",
  );
  await assert.rejects(
    () => service.createManual({ voucher_date: "2026/09/30", lines: depreciationLines() }, MANUAL_USER),
    (error) => error.getResponse().code === "INVALID_VOUCHER_DATE",
  );
  await assert.rejects(
    () => service.createManual({ voucher_date: "2026-09-30", lines: [{ direction: "两边都算", subject_label: "管理费用", amount: "1" }, depreciationLines()[1]] }, MANUAL_USER),
    (error) => error.getResponse().code === "INVALID_VOUCHER_DIRECTION",
  );
});

test("手工新增凭证：摘要留空有兜底（一张没摘要的凭证在清单里等于没写）", async () => {
  const { service, vouchers } = manualHarness();
  await service.createManual({ voucher_date: "2026-10-05", lines: depreciationLines() }, MANUAL_USER);
  assert.equal(vouchers[0].summary, "手工凭证 2026-10");
});

test("手工新增凭证：分录引用不存在的银行账户时 422（而不是让外键在提交时抛数据库错误）", async () => {
  const { service, vouchers } = manualHarness({ banks: [] });
  await assert.rejects(
    () => service.createManual({ voucher_date: "2026-09-30", lines: [
      { direction: "debit", subject_label: "管理费用", amount: "100" },
      { direction: "credit", subject_label: "银行存款", amount: "100", bank_id: "bank-gone" },
    ] }, MANUAL_USER),
    (error) => error.getResponse().code === "VOUCHER_BANK_NOT_FOUND",
  );
  assert.equal(vouchers.length, 0, "校验不过不写任何数据");
});

// ---------------------------------------------------------------------------
// 2026-09-24（二步口径）：**挂账凭证**。确认应收/应付那一步钱还没动，
//   所以凭证是「借应收账款 / 贷收入」或「借成本 / 贷应付账款」，**没有资金分录**。
//   方案见 docs/design/finance-accrual-two-step-2026-09-24.md。
// ---------------------------------------------------------------------------

const ACCRUAL_SUBJECTS = [
  { id: "sub-ar", category: "资产类", name: "应收账款" },
  { id: "sub-ap", category: "负债类", name: "应付账款" },
  { id: "sub-rev", category: "损益类", name: "主营业务收入" },
  { id: "sub-cost", category: "损益类", name: "主营业务成本" },
];

function accrualHarness({ existing = null, subjects = ACCRUAL_SUBJECTS, siblingCodes = [] } = {}) {
  const vouchers = [];
  const lines = [];
  const events = [];
  const tx = {
    voucher: {
      findMany: async () => siblingCodes.map((voucherNo) => ({ voucherNo })),
      create: async ({ data }) => { vouchers.push(data); return { id: "voucher-accrual", ...data }; },
      // 「占位复活」也走这里查（不带 deletedAt 过滤）：本组用例没有软删过的行，回 null = 正常新建。
      findFirst: async () => existing,
      update: async ({ data }) => data,
    },
    voucherLine: {
      createMany: async ({ data }) => { lines.push(...(Array.isArray(data) ? data : [data])); return { count: data.length }; },
      deleteMany: async () => {},
    },
  };
  const prisma = {
    voucher: { findFirst: async () => existing, findMany: async () => [] },
    accountingSubject: {
      findMany: async ({ where }) => subjects.filter((subject) => where.name.in.includes(subject.name)),
      findFirst: async ({ where }) => subjects.find((subject) => subject.id === where.id) ?? null,
    },
    $transaction: async (fn) => fn(tx),
  };
  const service = new VoucherService(prisma, { ...audit(), record: async (...args) => events.push(args) });
  service.get = async (id) => ({ id, ...vouchers[0], lines });
  return { service, vouchers, lines, events };
}

test("挂账凭证（应收）：借应收账款 / 贷收入，来源是那条应收，草稿；再确认一次拿到同一张（幂等）", async () => {
  const { service, vouchers, lines, events } = accrualHarness({ siblingCodes: ["记-2026-09-0007"] });
  const created = await service.createAccrual({
    source_type: "receivable_source", source_id: "ar-1", document_no: "AR-001",
    voucher_date: "2026-09-30", currency: "USD", amount: "120.5",
    counterparty_name: "香港迪礼", contra_subject_names: ["主营业务收入", "营业外收入"],
  }, MANUAL_USER);

  assert.equal(vouchers[0].sourceType, "receivable_source", "来源是那条应收（唯一键 (source_type, source_id) 就是幂等根）");
  assert.equal(vouchers[0].sourceId, "ar-1");
  assert.equal(vouchers[0].status, "draft", "挂账先落草稿，财务核对后过账");
  assert.equal(vouchers[0].currency, "USD");
  assert.equal(vouchers[0].voucherNo, "记-2026-09-0008", "编号与手工凭证同一套（期间内顺延）");
  assert.match(vouchers[0].summary, /确认应收 AR-001（香港迪礼） 挂账/);
  assert.deepEqual(lines.map((line) => [line.direction, line.subjectKey, line.amount.toString()]), [
    ["debit", "资产类/应收账款", "120.5"],
    ["credit", "损益类/主营业务收入", "120.5"],
  ]);
  assert.equal(lines.every((line) => line.bankId === null), true, "挂账**没有资金分录**：钱还没动");
  assert.equal(created.replayed, false);
  assert.equal(events[0][4].source_type, "receivable_source");

  // 幂等：同一条应收被另一个入口（批量 / 对账单）再确认一次 → 拿到同一张，不挂第二遍账。
  const second = new VoucherService({ voucher: { findFirst: async () => ({ id: "voucher-accrual" }) } }, audit());
  second.get = async (id) => ({ id, voucherNo: "记-2026-09-0008" });
  const replayed = await second.createAccrual({
    source_type: "receivable_source", source_id: "ar-1", document_no: "AR-001",
    voucher_date: "2026-09-30", amount: "120.5", contra_subject_names: ["主营业务收入"],
  }, MANUAL_USER);
  assert.equal(replayed.replayed, true, "第二次是「幂等命中」，不是新挂一张（挂两遍＝收入翻倍）");
  assert.equal(replayed.id, "voucher-accrual");
});

/**
 * 2026-10-16（用户报障）：「该笔应付选择的是备用金付款，该笔凭证的会计科目没法正常显示」——
 * 凭证纸上写着「借 应付账款 / 贷 库存现金」，她要的是「借 库存现金（备用金）/ 贷 银行存款」。
 *
 * 口径（用户选定）：其他应付的会计科目填的是资金科目（如「资产类 / 库存现金（备用金）」）时，
 * 这笔不是「欠款」而是**资金搬运**（从银行取现到备用金），确认时不该凭空造出一笔应付账款；
 * 钱在付款那一步一次记完（借方取条目自己的科目，见 supplier-payment.service.ts 的注释）。
 */
test("资金搬运（对方科目是资金科目）不挂账：确认不生成「贷应付账款」，普通科目照旧挂账", async () => {
  const CASH_TRANSFER_SUBJECTS = [
    ...ACCRUAL_SUBJECTS,
    { id: "sub-cash-box", category: "资产类", name: "库存现金（备用金）" },
    { id: "sub-rent", category: "成本类", name: "房租费" },
  ];
  const transfer = accrualHarness({ subjects: CASH_TRANSFER_SUBJECTS });
  const skipped = await transfer.service.createAccrual({
    source_type: "supplier_payable", source_id: "ap-cash", document_no: "APO-0001",
    voucher_date: "2026-10-16", amount: "3000", counterparty_name: "周金红",
    contra_subject_names: ["管理费用", "其他管理费用"], contra_subject_id: "sub-cash-box",
  }, MANUAL_USER);
  assert.equal(skipped, null, "不挂账：返回 null，调用方据此回报 accrual_voucher_id: null");
  assert.equal(transfer.vouchers.length, 0, "不得凭空造出一笔应付账款（那正是用户看到的「会计科目没法正常显示」）");
  assert.equal(transfer.lines.length, 0);
  assert.equal(transfer.events[0][0], "voucher.accrual_skipped", "跳过要留审计（账上少了一张凭证，事后要说得清）");
  assert.equal(transfer.events[0][4].reason, "cash_transfer");
  assert.equal(transfer.events[0][4].subject, "库存现金（备用金）");

  // 反向守卫：普通对方科目（房租费）照旧挂账 —— 这条口径只针对资金科目。
  const normal = accrualHarness({ subjects: CASH_TRANSFER_SUBJECTS });
  await normal.service.createAccrual({
    source_type: "supplier_payable", source_id: "ap-rent", document_no: "APO-0002",
    voucher_date: "2026-10-16", amount: "1200", contra_subject_names: ["管理费用"], contra_subject_id: "sub-rent",
  }, MANUAL_USER);
  assert.equal(normal.vouchers.length, 1);
  assert.deepEqual(normal.lines.map((line) => [line.direction, line.subjectLabel]), [["debit", "房租费"], ["credit", "应付账款"]]);
  assert.equal(normal.lines.every((line) => line.bankId === null), true, "挂账不动钱");
});

test("挂账凭证（应付）：借成本 / 贷应付账款（方向与应收相反）", async () => {
  const { service, lines } = accrualHarness();
  await service.createAccrual({
    source_type: "supplier_payable", source_id: "ap-1", document_no: "AP-001",
    voucher_date: "2026-09-30", amount: "800", contra_subject_names: ["主营业务成本", "原材料"],
  }, MANUAL_USER);
  assert.deepEqual(lines.map((line) => [line.direction, line.subjectKey, line.amount.toString()]), [
    ["debit", "损益类/主营业务成本", "800"],
    ["credit", "负债类/应付账款", "800"],
  ]);
});

test("挂账凭证：科目缺失显式 422（不静默跳过），0 元往来返回 null（不挂空账）", async () => {
  const missing = accrualHarness({ subjects: ACCRUAL_SUBJECTS.filter((subject) => subject.name !== "应收账款") });
  await assert.rejects(
    () => missing.service.createAccrual({ source_type: "receivable_source", source_id: "ar-1", document_no: "AR-001", voucher_date: "2026-09-30", amount: "10", contra_subject_names: ["主营业务收入"] }, MANUAL_USER),
    (error) => error.getResponse().code === "ACCOUNTING_SUBJECT_NOT_FOUND" && /应收账款/.test(error.getResponse().message),
  );
  assert.equal(missing.vouchers.length, 0, "校验不过不写任何数据");

  const noContra = accrualHarness({ subjects: ACCRUAL_SUBJECTS.filter((subject) => subject.name !== "主营业务收入") });
  await assert.rejects(
    () => noContra.service.createAccrual({ source_type: "receivable_source", source_id: "ar-1", document_no: "AR-001", voucher_date: "2026-09-30", amount: "10", contra_subject_names: ["主营业务收入", "营业外收入"] }, MANUAL_USER),
    (error) => error.getResponse().code === "ACCOUNTING_SUBJECT_NOT_FOUND",
  );

  const zero = accrualHarness();
  assert.equal(await zero.service.createAccrual({ source_type: "receivable_source", source_id: "ar-9", document_no: "AR-009", voucher_date: "2026-09-30", amount: "0", contra_subject_names: ["主营业务收入"] }, MANUAL_USER), null);
  assert.equal(zero.vouchers.length, 0);
  await assert.rejects(
    () => zero.service.createAccrual({ source_type: "unknown_source", source_id: "x-1", document_no: "X-1", voucher_date: "2026-09-30", amount: "10", contra_subject_names: ["主营业务收入"] }, MANUAL_USER),
    (error) => error.getResponse().code === "ACCRUAL_SOURCE_UNSUPPORTED",
  );
});

test("accruedSourceIds：只认未红冲的挂账凭证（销账时据此决定贷应收账款还是贷收入）", async () => {
  const seen = [];
  const prisma = {
    voucher: {
      findMany: async ({ where }) => {
        seen.push(where);
        return [{ sourceId: "ar-1" }, { sourceId: "ar-2" }];
      },
    },
  };
  const service = new VoucherService(prisma, audit());
  const ids = await service.accruedSourceIds("receivable_source", ["ar-1", "ar-2", "ar-1", ""]);
  assert.deepEqual([...ids].sort(), ["ar-1", "ar-2"]);
  assert.deepEqual(seen[0].sourceId.in, ["ar-1", "ar-2"], "重复与空 id 先去重再查");
  assert.equal(seen[0].status.not, "reversed", "已红冲的挂账不算数（那张账已经不存在了）");
  assert.equal(seen[0].deletedAt, null);

  assert.deepEqual([...(await service.accruedSourceIds("receivable_source", []))], [], "没有来源就不查库");
});
