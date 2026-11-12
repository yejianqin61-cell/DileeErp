// 建账期初余额服务的测试（用户 2026-09-24「1,3,4 都要」的第 ③ 件）。
//
// 无可用 PostgreSQL，用手写 Prisma 替身验证服务层规则（谁被写、谁被拦），不验证 SQL。
// 这里钉五件事：
//   ① **整批替换**：这次没出现的旧行要软删、出现的行要 upsert（含把软删的行**恢复**回来 ——
//      唯一索引不区分软删，删了再加同一科目必须走更新）；
//   ② 校验：方向只能是借/贷、金额必须是**正数**（方向决定符号，不写负数）、科目必填；
//   ③ 试算平衡（借/贷合计与差额）随响应回话，但**不强制**（财务可能分批录）；
//   ④ 纯函数：期初行 → 借贷累计（与凭证同型，可直接相加）、两表相加；
//   ⑤ **写入校验科目必须存在**（2026-11-12 R-4 / T10）：不存在 → 422 一行不落库；
//      同名跨分类 → 放行进未归位；已停用 → 放行落主键 + 计数提示。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { Prisma } = require("@prisma/client");
const {
  OpeningBalanceService,
  hasFundOpening,
  mergeBalances,
  openingBalanceTotals,
  openingBalancesToMap,
  resolveOpeningSubjectIds,
} = require("../../dist/modules/finance/opening-balance.service.js");

const audit = () => ({
  create: () => ({ createdBy: "user-1", updatedBy: "user-1" }),
  update: () => ({ updatedBy: "user-1" }),
  softDelete: () => ({ deletedAt: new Date("2026-09-24"), deletedBy: "user-1" }),
  record: async () => {},
});

const USER = { id: "user-1", username: "caiwu", display_name: "小叶" };

/** 期初余额服务替身：记录写入与软删的行。 */
function harness({ existing = [], latest = null, subjects = [] } = {}) {
  const created = [];
  const updated = [];
  const calls = [];
  const tx = {
    // 科目表（2026-11-11 R-1 / T3）：`replaceAll` 写入前先把科目键解析成科目主键。
    // 替身按真实查询同形过滤 —— `name: { in }`、`deletedAt: null`、`isActive` 都照做：
    // 「已删除」必须当成不存在（否则 422 校验会被替身悄悄放过），
    // 「已停用」必须查得出来（否则计数提示永远是 0）。
    accountingSubject: {
      findMany: async (args) => {
        calls.push({ tx: true, table: "accountingSubject", args });
        const where = args?.where ?? {};
        const names = where.name?.in ?? null;
        return subjects.filter((row) =>
          (!names || names.includes(row.name))
          && (where.deletedAt === null ? (row.deletedAt ?? null) === null : true)
          // 库层 `is_active` 默认 true；替身里没写 isActive 的科目就是启用科目。
          && (where.isActive === undefined ? true : (row.isActive ?? true) === where.isActive));
      },
    },
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
    // T10 起写入前要校验科目存在，这一批两行都得先在科目表里。
    subjects: [
      { id: "sub-bank", category: "资产类", name: "银行存款" },
      { id: "sub-payable", category: "负债类", name: "应付账款" },
    ],
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
  const { service } = harness({
    subjects: [
      { id: "sub-bank", category: "资产类", name: "银行存款" },
      { id: "sub-capital", category: "所有者权益类", name: "实收资本" },
    ],
  });
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

test("list() 的出参必须能被 JSON.stringify（BigInt 会让整个 GET 接口 500）", async () => {
  // 事故（2026-09-26）：list() 原先把 `openingBalanceTotals()` 的 BigInt 结果直接回给控制器，
  // express 序列化时抛 `Do not know how to serialize a BigInt` → **GET /finance/opening-balances 整个 500**。
  // 出参金额一律字符串十进制（全站约定），并且整份响应必须过得了 JSON.stringify。
  const { service } = harness({
    latest: { asOfDate: new Date("2026-09-01T00:00:00.000Z") },
    existing: [
      { subjectKey: "资产类/库存现金", subjectLabel: "库存现金", direction: "debit", amount: new Prisma.Decimal("1234.5600"), currency: "CNY" },
      { subjectKey: "负债类/应付账款", subjectLabel: "应付账款", direction: "credit", amount: new Prisma.Decimal("1000.0000"), currency: "CNY" },
    ],
  });
  const result = await service.list({ currency: "CNY" });

  assert.equal(typeof result.totals.debit, "string", "金额出参必须是字符串（BigInt 会 500）");
  assert.equal(typeof result.totals.credit, "string");
  assert.equal(typeof result.totals.difference, "string");
  assert.equal(result.totals.debit, "1234.56");
  assert.equal(result.totals.credit, "1000");
  assert.equal(result.totals.difference, "234.56");
  assert.equal(result.totals.balanced, false);
  assert.equal(typeof result.totals.balanced, "boolean", "balanced 仍是布尔（不要被序列化一起变成字符串）");
  assert.doesNotThrow(() => JSON.stringify(result), "整份响应必须能被 JSON.stringify");

  // 空表（还没有任何期初）这条分支同样要能序列化 —— 它返回的是同一族的 totals。
  const empty = await service.list({ currency: "USD" });
  assert.equal(typeof empty.totals.debit, "string");
  assert.doesNotThrow(() => JSON.stringify(empty));
});

/* ------------------------------------------------- 期初落科目主键（2026-11-11 R-1 / T3） */

// 为什么这组必须钉：期初原本只有文本键，是**唯一一张连科目外键都没有**的业务表。
// 科目一改名，期初就与主数据脱节，报表按名字匹配不上、金额静默消失（诊断 P0-2）。
// 判据是全站同一条：**唯一同名才认**，绝不猜一个科目。
// T10（2026-11-12 R-4）把「查不到」拆成两档：科目不存在 → 422 拦掉，同名跨分类（歧义）→ 留空放行。
// 前者在下面「写入校验」那一组钉住，后者仍是本节这条用例。

const SUBJECTS = [
  { id: "sub-bank", category: "资产类", name: "银行存款" },
  { id: "sub-material", category: "资产类", name: "原材料" },
  { id: "sub-cost", category: "成本类", name: "原材料" },
  { id: "sub-manage", category: "损益类", name: "管理费用" },
];

test("期初落主键：带分类的键按「同分类 + 同名称」命中", async () => {
  const { service, created } = harness({ subjects: SUBJECTS });
  await service.replaceAll({
    as_of_date: "2026-09-01",
    rows: [{ subject_key: "资产类/银行存款", direction: "debit", amount: "100" }],
  }, USER);
  assert.equal(created[0].subjectId, "sub-bank");
});

test("期初落主键：裸名（资金科目老写法）按唯一同名命中", async () => {
  // 历史期初行写的是「银行存款」而不是「资产类/银行存款」：`normalizeSubjectKey` 会先补成
  // 资产类/银行存款，再按同分类命中。裸名与带分类两种写法必须落到同一个科目。
  const { service, created } = harness({ subjects: SUBJECTS });
  await service.replaceAll({
    as_of_date: "2026-09-01",
    rows: [{ subject_key: "银行存款", direction: "debit", amount: "100" }],
  }, USER);
  assert.equal(created[0].subjectId, "sub-bank");
});

test("期初落主键：同名跨分类且没写分类 → 留空并回一条未归位提示（绝不猜）", async () => {
  // 「原材料」在资产类与成本类下各有一个。期初行只写裸名「原材料」时，猜哪条都可能把
  // 一笔资产期初记成成本期初 —— 报表上看不出来。所以留空。
  const { service, created } = harness({ subjects: SUBJECTS });
  const result = await service.replaceAll({
    as_of_date: "2026-09-01",
    rows: [{ subject_key: "原材料", direction: "debit", amount: "100" }],
  }, USER);
  assert.equal(created[0].subjectId, null, "同名跨分类不能猜");
  // 清单里回的是**归一后的键**：`normalizeSubjectKey` 只给「银行存款 / 库存现金」两个资金裸名补分类，
  // 「原材料」保持裸名。财务按这个键能认出自己填的是哪一行。
  assert.deepEqual(result.unassigned, ["原材料"], "要把归不上的键回给界面，财务才知道去补分类");
});

test("期初落主键：写了分类就按分类认，同名跨分类不再是歧义", async () => {
  const { service, created } = harness({ subjects: SUBJECTS });
  const result = await service.replaceAll({
    as_of_date: "2026-09-01",
    rows: [{ subject_key: "成本类/原材料", direction: "debit", amount: "100" }],
  }, USER);
  assert.equal(created[0].subjectId, "sub-cost");
  assert.deepEqual(result.unassigned, []);
});

test("纯解析：id 键原样跳过，不重复解析", () => {
  const resolved = resolveOpeningSubjectIds(
    [{ subjectKey: "@id:sub-bank" }, { subjectKey: "损益类/管理费用" }],
    SUBJECTS,
  );
  assert.equal(resolved.has("@id:sub-bank"), false, "已经是 id 键的行不该被再解析一次");
  assert.equal(resolved.get("损益类/管理费用"), "sub-manage");
});

/* ------------------------------ 写入校验：科目必须存在（2026-11-12 Phase 2 R-4 / T10） */

// 为什么这组必须钉：期初余额是**建账的起点**。写进一个不存在的科目，报表取数时就归不了行，
// 这笔金额直接从报表上消失，而且不报错 —— 与诊断 P0-2 是同一条失败形态。
// 三档判据（任务书 10 §2「已定」）：
//   ① 科目不存在 → **422 拦掉、一行都不落库**（「写错了」）；
//   ② 同名跨分类且没写分类 → 放行 + 未归位清单（「写得不够」，见上面 T3 那组）；
//   ③ 科目存在但已停用 → 放行、照常落主键，但计数提示（历史账上的科目不能拦）。
// T3 当初把「查不到」留空放行；T10 改成 422 —— 留空正是「金额静默消失」那条路。

const DISABLED_SUBJECT = { id: "sub-old", category: "损益类", name: "老科目", isActive: false };

test("写入校验：科目不存在 → 422 拒绝，且一行都不落库、旧行也不动", async () => {
  const { service, created, updated } = harness({
    subjects: SUBJECTS,
    existing: [{ id: "ob-old", subjectKey: "资产类/银行存款", deletedAt: null }],
  });
  await assert.rejects(
    () => service.replaceAll({
      as_of_date: "2026-09-01",
      rows: [
        { subject_key: "资产类/银行存款", direction: "debit", amount: "100" },
        { subject_key: "损益类/老名字", direction: "debit", amount: "50" },
      ],
    }, USER),
    (error) => {
      const response = error.getResponse();
      assert.equal(response.code, "OPENING_SUBJECT_NOT_FOUND");
      assert.match(response.message, /损益类\/老名字/, "要点名是哪个科目对不上");
      assert.match(response.message, /不存在/, "要说清为什么拦：期初是建账起点，收下就从报表消失");
      assert.deepEqual(response.details[0].missing.map((item) => item.subject_key), ["损益类/老名字"], "只报对不上的那一行，能对上的不牵连");
      // 「给出可选科目」（改进计划 R-4 验收）：科目表里现在真能选的科目要一起回话。
      assert.ok(response.details[0].available_subjects.includes("资产类/银行存款"));
      return true;
    },
  );
  assert.equal(created.length, 0, "422 时一行都不能落库");
  assert.equal(updated.length, 0, "旧行也不能动（校验在软删之前，改完再存不会丢已有期初）");
});

test("写入校验：分类写错（同名在别的分类）→ 422，并把同名科目作为可选项回话", async () => {
  const { service } = harness({ subjects: SUBJECTS });
  await assert.rejects(
    () => service.replaceAll({
      as_of_date: "2026-09-01",
      rows: [{ subject_key: "负债类/银行存款", direction: "debit", amount: "100" }],
    }, USER),
    (error) => {
      assert.equal(error.getResponse().code, "OPENING_SUBJECT_NOT_FOUND");
      const miss = error.getResponse().details[0].missing[0];
      assert.deepEqual(miss.candidates.map((item) => `${item.category}/${item.name}`), ["资产类/银行存款"], "同名科目要当可选项给出，财务才知道是漏了分类还是分类写错");
      return true;
    },
  );
});

test("写入校验：科目已停用 → 放行、照常落主键，但提示里带出计数", async () => {
  const { service, created } = harness({ subjects: [...SUBJECTS, DISABLED_SUBJECT] });
  const result = await service.replaceAll({
    as_of_date: "2026-09-01",
    rows: [{ subject_key: "损益类/老科目", direction: "debit", amount: "100" }],
  }, USER);
  assert.equal(created[0].subjectId, "sub-old", "停用科目可能正是历史账上的科目，必须照常落主键");
  assert.deepEqual(result.disabled_subjects, ["损益类/老科目"]);
  assert.deepEqual(result.unassigned, [], "「已停用」不是「归不上」，两件事不能混进同一个清单");
  assert.match(result.warnings.join("；"), /1 个科目已停用/, "提示里要带出计数");
});

test("写入校验：已删除的科目按「不存在」处理（删除与停用是两回事）", async () => {
  const { service, created } = harness({
    subjects: [...SUBJECTS, { id: "sub-gone", category: "损益类", name: "已删科目", deletedAt: new Date("2026-10-01") }],
  });
  await assert.rejects(
    () => service.replaceAll({
      as_of_date: "2026-09-01",
      rows: [{ subject_key: "损益类/已删科目", direction: "debit", amount: "100" }],
    }, USER),
    (error) => error.getResponse().code === "OPENING_SUBJECT_NOT_FOUND",
  );
  assert.equal(created.length, 0, "已删除的科目不能再收进期初");
});

test("写入校验：全部科目都存在且唯一 → 未归位清单为空、也没有停用提示", async () => {
  const { service } = harness({ subjects: SUBJECTS });
  const result = await service.replaceAll({
    as_of_date: "2026-09-01",
    rows: [
      { subject_key: "资产类/银行存款", direction: "debit", amount: "100" },
      { subject_key: "成本类/原材料", direction: "debit", amount: "20" },
      { subject_key: "损益类/管理费用", direction: "debit", amount: "30" },
    ],
  }, USER);
  assert.equal(result.saved, 3);
  assert.deepEqual(result.unassigned, []);
  assert.deepEqual(result.disabled_subjects, []);
  assert.deepEqual(result.warnings, []);
});
