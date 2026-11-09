// AccountingSubjectCategoryService：会计科目类目（2026-11-07 起类目是一等实体）的维护规则。
// 不连数据库，用手写 Prisma 替身（有状态：create/update/updateMany/delete 会真的改内存里的行，
// 这样「改名级联改全部科目（含软删）」才能被真正验证，而不是只断言调用参数）。
//
// 为什么这一层值得单独测（设计文档 §7）：
//   1. 类目名是科目行的外键语义（字符串），改名必须**原子**级联 —— 半途失败会让科目散落在
//      新旧两个名字下，报表的分类小计被拆成两段；
//   2. 内置五类（资产类/负债类/成本类/所有者权益类/损益类）被三大报表与凭证按名字硬编码匹配，
//      允许改名会让报表静默变成空表；
//   3. 删除必须挡住「还有科目」的类目（含停用科目），否则那些科目会失去所属类目、下拉里选不到。
const assert = require("node:assert/strict");
const { test } = require("node:test");
// 装饰器元数据（路由路径 / 权限）要能读出来，必须先装 reflect-metadata。
require("reflect-metadata");
const { RequestMethod } = require("@nestjs/common");
const { PATH_METADATA, METHOD_METADATA } = require("@nestjs/common/constants");
const { AccountingSubjectCategoryService } = require("../../dist/modules/finance/accounting-subject-category.service.js");
const { AccountingSubjectCategoryController } = require("../../dist/modules/finance/accounting-subject-category.controller.js");
const { ACCOUNTING_SUBJECT_CATEGORIES } = require("../../dist/modules/finance/accounting-subject-catalog.js");
const { REQUIRED_MODULES } = require("../../dist/platform/authorization/require-modules.decorator.js");
const { REQUIRE_ADMINISTRATOR } = require("../../dist/platform/authorization/require-administrator.decorator.js");

const USER = { id: "user-1" };
const AUDIT_TIME = new Date("2026-11-07T00:00:00.000Z");

/** 一条类目表行（默认为内置的「资产类」）。 */
const categoryRow = (overrides = {}) => ({
  id: "cat-1",
  name: "资产类",
  sortOrder: 10,
  isSystem: true,
  createdBy: "user-0",
  updatedBy: "user-0",
  createdAt: AUDIT_TIME,
  updatedAt: AUDIT_TIME,
  ...overrides,
});

/** 一条科目行（类目计数用；`deletedAt` 非空 = 已软删、不参与计数）。 */
const subjectRow = (overrides = {}) => ({ id: "subject-1", category: "资产类", isActive: true, deletedAt: null, ...overrides });

/** 5 个内置类目行（顺序与会计制度一致）。 */
const BUILTIN_ROWS = ACCOUNTING_SUBJECT_CATEGORIES.map((name, index) => categoryRow({ id: `system-${index + 1}`, name, sortOrder: (index + 1) * 10, isSystem: true }));

/**
 * 有状态 Prisma 替身。
 *
 * - `accountingSubjectCategory`：findMany / findUnique / findFirst / create / update / delete；
 * - `accountingSubject`：groupBy（类目计数）/ count（删除守卫）/ updateMany（改名级联）；
 * - `$transaction`：直接以同一个替身执行回调（级联仍要求「先改类目、再改科目」的调用顺序）。
 */
function harness({ categories = BUILTIN_ROWS, subjects = [] } = {}) {
  const state = {
    categories: categories.map((row) => ({ ...row })),
    subjects: subjects.map((row) => ({ ...row }))
  };
  const calls = [];
  const events = [];
  const prisma = {
    accountingSubjectCategory: {
      findMany: async (args) => {
        calls.push({ member: "category.findMany", args });
        return state.categories;
      },
      findUnique: async (args) => {
        calls.push({ member: "category.findUnique", args });
        const where = args?.where ?? {};
        if (typeof where.id === "string") return state.categories.find((row) => row.id === where.id) ?? null;
        return state.categories.find((row) => row.name === where.name) ?? null;
      },
      findFirst: async (args) => {
        calls.push({ member: "category.findFirst", args });
        return [...state.categories].sort((left, right) => right.sortOrder - left.sortOrder)[0] ?? null;
      },
      create: async ({ data }) => {
        calls.push({ member: "category.create", args: { data } });
        const row = { id: `category-new-${state.categories.length + 1}`, ...data };
        state.categories.push(row);
        return row;
      },
      update: async ({ where, data }) => {
        calls.push({ member: "category.update", args: { where, data } });
        const row = state.categories.find((candidate) => candidate.id === where.id);
        Object.assign(row, data);
        return row;
      },
      delete: async ({ where }) => {
        calls.push({ member: "category.delete", args: { where } });
        const index = state.categories.findIndex((candidate) => candidate.id === where.id);
        const [row] = state.categories.splice(index, 1);
        return row;
      }
    },
    accountingSubject: {
      // 与真实 groupBy 同语义：只统计未软删科目；带 isActive 条件时只统计启用中的。
      groupBy: async (args) => {
        calls.push({ member: "subject.groupBy", args });
        const counts = new Map();
        for (const row of state.subjects) {
          if (row.deletedAt !== null) continue;
          if (args?.where?.isActive !== undefined && row.isActive !== args.where.isActive) continue;
          counts.set(row.category, (counts.get(row.category) ?? 0) + 1);
        }
        return [...counts.entries()].map(([category, count]) => ({ category, _count: { _all: count } }));
      },
      count: async (args) => {
        calls.push({ member: "subject.count", args });
        return state.subjects.filter((row) => row.category === args.where.category && row.deletedAt === null).length;
      },
      updateMany: async (args) => {
        calls.push({ member: "subject.updateMany", args });
        let count = 0;
        for (const row of state.subjects) {
          if (row.category !== args.where.category) continue;
          row.category = args.data.category;
          count += 1;
        }
        return { count };
      }
    },
    $transaction: async (callback) => callback(prisma)
  };
  const audit = {
    create: (user) => ({ createdBy: user.id, updatedBy: user.id }),
    update: (user) => ({ updatedBy: user.id }),
    record: async (...args) => {
      events.push(args);
    }
  };
  return { service: new AccountingSubjectCategoryService(prisma, audit), state, calls, events };
}

const membersOf = (calls) => calls.map((call) => call.member);

/* ------------------------------------------------------------------ list */

test("list：内置五类按会计制度顺序、自建按 sortOrder/名称、历史类目最后；并带科目计数", async () => {
  const { service } = harness({
    categories: [
      // 故意把库里的返回顺序打乱（真实 findMany 没有 orderBy 也保证不了制度顺序）。
      categoryRow({ id: "system-5", name: "损益类", sortOrder: 50 }),
      categoryRow({ id: "system-1", name: "资产类", sortOrder: 10 }),
      categoryRow({ id: "custom-b", name: "自建B", sortOrder: 70, isSystem: false }),
      categoryRow({ id: "system-3", name: "成本类", sortOrder: 30 }),
      categoryRow({ id: "custom-a", name: "自建A", sortOrder: 70, isSystem: false }),
      categoryRow({ id: "system-2", name: "负债类", sortOrder: 20 }),
      categoryRow({ id: "system-4", name: "所有者权益类", sortOrder: 40 }),
      categoryRow({ id: "custom-c", name: "共同类", sortOrder: 60, isSystem: false })
    ],
    subjects: [
      subjectRow({ id: "s1", category: "资产类" }),
      subjectRow({ id: "s2", category: "资产类", isActive: false }),
      subjectRow({ id: "s3", category: "资产类" }),
      subjectRow({ id: "s4", category: "损益类" }),
      subjectRow({ id: "s5", category: "共同类" }),
      // 历史类目：科目行上有、类目表里没有（旧备份恢复才会出现）→ 合成 id:null 行排最后。
      subjectRow({ id: "s6", category: "未分类" }),
      subjectRow({ id: "s7", category: "未分类", isActive: false }),
      // 已软删科目不计数。
      subjectRow({ id: "s8", category: "资产类", deletedAt: AUDIT_TIME })
    ]
  });

  const rows = await service.list();

  assert.deepEqual(rows.map((row) => row.name), [
    "资产类",
    "负债类",
    "成本类",
    "所有者权益类",
    "损益类",
    "共同类",
    "自建A",
    "自建B",
    "未分类"
  ], "内置五类按会计制度顺序 → 自建按 sortOrder（同权重再按名称）→ 历史类目最后");
  const assets = rows[0];
  assert.equal(assets.subjectCount, 3, "未软删科目数（含停用）：资产类 3");
  assert.equal(assets.activeSubjectCount, 2, "其中启用中的 2 个");
  const historical = rows.at(-1);
  assert.equal(historical.id, null, "历史类目没有实体行：id 为 null（前端据此不给改名/删除按钮）");
  assert.equal(historical.isSystem, false);
  assert.equal(historical.subjectCount, 2);
  assert.equal(historical.activeSubjectCount, 1);
  assert.equal(historical.createdBy, null);
  assert.equal(historical.updatedAt, null);
  assert.ok(historical.sortOrder > Math.max(...rows.slice(0, -1).map((row) => row.sortOrder)), "合成排序值接在现有最大权重之后（只为类型一致，排序由行位置保证）");
});

test("list：两个 groupBy 的过滤条件分别是「未软删」与「未软删且启用」，不把明细搬回应用层", async () => {
  const { service, calls } = harness({ subjects: [subjectRow()] });
  await service.list();
  const groupBys = calls.filter((call) => call.member === "subject.groupBy").map((call) => call.args);
  assert.deepEqual(groupBys[0].where, { deletedAt: null }, "总数：未软删（含停用）");
  assert.deepEqual(groupBys[0].by, ["category"]);
  assert.deepEqual(groupBys[1].where, { deletedAt: null, isActive: true }, "启用数：其中 isActive");
  assert.deepEqual(groupBys[1].by, ["category"]);
});

/* ------------------------------------------------------------------ create */

test("create：名称 trim、isSystem 恒为 false、默认排序 = 现有最大权重 +10，并写审计事件", async () => {
  const { service, calls, events, state } = harness();
  const row = await service.create({ name: "  共同类  " }, USER);

  const data = calls.find((call) => call.member === "category.create").args.data;
  assert.equal(data.name, "共同类", "名称去空白后落库");
  assert.equal(data.isSystem, false, "用户新建的永远是自建类目");
  assert.equal(data.sortOrder, 60, "内置五类最大 50 → 新类目 60");
  assert.equal(data.createdBy, "user-1");
  assert.equal(data.updatedBy, "user-1");
  assert.equal(row.name, "共同类");
  assert.equal(state.categories.length, 6);
  assert.deepEqual(events[0].slice(0, 4), ["accounting_subject_category.create", "accounting_subject_category", "user-1", "category-new-6"], "审计：动作/实体/人/新 id");
  assert.deepEqual(events[0][4], { name: "共同类", sort_order: 60 });
});

test("create：显式给 sort_order 时不再查最大权重", async () => {
  const { service, calls } = harness();
  await service.create({ name: "共同类", sort_order: 5 }, USER);
  assert.equal(calls.find((call) => call.member === "category.create").args.data.sortOrder, 5);
  assert.equal(calls.filter((call) => call.member === "category.findFirst").length, 0);
});

test("create：重名 422 ACCOUNTING_SUBJECT_CATEGORY_DUPLICATED，且不落库", async () => {
  const { service, calls } = harness();
  await assert.rejects(
    () => service.create({ name: "资产类" }, USER),
    (error) => error.getStatus?.() === 422 && error.getResponse().code === "ACCOUNTING_SUBJECT_CATEGORY_DUPLICATED" && /资产类/.test(error.getResponse().message)
  );
  assert.equal(calls.filter((call) => call.member === "category.create").length, 0, "重名时不落库（撞库层唯一索引会变成财务看不懂的 500）");
});

test("create：名称为空或超长 → 422 ACCOUNTING_SUBJECT_CATEGORY_FIELD_REQUIRED，不落库", async () => {
  for (const name of ["   ", "类".repeat(31)]) {
    const { service, calls } = harness();
    await assert.rejects(
      () => service.create({ name }, USER),
      (error) => error.getStatus?.() === 422 && error.getResponse().code === "ACCOUNTING_SUBJECT_CATEGORY_FIELD_REQUIRED"
    );
    assert.equal(calls.filter((call) => call.member === "category.create").length, 0);
  }
});

/* ------------------------------------------------------------------ update（改名级联 / 内置保护） */

test("update 改名：同一事务里先改类目行、再 updateMany 全部科目（含软删，不带 deletedAt 过滤）", async () => {
  const { service, calls, events, state } = harness({
    categories: [categoryRow({ id: "cat-custom", name: "共同类", sortOrder: 60, isSystem: false })],
    subjects: [
      subjectRow({ id: "s-active", category: "共同类" }),
      subjectRow({ id: "s-deleted", category: "共同类", deletedAt: AUDIT_TIME }),
      subjectRow({ id: "s-other", category: "资产类" })
    ]
  });

  const row = await service.update("cat-custom", { name: "共同类（新）" }, USER);

  assert.deepEqual(membersOf(calls), ["category.findUnique", "category.findUnique", "category.update", "subject.updateMany"], "先取当前行、再查重名，然后事务里改类目 + 级联科目");
  const updateCall = calls.find((call) => call.member === "category.update");
  assert.deepEqual(updateCall.args.where, { id: "cat-custom" });
  assert.equal(updateCall.args.data.name, "共同类（新）");
  assert.equal(updateCall.args.data.updatedBy, "user-1");

  const cascade = calls.find((call) => call.member === "subject.updateMany");
  assert.deepEqual(cascade.args.where, { category: "共同类" }, "级联条件只有旧类目名 —— **不能**加 deletedAt 过滤（科目唯一键不认软删，设计文档 §4.3）");
  assert.equal("deletedAt" in cascade.args.where, false);
  assert.deepEqual(cascade.args.data, { category: "共同类（新）", updatedBy: "user-1" });

  assert.deepEqual(state.subjects.map((subject) => subject.category), ["共同类（新）", "共同类（新）", "资产类"], "软删的那行也必须跟着改名（否则旧名字下留一颗唯一键地雷）");
  assert.equal(row.name, "共同类（新）");

  assert.deepEqual(events[0].slice(0, 4), ["accounting_subject_category.rename", "accounting_subject_category", "user-1", "cat-custom"]);
  assert.deepEqual(events[0][4], {
    before: { name: "共同类", sort_order: 60 },
    after: { name: "共同类（新）", sort_order: 60 },
    affected_subjects: 2
  }, "审计要带 before/after 与受影响科目数（宪法《Reversible Business Changes》）");
});

test("update 改名：撞上已有类目名 → 422，事务一行都不写", async () => {
  const { service, calls } = harness({
    categories: [
      categoryRow({ id: "cat-custom", name: "共同类", sortOrder: 60, isSystem: false }),
      categoryRow({ id: "cat-other", name: "共同类（新）", sortOrder: 70, isSystem: false })
    ]
  });
  await assert.rejects(
    () => service.update("cat-custom", { name: "共同类（新）" }, USER),
    (error) => error.getResponse().code === "ACCOUNTING_SUBJECT_CATEGORY_DUPLICATED"
  );
  assert.equal(calls.filter((call) => call.member === "category.update").length, 0);
  assert.equal(calls.filter((call) => call.member === "subject.updateMany").length, 0);
});

test("update：内置类目改名或改排序 → 422 ACCOUNTING_SUBJECT_CATEGORY_SYSTEM，且不写库", async () => {
  const { service, calls } = harness();
  for (const patch of [{ name: "资产（改名）" }, { sort_order: 99 }]) {
    await assert.rejects(
      () => service.update("system-1", patch, USER),
      (error) => error.getStatus?.() === 422 && error.getResponse().code === "ACCOUNTING_SUBJECT_CATEGORY_SYSTEM" && /内置类目/.test(error.getResponse().message)
    );
  }
  assert.equal(calls.filter((call) => call.member === "category.update").length, 0, "内置类目只读：三大报表按这五个名字取数，改名会让报表静默变空");
});

test("update：什么都没变时直接返回当前行，不写库也不记审计（避免无意义的修改记录）", async () => {
  const { service, calls, events } = harness();
  const row = await service.update("system-1", { name: "资产类", sort_order: 10 }, USER);
  assert.equal(row.id, "system-1");
  assert.equal(calls.filter((call) => call.member === "category.update").length, 0);
  assert.deepEqual(events, []);
});

test("update 只改排序：只 update 类目行、不级联科目，审计记录 update（带前后排序值）", async () => {
  const { service, calls, events } = harness({
    categories: [categoryRow({ id: "cat-custom", name: "共同类", sortOrder: 60, isSystem: false })]
  });
  await service.update("cat-custom", { sort_order: 90 }, USER);
  const updateCall = calls.find((call) => call.member === "category.update");
  assert.deepEqual(updateCall.args.data, { sortOrder: 90, updatedBy: "user-1" });
  assert.equal(calls.filter((call) => call.member === "subject.updateMany").length, 0, "只改排序不动科目");
  assert.deepEqual(events[0].slice(0, 4), ["accounting_subject_category.update", "accounting_subject_category", "user-1", "cat-custom"]);
  assert.deepEqual(events[0][4], { before: { name: "共同类", sort_order: 60 }, after: { name: "共同类", sort_order: 90 } });
});

test("update：不存在的 id → 404 ACCOUNTING_SUBJECT_CATEGORY_NOT_FOUND", async () => {
  const { service } = harness();
  await assert.rejects(() => service.update("cat-missing", { name: "新名字" }, USER), (error) => error.getStatus?.() === 404 && error.getResponse().code === "ACCOUNTING_SUBJECT_CATEGORY_NOT_FOUND");
});

/* ------------------------------------------------------------------ remove */

test("remove：内置类目 → 422 ACCOUNTING_SUBJECT_CATEGORY_SYSTEM（连 count 都不查）", async () => {
  const { service, calls } = harness();
  await assert.rejects(
    () => service.remove("system-1", USER),
    (error) => error.getStatus?.() === 422 && error.getResponse().code === "ACCOUNTING_SUBJECT_CATEGORY_SYSTEM" && /不许删除/.test(error.getResponse().message)
  );
  assert.equal(calls.filter((call) => call.member === "subject.count").length, 0);
});

test("remove：类目下还有未软删科目（含停用）→ 422 且消息写明还有几个，绝不删除", async () => {
  const { service, calls, state } = harness({
    categories: [categoryRow({ id: "cat-custom", name: "共同类", sortOrder: 60, isSystem: false })],
    subjects: [
      subjectRow({ id: "s1", category: "共同类" }),
      subjectRow({ id: "s2", category: "共同类", isActive: false }),
      // 已软删的不挡删除（它已经不在会计科目页上了）。
      subjectRow({ id: "s3", category: "共同类", deletedAt: AUDIT_TIME })
    ]
  });
  await assert.rejects(
    () => service.remove("cat-custom", USER),
    (error) => {
      assert.equal(error.getStatus?.(), 422);
      assert.equal(error.getResponse().code, "ACCOUNTING_SUBJECT_CATEGORY_IN_USE");
      assert.match(error.getResponse().message, /还有 2 个科目/, "消息必须说清还有几个科目，否则财务不知道从哪下手");
      assert.match(error.getResponse().message, /改到其它类目/);
      assert.deepEqual(error.getResponse().details, [{ subject_count: 2 }]);
      return true;
    }
  );
  assert.equal(calls.filter((call) => call.member === "category.delete").length, 0);
  assert.equal(state.categories.length, 1);
});

test("remove：空类目物理删除，并写审计（留类目名，便于追溯删了什么）", async () => {
  const { service, calls, events, state } = harness({
    categories: [
      categoryRow({ id: "system-1", name: "资产类", sortOrder: 10 }),
      categoryRow({ id: "cat-custom", name: "写错的类目", sortOrder: 60, isSystem: false })
    ]
  });
  const row = await service.remove("cat-custom", USER);
  assert.deepEqual(calls.find((call) => call.member === "category.delete").args.where, { id: "cat-custom" });
  assert.equal(row.name, "写错的类目");
  assert.deepEqual(state.categories.map((category) => category.name), ["资产类"], "物理删除：删掉后用同名重新建才可能（软删 + 唯一索引会挡住）");
  assert.deepEqual(events[0].slice(0, 4), ["accounting_subject_category.delete", "accounting_subject_category", "user-1", "cat-custom"]);
  assert.deepEqual(events[0][4], { name: "写错的类目" });

  // 验收里点名的一条：删掉写错的类目后，**可以用同名重新建**（这正是选择物理删除的理由）。
  const rebuilt = await service.create({ name: "写错的类目", sort_order: 60 }, USER);
  assert.equal(rebuilt.name, "写错的类目");
  assert.equal(state.categories.at(-1).name, "写错的类目");
});

test("remove：不存在的 id → 404", async () => {
  const { service } = harness();
  await assert.rejects(() => service.remove("cat-missing", USER), (error) => error.getStatus?.() === 404 && error.getResponse().code === "ACCOUNTING_SUBJECT_CATEGORY_NOT_FOUND");
});

/* ------------------------------------------------------------------ 控制器接线（路由 / 权限） */

test("控制器：/finance/accounting-subject-categories 四个方法，读走 finance 模块权限、写仅管理员", () => {
  const prototype = AccountingSubjectCategoryController.prototype;
  assert.equal(Reflect.getMetadata(PATH_METADATA, AccountingSubjectCategoryController), "finance/accounting-subject-categories");
  assert.deepEqual(Reflect.getMetadata(REQUIRED_MODULES, AccountingSubjectCategoryController), ["finance"], "读走 finance 模块权限（与会计科目主数据同一约定）");

  const readOnly = prototype.list;
  assert.equal(Reflect.getMetadata(METHOD_METADATA, readOnly), RequestMethod.GET);
  assert.equal(Reflect.getMetadata(REQUIRE_ADMINISTRATOR, readOnly), undefined, "读不需要管理员");

  for (const [handler, method] of [[prototype.create, RequestMethod.POST], [prototype.update, RequestMethod.PATCH], [prototype.remove, RequestMethod.DELETE]]) {
    assert.equal(Reflect.getMetadata(METHOD_METADATA, handler), method);
    assert.equal(Reflect.getMetadata(REQUIRE_ADMINISTRATOR, handler), true, "写仅管理员：类目是科目分类的唯一清单，任何客户端都能随便增删会让财务口径不可信");
  }
});
