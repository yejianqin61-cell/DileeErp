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

/**
 * 凭证替身的 `where` 匹配（只实现本文件用到的形状：等值 / `in` / `not` / `OR`）。
 *
 * 为什么需要它（2026-11-09 R3-4）：`activeVoucherOf` 会按 `status not "reversed"` 过滤，
 * 旧的「findFirst 无条件返回 fixture」替身会把已红冲的行也当成有效行，
 * 那就测不出「红冲后允许按来源重算」这条新行为。字段缺省按 null 处理（fixture 不写 deletedAt 即视为未删）。
 */
function voucherMatchesWhere(row, where = {}) {
  for (const [key, expected] of Object.entries(where)) {
    if (key === "OR") {
      if (!expected.some((condition) => voucherMatchesWhere(row, condition))) return false;
      continue;
    }
    const actual = row?.[key] ?? null;
    if (expected && typeof expected === "object" && !Array.isArray(expected)) {
      if ("in" in expected) { if (!expected.in.includes(actual)) return false; continue; }
      if ("not" in expected) { if (actual === (expected.not ?? null)) return false; continue; }
      if ("startsWith" in expected) { if (!String(actual ?? "").startsWith(expected.startsWith)) return false; continue; }
      return false;
    }
    if (actual !== (expected ?? null)) return false;
  }
  return true;
}

const cashFlowEntry = (extra = {}) => ({
  id: "cf-1", entryNo: "CF-20260915-0001", entryDate: new Date("2026-09-15T00:00:00.000Z"),
  counterpartyName: "香港迪礼", direction: "income", amount: new Prisma.Decimal("14310.0000"), currency: "USD",
  settlementMethod: "转账--农业银行5706", settlementAccountId: null, status: "posted", remark: null,
  subject: { id: "subject-1", category: "损益类", name: "主营业务收入" }, settlementAccount: { id: "acc-1", key: "农业银行5706", label: "农业银行5706" },
  ...extra,
});

/** 科目表替身（R3-1：分录要按科目名解析 `subject_id`，业务科目按 id 取名称快照）。 */
const SUBJECT_ROWS = [
  { id: "sub-bank", category: "资产类", name: "银行存款" },
  { id: "sub-cash", category: "资产类", name: "库存现金" },
  { id: "sub-rev", category: "损益类", name: "主营业务收入" },
  { id: "sub-cost", category: "损益类", name: "主营业务成本" },
  { id: "sub-raw", category: "资产类", name: "原材料" },
  { id: "sub-management", category: "损益类", name: "管理费用" },
  { id: "sub-ap", category: "负债类", name: "应付账款" },
  { id: "sub-ar", category: "资产类", name: "应收账款" },
  { id: "sub-input-tax", category: "负债类", name: "应交税费-进项税" },
];
function accountingSubjectFake(subjects = SUBJECT_ROWS) {
  return {
    findMany: async ({ where } = {}) =>
      subjects.filter(
        (subject) =>
          (!where?.name || where.name.in.includes(subject.name)) &&
          (!where?.id || where.id.in.includes(subject.id)),
      ),
    findFirst: async ({ where } = {}) => subjects.find((subject) => subject.id === where?.id) ?? null,
  };
}

/** 生成路径的替身：记录被写入的凭证与分录。 */
function createHarness({ entry = cashFlowEntry(), existing = null, occupied = null, siblingCodes = [], subjects = SUBJECT_ROWS } = {}) {
  const vouchers = [];
  const lines = [];
  const revivals = [];
  const tx = {
    $queryRaw: async () => [],
    voucher: {
      findMany: async () => siblingCodes.map((voucherNo) => ({ voucherNo })),
      create: async ({ data }) => { vouchers.push(data); return { id: "voucher-new", ...data }; },
      // 「占位复活」找的是**未红冲**的那一行（可含软删）；已红冲的历史行不参与（R3-4）。
      // 幂等命中的判断在 `prisma.voucher.findFirst`（`activeVoucherOf`，未删 + 未红冲）。
      findFirst: async ({ where } = {}) => [occupied, existing].filter(Boolean).find((row) => voucherMatchesWhere(row, where)) ?? null,
      update: async ({ data }) => { revivals.push(data); return { id: "voucher-deleted", ...data }; },
    },
    voucherLine: {
      createMany: async ({ data }) => { lines.push(...(Array.isArray(data) ? data : [data])); return { count: 1 }; },
      deleteMany: async ({ where }) => { revivals.push({ deletedLinesOf: where.voucherId }); },
    },
  };
  const prisma = {
    cashFlowEntry: { findFirst: async () => entry },
    voucher: { findFirst: async ({ where } = {}) => (existing && voucherMatchesWhere(existing, where) ? existing : null), findMany: async () => [] },
    accountingSubject: accountingSubjectFake(subjects),
    $transaction: async (fn) => fn(tx),
  };
  const service = new VoucherService(prisma, audit());
  // get(id) 在 create 之后被调用：直接回放刚写入的凭据，避免再搭一套查询替身
  service.get = async (id) => ({ id, ...vouchers[0], lines });
  return { service, vouchers, lines, revivals };
}

test("由收支流水生成凭证（R3-7：自动生成即已过账）：凭证号按期间顺延，两条分录金额相等且方向正确", async () => {
  const { service, vouchers, lines } = createHarness({ siblingCodes: ["记-2026-09-0001", "记-2026-09-0003"] });
  const row = await service.createFromCashFlowEntry("cf-1", { id: "user-1" });
  assert.equal(vouchers.length, 1);
  assert.equal(vouchers[0].voucherNo, "记-2026-09-0004", "取同期间已有编号的最大值 +1（不是按张数，跳号也不重号）");
  assert.equal(vouchers[0].period, "2026-09");
  assert.equal(vouchers[0].sourceType, "cash_flow_entry");
  assert.equal(vouchers[0].sourceId, "cf-1");
  assert.equal(vouchers[0].status, "posted", "R3-7 契约 F：流水自动生成的凭证生成即 posted（手工凭证仍 draft）");
  assert.equal(vouchers[0].debitTotal.toString(), "14310");
  assert.equal(vouchers[0].creditTotal.toString(), "14310");
  assert.equal(row.voucherNo, "记-2026-09-0004");
  assert.equal(lines.length, 2);
  assert.deepEqual(lines.map((line) => [line.lineNo, line.direction, line.subjectLabel]), [
    [1, "debit", "银行存款—农业银行5706"],
    [2, "credit", "主营业务收入"],
  ]);
  assert.equal(lines[1].subjectKey, "损益类/主营业务收入", "业务科目的科目编码 = 分类/项目");
  assert.equal(lines[0].cashFlowEntryId, "cf-1", "分录回指来源流水");
});

test("生成是幂等的：该流水已有有效凭证就返回原凭证（R3-7：存量草稿不自动过账）", async () => {
  const existing = { id: "voucher-9", voucherNo: "记-202609-0009", status: "draft", sourceType: "cash_flow_entry", sourceId: "cf-1", lines: [] };
  const { service, vouchers, lines } = createHarness({ existing });
  const row = await service.createFromCashFlowEntry("cf-1", { id: "user-1" });
  assert.equal(row.id, "voucher-9");
  assert.equal(row.replayed, true, "幂等命中");
  assert.equal(existing.status, "draft", "契约 F：存量草稿不自动过账（只对新建生效；历史草稿交 R3-8 清单人工处理）");
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
test("（R3-7）删掉草稿凭证后重新生成：原地复活那一行并直接过账（不新建、不撞唯一键）", async () => {
  const { service, vouchers, lines, revivals } = createHarness({ occupied: { id: "voucher-deleted", voucherNo: "记-2026-09-0002", sourceType: "cash_flow_entry", sourceId: "cf-1" } });
  const row = await service.createFromCashFlowEntry("cf-1", { id: "user-1" });

  assert.equal(vouchers.length, 0, "不得新建一行（同一个来源只允许一行）");
  assert.equal(row.id, "voucher-deleted");
  const update = revivals.find((item) => item.deletedAt !== undefined);
  assert.equal(update.deletedAt, null, "清掉软删标记（这一行重新生效）");
  assert.equal(update.deletedBy, null);
  assert.equal(update.status, "posted", "R3-7 契约 F：复活后的自动凭证仍是「生成即过账」");
  assert.equal(update.voucherNo, "记-2026-09-0002", "凭证号沿用原号：换号会让被删掉的那张在审计里对不上");
  assert.deepEqual(revivals.find((item) => item.deletedLinesOf), { deletedLinesOf: "voucher-deleted" }, "旧分录先清掉");
  assert.equal(lines.length, 2, "再按现在的内容写两条分录");
  assert.deepEqual(lines.map((line) => [line.direction, line.subjectLabel]), [["debit", "银行存款—农业银行5706"], ["credit", "主营业务收入"]]);
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
    accountingSubject: accountingSubjectFake(),
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

/**
 * 2026-11-09（A3a）：**红字凭证不能再红冲**。
 *
 * 红字凭证落库时就是 posted，于是它本身也能被红冲 —— 生产库因此出现过 9 连红冲链：
 * 链上每张「原作者」都被置为 reversed，最终只有链尾留在账上，3 张 posted 红字凭证反向虚增 12,061.20。
 * 要更正一张红字凭证，正确做法是回到业务单据重新生成，而不是在凭证层反复对冲。
 */
test("红冲：红字凭证（sourceType=voucher）不能再红冲 → 422 VOUCHER_RED_NOT_REVERSIBLE", async () => {
  const red = voucherHarness({ voucher: draftVoucher({ status: "posted", sourceType: "voucher", sourceId: "voucher-0" }) });
  await assert.rejects(
    () => red.service.reverse("voucher-1", "再冲一次", { id: "user-1" }),
    (error) => error.getResponse().code === "VOUCHER_RED_NOT_REVERSIBLE" && error.getResponse().message.includes("红字凭证不能再次红冲"),
  );
  assert.equal(red.createdVouchers.length, 0, "被拦下时一张红字凭证都不落库（否则又是一节红冲链）");
  assert.equal(red.updated.length, 0, "原红字凭证的状态也不动");
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
    accountingSubject: accountingSubjectFake(),
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
    accountingSubject: accountingSubjectFake(),
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
  const prisma = { voucher: { findFirst: async () => voucher }, accountingSubject: accountingSubjectFake(), $transaction: async (fn) => fn(tx) };
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
    accountingSubject: accountingSubjectFake(),
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
function manualHarness({ siblingCodes = [], banks = [{ id: "bank-1" }], events = [], subjects = SUBJECT_ROWS } = {}) {
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
    accountingSubject: accountingSubjectFake(subjects),
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
  const updates = [];
  // `existing` 既可以是一行，也可以是一组历史行（R3-4 用例：已红冲旧行 + 新建的有效行）。
  const rows = Array.isArray(existing) ? existing : existing ? [existing] : [];
  const findVoucher = (where) => rows.find((row) => voucherMatchesWhere(row, where)) ?? null;
  const tx = {
    voucher: {
      findMany: async () => siblingCodes.map((voucherNo) => ({ voucherNo })),
      create: async ({ data }) => { vouchers.push(data); return { id: "voucher-accrual", ...data }; },
      // 「占位复活」也走这里查（R3-4：排除已红冲的行，但软删行可复活）。
      findFirst: async ({ where } = {}) => findVoucher(where),
      // 草稿重建路径（post=true 时把已有草稿按本次入参重写后过账）会把新的 status/金额写在这里。
      update: async ({ data }) => { updates.push(data); return { id: rows[0]?.id ?? "voucher-accrual", ...data }; },
    },
    voucherLine: {
      createMany: async ({ data }) => { lines.push(...(Array.isArray(data) ? data : [data])); return { count: data.length }; },
      deleteMany: async () => {},
    },
  };
  const prisma = {
    voucher: { findFirst: async ({ where } = {}) => findVoucher(where), findMany: async () => [] },
    accountingSubject: {
      // 两种查询都要支持：按名称（解析 subject_id）与按 id（业务科目取名称快照）。
      findMany: async ({ where } = {}) =>
        subjects.filter(
          (subject) =>
            (!where?.name || where.name.in.includes(subject.name)) &&
            (!where?.id || where.id.in.includes(subject.id)),
        ),
      findFirst: async ({ where } = {}) => subjects.find((subject) => subject.id === where?.id) ?? null,
    },
    $transaction: async (fn) => fn(tx),
  };
  const service = new VoucherService(prisma, { ...audit(), record: async (...args) => events.push(args) });
  service.get = async (id) => ({ id, ...vouchers[0], lines });
  return { service, vouchers, lines, events, updates };
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
 * 2026-11-09（D2「确认即过账」）：五个确认入口都传 `{ client, post: true }`。
 *
 * 这里钉住 VoucherService 侧的两件事：
 *   ① 新建时生成即 `posted`，返回统一形状 `{ id, voucherNo, status, replayed }`（调用方只拿必要字段）；
 *   ② 同一来源已过账后再次确认：金额/币种一致 → 复用原凭证（replayed=true，不新建），
 *      不一致 → 显式 422，**绝不静默把旧金额当成新金额**。
 */
test("挂账凭证：post=true 生成即已过账，返回统一形状 {id, voucherNo, status, replayed}", async () => {
  const { service, vouchers, lines, events } = accrualHarness({ siblingCodes: ["记-2026-09-0007"] });
  const created = await service.createAccrual({
    source_type: "receivable_source", source_id: "ar-1", document_no: "AR-001",
    voucher_date: "2026-09-30", currency: "USD", amount: "120.5",
    counterparty_name: "香港迪礼", contra_subject_names: ["主营业务收入", "营业外收入"],
  }, MANUAL_USER, { post: true });

  assert.equal(vouchers[0].status, "posted", "确认即过账：挂账凭证不再停在草稿（草稿在报表上等于没记）");
  assert.deepEqual(lines.map((line) => line.subjectKey), ["资产类/应收账款", "损益类/主营业务收入"], "分录与草稿口径逐字一致");
  assert.equal(created.status, "posted");
  assert.equal(created.replayed, false);
  assert.equal(created.id, "voucher-accrual");
  assert.equal(created.voucherNo, "记-2026-09-0008");
  // 自动过账要留一条 post 审计：事后看得出「这张从来没在草稿态被人动过」。
  const postEvent = events.find(([action]) => action === "voucher.post");
  assert.ok(postEvent, "直接过账必须留 voucher.post 审计");
  assert.equal(postEvent[4].auto, true);
  assert.equal(postEvent[4].reason, "confirm_post");
});

test("挂账凭证：post=true 且来源已有已过账凭证 → 金额币种一致复用，不一致显式 422", async () => {
  const existing = {
    id: "voucher-accrual", voucherNo: "记-2026-09-0008", status: "posted", currency: "USD",
    sourceType: "receivable_source", sourceId: "ar-1",
    debitTotal: new Prisma.Decimal("120.5"), lines: [],
  };
  const replay = accrualHarness({ existing });
  const replayed = await replay.service.createAccrual({
    source_type: "receivable_source", source_id: "ar-1", document_no: "AR-001",
    voucher_date: "2026-09-30", currency: "USD", amount: "120.5",
    counterparty_name: "香港迪礼", contra_subject_names: ["主营业务收入"],
  }, MANUAL_USER, { post: true });
  assert.equal(replayed.replayed, true, "第二次确认是幂等命中，不挂第二遍账");
  assert.equal(replayed.status, "posted");
  assert.equal(replay.vouchers.length, 0, "不能新建第二张挂账凭证");

  const mismatch = accrualHarness({ existing });
  await assert.rejects(
    () => mismatch.service.createAccrual({
      source_type: "receivable_source", source_id: "ar-1", document_no: "AR-001",
      voucher_date: "2026-09-30", currency: "USD", amount: "999",
      counterparty_name: "香港迪礼", contra_subject_names: ["主营业务收入"],
    }, MANUAL_USER, { post: true }),
    (error) => error.getResponse().code === "VOUCHER_ACCRUAL_AMOUNT_MISMATCH",
  );
  assert.equal(mismatch.vouchers.length, 0, "被拦下时不落库");
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

// ---------------------------------------------------------------------------
// 2026-11-09（用户拍板 D5）：**专票挂账拆进项税**。
//   应付条目 amount 是含税总额、taxRate 是价内税率；专票（invoice_type=special）且税率>0 时：
//   借 业务科目（不含税） + 借 应交税费-进项税（税额） / 贷 应付账款（含税）。
//   普票 / 无票 / 未录 → 两行全额；专票缺税率 422、进项税科目缺失 422（绝不猜、绝不静默换科目）。
// ---------------------------------------------------------------------------

const INPUT_TAX_SUBJECT_NAMES_EXPECTED = ["应交税费-进项税", "应交税费-应交增值税（进项税额）", "应交税费"];

/** 带进项税科目的科目表替身（ACCRUAL_SUBJECTS 里没有应交税费）。 */
const TAX_SUBJECTS = [
  ...ACCRUAL_SUBJECTS,
  { id: "sub-input-tax", category: "负债类", name: "应交税费-进项税" },
];

const accrualInput = (extra = {}) => ({
  source_type: "supplier_payable", source_id: "ap-1", document_no: "AP-001",
  voucher_date: "2026-11-09", amount: "11300", counterparty_name: "泉州峰峰雨伞",
  contra_subject_names: ["原材料", "主营业务成本"], contra_subject_id: "sub-cost",
  ...extra,
});

test("专票挂账：11300 / 13% → 借 业务科目 10000 + 借 应交税费-进项税 1300 / 贷 应付账款 11300", async () => {
  const { service, lines } = accrualHarness({ subjects: TAX_SUBJECTS });
  await service.createAccrual(accrualInput({ invoice_type: "special", tax_rate: "0.13" }), MANUAL_USER);

  assert.equal(lines.length, 3, "专票要拆三行：业务科目 + 进项税 + 应付账款");
  assert.deepEqual(lines.map((line) => [line.lineNo, line.direction, line.subjectLabel, line.amount.toString()]), [
    [1, "debit", "主营业务成本", "10000"],
    [2, "debit", "应交税费-进项税", "1300"],
    [3, "credit", "应付账款", "11300"],
  ], "不含税 = 11300 ÷ 1.13，税额 = 含税 − 不含税；贷方仍是含税的应付账款");
  assert.equal(lines[1].subjectKey, "负债类/应交税费-进项税", "进项税科目编码 = 分类/名称");
  assert.match(lines[1].summary, /进项税额/, "进项税行要有自己的摘要（凭证纸上才看得出这一行是什么）");
  assert.equal(lines.every((line) => line.bankId === null), true, "挂账仍然没有资金分录（钱还没付）");
});

test("专票挂账：借方合计 = 贷方合计，严格相等（税额由含税额减出来，不各自四舍五入）", async () => {
  // 100 ÷ 1.13 = 88.495575… → 净额 88.4956；税额必须是 100 − 88.4956 = 11.5044。
  // 若两边各自四舍五入（11.5044 恰好一样，但 11300 这类非整除值会差 0.0001），借贷就不平。
  const { service, vouchers, lines } = accrualHarness({ subjects: TAX_SUBJECTS });
  await service.createAccrual(accrualInput({ amount: "100", invoice_type: "special", tax_rate: "0.13" }), MANUAL_USER);

  assert.equal(lines.length, 3);
  assert.deepEqual(lines.map((line) => line.amount.toString()), ["88.4956", "11.5044", "100"], "净额 4 位小数、税额 = 含税 − 净额");
  assert.equal(vouchers[0].debitTotal.toString(), "100", "借方合计 = 含税总额（88.4956 + 11.5044）");
  assert.equal(vouchers[0].creditTotal.toString(), "100");
  assert.equal(vouchers[0].debitTotal.eq(vouchers[0].creditTotal), true, "借贷严格相等：不允许出现 0.0001 的差");
  const lineSum = lines.filter((line) => line.direction === "debit").reduce((sum, line) => sum.plus(line.amount), new Prisma.Decimal(0));
  assert.equal(lineSum.eq(vouchers[0].creditTotal), true, "所有借方行之和必须等于贷方");
});

test("普票 / 无票 / 未录发票类型：两行全额进业务科目，不拆进项税", async () => {
  for (const invoice_type of ["general", "none", null, undefined]) {
    const { service, lines } = accrualHarness({ subjects: TAX_SUBJECTS });
    // 普票即使带了税率也不拆：该不该拆由发票类型判定，不靠税率猜。
    await service.createAccrual(accrualInput({ amount: "1000", invoice_type, tax_rate: "0.13" }), MANUAL_USER);
    assert.equal(lines.length, 2, `发票类型 ${invoice_type} 必须只有两行`);
    assert.deepEqual(lines.map((line) => [line.direction, line.subjectLabel, line.amount.toString()]), [
      ["debit", "主营业务成本", "1000"],
      ["credit", "应付账款", "1000"],
    ], `发票类型 ${invoice_type}：全额进业务科目`);
  }
});

test("专票但缺税率 / 税率为 0 / 税率非数字 → 422 INVOICE_TAX_RATE_REQUIRED（专票不许猜 13%）", async () => {
  for (const tax_rate of [undefined, null, "", "0", "0.0000", "abc"]) {
    const { service, vouchers } = accrualHarness({ subjects: TAX_SUBJECTS });
    await assert.rejects(
      () => service.createAccrual(accrualInput({ invoice_type: "special", tax_rate }), MANUAL_USER),
      (error) => error.getResponse().code === "INVOICE_TAX_RATE_REQUIRED",
      `税率 ${JSON.stringify(tax_rate)} 必须 422，而不是按一个默认税率拆`,
    );
    assert.equal(vouchers.length, 0, "校验不过不落库");
  }
});

test("专票但科目表没有进项税科目 → 422 INPUT_TAX_SUBJECT_MISSING，details 列出候选名", async () => {
  const { service, vouchers } = accrualHarness(); // ACCRUAL_SUBJECTS 里没有应交税费-进项税
  await assert.rejects(
    () => service.createAccrual(accrualInput({ invoice_type: "special", tax_rate: "0.13" }), MANUAL_USER),
    (error) => {
      const response = error.getResponse();
      assert.equal(response.code, "INPUT_TAX_SUBJECT_MISSING");
      assert.deepEqual(response.details[0].candidates, INPUT_TAX_SUBJECT_NAMES_EXPECTED, "details 要给出候选名，财务才知道该建哪个科目");
      return true;
    },
  );
  assert.equal(vouchers.length, 0, "找不到进项税科目时不静默换成别的科目");
});

/**
 * 2026-11-09 lead 指定的**防御守卫**：`tax_rate` 是价内税率（0.13），必须 0 < r < 1。
 *
 * 上游 `tax_rate` 是自由 `Decimal(8,4)`，历史/UI 出现过按百分数存 13；归一化由 R2-3 在业务边界做，
 * 凭证侧必须最后拦一道 —— 否则 `11300 ÷ (1 + 13)` 会生成一张「有净额有税额、但全错」的凭证，
 * 而凭证纸上看不出任何异常。
 */
test("专票税率 ≥ 1（百分数写法漏了归一）→ 422 INVALID_TAX_RATE，details 带原值", async () => {
  for (const tax_rate of ["13", "1", "1.0000"]) {
    const { service, vouchers } = accrualHarness({ subjects: TAX_SUBJECTS });
    await assert.rejects(
      () => service.createAccrual(accrualInput({ invoice_type: "special", tax_rate }), MANUAL_USER),
      (error) => {
        const response = error.getResponse();
        assert.equal(response.code, "INVALID_TAX_RATE", `税率 ${tax_rate} 不能算成 amount/(1+${tax_rate})`);
        assert.deepEqual(response.details[0], { tax_rate }, "details 要带原值，财务才知道填的是什么");
        return true;
      },
    );
    assert.equal(vouchers.length, 0, "被拦下时不落库");
  }
});

test("专票税率接受 Prisma.Decimal（调用方从 tax_rate 列直接透传，不过浮点）", async () => {
  const { service, lines } = accrualHarness({ subjects: TAX_SUBJECTS });
  await service.createAccrual(accrualInput({ invoice_type: "special", tax_rate: new Prisma.Decimal("0.13") }), MANUAL_USER);
  assert.deepEqual(lines.map((line) => line.amount.toString()), ["10000", "1300", "11300"], "Decimal 税率与字符串税率结果一致");
});

test("应收侧传了专票也不拆销项税（本轮用户只拍进项）", async () => {
  const { service, lines } = accrualHarness({ subjects: TAX_SUBJECTS });
  await service.createAccrual({
    source_type: "receivable_source", source_id: "ar-1", document_no: "AR-001",
    voucher_date: "2026-11-09", amount: "11300", counterparty_name: "香港迪礼",
    contra_subject_names: ["主营业务收入"], invoice_type: "special", tax_rate: "0.13",
  }, MANUAL_USER);
  assert.deepEqual(lines.map((line) => [line.direction, line.subjectLabel, line.amount.toString()]), [
    ["debit", "应收账款", "11300"],
    ["credit", "主营业务收入", "11300"],
  ], "应收挂账保持两行（销项税拆分不在本轮范围）");
});

test("草稿挂账凭证按专票重建后过账：三行与首次生成逐字一致（post=true 的草稿分支同样走拆分）", async () => {
  const existing = {
    id: "voucher-accrual", voucherNo: "记-2026-11-0009", status: "draft", currency: "CNY",
    sourceType: "supplier_payable", sourceId: "ap-1",
    debitTotal: new Prisma.Decimal("11300"), lines: [{ subjectLabel: "旧科目" }],
  };
  const { service, lines, updates } = accrualHarness({ existing, subjects: TAX_SUBJECTS });
  const result = await service.createAccrual(accrualInput({ invoice_type: "special", tax_rate: "0.13" }), MANUAL_USER, { post: true });

  assert.equal(result.status, "posted");
  assert.deepEqual(lines.map((line) => [line.direction, line.subjectLabel, line.amount.toString()]), [
    ["debit", "主营业务成本", "10000"],
    ["debit", "应交税费-进项税", "1300"],
    ["credit", "应付账款", "11300"],
  ], "已有草稿按本次入参重建：同样是三行（与首次生成共用 accrualDraft）");
  assert.equal(updates.at(-1).status, "posted", "重建后直接过账（确认即过账）");
});

test("accruedSourceIds：只认**已过账**的挂账凭证（销账时据此决定贷应收账款还是贷收入）", async () => {
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
  // A1（2026-11-09）：草稿不是账务事实，已红冲的账也已不存在 —— 两种都不算数，只认 posted。
  assert.equal(seen[0].status, "posted", "只认已过账的挂账凭证（草稿 / 已红冲都不算）");
  assert.equal(seen[0].deletedAt, null);

  assert.deepEqual([...(await service.accruedSourceIds("receivable_source", []))], [], "没有来源就不查库");
});

/**
 * 2026-11-04 用户报障：财务把挂账凭证的分录手改成现金分录（把「贷应付账款」改成「贷银行存款」）后，
 * 凭证页没有「重新生成」可用，只能红冲/删草稿 —— 于是越改越乱。
 * 现在挂账凭证（来源 = 应付/应收确认）也支持按来源单据重建，且与 `createAccrual` 用同一套分录/摘要。
 */
test("挂账凭证重新生成：按来源应付单重建「借业务科目 / 贷应付账款」，覆盖手改的分录", async () => {
  const payable = {
    id: "payable-1", payableNo: "APO-20261104-AC4E1120", amount: new Prisma.Decimal("2700"), currency: "CNY",
    sourceType: "other", supplierId: "sup-1", supplier: { name: "厦门纳益联合专利代理事务所有限公司" },
    subject: { category: "损益类", name: "销售费 推广费" },
  };
  const current = {
    id: "voucher-1", voucherNo: "记-2026-11-0002", summary: "确认应付 APO-20261104-AC4E1120（厦门纳益联合专利代理事务所有限公司） 挂账",
    currency: "CNY", sourceType: "supplier_payable", sourceId: "payable-1", status: "draft",
    // 手改后的分录：贷方被改成银行存款（原口径应是应付账款）
    lines: [{ subjectLabel: "销售费 推广费" }, { subjectLabel: "银行存款 中国银行（人民币）" }],
  };
  const lines = [];
  const updates = [];
  const events = [];  const tx = {
    $queryRaw: async () => [],
    voucher: {
      findFirst: async () => current,
      update: async ({ data }) => { updates.push(data); return { id: "voucher-1", ...data }; },
    },
    voucherLine: {
      deleteMany: async () => ({ count: 2 }),
      createMany: async ({ data }) => { lines.push(...data); return { count: data.length }; },
    },
  };
  const subjects = [
    { category: "损益类", name: "销售费 推广费" },
    { category: "负债类", name: "应付账款" },
  ];
  const prisma = {
    voucher: { findFirst: async () => current },
    supplierPayableEntry: { findFirst: async () => payable },
    accountingSubject: { findMany: async ({ where }) => subjects.filter((subject) => where.name.in.includes(subject.name)) },
    $transaction: async (fn) => fn(tx),
  };
  const service = new VoucherService(prisma, { ...audit(), record: async (...args) => events.push(args) });
  service.get = async (id) => ({ id, ...current, lines });

  const row = await service.regenerate("voucher-1", MANUAL_USER);

  assert.equal(row.regenerated, true);
  assert.equal(lines.length, 2, "原分录先删后建");
  assert.deepEqual(lines.map((line) => [line.direction, line.subjectLabel, line.amount.toString()]), [
    ["debit", "销售费 推广费", "2700"],
    ["credit", "应付账款", "2700"],
  ], "按来源单据重建：借方业务科目、贷方应付账款");
  assert.equal(updates[0].summary, "确认应付 APO-20261104-AC4E1120（厦门纳益联合专利代理事务所有限公司） 挂账");
  assert.equal(updates[0].debitTotal.toString(), "2700");
  const event = events.find(([action]) => action === "voucher.regenerate");
  assert.ok(event, "重新生成必须留审计");
  assert.deepEqual(event[4].before.subjects, ["销售费 推广费", "银行存款 中国银行（人民币）"], "审计要记改前科目");
  assert.deepEqual(event[4].after.subjects, ["销售费 推广费", "应付账款"], "审计要记改后科目");
});

/**
 * D5 的「第三处生成路径」：`regenerateAccrual` 与 `createAccrual` 共用 `accrualDraft`，
 * 只要它把来源应付单上的 `invoiceType` / `taxRate` 传进去，重建就与首次生成逐字一致；
 * 少传这两个值，财务点一次「重新生成」就会把专票的三行悄悄退回两行全额 —— 那是最难查的一类分叉。
 */
test("挂账凭证重新生成：专票按来源单的发票类型/税率重建三行（与首次生成同一套拆分）", async () => {
  const payable = {
    id: "payable-tax", payableNo: "APO-20261109-TAX", amount: new Prisma.Decimal("11300"), currency: "CNY",
    sourceType: "raw_material_inbound", supplierId: "sup-1", supplier: { name: "泉州峰峰雨伞" },
    subject: { category: "资产类", name: "原材料" }, invoiceType: "special", taxRate: new Prisma.Decimal("0.13"),
  };
  const current = {
    id: "voucher-tax", voucherNo: "记-2026-11-0010", summary: "确认应付 APO-20261109-TAX 挂账",
    currency: "CNY", sourceType: "supplier_payable", sourceId: "payable-tax", status: "draft", lines: [],
  };
  const lines = [];
  const updates = [];
  const events = [];
  const tx = {
    $queryRaw: async () => [],
    voucher: {
      findFirst: async () => current,
      update: async ({ data }) => { updates.push(data); return { id: "voucher-tax", ...data }; },
    },
    voucherLine: {
      deleteMany: async () => ({ count: 0 }),
      createMany: async ({ data }) => { lines.push(...data); return { count: data.length }; },
    },
  };
  const subjects = [
    { category: "资产类", name: "原材料" },
    { category: "负债类", name: "应付账款" },
    { category: "负债类", name: "应交税费-进项税" },
  ];
  const prisma = {
    voucher: { findFirst: async () => current },
    supplierPayableEntry: { findFirst: async () => payable },
    accountingSubject: { findMany: async ({ where }) => subjects.filter((subject) => where.name.in.includes(subject.name)) },
    $transaction: async (fn) => fn(tx),
  };
  const service = new VoucherService(prisma, { ...audit(), record: async (...args) => events.push(args) });
  service.get = async (id) => ({ id, ...current, lines });

  const row = await service.regenerate("voucher-tax", MANUAL_USER);

  assert.equal(row.regenerated, true);
  assert.deepEqual(lines.map((line) => [line.direction, line.subjectLabel, line.amount.toString()]), [
    ["debit", "原材料", "10000"],
    ["debit", "应交税费-进项税", "1300"],
    ["credit", "应付账款", "11300"],
  ], "重新生成不许把专票三行退回两行全额");
  assert.equal(updates[0].debitTotal.toString(), "11300", "借贷合计仍是含税总额");
});

// ---------------------------------------------------------------------------
// 2026-11-05：贷方资金科目名改用「结算账户优先」后，**已经生成出来的草稿凭证不会自己变**。
// `fundLabelRefreshPreview` / `refreshDraftFundLabels` 按来源流水把草稿凭证的**资金行**科目名
// 对齐到新口径：只改名字，不动金额、业务分录与手工调整过的行（草稿还没过账，不能整张覆盖）。
// ---------------------------------------------------------------------------

function fundLabelHarness({ drafts = [], entries = [] } = {}) {
  const updates = [];
  const audits = [];
  const prisma = {
    voucher: { findMany: async () => drafts },
    cashFlowEntry: { findMany: async ({ where }) => entries.filter((entry) => where.id.in.includes(entry.id)) },
    voucherLine: { update: async ({ where, data }) => { updates.push({ where, data }); return { id: where.id, ...data }; } },
  };
  const service = new VoucherService(prisma, { ...audit(), record: async (...args) => { audits.push(args); } });
  return { service, updates, audits };
}

const draftWithFundLine = (overrides = {}) => ({
  id: "voucher-1",
  voucherNo: "记-2026-11-0003",
  sourceId: "cf-1",
  lines: [
    { id: "line-1", lineNo: 1, subjectKey: "负债类/应付账款", subjectLabel: "应付账款", bankId: null },
    { id: "line-2", lineNo: 2, subjectKey: "银行存款", subjectLabel: "银行存款—招商银行6214851811022925", bankId: "bank-9" },
  ],
  ...overrides,
});

/** 来源流水现在补上了结算账户（农业银行5706），银行账户是招商卡 —— 新口径要写结算账户名。 */
const entryWithSettlement = (extra = {}) => cashFlowEntry({
  direction: "expense",
  amount: new Prisma.Decimal("27.2"),
  subject: { id: "subject-ap", category: "负债类", name: "应付账款" },
  settlementAccount: { id: "acc-1", key: "农业银行5706", label: "农业银行5706" },
  bank: { id: "bank-9", bankName: "招商银行", accountNumber: "6214851811022925" },
  ...extra,
});

test("草稿凭证资金行按新口径重算：贷方科目名从银行账户名换成结算账户名（只改那一行）", async () => {
  const harness = fundLabelHarness({ drafts: [draftWithFundLine()], entries: [entryWithSettlement()] });
  const preview = await harness.service.fundLabelRefreshPreview();
  assert.equal(preview.checked, 1);
  assert.equal(preview.changed, 1);
  assert.deepEqual(preview.targets[0], {
    voucher_no: "记-2026-11-0003", entry_no: "CF-20260915-0001", line_no: 2,
    before: "银行存款—招商银行6214851811022925", after: "银行存款—农业银行5706", changed: true,
  });
  assert.equal(harness.updates.length, 0, "预览不写库");

  const result = await harness.service.refreshDraftFundLabels({ id: "user-1" });
  assert.equal(result.changed, 1);
  assert.deepEqual(result.vouchers, ["记-2026-11-0003"]);
  assert.equal(harness.updates.length, 1, "只更新资金行，业务行不动");
  assert.equal(harness.updates[0].where.id, "line-2");
  assert.equal(harness.updates[0].data.subjectLabel, "银行存款—农业银行5706");
  assert.equal(harness.updates[0].data.subjectKey, "银行存款", "会计科目仍是银行存款（要能汇总）");
  assert.equal(harness.audits.length, 1);
  assert.equal(harness.audits[0][0], "voucher.refresh_fund_label");
});

test("资金行已经是新写法时预览 0 条要改、执行不写库（幂等，可反复跑）", async () => {
  const draft = draftWithFundLine({
    lines: [
      { id: "line-1", lineNo: 1, subjectKey: "负债类/应付账款", subjectLabel: "应付账款", bankId: null },
      { id: "line-2", lineNo: 2, subjectKey: "银行存款", subjectLabel: "银行存款—农业银行5706", bankId: "bank-9" },
    ],
  });
  const harness = fundLabelHarness({ drafts: [draft], entries: [entryWithSettlement()] });
  const preview = await harness.service.fundLabelRefreshPreview();
  assert.equal(preview.checked, 1);
  assert.equal(preview.changed, 0);
  const result = await harness.service.refreshDraftFundLabels({ id: "user-1" });
  assert.equal(result.changed, 0);
  assert.equal(harness.updates.length, 0);
});

test("结算账户为空时退回银行账户名（与旧写法一致 → 不需要改）", async () => {
  const harness = fundLabelHarness({ drafts: [draftWithFundLine()], entries: [entryWithSettlement({ settlementAccount: null })] });
  const preview = await harness.service.fundLabelRefreshPreview();
  assert.equal(preview.changed, 0, "没有结算账户的流水，科目名保持银行名 + 账号");
});

test("来源流水被删/冲销时跳过那张草稿（没有可重算的事实，不猜）", async () => {
  const harness = fundLabelHarness({ drafts: [draftWithFundLine()], entries: [] });
  const preview = await harness.service.fundLabelRefreshPreview();
  assert.equal(preview.checked, 0);
  assert.equal(preview.changed, 0);
  assert.equal(harness.updates.length, 0);
});

// ---------------------------------------------------------------------------
// 2026-11-09 R3-1（契约 C）：凭证行落「记账科目 id」+「业务科目（辅助维度）」。
//
// 历史行只有文本科目（subject_label）；改名、同名跨类目、历史手工名都会让报表按文本归集不上账。
// 所以每条生成路径都要写 subject_id（唯一同名才解析，歧义/找不到留空），
// 能拿到业务科目录入的路径（挂账条目科目 / 流水「收支类目」）再写 business_subject_id + label 快照。
// 辅助维度**不参与**记账：借贷方向、金额、科目名称一个都不动。
// ---------------------------------------------------------------------------

const R3_SUBJECTS = [
  ...SUBJECT_ROWS,
  { id: "sub-other-a", category: "资产类", name: "其他" },
  { id: "sub-other-b", category: "负债类", name: "其他" },
];

test("挂账凭证（R3-1）：两行都写 subject_id（管理费用 / 应付账款），业务科目行带辅助维度", async () => {
  const { service, lines } = accrualHarness({ subjects: R3_SUBJECTS });
  await service.createAccrual({
    source_type: "supplier_payable", source_id: "ap-r3", document_no: "AP-R3",
    voucher_date: "2026-11-09", amount: "2700", counterparty_name: "厦门纳益",
    contra_subject_names: ["管理费用", "其他管理费用"],
    business_subject_id: "sub-management",
  }, MANUAL_USER);

  assert.deepEqual(lines.map((line) => [line.subjectLabel, line.subjectId]), [
    ["管理费用", "sub-management"],
    ["应付账款", "sub-ap"],
  ], "每一行都要按唯一同名科目落 subject_id（报表/明细账按 id 归集）");
  // 辅助维度只挂业务分录行：应付账款行不是「业务科目」那一行。
  assert.equal(lines[0].businessSubjectId, "sub-management");
  assert.equal(lines[0].businessSubjectLabel, "管理费用", "业务科目名快照（科目改名后历史凭证仍显示当时的名字）");
  assert.equal(lines[1].businessSubjectId ?? null, null);
  assert.equal(lines[1].businessSubjectLabel ?? null, null);
});

test("挂账凭证（R3-1）：专票拆三行时辅助维度只在不含税的业务行上", async () => {
  const { service, lines } = accrualHarness({ subjects: SUBJECT_ROWS });
  await service.createAccrual({
    source_type: "supplier_payable", source_id: "ap-r3-tax", document_no: "AP-R3-TAX",
    voucher_date: "2026-11-09", amount: "11300", counterparty_name: "泉州峰峰雨伞",
    contra_subject_names: ["原材料"], invoice_type: "special", tax_rate: "0.13",
    business_subject_id: "sub-raw",
  }, MANUAL_USER);

  assert.deepEqual(lines.map((line) => [line.subjectLabel, line.subjectId, line.businessSubjectId ?? null]), [
    ["原材料", "sub-raw", "sub-raw"],
    ["应交税费-进项税", "sub-input-tax", null],
    ["应付账款", "sub-ap", null],
  ], "进项税行/应付账款行没有业务辅助维度；记账科目 id 三行都写");
});

test("流水凭证（R3-1）：收支类目落业务科目辅助维度；记账科目仍取流水主科目", async () => {
  const entry = cashFlowEntry({
    direction: "expense",
    categorySubject: { id: "sub-management", category: "损益类", name: "管理费用" },
  });
  const { service, lines } = createHarness({ entry });
  await service.createFromCashFlowEntry("cf-1", { id: "user-1" });

  assert.deepEqual(lines.map((line) => [line.direction, line.subjectLabel, line.subjectId]), [
    ["debit", "主营业务收入", "sub-rev"],
    ["credit", "银行存款—农业银行5706", "sub-bank"],
  ], "记账科目取流水 subject；资金行按名称解析到「银行存款」（不带账户后缀）");
  // 业务分录行 = 支出方向的借方；辅助维度写收支类目，不改记账科目。
  assert.equal(lines[0].businessSubjectId, "sub-management");
  assert.equal(lines[0].businessSubjectLabel, "管理费用");
  assert.equal(lines[1].businessSubjectId, null, "资金行不属于任何业务科目");
});

test("手工凭证（R3-1）：科目名在科目表里不存在（历史手工名）→ subject_id=null，label 原样保留", async () => {
  const harness = manualHarness();
  await harness.service.createManual({
    voucher_date: "2026-11-09", summary: "历史凭证补录",
    lines: [
      { direction: "debit", subject_label: "历史手工科目", amount: "100" },
      { direction: "credit", subject_label: "银行存款", amount: "100" },
    ],
  }, MANUAL_USER);

  assert.equal(harness.lines[0].subjectId, null, "找不到唯一同名科目就留空（不许猜）");
  assert.equal(harness.lines[0].subjectLabel, "历史手工科目", "label 必须原样保留：打印与报表都靠它兜底");
  assert.equal(harness.lines[0].businessSubjectId, null, "手工凭证没有业务科目维度");
  assert.equal(harness.lines[1].subjectId, "sub-bank", "唯一同名科目照常解析");
});

test("同名跨类目（两个类别各一个「其他」）→ subject_id=null（歧义不猜）", async () => {
  const harness = manualHarness({ subjects: R3_SUBJECTS });
  await harness.service.createManual({
    voucher_date: "2026-11-09", summary: "歧义科目",
    lines: [
      { direction: "debit", subject_label: "其他", amount: "100" },
      { direction: "credit", subject_label: "银行存款", amount: "100" },
    ],
  }, MANUAL_USER);

  assert.equal(harness.lines[0].subjectId, null, "同名跨类目不能按 sortOrder/分类猜，只能留空让报表回退 label");
  assert.equal(harness.lines[0].subjectLabel, "其他");
  assert.equal(harness.lines[1].subjectId, "sub-bank", "其他唯一同名科目不受影响");
});

test("红冲（R3-1）：红字分录沿用原行的 subject_id / 业务科目（借贷对调、科目不变）", async () => {
  const voucher = draftVoucher({
    status: "posted",
    lines: [
      { lineNo: 1, direction: "debit", subjectKey: "负债类/应付账款", subjectLabel: "应付账款", summary: "原行", amount: new Prisma.Decimal("100"), currency: "CNY", subjectId: "sub-ap" },
      { lineNo: 2, direction: "credit", subjectKey: "资产类/原材料", subjectLabel: "原材料", summary: "原行", amount: new Prisma.Decimal("100"), currency: "CNY", subjectId: "sub-raw", businessSubjectId: "sub-management", businessSubjectLabel: "管理费用" },
    ],
  });
  const harness = voucherHarness({ voucher });
  await harness.service.reverse("voucher-1", "测试红冲", { id: "user-1" });

  assert.deepEqual(harness.createdLines.map((line) => [line.direction, line.subjectId, line.businessSubjectId]), [
    ["credit", "sub-ap", null],
    ["debit", "sub-raw", "sub-management"],
  ], "沿用原行 id（不按名称重新解析：科目这段时间被改名/停用也不会挂错）");
  assert.equal(harness.createdLines[1].businessSubjectLabel, "管理费用", "业务科目名称快照一并沿用");
});

test("编辑分录（R3-1）：保存时同样按名称解析 subject_id，人工输入的科目名不落 id", async () => {
  const harness = voucherHarness({ voucher: draftVoucher({ currency: "CNY" }) });
  await harness.service.update("voucher-1", {
    lines: [
      { direction: "debit", subject_label: "管理费用", amount: "100" },
      { direction: "credit", subject_label: "银行手续费", amount: "100" },
    ],
  }, { id: "user-1" });

  assert.equal(harness.createdLines[0].subjectId, "sub-management", "科目表里有的名字要落 id");
  assert.equal(harness.createdLines[1].subjectId, null, "科目表里没有的名字留空，label 原样");
  assert.equal(harness.createdLines[1].subjectLabel, "银行手续费");
});

// ---------------------------------------------------------------------------
// 2026-11-09 R3-4（契约 D）：红冲后按来源重算。
//
// 唯一约束从「全局唯一 (source_type, source_id)」改成**部分唯一索引**
// （`WHERE deleted_at IS NULL AND status <> 'reversed'`，迁移 20261109130000_finance_governance_r3）：
// 已红冲的历史行不再占键。于是 `createAccrual(post=true)` 遇「来源只有已红冲凭证」时
// 不再 422 `VOUCHER_ACCRUAL_REVERSED`，而是按本次入参**新建一张 posted**，历史红字原样保留；
// 「同一来源同时只有一张有效凭证」仍由部分唯一索引保证。
// ---------------------------------------------------------------------------

const REVERSED_ACCRUAL = (extra = {}) => ({
  id: "voucher-red", voucherNo: "记-2026-11-0007", status: "reversed", currency: "CNY",
  sourceType: "supplier_payable", sourceId: "ap-1", debitTotal: new Prisma.Decimal("2700"), lines: [],
  ...extra,
});
const POSTED_ACCRUAL = (extra = {}) => ({
  id: "voucher-new", voucherNo: "记-2026-11-0011", status: "posted", currency: "CNY",
  sourceType: "supplier_payable", sourceId: "ap-1", debitTotal: new Prisma.Decimal("2700"), lines: [],
  ...extra,
});
const accruePayable = (service, options = { post: true }, extra = {}) => service.createAccrual({
  source_type: "supplier_payable", source_id: "ap-1", document_no: "AP-001",
  voucher_date: "2026-11-09", amount: "2700", counterparty_name: "泉州峰峰雨伞",
  contra_subject_names: ["原材料"],
  ...extra,
}, MANUAL_USER, options);

test("R3-4 用例1：来源只有已红冲的挂账凭证 → createAccrual(post) 新建 posted，旧行仍 reversed", async () => {
  const history = REVERSED_ACCRUAL();
  const harness = accrualHarness({ existing: [history], subjects: SUBJECT_ROWS });
  const created = await accruePayable(harness.service);

  // 此前这里 422 VOUCHER_ACCRUAL_REVERSED（全局唯一键占着，建不出第二张）；契约 D 改为允许重建。
  assert.equal(created.status, "posted");
  assert.equal(created.replayed, false);
  assert.equal(harness.vouchers.length, 1, "新建一张（不是复活/改写那条红冲行）");
  assert.equal(harness.vouchers[0].status, "posted");
  assert.equal(harness.updates.length, 0, "红冲历史行不得被改写（契约 D：历史原样保留）");
  assert.equal(history.status, "reversed");
});

test("R3-4 用例2：已有有效 posted 且金额一致 → replayed=true，不新建", async () => {
  const harness = accrualHarness({ existing: [POSTED_ACCRUAL()] });
  const replayed = await accruePayable(harness.service);

  assert.equal(replayed.replayed, true);
  assert.equal(replayed.status, "posted");
  assert.equal(harness.vouchers.length, 0, "幂等命中不新建");
  assert.equal(harness.updates.length, 0);
});

test("R3-4 用例3：已有有效 posted 但金额不同 → 422 VOUCHER_ACCRUAL_AMOUNT_MISMATCH（不覆盖已过账）", async () => {
  const harness = accrualHarness({ existing: [POSTED_ACCRUAL()] });
  await assert.rejects(
    () => accruePayable(harness.service, { post: true }, { amount: "999" }),
    (error) => error.getResponse().code === "VOUCHER_ACCRUAL_AMOUNT_MISMATCH",
  );
  assert.equal(harness.vouchers.length, 0, "被拦下时不落库、也不改写原凭证");
  assert.equal(harness.updates.length, 0);
});

test("R3-4 用例4：同一来源「红冲历史行 + 新 posted」并存时，activeVoucherOf 取到新的那张", async () => {
  const harness = accrualHarness({ existing: [REVERSED_ACCRUAL(), POSTED_ACCRUAL({ id: "voucher-newer" })] });
  const active = await harness.service.activeVoucherOf("supplier_payable", "ap-1");
  assert.equal(active.id, "voucher-newer", "helper 排除 reversed，只取有效行");
  assert.equal(await harness.service.activeVoucherOf("supplier_payable", null), null, "没有来源 id 不查库");
});

/** 有「行集合」语义的替身：createAccrual 新建的凭证会真的落进 rows，用来串起「红冲→重算」两次调用。 */
function accrualRepositoryHarness({ rows = [], subjects = ACCRUAL_SUBJECTS } = {}) {
  const created = [];
  const lines = [];
  const events = [];
  const findVoucher = (where) => rows.find((row) => voucherMatchesWhere(row, where)) ?? null;
  const tx = {
    voucher: {
      // 凭证号在期间内顺延：从已有的行里取（真实实现查 vouchers 表）。
      findMany: async ({ where } = {}) => rows.filter((row) => voucherMatchesWhere(row, where)).map((row) => ({ voucherNo: row.voucherNo })),
      create: async ({ data }) => {
        const row = { id: `voucher-${rows.length + 1}`, createdAt: new Date(Date.UTC(2026, 10, 9, 0, rows.length)), ...data };
        rows.push(row);
        created.push(row);
        return row;
      },
      findFirst: async ({ where } = {}) => findVoucher(where),
      update: async ({ where, data }) => {
        const row = rows.find((item) => item.id === where.id);
        if (row) Object.assign(row, data);
        return row;
      },
    },
    voucherLine: {
      createMany: async ({ data }) => { lines.push(...(Array.isArray(data) ? data : [data])); return { count: data.length }; },
      deleteMany: async () => ({ count: 0 }),
    },
  };
  const prisma = {
    voucher: { findFirst: async ({ where } = {}) => findVoucher(where), findMany: async () => [] },
    accountingSubject: accountingSubjectFake(subjects),
    $transaction: async (fn) => fn(tx),
  };
  const service = new VoucherService(prisma, { ...audit(), record: async (...args) => events.push(args) });
  return { service, rows, created, lines, events };
}

test("R3-4：红冲 → 按来源重算两次后，历史红字行一张没少、有效行始终唯一", async () => {
  const history = REVERSED_ACCRUAL({ id: "voucher-old", voucherNo: "记-2026-11-0001" });
  const harness = accrualRepositoryHarness({ rows: [history], subjects: SUBJECT_ROWS });

  const first = await accruePayable(harness.service);
  assert.equal(first.status, "posted");
  // 模拟财务在凭证页把这第一张红冲（reverse 本身有独立用例；这里只改状态，等价于红冲后的结果）。
  harness.rows.find((row) => row.id === first.id).status = "reversed";

  const second = await accruePayable(harness.service);
  const active = harness.rows.filter((row) => row.status !== "reversed");
  assert.equal(active.length, 1, "同一来源同时只有一张有效凭证（部分唯一索引口径）");
  assert.equal(active[0].id, second.id);
  assert.equal(harness.rows.length, 3, "历史行一张没删：原红冲行 + 第一次红冲行 + 新有效行");
  assert.equal(harness.rows[0].status, "reversed", "原红冲行原样保留");
  assert.equal(harness.rows[1].status, "reversed", "第一次重算的凭证红冲后也保留");
  assert.notEqual(harness.rows[1].voucherNo, harness.rows[2].voucherNo, "新凭证是新凭证号（同来源多行不再撞号）");
});

test("R3-4 / R3-7：流水凭证红冲后，同一条流水可以再生成一张（新凭证生成即 posted）", async () => {
  const reversedVoucher = {
    id: "voucher-old", voucherNo: "记-2026-09-0001", status: "reversed",
    sourceType: "cash_flow_entry", sourceId: "cf-1", lines: [],
  };
  const harness = createHarness({ existing: reversedVoucher, siblingCodes: ["记-2026-09-0001"] });
  const row = await harness.service.createFromCashFlowEntry("cf-1", { id: "user-1" });

  assert.equal(harness.vouchers.length, 1, "已红冲行不占部分唯一键 → 允许新建第二张");
  assert.equal(harness.vouchers[0].status, "posted", "R3-7：新建的流水凭证生成即过账（红冲不改变自动过账口径）");
  assert.equal(row.voucherNo, "记-2026-09-0002", "新凭证走新号，不复用红冲行的号");
});

// ---------------------------------------------------------------------------
// R3-5 契约 E：按来源红冲（reverseBySource）
//
// 用途：付款/收款冲销、流水冲销都要「红冲它生成的凭证」，但三处调用点不能各写一遍
// 「按来源找有效凭证」——那会重演 R3-4 之前的坑：按 `deletedAt: null` 找会把已红冲行
// 当成有效凭证，于是重复红冲 / 静默回放。这里只测 helper 的四种输入形状。
// ---------------------------------------------------------------------------

/**
 * `reverseBySource` 的最小替身：
 *   - 根 `prisma.voucher.findFirst` 用 `voucherMatchesWhere` 模拟 `activeVoucherOf`（未删 + 未红冲）；
 *   - `posted` 走既有 `reverse`：事务里锁行 → 红字占位查询 → 建红字 → 原行置 reversed；
 *   - `draft` 走软删（根 `prisma.voucher.update`），不生成红字。
 */
function reverseBySourceHarness({ active = null, occupiedRed = null } = {}) {
  const events = [];
  const redCreated = [];
  const updated = [];
  const tx = {
    $queryRaw: async () => [],
    voucher: {
      findFirst: async ({ where } = {}) => {
        if (where?.sourceType === "voucher") return occupiedRed;
        if (where?.id) return active && active.id === where.id ? active : null;
        return null;
      },
      findMany: async () => [],
      create: async ({ data }) => { redCreated.push(data); return { id: "red-1", ...data }; },
      update: async ({ data }) => { updated.push({ scope: "tx", data }); return { id: active?.id, ...data }; },
    },
    voucherLine: {
      deleteMany: async () => ({ count: 0 }),
      createMany: async ({ data }) => ({ count: Array.isArray(data) ? data.length : 1 }),
    },
  };
  const prisma = {
    voucher: {
      findFirst: async ({ where } = {}) => (active && voucherMatchesWhere(active, where) ? active : null),
      update: async ({ where, data }) => { updated.push({ scope: "root", where, data }); return { id: where.id, ...data }; },
    },
    $transaction: async (fn) => fn(tx),
  };
  const service = new VoucherService(prisma, { ...audit(), record: async (...args) => events.push(args) });
  // `reverse()` 结束时会回读红字凭证；替身直接返回刚创建的行。
  service.get = async (id) => (id === "red-1" ? { id, ...(redCreated[0] ?? {}) } : active);
  return { service, events, redCreated, updated };
}

const flowVoucher = (extra = {}) => ({
  id: "voucher-flow", voucherNo: "记-2026-11-0001", status: "posted",
  sourceType: "cash_flow_entry", sourceId: "cf-1",
  period: "2026-11", currency: "CNY",
  debitTotal: new Prisma.Decimal("100"), creditTotal: new Prisma.Decimal("100"),
  summary: "香港迪礼 · 主营业务收入", remark: null,
  lines: [
    { lineNo: 1, direction: "debit", subjectKey: "银行存款", subjectLabel: "银行存款", summary: "s", amount: new Prisma.Decimal("100"), currency: "CNY", cashFlowEntryId: "cf-1", bankId: null, subjectId: null, businessSubjectId: null, businessSubjectLabel: null },
    { lineNo: 2, direction: "credit", subjectKey: "损益类/主营业务收入", subjectLabel: "主营业务收入", summary: "s", amount: new Prisma.Decimal("100"), currency: "CNY", cashFlowEntryId: "cf-1", bankId: null, subjectId: null, businessSubjectId: null, businessSubjectLabel: null },
  ],
  ...extra,
});

test("R3-5 用例1：按来源红冲 posted 凭证 → 走既有 reverse，生成 1 张红字、原凭证 reversed", async () => {
  const harness = reverseBySourceHarness({ active: flowVoucher() });
  const result = await harness.service.reverseBySource("cash_flow_entry", "cf-1", "流水冲销：银行退回", { id: "user-1" });

  assert.equal(result.action, "reversed");
  assert.equal(result.voucherNo, "记-2026-11-0001");
  assert.match(result.redVoucherNo, /^记-2026-11-\d{4}$/, "红字凭证号来自既有 reverse 的期间内顺延");
  assert.equal(harness.redCreated.length, 1, "只生成一张红字");
  assert.equal(harness.redCreated[0].sourceType, "voucher", "红字凭证的来源是被红冲的那张凭证");
  assert.equal(harness.redCreated[0].sourceId, "voucher-flow");
  assert.equal(harness.redCreated[0].status, "posted", "红字凭证同事务直接过账");
  assert.equal(harness.updated.find((row) => row.scope === "tx")?.data.status, "reversed", "原凭证置 reversed");
  assert.ok(harness.events.some((args) => args[0] === "voucher.reverse"), "红冲审计照常记");
});

test("R3-5 用例2：来源凭证已红冲 → 幂等返回 null，不重复红冲、不再开红字", async () => {
  const harness = reverseBySourceHarness({ active: flowVoucher({ status: "reversed" }) });
  const result = await harness.service.reverseBySource("cash_flow_entry", "cf-1", "再次冲销", { id: "user-1" });

  assert.equal(result, null);
  assert.equal(harness.redCreated.length, 0, "已红冲行不算有效凭证（activeVoucherOf 排除 reversed）");
  assert.equal(harness.updated.length, 0);
});

test("R3-5 用例4：来源没有凭证 → 返回 null，不报错、不生成红字", async () => {
  const harness = reverseBySourceHarness({ active: null });
  assert.equal(await harness.service.reverseBySource("cash_flow_entry", "cf-1", "无凭证流水冲销", { id: "user-1" }), null);
  assert.equal(harness.redCreated.length, 0);
  assert.equal(harness.updated.length, 0);
});

test("R3-5：来源凭证还是草稿 → 软删作废（草稿不是账务事实），不生成红字", async () => {
  const harness = reverseBySourceHarness({ active: flowVoucher({ status: "draft" }) });
  const result = await harness.service.reverseBySource("cash_flow_entry", "cf-1", "流水冲销", { id: "user-1" });

  assert.equal(result.action, "draft_discarded");
  assert.equal(result.redVoucherNo, null, "草稿没有账务事实，不需要红字对冲");
  assert.equal(harness.redCreated.length, 0);
  assert.ok(harness.updated.some((row) => row.scope === "root" && row.data.deletedAt instanceof Date), "草稿软删");
  assert.ok(harness.events.some((args) => args[0] === "voucher.delete" && args[4]?.auto === true), "作废留审计（auto:true）");
});

test("R3-5：红冲原因必填；sourceId 为空直接幂等返回（不查库、不报错）", async () => {
  const harness = reverseBySourceHarness({ active: flowVoucher() });
  await assert.rejects(
    () => harness.service.reverseBySource("cash_flow_entry", "cf-1", "   ", { id: "user-1" }),
    (error) => error.getResponse().code === "REVERSAL_REASON_REQUIRED",
  );
  assert.equal(await harness.service.reverseBySource("cash_flow_entry", null, "x", { id: "user-1" }), null);
});

// ---------------------------------------------------------------------------
// R3-7 契约 F：自动凭证过账后的「来源流水编辑」护栏（helper 侧）
// ---------------------------------------------------------------------------

test("R3-7：postedVoucherOf 只认「未删 + 已过账」的有效凭证（草稿/已红冲都不算）", async () => {
  const posted = reverseBySourceHarness({ active: flowVoucher() });
  const found = await posted.service.postedVoucherOf("cash_flow_entry", "cf-1");
  assert.equal(found.id, "voucher-flow");
  assert.equal(found.voucherNo, "记-2026-11-0001");

  const draft = reverseBySourceHarness({ active: flowVoucher({ status: "draft" }) });
  assert.equal(await draft.service.postedVoucherOf("cash_flow_entry", "cf-1"), null, "草稿不阻止改流水（改完会作废）");

  const reversed = reverseBySourceHarness({ active: flowVoucher({ status: "reversed" }) });
  assert.equal(await reversed.service.postedVoucherOf("cash_flow_entry", "cf-1"), null, "已红冲不是有效凭证");
});

test("R3-7：discardDraftVoucherOfSource 只作废草稿（软删+审计），已过账/无凭证返回 null", async () => {
  const draft = reverseBySourceHarness({ active: flowVoucher({ status: "draft" }) });
  assert.equal(await draft.service.discardDraftVoucherOfSource("cash_flow_entry", "cf-1", "流水更正", { id: "user-1" }), "记-2026-11-0001");
  assert.ok(draft.updated.some((row) => row.scope === "root" && row.data.deletedAt instanceof Date), "草稿软删");
  assert.ok(draft.events.some((args) => args[0] === "voucher.delete" && args[4]?.because === "source_updated"), "作废理由可追溯");

  const posted = reverseBySourceHarness({ active: flowVoucher() });
  assert.equal(await posted.service.discardDraftVoucherOfSource("cash_flow_entry", "cf-1", "流水更正", { id: "user-1" }), null, "已过账只能红冲，不能作废");
  assert.equal(posted.updated.length, 0);

  const none = reverseBySourceHarness({ active: null });
  assert.equal(await none.service.discardDraftVoucherOfSource("cash_flow_entry", "cf-1", "流水更正", { id: "user-1" }), null);
});


