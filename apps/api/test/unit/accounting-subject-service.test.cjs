// AccountingSubjectService：会计科目的维护规则（不连数据库，用手写 Prisma 替身）。
//
// 为什么这一层值得单独测：2026-09-17 起「会计科目」是全站财务口径的**唯一来源** ——
// 收支流水、客户收款、供应商付款、应收/应付对账上的分类全部指向它。
// 因此三条约束一旦写坏，坏的不是一个页面，而是所有报表与凭证：
//   1. 只停用不删除：科目被流水引用后必须留成历史快照，删掉会让历史凭证指到不存在的科目；
//   2. 停用的**仍要能显示**（include_inactive），否则历史流水上的科目名会消失；
//   3. 分类允许出现 5 类之外的取值（迁移把归类不了的旧项目并入「未分类」），硬挡掉等于丢掉已记过的分类。
const assert = require("node:assert/strict");
const test = require("node:test");
const { AccountingSubjectService } = require("../../dist/modules/finance/accounting-subject.service.js");
const { ACCOUNTING_SUBJECT_CATEGORIES } = require("../../dist/modules/finance/accounting-subject-catalog.js");

const USER = { id: "user-1" };

const subjectRow = (overrides = {}) => ({
  id: "subject-1",
  category: "损益类",
  name: "主营业务收入",
  balanceDirection: "借",
  sortOrder: 770,
  isActive: true,
  deletedAt: null,
  deletedBy: null,
  ...overrides,
});

/**
 * 记账式 Prisma 替身：会计科目表 + 五张引用表 + 审计事件。
 *
 * 三种 `accountingSubject.findFirst` 的调用形状不同，替身按 where 区分：
 *   - 带 `name`：唯一性检查（`assertUnique`，**连软删的科目一起查**，见那里的注释）；
 *   - 带字符串 `id`：`get(id)`；
 *   - 其余：`nextSortOrder` 的「取本分类最大 sortOrder」（分类下没有科目时还有一次全局查询）。
 */
function harness({ subjects = [], duplicate = undefined, maxSortOrder = null, usage = {} } = {}) {
  const calls = { findMany: [], findFirst: [], create: [], update: [], count: [] };
  const events = [];
  const prisma = {
    accountingSubject: {
      // 替身照做 `distinct`：`categories()` 靠库层去重，替身不去重就会把「未分类」数出两行。
      findMany: async (args) => {
        calls.findMany.push(args);
        const fields = args?.distinct ?? [];
        if (!fields.length) return subjects;
        return subjects.filter((row, index) => subjects.findIndex((other) => fields.every((field) => other[field] === row[field])) === index);
      },
      findFirst: async (args) => {
        calls.findFirst.push(args);
        const where = args?.where ?? {};
        if (where.name !== undefined) return duplicate ?? null;
        if (typeof where.id === "string") return subjects.find((row) => row.id === where.id) ?? null;
        // nextSortOrder：先按分类查（该分类下没有科目时返回 null），再退到全局查。替身如实照做 ——
        // 「新分类的第一个科目接在全局最后」这条路径只有分类查询真的返回 null 才会走到。
        if (where.category !== undefined) {
          const pool = subjects.filter((row) => row.category === where.category && row.deletedAt === null);
          if (!pool.length) return null;
          return { sortOrder: pool.reduce((max, row) => Math.max(max, row.sortOrder), 0) };
        }
        return maxSortOrder === null ? null : { sortOrder: maxSortOrder };
      },
      create: async ({ data }) => { calls.create.push(data); return { id: "subject-new", ...data }; },
      update: async ({ where, data }) => {
        calls.update.push({ where, data });
        return { ...(subjects.find((row) => row.id === where.id) ?? {}), ...data, id: where.id };
      },
    },
    cashFlowEntry: { count: async (args) => { calls.count.push({ table: "cashFlowEntry", ...args }); return usage.cashFlowEntry ?? 0; } },
    customerPayment: { count: async (args) => { calls.count.push({ table: "customerPayment", ...args }); return usage.customerPayment ?? 0; } },
    supplierPayment: { count: async (args) => { calls.count.push({ table: "supplierPayment", ...args }); return usage.supplierPayment ?? 0; } },
    receivableReconciliation: { count: async (args) => { calls.count.push({ table: "receivableReconciliation", ...args }); return usage.receivableReconciliation ?? 0; } },
    supplierPayableReconciliation: { count: async (args) => { calls.count.push({ table: "supplierPayableReconciliation", ...args }); return usage.supplierPayableReconciliation ?? 0; } },
  };
  const audit = {
    create: (user) => ({ createdBy: user.id, updatedBy: user.id }),
    update: (user) => ({ updatedBy: user.id }),
    softDelete: (user) => ({ deletedAt: new Date("2026-09-17T00:00:00.000Z"), deletedBy: user.id, updatedBy: user.id }),
    record: async (...args) => { events.push(args); },
  };
  return { service: new AccountingSubjectService(prisma, audit), calls, events };
}

/* ------------------------------------------------------------------ list / categories */

test("list：默认只给「未删除 + 启用」的科目，并按「分类 → sortOrder → 名称」统一排序", async () => {
  // 分类顺序必须由服务层保证：库层 `orderBy: sortOrder` 做不到 —— 财务在「资产类」下新增的科目
  // 拿到的是本分类内较大的 sortOrder，但只要它大于损益类的科目，按 sortOrder 排就会跑到损益类后面，
  // 于是「资产类」被拆成两段（收支汇总表的分类小计会因此出现两行）。
  const rows = [
    subjectRow({ id: "subject-a", name: "库存现金（备用金）", category: "资产类", sortOrder: 10 }),
    subjectRow({ id: "subject-c", name: "加工费", category: "成本类", sortOrder: 1300 }),
    subjectRow({ id: "subject-b", name: "主营业务收入", category: "损益类", sortOrder: 770 }),
    subjectRow({ id: "subject-x", name: "展会物料费", category: "未分类", sortOrder: 1400 }),
  ];
  const { service, calls } = harness({ subjects: [...rows] });
  const result = await service.list();
  assert.deepEqual(result.map((row) => row.id), ["subject-a", "subject-c", "subject-b", "subject-x"], "分类按科目表顺序（资产类→成本类→损益类→未分类），同分类内才看 sortOrder");
  assert.deepEqual(calls.findMany[0].where, { deletedAt: null, isActive: true }, "下拉框只给能选的：软删与停用都不给");
  assert.equal(calls.findMany[0].orderBy, undefined, "顺序在服务层用统一比较器算，不依赖库层 orderBy（库层排不出「分类优先」）");
});

test("list 排序：同分类内按 sortOrder，sortOrder 相同时按名称（结果确定，不随查询计划漂移）", async () => {
  const rows = [
    subjectRow({ id: "b", name: "银行存款", category: "资产类", sortOrder: 20 }),
    subjectRow({ id: "a", name: "库存现金（备用金）", category: "资产类", sortOrder: 20 }),
    subjectRow({ id: "c", name: "应收账款", category: "资产类", sortOrder: 30 }),
  ];
  const { service } = harness({ subjects: [...rows] });
  assert.deepEqual((await service.list()).map((row) => row.id), ["a", "b", "c"]);
});

test("list({includeInactive:true})：保留停用科目，但软删的仍然不给", async () => {
  const rows = [subjectRow(), subjectRow({ id: "subject-off", name: "房租费", category: "成本类", isActive: false })];
  const { service, calls } = harness({ subjects: rows });
  const result = await service.list({ includeInactive: true });
  assert.deepEqual(result, rows, "停用科目必须还能查出来（历史流水上还挂着它们的名字）");
  assert.deepEqual(calls.findMany[0].where, { deletedAt: null }, "去掉了 isActive 限制，但 deletedAt 仍必须是 null");
  assert.equal(calls.findMany[0].where.isActive, undefined, "软删的科目在任何模式下都不出现");
});

test("list({category})：分类筛选下推到库，且与 includeInactive 可以叠加", async () => {
  const { service, calls } = harness({ subjects: [subjectRow()] });
  await service.list({ category: "成本类" });
  assert.deepEqual(calls.findMany[0].where, { deletedAt: null, isActive: true, category: "成本类" });
  await service.list({ includeInactive: true, category: "未分类" });
  assert.deepEqual(calls.findMany[1].where, { deletedAt: null, category: "未分类" }, "「未分类」是迁移兜底出来的真实分类，必须能筛");
});

test("categories：5 类科目类别在前（按科目表顺序），库里多出来的分类去重后排在后面", async () => {
  // 迁移会把对照表覆盖不到的自定义旧项目并入「未分类」，只有这 5 类会让那些科目在筛选里选不出来。
  const { service, calls } = harness({
    subjects: [{ category: "未分类" }, { category: "损益类" }, { category: "未分类" }, { category: "资产类" }],
  });
  const categories = await service.categories();
  assert.deepEqual(categories.slice(0, 5), [...ACCOUNTING_SUBJECT_CATEGORIES], "固定的 5 类必须排在前面且顺序稳定");
  assert.deepEqual(categories.slice(5), ["未分类"], "库里的额外分类去重后附在后面");
  assert.equal(categories.length, 6, "「未分类」出现两次也只有一个");
  assert.deepEqual(calls.findMany[0].where, { deletedAt: null }, "软删科目的分类不该出现在筛选里");
  assert.deepEqual(calls.findMany[0].select, { category: true });
  assert.deepEqual(calls.findMany[0].distinct, ["category"]);
});

/* ------------------------------------------------------------------ create */

test("create：分类与项目名去空白后落库，余额方向照存，并写审计事件", async () => {
  const { service, calls, events } = harness({ subjects: [subjectRow({ id: "subject-same-category", category: "损益类", sortOrder: 120 })] });
  const row = await service.create({ category: "  损益类  ", name: "  主营业务收入  ", balance_direction: "借" }, USER);
  const data = calls.create[0];
  assert.equal(data.category, "损益类");
  assert.equal(data.name, "主营业务收入");
  assert.equal(data.balanceDirection, "借");
  assert.equal(data.sortOrder, 130, "新科目接在本分类最后一个科目之后（本分类最大 sortOrder + 10）");
  assert.equal(data.createdBy, "user-1");
  assert.equal(data.updatedBy, "user-1");
  assert.equal(row.id, "subject-new");
  assert.deepEqual(events[0][0], "accounting_subject.create");
  assert.deepEqual(events[0].slice(1, 5), ["accounting_subject", "user-1", "subject-new", { category: "损益类", name: "主营业务收入" }], "审计事件记录动作/实体/人/新 id/前后值");
  // 排序号必须是**本分类内**的最大值：取全局最大值会让新科目排到别的分类后面（见 list 的注释）。
  assert.deepEqual(calls.findFirst.at(-1), { where: { category: "损益类", deletedAt: null }, orderBy: { sortOrder: "desc" }, select: { sortOrder: true } }, "排序号取的是本分类未删除科目的最大值");
});

test("create：显式给 sort_order 时不再查最大排序号", async () => {
  const { service, calls } = harness({ maxSortOrder: 120 });
  await service.create({ category: "成本类", name: "加工费", sort_order: 5 }, USER);
  assert.equal(calls.create[0].sortOrder, 5);
  assert.equal(calls.findFirst.filter((args) => args?.where?.name === undefined).length, 0, "给了排序号就不该再发「取最大 sortOrder」的查询");
});

test("create：不填余额方向存 null（不是空串，也不是瞎猜一个方向）", async () => {
  const { service, calls } = harness({ maxSortOrder: 0 });
  await service.create({ category: "损益类", name: "主营业务收入" }, USER);
  assert.equal(calls.create[0].balanceDirection, null);
  const blank = harness({ maxSortOrder: 0 });
  await blank.service.create({ category: "损益类", name: "主营业务收入", balance_direction: "   " }, USER);
  assert.equal(blank.calls.create[0].balanceDirection, null, "空串与不填同义：清空方向");
});

test("create：余额方向只能是「借」或「贷」，其它取值一律 422", async () => {
  const { service, calls } = harness({ maxSortOrder: 0 });
  await assert.rejects(
    () => service.create({ category: "损益类", name: "主营业务收入", balance_direction: "借方" }, USER),
    (error) => error.getResponse().code === "ACCOUNTING_SUBJECT_DIRECTION_INVALID" && /借.*贷/.test(error.getResponse().message),
    "放开成任意字符串的话，将来靠它判断科目自然余额方向时已经不知道是谁写坏的",
  );
  assert.deepEqual(calls.create, [], "被拦下时不得落库");
});

test("create：分类与项目名必填（只有空白也算空）", async () => {
  for (const [body, label] of [[{ category: "   ", name: "主营业务收入" }, "分类"], [{ category: "损益类", name: "  " }, "项目名称"]]) {
    const { service, calls } = harness({ maxSortOrder: 0 });
    await assert.rejects(
      () => service.create(body, USER),
      (error) => error.getResponse().code === "ACCOUNTING_SUBJECT_FIELD_REQUIRED" && error.getResponse().message.includes(label),
      `${label} 必填`,
    );
    assert.deepEqual(calls.create, []);
  }
});

test("create：同分类下重名 422（与库层 @@unique([category, name]) 同一口径）", async () => {
  const { service, calls } = harness({ duplicate: { id: "subject-other" }, maxSortOrder: 0 });
  await assert.rejects(
    () => service.create({ category: "损益类", name: "主营业务收入" }, USER),
    (error) => error.getResponse().code === "ACCOUNTING_SUBJECT_DUPLICATED" && error.getResponse().message.includes("主营业务收入"),
  );
  assert.deepEqual(calls.create, [], "重名时不落库（否则库层报的是唯一约束错，财务看不懂）");
  // 唯一性必须**连软删的科目一起查**：库层 @@unique([category, name]) 不认 deleted_at，
  // 只查「未删除」会放过「删掉再同名新建」，然后在库里炸成 500。
  assert.deepEqual(calls.findFirst[0].where, { category: "损益类", name: "主营业务收入" }, "唯一性检查覆盖已软删的科目（与库层唯一键同一口径）");
});

test("create：撞上「已软删」的同名科目也拦下，并说明名称仍被占用（而不是放过去撞库层唯一索引变 500）", async () => {
  const { service, calls } = harness({ duplicate: { id: "subject-deleted", deletedAt: new Date("2026-09-17T00:00:00.000Z") }, maxSortOrder: 0 });
  await assert.rejects(
    () => service.create({ category: "损益类", name: "主营业务收入" }, USER),
    (error) => error.getResponse().code === "ACCOUNTING_SUBJECT_DUPLICATED" && /已删除/.test(error.getResponse().message),
    "库层唯一键不认 deleted_at：这里必须提前拦住，并说清楚「名称仍被占用」",
  );
  assert.deepEqual(calls.create, [], "被拦下时不落库");
});

test("create：本分类还没有科目时，排序号退到全局最后（靠分类权重把新分类排到末尾）", async () => {
  const { service, calls } = harness({ subjects: [subjectRow({ id: "subject-last", category: "损益类", sortOrder: 1210 })], maxSortOrder: 1210 });
  await service.create({ category: "新分类", name: "展会物料费" }, USER);
  assert.deepEqual(calls.findFirst.map((args) => args.where), [
    { category: "新分类", name: "展会物料费" },
    { category: "新分类", deletedAt: null },
    { deletedAt: null },
  ], "先按本分类查（空），再退到全局查");
  assert.equal(calls.create[0].sortOrder, 1220);
});

/* ------------------------------------------------------------------ get / update */

test("get：不存在的科目 404，而不是返回一个看起来正常的空对象", async () => {
  const { service } = harness({ subjects: [] });
  await assert.rejects(() => service.get("subject-missing"), (error) => error.getResponse().code === "ACCOUNTING_SUBJECT_NOT_FOUND");
});

test("update：改名撞上同分类的另一个科目 → 422，且不写库", async () => {
  const current = subjectRow();
  const { service, calls } = harness({ subjects: [current], duplicate: { id: "subject-other" } });
  await assert.rejects(
    () => service.update("subject-1", { name: "管理费用" }, USER),
    (error) => error.getResponse().code === "ACCOUNTING_SUBJECT_DUPLICATED" && error.getResponse().message.includes("管理费用"),
  );
  assert.equal(calls.update.length, 0, "重名被拦下时不能改动原科目");
  assert.deepEqual(calls.findFirst[1].where, { category: "损益类", name: "管理费用", id: { not: "subject-1" } }, "唯一性检查要排除自己，并覆盖已软删的科目");
});

test("update：名字与分类都没变时不做唯一性查询（改个排序号不该被自己的名字挡住）", async () => {
  const current = subjectRow();
  const { service, calls } = harness({ subjects: [current] });
  await service.update("subject-1", { name: "主营业务收入", sort_order: 800 }, USER);
  assert.equal(calls.findFirst.length, 1, "只有 get(id) 一次查询：名字没变就不必查唯一性");
  assert.equal(calls.update[0].data.sortOrder, 800);
});

test("update：可以换分类、可以清空余额方向、可以停用，并记录前后值审计", async () => {
  const current = subjectRow();
  const { service, calls, events } = harness({ subjects: [current] });
  await service.update("subject-1", { category: "成本类", balance_direction: "", is_active: false }, USER);
  const data = calls.update[0].data;
  assert.equal(data.category, "成本类");
  assert.equal(data.name, "主营业务收入", "没给名字就保持原值");
  assert.equal(data.balanceDirection, null, "空串 = 清空方向（不是写一个空字符串进库）");
  assert.equal(data.isActive, false, "停用而不是删除");
  assert.equal(data.sortOrder, undefined, "没给排序号就不动");
  assert.equal(data.updatedBy, "user-1");
  assert.deepEqual(events[0][0], "accounting_subject.update");
  assert.deepEqual(events[0][4], {
    before: { category: "损益类", name: "主营业务收入", is_active: true },
    after: { category: "成本类", name: "主营业务收入", is_active: false },
  }, "审计要留住改前改后（宪法《Reversible Business Changes》）");
});

test("update：余额方向非法与 rename 非法用同一套校验", async () => {
  const { service, calls } = harness({ subjects: [subjectRow()] });
  await assert.rejects(
    () => service.update("subject-1", { balance_direction: "双方" }, USER),
    (error) => error.getResponse().code === "ACCOUNTING_SUBJECT_DIRECTION_INVALID",
  );
  assert.equal(calls.update.length, 0);
});

/* ------------------------------------------------------------------ remove / usageCount */

test("usageCount：五张引用表的计数相加（少算一张就会删掉还在用的科目）", async () => {
  const { service, calls } = harness({
    subjects: [subjectRow()],
    usage: { cashFlowEntry: 2, customerPayment: 3, supplierPayment: 4, receivableReconciliation: 5, supplierPayableReconciliation: 6 },
  });
  assert.equal(await service.usageCount("subject-1"), 20);
  assert.deepEqual(
    calls.count.map((call) => call.table).sort(),
    ["cashFlowEntry", "customerPayment", "receivableReconciliation", "supplierPayableReconciliation", "supplierPayment"],
  );
  for (const call of calls.count) assert.deepEqual(call.where, { subjectId: "subject-1" });
});

test("remove：被业务单据引用时 422 且绝不软删（删了历史凭证就指向不存在的科目）", async () => {
  const { service, calls } = harness({ subjects: [subjectRow()], usage: { cashFlowEntry: 1 } });
  await assert.rejects(
    () => service.remove("subject-1", USER),
    (error) => error.getResponse().code === "ACCOUNTING_SUBJECT_IN_USE" && /停用/.test(error.getResponse().message),
  );
  assert.deepEqual(calls.update, [], "被引用时必须连软删都不做");
});

test("remove：没被引用时软删（置 deletedAt/deletedBy）并写审计", async () => {
  const { service, calls, events } = harness({ subjects: [subjectRow()] });
  const row = await service.remove("subject-1", USER);
  assert.deepEqual(calls.update[0].where, { id: "subject-1" });
  assert.ok(calls.update[0].data.deletedAt instanceof Date, "软删写 deletedAt");
  assert.equal(calls.update[0].data.deletedBy, "user-1");
  assert.equal(calls.update[0].data.updatedBy, "user-1");
  assert.equal(row.deletedBy, "user-1");
  assert.deepEqual(events[0][0], "accounting_subject.delete");
  assert.deepEqual(events[0].slice(1, 5), ["accounting_subject", "user-1", "subject-1", { category: "损益类", name: "主营业务收入" }]);
});

test("remove：科目不存在时 404（不静默当成「删成功」）", async () => {
  const { service, calls } = harness({ subjects: [] });
  await assert.rejects(() => service.remove("subject-missing", USER), (error) => error.getResponse().code === "ACCOUNTING_SUBJECT_NOT_FOUND");
  assert.deepEqual(calls.count, [], "都找不到科目就不必再去数引用");
  assert.deepEqual(calls.update, []);
});
