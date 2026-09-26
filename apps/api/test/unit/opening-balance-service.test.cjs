// 建账期初余额服务的测试（用户 2026-09-24「1,3,4 都要」的第 ③ 件）。
//
// 无可用 PostgreSQL，用手写 Prisma 替身验证服务层规则（谁被写、谁被拦），不验证 SQL。
// 这里钉四件事：
//   ① **整批替换**：这次没出现的旧行要软删、出现的行要 upsert（含把软删的行**恢复**回来 ——
//      唯一索引不区分软删，删了再加同一科目必须走更新）；
//   ② 校验：方向只能是借/贷、金额必须是**正数**（方向决定符号，不写负数）、科目必填；
//   ③ 试算平衡（借/贷合计与差额）随响应回话，但**不强制**（财务可能分批录）；
//   ④ 纯函数：期初行 → 借贷累计（与凭证同型，可直接相加）、两表相加。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { Prisma } = require("@prisma/client");
const {
  OpeningBalanceService,
  hasFundOpening,
  mergeBalances,
  openingBalanceTotals,
  openingBalancesToMap,
} = require("../../dist/modules/finance/opening-balance.service.js");

const audit = () => ({
  create: () => ({ createdBy: "user-1", updatedBy: "user-1" }),
  update: () => ({ updatedBy: "user-1" }),
  softDelete: () => ({ deletedAt: new Date("2026-09-24"), deletedBy: "user-1" }),
  record: async () => {},
});

const USER = { id: "user-1", username: "caiwu", display_name: "小叶" };

/** 期初余额服务替身：记录写入与软删的行。 */
function harness({ existing = [], latest = null } = {}) {
  const created = [];
  const updated = [];
  const calls = [];
  const tx = {
    accountingOpeningBalance: {
      findMany: async (args) => { calls.push({ tx: true, args }); return existing; },
      create: async ({ data }) => { created.push(data); return { id: `ob-${created.length}`, ...data }; },
      update: async ({ where, data }) => { updated.push({ id: where.id, data }); return { id: where.id, ...data }; },
    },
  };
  const prisma = {
    accountingOpeningBalance: {
      findMany: async (args) => { calls.push({ tx: false, args }); return existing; },
      findFirst: async () => latest,
    },
    $transaction: async (fn) => fn(tx),
  };
  return { service: new OpeningBalanceService(prisma, audit()), created, updated, calls };
}

test("期初余额：整批替换 —— 新行建、旧行软删、软删过的同一科目被恢复（而不是再插一条）", async () => {
  const { service, created, updated } = harness({
    existing: [
      { id: "ob-old", subjectKey: "资产类/应收账款", deletedAt: null },
      { id: "ob-gone", subjectKey: "资产类/原材料", deletedAt: null },
      { id: "ob-revived", subjectKey: "负债类/应付账款", deletedAt: new Date("2026-09-20") },
    ],
  });
  const result = await service.replaceAll({
    as_of_date: "2026-09-01",
    currency: "CNY",
    rows: [
      { subject_key: "资产类/银行存款", subject_label: "银行存款", direction: "debit", amount: "100000" },
      { subject_key: "负债类/应付账款", subject_label: "应付账款", direction: "credit", amount: "100000" },
    ],
  }, USER);

  assert.equal(result.saved, 2);
  assert.equal(result.removed, 2, "这次没出现的两行（应收账款、原材料）要软删");
  assert.deepEqual(updated.filter((row) => row.data.deletedAt).map((row) => row.id), ["ob-old", "ob-gone"]);
  assert.equal(created.length, 1, "银行存款是新行");
  assert.equal(created[0].asOfDate.toISOString().slice(0, 10), "2026-09-01");
  assert.equal(created[0].subjectLabel, "银行存款");
  assert.equal(created[0].amount.toString(), "100000");
  const revived = updated.find((row) => row.id === "ob-revived");
  assert.ok(revived, "软删过的同一科目必须走 update（唯一索引不区分软删，再插一条会撞索引）");
  assert.equal(revived.data.deletedAt, null, "恢复：deletedAt 清空");
  assert.equal(revived.data.deletedBy, null);
  assert.equal(result.totals.balanced, true, "借 100000 = 贷 100000");
});

test("期初余额：借贷不平**不拦**，但把差额回话（财务可能分批录；报表那边会因为这个数不平）", async () => {
  const { service } = harness();
  const result = await service.replaceAll({
    as_of_date: "2026-09-01",
    rows: [
      { subject_key: "资产类/银行存款", direction: "debit", amount: "100" },
      { subject_key: "所有者权益类/实收资本", direction: "credit", amount: "60" },
    ],
  }, USER);
  assert.equal(result.totals.balanced, false);
  assert.equal(result.totals.difference, 400000n, "差额 40 元（借 100 − 贷 60）");
});

test("期初余额：方向/金额/科目逐行校验（金额必须写正数，符号由借/贷决定）", async () => {
  const { service } = harness();
  await assert.rejects(
    () => service.replaceAll({ as_of_date: "2026-09-01", rows: [{ subject_key: "资产类/银行存款", direction: "借", amount: "1" }] }, USER),
    (error) => error.getResponse().code === "INVALID_OPENING_DIRECTION",
  );
  await assert.rejects(
    () => service.replaceAll({ as_of_date: "2026-09-01", rows: [{ subject_key: "资产类/银行存款", direction: "debit", amount: "-100" }] }, USER),
    (error) => error.getResponse().code === "INVALID_OPENING_AMOUNT",
  );
  await assert.rejects(
    () => service.replaceAll({ as_of_date: "2026-09-01", rows: [{ subject_key: "  ", direction: "debit", amount: "100" }] }, USER),
    (error) => error.getResponse().code === "OPENING_SUBJECT_REQUIRED",
  );
  await assert.rejects(
    () => service.replaceAll({ as_of_date: "2026/09/01", rows: [] }, USER),
    (error) => error.getResponse().code === "INVALID_AS_OF_DATE",
  );
  // 同一科目两行会撞唯一索引 (as_of_date, subject_key, currency)：先拦住并说清是哪个科目。
  await assert.rejects(
    () => service.replaceAll({ as_of_date: "2026-09-01", rows: [
      { subject_key: "资产类/银行存款", direction: "debit", amount: "100" },
      { subject_key: "资产类/银行存款", direction: "debit", amount: "50" },
    ] }, USER),
    (error) => error.getResponse().code === "OPENING_SUBJECT_DUPLICATED" && /资产类\/银行存款/.test(error.getResponse().message),
  );
});

test("期初余额查询：不传日期时取最近一次建账日，并带上试算平衡", async () => {
  const asOfDate = new Date("2026-09-01T00:00:00.000Z");
  const { service } = harness({
    latest: { asOfDate },
    existing: [
      { subjectKey: "资产类/银行存款", direction: "debit", amount: new Prisma.Decimal("100") },
      { subjectKey: "负债类/应付账款", direction: "credit", amount: new Prisma.Decimal("100") },
    ],
  });
  const result = await service.list({});
  assert.equal(result.as_of_date, "2026-09-01");
  assert.equal(result.currency, "CNY", "默认本币");
  assert.equal(result.totals.balanced, true);
  assert.equal(result.rows.length, 2);
});

test("期初余额：没有记录时返回空表（报表那边据此退回银行账户期初兜底）", async () => {
  const { service } = harness({ latest: null });
  const result = await service.list({});
  assert.equal(result.as_of_date, null);
  assert.deepEqual(result.rows, []);
  assert.equal(result.totals.balanced, true, "空表的借/贷合计都是 0，算平");
  assert.equal(await service.effectiveFor("CNY", "2026-09-30"), null);
});

test("期初余额：effectiveForAll 每个币种各取自己的最近建账日（折算要靠它把外币期初一起折进来）", async () => {
  const { service, calls } = harness({
    existing: [
      { currency: "CNY", asOfDate: new Date("2025-12-31T00:00:00.000Z"), subjectKey: "资产类/银行存款", direction: "debit", amount: "1000" },
      { currency: "CNY", asOfDate: new Date("2026-06-30T00:00:00.000Z"), subjectKey: "资产类/银行存款", direction: "debit", amount: "9999" },
      { currency: "USD", asOfDate: new Date("2026-03-31T00:00:00.000Z"), subjectKey: "资产类/银行存款", direction: "debit", amount: "100" },
    ],
  });
  const groups = await service.effectiveForAll("2026-09-30");

  assert.deepEqual(groups.map((group) => [group.currency, group.asOfDate]), [["CNY", "2026-06-30"], ["USD", "2026-03-31"]], "每币种各取最近一次建账日");
  assert.equal(groups[0].rows.length, 1, "只带该建账日的行（不是把同一币种的历史期初全捞回来）");
  assert.equal(groups[0].rows[0].amount, "9999");
  assert.equal(groups[1].rows[0].amount, "100", "外币期初必须能被读到 —— 否则折算时它就凭空消失了");
  // 「不晚于期末」必须下推到 SQL：把未来期间的期初（还没生效）当成已生效，报表会提前带上未来的钱。
  assert.equal(calls[0].args.where.deletedAt, null, "软删的期初不算");
  assert.equal(calls[0].args.where.asOfDate.lte.toISOString().slice(0, 10), "2026-09-30");
});

test("期初余额纯函数：行 → 借贷累计（与凭证同型）、两表相加、货币资金判断", () => {
  const rows = [
    { subjectKey: "资产类/银行存款", direction: "debit", amount: "100" },
    { subjectKey: "资产类/银行存款", direction: "debit", amount: "50" },
    { subjectKey: "负债类/应付账款", direction: "credit", amount: "150" },
  ];
  const map = openingBalancesToMap(rows);
  assert.deepEqual(map.get("资产类/银行存款"), { debit: 1500000n, credit: 0n });
  assert.deepEqual(map.get("负债类/应付账款"), { debit: 0n, credit: 1500000n });

  // 与凭证余额相加：同一科目两边都有时借贷分别累加（报表因此不必知道数据来自哪张表）。
  const merged = mergeBalances(map, new Map([["资产类/银行存款", { debit: 250000n, credit: 0n }]]));
  assert.deepEqual(merged.get("资产类/银行存款"), { debit: 1750000n, credit: 0n });

  assert.equal(hasFundOpening([{ subjectKey: "资产类/银行存款" }]), true);
  assert.equal(hasFundOpening([{ subjectKey: "银行存款" }]), true, "裸名的资金科目也要认（凭证上就是裸名）");
  assert.equal(hasFundOpening([{ subjectKey: "资产类/应收账款" }]), false);
  assert.equal(openingBalanceTotals(rows).difference, 0n);
});
