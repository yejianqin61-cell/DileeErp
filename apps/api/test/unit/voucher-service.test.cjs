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
function createHarness({ entry = cashFlowEntry(), existing = null, siblingCodes = [] } = {}) {
  const vouchers = [];
  const lines = [];
  const tx = {
    $queryRaw: async () => [],
    voucher: {
      findMany: async () => siblingCodes.map((voucherNo) => ({ voucherNo })),
      create: async ({ data }) => { vouchers.push(data); return { id: "voucher-new", ...data }; },
      findFirst: async () => existing,
    },
    voucherLine: { createMany: async ({ data }) => { lines.push(...(Array.isArray(data) ? data : [data])); return { count: 1 }; } },
  };
  const prisma = {
    cashFlowEntry: { findFirst: async () => entry },
    voucher: { findFirst: async () => existing, findMany: async () => [] },
    $transaction: async (fn) => fn(tx),
  };
  const service = new VoucherService(prisma, audit());
  // get(id) 在 create 之后被调用：直接回放刚写入的凭据，避免再搭一套查询替身
  service.get = async (id) => ({ id, ...vouchers[0], lines });
  return { service, vouchers, lines };
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

test("已冲销的收支流水不能生成凭证（钱没真的动过）", async () => {
  const { service } = createHarness({ entry: cashFlowEntry({ status: "reversed" }) });
  await assert.rejects(() => service.createFromCashFlowEntry("cf-1", { id: "user-1" }), (error) => error.getResponse().code === "CASH_FLOW_ENTRY_NOT_VOUCHERABLE");
});

test("流水不存在时 404，而不是建一张没有来源的凭证", async () => {
  const { service } = createHarness({ entry: null });
  await assert.rejects(() => service.createFromCashFlowEntry("cf-x", { id: "user-1" }), (error) => error.getResponse().code === "CASH_FLOW_ENTRY_NOT_FOUND");
});

// ---------------------------------------------------------------- 过账 / 编辑 / 删除 / 红冲

/** 已有凭证的操作替身。 */
function voucherHarness({ voucher, redLines } = {}) {
  const updated = [];
  const createdVouchers = [];
  const createdLines = [];
  const tx = {
    $queryRaw: async () => [],
    voucher: {
      findFirst: async () => voucher,
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
