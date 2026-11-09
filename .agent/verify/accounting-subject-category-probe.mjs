/**
 * 会计科目类目 CRUD —— 独立验证探针（2026-11-07，task-10）。
 *
 * 不复用 api-dev 的单测：**手写 Prisma 替身**直接加载 `apps/api/dist` 的真实 service，
 * 逐条断言 list / create / update / remove 的契约语义，以及科目写入口的类目校验。
 * 同时做迁移 SQL 与 seed 的静态检查（本机无 PostgreSQL，迁移只能静态验证）。
 *
 * 运行：node .agent/verify/accounting-subject-category-probe.mjs
 * 产物：.agent/verify/accounting-subject-category-results.json
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const DIST = path.join(REPO_ROOT, "apps", "api", "dist", "modules", "finance");
const MIGRATION = path.join(REPO_ROOT, "apps", "api", "prisma", "migrations", "20261107200000_accounting_subject_categories", "migration.sql");
const SCHEMA = path.join(REPO_ROOT, "apps", "api", "prisma", "schema.prisma");
const SEED = path.join(REPO_ROOT, "apps", "api", "prisma", "seed.ts");
const RESULTS_JSON = path.join(REPO_ROOT, ".agent", "verify", "accounting-subject-category-results.json");

require("reflect-metadata");
const { RequestMethod } = require("@nestjs/common");
const { PATH_METADATA, METHOD_METADATA } = require("@nestjs/common/constants");
const {
  AccountingSubjectCategoryService
} = require(path.join(DIST, "accounting-subject-category.service.js"));
const { AccountingSubjectService } = require(path.join(DIST, "accounting-subject.service.js"));
const catalog = require(path.join(DIST, "accounting-subject-catalog.js"));
const { AccountingSubjectCategoryController } = require(path.join(DIST, "accounting-subject-category.controller.js"));
const { REQUIRE_ADMINISTRATOR } = require(path.join(REPO_ROOT, "apps/api/dist/platform/authorization/require-administrator.decorator.js"));
const { REQUIRED_MODULES } = require(path.join(REPO_ROOT, "apps/api/dist/platform/authorization/require-modules.decorator.js"));

const CATEGORY_NAMES = [...catalog.ACCOUNTING_SUBJECT_CATEGORIES];
const USER = { id: "user-1", username: "admin", display_name: "管理员" };

// ===========================================================================
// 手写 Prisma 替身
// ===========================================================================
function matches(row, where = {}) {
  for (const [key, condition] of Object.entries(where)) {
    const value = row[key];
    if (condition === null) {
      if (value !== null && value !== undefined) return false;
      continue;
    }
    if (condition instanceof Date) {
      if (value !== condition) return false;
      continue;
    }
    if (condition && typeof condition === "object") {
      if ("not" in condition) {
        if (condition.not === null && (value === null || value === undefined)) return false;
        if (value === condition.not) return false;
        continue;
      }
      throw new Error(`fake prisma: 未支持的 where 条件 ${key}=${JSON.stringify(condition)}`);
    }
    if (value !== condition) return false;
  }
  return true;
}

const clone = (value) => (value === undefined || value === null ? value : JSON.parse(JSON.stringify(value)));
const pick = (row, select) => (row && select ? Object.fromEntries(Object.keys(select).map((key) => [key, row[key]])) : row);

function makeAudit() {
  const events = [];
  return {
    events,
    create: (user) => ({ createdBy: user.id, updatedBy: user.id }),
    update: (user) => ({ updatedBy: user.id }),
    record: async (action, entityType, actorId, entityId, details) => {
      events.push({ action, entityType, actorId, entityId, details });
    }
  };
}

function makePrisma(seed = {}) {
  const calls = [];
  const store = {
    categories: (seed.categories ?? []).map((row) => ({ ...row })),
    subjects: (seed.subjects ?? []).map((row) => ({ ...row }))
  };
  let sequence = 0;
  let depth = 0;
  let transactionId = 0;
  const log = (model, op, args) => calls.push({ model, op, args, inTransaction: depth > 0, transactionId });
  const nextId = (prefix) => `${prefix}-${++sequence}`;

  const categoryModel = {
    findMany: async (args) => {
      log("accountingSubjectCategory", "findMany", args);
      let rows = store.categories.filter((row) => matches(row, args?.where));
      if (args?.orderBy?.sortOrder === "desc") rows = [...rows].sort((left, right) => right.sortOrder - left.sortOrder);
      return clone(rows.map((row) => pick(row, args?.select)));
    },
    findUnique: async (args) => {
      log("accountingSubjectCategory", "findUnique", args);
      return clone(pick(store.categories.find((row) => matches(row, args?.where)), args?.select));
    },
    findFirst: async (args) => {
      log("accountingSubjectCategory", "findFirst", args);
      let rows = store.categories.filter((row) => matches(row, args?.where));
      if (args?.orderBy?.sortOrder === "desc") rows = [...rows].sort((left, right) => right.sortOrder - left.sortOrder);
      return clone(pick(rows[0], args?.select));
    },
    create: async (args) => {
      log("accountingSubjectCategory", "create", args);
      const row = { id: args.data.id ?? nextId("cat-new"), ...args.data };
      store.categories.push(row);
      return clone(row);
    },
    update: async (args) => {
      log("accountingSubjectCategory", "update", args);
      const row = store.categories.find((item) => matches(item, args.where));
      if (!row) throw new Error("fake prisma: category update target missing");
      Object.assign(row, args.data);
      return clone(row);
    },
    delete: async (args) => {
      log("accountingSubjectCategory", "delete", args);
      const index = store.categories.findIndex((item) => matches(item, args.where));
      if (index < 0) throw new Error("fake prisma: category delete target missing");
      const [row] = store.categories.splice(index, 1);
      return clone(row);
    }
  };

  const subjectModel = {
    groupBy: async (args) => {
      log("accountingSubject", "groupBy", args);
      const rows = store.subjects.filter((row) => matches(row, args?.where));
      const groups = new Map();
      for (const row of rows) groups.set(row.category, (groups.get(row.category) ?? 0) + 1);
      return [...groups.entries()].map(([category, count]) => ({ category, _count: { _all: count } }));
    },
    count: async (args) => {
      log("accountingSubject", "count", args);
      return store.subjects.filter((row) => matches(row, args?.where)).length;
    },
    updateMany: async (args) => {
      log("accountingSubject", "updateMany", args);
      let count = 0;
      for (const row of store.subjects) {
        if (!matches(row, args.where)) continue;
        Object.assign(row, args.data);
        count += 1;
      }
      return { count };
    },
    findFirst: async (args) => {
      log("accountingSubject", "findFirst", args);
      let rows = store.subjects.filter((row) => matches(row, args?.where));
      if (args?.orderBy?.sortOrder === "desc") rows = [...rows].sort((left, right) => right.sortOrder - left.sortOrder);
      return clone(pick(rows[0], args?.select));
    },
    findMany: async (args) => {
      log("accountingSubject", "findMany", args);
      return clone(store.subjects.filter((row) => matches(row, args?.where)).map((row) => pick(row, args?.select)));
    },
    create: async (args) => {
      log("accountingSubject", "create", args);
      const row = { id: args.data.id ?? nextId("sub-new"), ...args.data };
      store.subjects.push(row);
      return clone(row);
    },
    update: async (args) => {
      log("accountingSubject", "update", args);
      const row = store.subjects.find((item) => matches(item, args.where));
      if (!row) throw new Error("fake prisma: subject update target missing");
      Object.assign(row, args.data);
      return clone(row);
    }
  };

  const prisma = {
    calls,
    store,
    accountingSubjectCategory: categoryModel,
    accountingSubject: subjectModel,
    $transaction: async (callback) => {
      depth += 1;
      transactionId += 1;
      const currentTransaction = transactionId;
      log("$transaction", "begin", { transactionId: currentTransaction });
      try {
        return await callback(prisma);
      } finally {
        log("$transaction", "end", { transactionId: currentTransaction });
        depth -= 1;
      }
    }
  };
  return prisma;
}

function harness(seed) {
  const prisma = makePrisma(seed);
  const audit = makeAudit();
  return {
    prisma,
    audit,
    categoryService: new AccountingSubjectCategoryService(prisma, audit),
    subjectService: new AccountingSubjectService(prisma, audit)
  };
}

// ---------------------------------------------------------------------------
// 断言收集
// ---------------------------------------------------------------------------
const apiChecks = [];
const migrationChecks = [];
function check(list, name, condition, detail) {
  list.push({ name, ok: Boolean(condition), detail: detail ?? null });
  return Boolean(condition);
}
async function checkThrows(list, name, action, expected) {
  try {
    await action();
  } catch (error) {
    const status = typeof error?.getStatus === "function" ? error.getStatus() : null;
    const response = typeof error?.getResponse === "function" ? error.getResponse() : null;
    const ok = (!expected.status || status === expected.status)
      && (!expected.code || response?.code === expected.code)
      && (!expected.messageIncludes || String(response?.message ?? "").includes(expected.messageIncludes));
    list.push({ name, ok, detail: ok ? null : { status, response, expected } });
    return ok;
  }
  list.push({ name, ok: false, detail: { message: "预期抛错但没有", expected } });
  return false;
}
const callsOf = (prisma, model, op) => prisma.calls.filter((call) => call.model === model && call.op === op);

// ---------------------------------------------------------------------------
// 固定数据：类目表（内置五类 sortOrder 故意打乱，证明排序按会计制度顺序而不是权重）
// ---------------------------------------------------------------------------
const CATEGORY_SEED = [
  { id: "cat-profit", name: "损益类", sortOrder: 50, isSystem: true, createdBy: "u1", updatedBy: "u1", createdAt: "2026-11-07T00:00:00.000Z", updatedAt: "2026-11-07T00:00:00.000Z" },
  { id: "cat-asset", name: "资产类", sortOrder: 50, isSystem: true, createdBy: "u1", updatedBy: "u1", createdAt: "2026-11-07T00:00:00.000Z", updatedAt: "2026-11-07T00:00:00.000Z" },
  { id: "cat-liability", name: "负债类", sortOrder: 30, isSystem: true, createdBy: "u1", updatedBy: "u1", createdAt: "2026-11-07T00:00:00.000Z", updatedAt: "2026-11-07T00:00:00.000Z" },
  { id: "cat-cost", name: "成本类", sortOrder: 20, isSystem: true, createdBy: "u1", updatedBy: "u1", createdAt: "2026-11-07T00:00:00.000Z", updatedAt: "2026-11-07T00:00:00.000Z" },
  { id: "cat-equity", name: "所有者权益类", sortOrder: 10, isSystem: true, createdBy: "u1", updatedBy: "u1", createdAt: "2026-11-07T00:00:00.000Z", updatedAt: "2026-11-07T00:00:00.000Z" },
  // 自建：sortOrder 60/70（都大于内置权重），排序应按 sortOrder 而不是插入顺序
  { id: "cat-custom", name: "共同类", sortOrder: 60, isSystem: false, createdBy: "u1", updatedBy: "u1", createdAt: "2026-11-07T01:00:00.000Z", updatedAt: "2026-11-07T01:00:00.000Z" },
  { id: "cat-custom2", name: "其他类", sortOrder: 70, isSystem: false, createdBy: "u1", updatedBy: "u1", createdAt: "2026-11-07T02:00:00.000Z", updatedAt: "2026-11-07T02:00:00.000Z" }
];

const SUBJECT_SEED = [
  { id: "s1", category: "资产类", name: "库存现金", isActive: true, sortOrder: 10, deletedAt: null },
  { id: "s2", category: "资产类", name: "银行存款", isActive: false, sortOrder: 20, deletedAt: null },
  { id: "s3", category: "共同类", name: "共同-A", isActive: true, sortOrder: 10, deletedAt: null },
  { id: "s4", category: "共同类", name: "共同-B", isActive: true, sortOrder: 20, deletedAt: null },
  // 软删的科目也算「类目被使用」吗？—— 不算（删除守卫只数未软删），但改名级联必须连它一起改（唯一键不认软删）
  { id: "s5", category: "共同类", name: "共同-C（已删）", isActive: true, sortOrder: 30, deletedAt: "2026-11-01T00:00:00.000Z" },
  { id: "s6", category: "未分类", name: "历史科目", isActive: true, sortOrder: 10, deletedAt: null },
  { id: "s7", category: "未分类", name: "历史科目2", isActive: false, sortOrder: 20, deletedAt: null }
];

// ===========================================================================
// 1) list：排序 + 计数 + 历史类目
// ===========================================================================
async function checkList() {
  const { prisma, categoryService } = harness({ categories: CATEGORY_SEED, subjects: SUBJECT_SEED });
  const rows = await categoryService.list();

  check(apiChecks, "list 排序：内置五类按会计制度顺序 → 自建按 sortOrder → 历史类目最后",
    JSON.stringify(rows.map((row) => row.name)) === JSON.stringify(["资产类", "负债类", "成本类", "所有者权益类", "损益类", "共同类", "其他类", "未分类"]),
    rows.map((row) => [row.name, row.sortOrder, row.isSystem, row.id]));
  check(apiChecks, "list 内置五类即使 sortOrder 打乱也按会计制度顺序（不按权重）", rows.slice(0, 5).every((row) => row.isSystem), rows.slice(0, 5).map((row) => [row.name, row.sortOrder]));
  check(apiChecks, "list 自建类目按 sortOrder 升序（共同类 60 < 其他类 70）", rows[5].name === "共同类" && rows[6].name === "其他类", [rows[5].sortOrder, rows[6].sortOrder]);

  const byName = new Map(rows.map((row) => [row.name, row]));
  check(apiChecks, "list subjectCount = 未软删科目数（含停用）：资产类 2 / 共同类 2 / 未分类 2", byName.get("资产类").subjectCount === 2 && byName.get("共同类").subjectCount === 2 && byName.get("未分类").subjectCount === 2, { asset: byName.get("资产类"), custom: byName.get("共同类"), history: byName.get("未分类") });
  check(apiChecks, "list activeSubjectCount = 其中启用：资产类 1 / 共同类 2 / 未分类 1", byName.get("资产类").activeSubjectCount === 1 && byName.get("共同类").activeSubjectCount === 2 && byName.get("未分类").activeSubjectCount === 1, { asset: byName.get("资产类").activeSubjectCount, custom: byName.get("共同类").activeSubjectCount, history: byName.get("未分类").activeSubjectCount });
  check(apiChecks, "list 空类目计数为 0（负债类/成本类/所有者权益类/损益类/其他类）", ["负债类", "成本类", "所有者权益类", "损益类", "其他类"].every((name) => byName.get(name).subjectCount === 0 && byName.get(name).activeSubjectCount === 0), null);
  check(apiChecks, "list 软删科目不计入 subjectCount（共同类 3 个科目里软删 1 → 共 2）", byName.get("共同类").subjectCount === 2, byName.get("共同类"));

  const history = byName.get("未分类");
  check(apiChecks, "list 历史类目 id = null、isSystem = false、审计列为 null", history.id === null && history.isSystem === false && history.createdBy === null && history.createdAt === null, history);
  check(apiChecks, "list 历史类目排在最后（第 8 行）", rows[rows.length - 1].name === "未分类" && rows[rows.length - 1].id === null, rows[rows.length - 1]);
  check(apiChecks, "list 内置类目带出 id / createdBy / createdAt（供响应出口补姓名）", rows[0].id === "cat-asset" && rows[0].createdBy === "u1" && typeof rows[0].createdAt === "string", rows[0]);
  check(apiChecks, "list 三个查询都是计数聚合（1 次类目 findMany + 2 次科目 groupBy）", callsOf(prisma, "accountingSubjectCategory", "findMany").length === 1 && callsOf(prisma, "accountingSubject", "groupBy").length === 2, prisma.calls.map((call) => `${call.model}.${call.op}`));
  const groups = callsOf(prisma, "accountingSubject", "groupBy");
  check(apiChecks, "list 计数查询口径：未软删（deletedAt=null）与其中启用（isActive=true）", JSON.stringify(groups[0].args.where) === JSON.stringify({ deletedAt: null }) && JSON.stringify(groups[1].args.where) === JSON.stringify({ deletedAt: null, isActive: true }) && JSON.stringify(groups[0].args.by) === JSON.stringify(["category"]), groups.map((group) => group.args));

  return rows;
}

// ===========================================================================
// 2) create：默认 sortOrder / 重名 / 空名 / 超长 / 审计
// ===========================================================================
async function checkCreate() {
  {
    const { prisma, audit, categoryService } = harness({ categories: CATEGORY_SEED, subjects: [] });
    const created = await categoryService.create({ name: "  新类目  " }, USER);
    const createCall = callsOf(prisma, "accountingSubjectCategory", "create")[0];
    check(apiChecks, "create 默认 sortOrder = 当前最大值 + 10（70 → 80）", createCall.args.data.sortOrder === 80, createCall.args.data);
    check(apiChecks, "create 落库 isSystem=false、name 已 trim、审计人 = 当前用户", createCall.args.data.isSystem === false && createCall.args.data.name === "新类目" && createCall.args.data.createdBy === USER.id && createCall.args.data.updatedBy === USER.id, createCall.args.data);
    check(apiChecks, "create 返回新建行且写审计 accounting_subject_category.create（含 name/sort_order）", created.name === "新类目" && audit.events.length === 1 && audit.events[0].action === "accounting_subject_category.create" && audit.events[0].entityType === "accounting_subject_category" && audit.events[0].actorId === USER.id && audit.events[0].details.name === "新类目" && audit.events[0].details.sort_order === 80, audit.events);
  }
  {
    const { prisma, categoryService } = harness({ categories: CATEGORY_SEED, subjects: [] });
    await categoryService.create({ name: "显式排序", sort_order: 99 }, USER);
    check(apiChecks, "create 显式 sort_order 原样使用（99），不被默认值覆盖", callsOf(prisma, "accountingSubjectCategory", "create")[0].args.data.sortOrder === 99, callsOf(prisma, "accountingSubjectCategory", "create")[0].args.data);
  }
  {
    const { prisma, categoryService } = harness({ categories: CATEGORY_SEED, subjects: [] });
    await checkThrows(apiChecks, "create 重名 → 422 ACCOUNTING_SUBJECT_CATEGORY_DUPLICATED", () => categoryService.create({ name: "共同类" }, USER), { status: 422, code: "ACCOUNTING_SUBJECT_CATEGORY_DUPLICATED" });
    check(apiChecks, "create 重名时不写库", callsOf(prisma, "accountingSubjectCategory", "create").length === 0, null);
  }
  for (const [label, name] of [["空名", "   "], ["超长", "甲".repeat(31)]]) {
    const { prisma, categoryService } = harness({ categories: CATEGORY_SEED, subjects: [] });
    await checkThrows(apiChecks, `create ${label} → 422 ACCOUNTING_SUBJECT_CATEGORY_FIELD_REQUIRED`, () => categoryService.create({ name }, USER), { status: 422, code: "ACCOUNTING_SUBJECT_CATEGORY_FIELD_REQUIRED" });
    check(apiChecks, `create ${label} 时不写库`, callsOf(prisma, "accountingSubjectCategory", "create").length === 0, null);
  }
}

// ===========================================================================
// 3) update：改名事务级联（含软删）/ 排序 / 内置保护 / 重名 / 404 / no-op
// ===========================================================================
async function checkUpdate() {
  {
    const { prisma, audit, categoryService } = harness({ categories: CATEGORY_SEED, subjects: SUBJECT_SEED });
    const before = prisma.calls.length;
    await categoryService.update("cat-custom", { name: "共同类（新）" }, USER);
    const newCalls = prisma.calls.slice(before);
    const categoryUpdate = newCalls.find((call) => call.model === "accountingSubjectCategory" && call.op === "update");
    const cascade = newCalls.find((call) => call.model === "accountingSubject" && call.op === "updateMany");
    check(apiChecks, "rename：类目行与科目行在同一 $transaction 里更新", categoryUpdate?.inTransaction === true && cascade?.inTransaction === true && categoryUpdate.transactionId === cascade.transactionId, newCalls);
    check(apiChecks, "rename：级联 updateMany 的 where 只有旧类目名（**没有 deletedAt 过滤**）", JSON.stringify(Object.keys(cascade.args.where)) === JSON.stringify(["category"]) && cascade.args.where.category === "共同类", cascade.args.where);
    check(apiChecks, "rename：级联 data = 新类目名 + updatedBy", JSON.stringify(cascade.args.data) === JSON.stringify({ category: "共同类（新）", updatedBy: USER.id }), cascade.args.data);
    const store = prisma.store;
    const affected = [store.subjects.find((row) => row.id === "s3"), store.subjects.find((row) => row.id === "s4"), store.subjects.find((row) => row.id === "s5")];
    check(apiChecks, "rename：级联覆盖全部科目（含软删）——3 行都改成新名，affectedSubjects = 3", affected.every((row) => row.category === "共同类（新）"), affected.map((row) => [row.id, row.category, row.deletedAt]));
    const renameEvent = audit.events.find((event) => event.action === "accounting_subject_category.rename");
    check(apiChecks, "rename 审计：action=.rename、带 before/after 与 affected_subjects=3", Boolean(renameEvent) && renameEvent.details.before.name === "共同类" && renameEvent.details.after.name === "共同类（新）" && renameEvent.details.affected_subjects === 3, renameEvent);
  }
  {
    const { prisma, audit, categoryService } = harness({ categories: CATEGORY_SEED, subjects: SUBJECT_SEED });
    await categoryService.update("cat-custom", { sort_order: 75 }, USER);
    const cascadeCalls = callsOf(prisma, "accountingSubject", "updateMany");
    const updateEvent = audit.events[0];
    check(apiChecks, "只改排序：不级联科目（updateMany 0 次），审计 action=.update 且不带 affected_subjects", cascadeCalls.length === 0 && updateEvent.action === "accounting_subject_category.update" && !("affected_subjects" in updateEvent.details), audit.events);
    check(apiChecks, "只改排序：before/after 的 sort_order 正确", updateEvent.details.before.sort_order === 60 && updateEvent.details.after.sort_order === 75, updateEvent.details);
  }
  {
    const { prisma, audit, categoryService } = harness({ categories: CATEGORY_SEED, subjects: SUBJECT_SEED });
    const current = await categoryService.update("cat-custom", { name: "共同类", sort_order: 60 }, USER);
    const writeCalls = prisma.calls.filter((call) => ["update", "updateMany", "create", "delete", "begin"].includes(call.op));
    check(apiChecks, "no-op（名称与排序都没变）：不写库、不进事务、不记审计（只做一次 get 查询）", writeCalls.length === 0 && audit.events.length === 0 && current.name === "共同类" && prisma.calls.length === 1, { writeCalls, auditEvents: audit.events.length, calls: prisma.calls.map((call) => `${call.model}.${call.op}`) });
  }
  for (const [label, payload] of [["改名", { name: "资产类（改）" }], ["改排序", { sort_order: 15 }]]) {
    const { prisma, categoryService } = harness({ categories: CATEGORY_SEED, subjects: SUBJECT_SEED });
    await checkThrows(apiChecks, `内置类目${label} → 422 ACCOUNTING_SUBJECT_CATEGORY_SYSTEM`, () => categoryService.update("cat-asset", payload, USER), { status: 422, code: "ACCOUNTING_SUBJECT_CATEGORY_SYSTEM" });
    check(apiChecks, `内置类目${label}被拒时不进事务、不写库`, callsOf(prisma, "$transaction", "begin").length === 0 && callsOf(prisma, "accountingSubjectCategory", "update").length === 0, prisma.calls.map((call) => `${call.model}.${call.op}`));
  }
  {
    const { prisma, categoryService } = harness({ categories: CATEGORY_SEED, subjects: SUBJECT_SEED });
    await checkThrows(apiChecks, "rename 撞已有类目名 → 422 ACCOUNTING_SUBJECT_CATEGORY_DUPLICATED", () => categoryService.update("cat-custom2", { name: "共同类" }, USER), { status: 422, code: "ACCOUNTING_SUBJECT_CATEGORY_DUPLICATED" });
    check(apiChecks, "rename 重名时不进事务", callsOf(prisma, "$transaction", "begin").length === 0, null);
    await categoryService.update("cat-custom2", { name: "其他类" }, USER); // 同名 = no-op，不应报错
    check(apiChecks, "rename 到自己当前名字不算重名（no-op 放行）", true, null);
  }
  {
    const { categoryService } = harness({ categories: CATEGORY_SEED, subjects: SUBJECT_SEED });
    await checkThrows(apiChecks, "update 不存在的 id → 404 ACCOUNTING_SUBJECT_CATEGORY_NOT_FOUND", () => categoryService.update("cat-missing", { name: "X" }, USER), { status: 404, code: "ACCOUNTING_SUBJECT_CATEGORY_NOT_FOUND" });
  }
  {
    const { prisma, categoryService } = harness({ categories: CATEGORY_SEED, subjects: SUBJECT_SEED });
    await categoryService.update("cat-custom", { name: "  带空格类目  " }, USER);
    check(apiChecks, "rename 名称 trim 后落库", callsOf(prisma, "accountingSubjectCategory", "update")[0].args.data.name === "带空格类目", callsOf(prisma, "accountingSubjectCategory", "update")[0].args.data);
  }
}

// ===========================================================================
// 4) remove：内置保护 / 有科目 422（含条数）/ 空类目物理删除 / 404
// ===========================================================================
async function checkRemove() {
  {
    const { prisma, categoryService } = harness({ categories: CATEGORY_SEED, subjects: SUBJECT_SEED });
    await checkThrows(apiChecks, "delete 内置类目 → 422 ACCOUNTING_SUBJECT_CATEGORY_SYSTEM", () => categoryService.remove("cat-asset", USER), { status: 422, code: "ACCOUNTING_SUBJECT_CATEGORY_SYSTEM" });
    check(apiChecks, "delete 内置类目被拒时不下发 delete", callsOf(prisma, "accountingSubjectCategory", "delete").length === 0, null);
  }
  {
    const { prisma, audit, categoryService } = harness({ categories: CATEGORY_SEED, subjects: SUBJECT_SEED });
    await checkThrows(apiChecks, "delete 有科目的类目 → 422 ACCOUNTING_SUBJECT_CATEGORY_IN_USE 且 message 含条数 2", () => categoryService.remove("cat-custom", USER), { status: 422, code: "ACCOUNTING_SUBJECT_CATEGORY_IN_USE", messageIncludes: "2 个科目" });
    check(apiChecks, "delete 有科目时不下发 delete（条数按未软删科目算）", callsOf(prisma, "accountingSubjectCategory", "delete").length === 0 && callsOf(prisma, "accountingSubject", "count")[0].args.where.category === "共同类", callsOf(prisma, "accountingSubject", "count"));
    check(apiChecks, "delete 有科目时也不记审计", audit.events.length === 0, audit.events);
  }
  {
    const { prisma, audit, categoryService } = harness({ categories: CATEGORY_SEED, subjects: SUBJECT_SEED });
    const removed = await categoryService.remove("cat-custom2", USER);
    check(apiChecks, "delete 空类目：物理删除（delete where id），返回被删行", callsOf(prisma, "accountingSubjectCategory", "delete").length === 1 && callsOf(prisma, "accountingSubjectCategory", "delete")[0].args.where.id === "cat-custom2" && removed.name === "其他类", null);
    const deleteEvent = audit.events.find((event) => event.action === "accounting_subject_category.delete");
    check(apiChecks, "delete 审计：action=.delete 带类目名与操作人", Boolean(deleteEvent) && deleteEvent.entityId === "cat-custom2" && deleteEvent.actorId === USER.id && deleteEvent.details.name === "其他类", deleteEvent);
  }
  {
    const { categoryService } = harness({ categories: CATEGORY_SEED, subjects: SUBJECT_SEED });
    await checkThrows(apiChecks, "delete 不存在的 id → 404 ACCOUNTING_SUBJECT_CATEGORY_NOT_FOUND", () => categoryService.remove("cat-missing", USER), { status: 404, code: "ACCOUNTING_SUBJECT_CATEGORY_NOT_FOUND" });
  }
}

// ===========================================================================
// 5) 科目写入口的类目校验（accounting-subject.service）
// ===========================================================================
async function checkSubjectWriteGuard() {
  {
    const { prisma, subjectService } = harness({ categories: CATEGORY_SEED, subjects: SUBJECT_SEED });
    await checkThrows(apiChecks, "科目 create：不存在的类目 → 422 ACCOUNTING_SUBJECT_CATEGORY_NOT_FOUND", () => subjectService.create({ category: "不存在类", name: "测试科目" }, USER), { status: 422, code: "ACCOUNTING_SUBJECT_CATEGORY_NOT_FOUND", messageIncludes: "分类「不存在类」不存在" });
    check(apiChecks, "科目 create：类目校验失败时不写科目", callsOf(prisma, "accountingSubject", "create").length === 0, null);
    check(apiChecks, "科目 create：类目校验查的是类目表 name（唯一清单口径）", callsOf(prisma, "accountingSubjectCategory", "findUnique")[0].args.where.name === "不存在类", callsOf(prisma, "accountingSubjectCategory", "findUnique")[0].args);
  }
  {
    const { prisma, audit, subjectService } = harness({ categories: CATEGORY_SEED, subjects: SUBJECT_SEED });
    const created = await subjectService.create({ category: "资产类", name: "新科目" }, USER);
    check(apiChecks, "科目 create：类目存在 → 正常落库（sortOrder 接在同分类最后一个之后 +10 = 30）", created.name === "新科目" && callsOf(prisma, "accountingSubject", "create")[0].args.data.sortOrder === 30 && audit.events.some((event) => event.action === "accounting_subject.create"), { created, create: callsOf(prisma, "accountingSubject", "create")[0].args.data });
  }
  {
    // 历史类目（未分类）上的科目：编辑不换分类 → 不查类目表、放行
    const { prisma, subjectService } = harness({ categories: CATEGORY_SEED, subjects: SUBJECT_SEED });
    const updated = await subjectService.update("s6", { name: "历史科目（改名）" }, USER);
    check(apiChecks, "编辑历史类目上的科目（不改分类）→ 放行，且不查类目表", updated.name === "历史科目（改名）" && updated.category === "未分类" && callsOf(prisma, "accountingSubjectCategory", "findUnique").length === 0, { updated, categoryQueries: callsOf(prisma, "accountingSubjectCategory", "findUnique").length });
  }
  {
    const { prisma, subjectService } = harness({ categories: CATEGORY_SEED, subjects: SUBJECT_SEED });
    await checkThrows(apiChecks, "科目 update：把分类改到不存在的类目 → 422 ACCOUNTING_SUBJECT_CATEGORY_NOT_FOUND", () => subjectService.update("s6", { category: "不存在类" }, USER), { status: 422, code: "ACCOUNTING_SUBJECT_CATEGORY_NOT_FOUND" });
    check(apiChecks, "科目 update：改到不存在类目时不写科目", callsOf(prisma, "accountingSubject", "update").length === 0, null);
    await subjectService.update("s6", { category: "资产类" }, USER);
    check(apiChecks, "科目 update：改到已存在类目 → 放行并写新分类", callsOf(prisma, "accountingSubject", "update")[0].args.data.category === "资产类", callsOf(prisma, "accountingSubject", "update")[0].args.data);
  }
}

// ===========================================================================
// 6) 控制器契约（路由/方法/仅管理员写/读走 finance）
// ===========================================================================
function checkController() {
  const prototype = AccountingSubjectCategoryController.prototype;
  const normalizedPath = (value) => (value === "/" || value === "" ? "" : value);
  check(apiChecks, "控制器：类目路由前缀 = finance/accounting-subject-categories", Reflect.getMetadata(PATH_METADATA, AccountingSubjectCategoryController) === "finance/accounting-subject-categories", Reflect.getMetadata(PATH_METADATA, AccountingSubjectCategoryController));
  check(apiChecks, "控制器：类级权限走 finance 模块", JSON.stringify(Reflect.getMetadata(REQUIRED_MODULES, AccountingSubjectCategoryController)) === JSON.stringify(["finance"]), Reflect.getMetadata(REQUIRED_MODULES, AccountingSubjectCategoryController));
  const routes = [
    ["list", "GET", ""],
    ["create", "POST", ""],
    ["update", "PATCH", ":id"],
    ["remove", "DELETE", ":id"]
  ];
  for (const [handler, method, routePath] of routes) {
    const actualPath = normalizedPath(Reflect.getMetadata(PATH_METADATA, prototype[handler]));
    const actualMethod = Reflect.getMetadata(METHOD_METADATA, prototype[handler]);
    check(apiChecks, `控制器：${handler} = ${method} /${routePath || ""}`, actualPath === routePath && actualMethod === RequestMethod[method], { handler, actualPath, actualMethod });
  }
  check(apiChecks, "控制器：写操作（POST/PATCH/DELETE）仅管理员", Reflect.getMetadata(REQUIRE_ADMINISTRATOR, prototype.create) === true && Reflect.getMetadata(REQUIRE_ADMINISTRATOR, prototype.update) === true && Reflect.getMetadata(REQUIRE_ADMINISTRATOR, prototype.remove) === true, { create: Reflect.getMetadata(REQUIRE_ADMINISTRATOR, prototype.create), update: Reflect.getMetadata(REQUIRE_ADMINISTRATOR, prototype.update), remove: Reflect.getMetadata(REQUIRE_ADMINISTRATOR, prototype.remove) });
  check(apiChecks, "控制器：读列表不要求管理员", Reflect.getMetadata(REQUIRE_ADMINISTRATOR, prototype.list) !== true, Reflect.getMetadata(REQUIRE_ADMINISTRATOR, prototype.list));
}

// ===========================================================================
// 7) 迁移静态检查 + seed 顺序 + schema 一致性
// ===========================================================================
function checkMigration() {
  check(migrationChecks, "迁移文件存在（目录名带 14 位时间戳）", fs.existsSync(MIGRATION) && /\/2026\d{10}_accounting_subject_categories\/migration\.sql$/.test(MIGRATION.replaceAll("\\", "/")), MIGRATION);
  const sql = fs.readFileSync(MIGRATION, "utf8");
  const tableBlock = /CREATE TABLE "accounting_subject_categories" \(([\s\S]*?)\);/.exec(sql)?.[1] ?? "";
  const requiredColumns = [
    ['"id" UUID NOT NULL', /"id"\s+UUID\s+NOT NULL/],
    ['"name" VARCHAR(30) NOT NULL', /"name"\s+VARCHAR\(30\)\s+NOT NULL/],
    ['"sort_order" INTEGER NOT NULL DEFAULT 0', /"sort_order"\s+INTEGER\s+NOT NULL\s+DEFAULT 0/],
    ['"is_system" BOOLEAN NOT NULL DEFAULT false', /"is_system"\s+BOOLEAN\s+NOT NULL\s+DEFAULT false/],
    ['"created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP', /"created_at"\s+TIMESTAMP\(3\)\s+NOT NULL\s+DEFAULT CURRENT_TIMESTAMP/],
    ['"updated_at" TIMESTAMP(3) NOT NULL', /"updated_at"\s+TIMESTAMP\(3\)\s+NOT NULL/],
    ['"created_by" UUID NOT NULL', /"created_by"\s+UUID\s+NOT NULL/],
    ['"updated_by" UUID NOT NULL', /"updated_by"\s+UUID\s+NOT NULL/],
    ['PRIMARY KEY ("id")', /PRIMARY KEY \("id"\)/]
  ];
  for (const [label, pattern] of requiredColumns) check(migrationChecks, `迁移：建表列 ${label}`, pattern.test(tableBlock), tableBlock.slice(0, 400));
  check(migrationChecks, "迁移：name 唯一索引 accounting_subject_categories_name_key", /CREATE UNIQUE INDEX "accounting_subject_categories_name_key"\s+ON "accounting_subject_categories"\("name"\)/.test(sql), null);
  check(migrationChecks, "迁移：sort_order 索引 accounting_subject_categories_sort_order_idx", /CREATE INDEX "accounting_subject_categories_sort_order_idx"\s+ON "accounting_subject_categories"\("sort_order"\)/.test(sql), null);

  const systemNamesMatch = /system_names text\[\]\s*:=\s*ARRAY\[([^\]]+)\]/.exec(sql);
  const sqlSystemNames = systemNamesMatch ? [...systemNamesMatch[1].matchAll(/'([^']+)'/g)].map((match) => match[1]) : [];
  check(migrationChecks, "迁移：5 个内置类目名与顺序 = ACCOUNTING_SUBJECT_CATEGORIES 逐字一致", JSON.stringify(sqlSystemNames) === JSON.stringify(CATEGORY_NAMES), { sqlSystemNames, catalog: CATEGORY_NAMES });
  const systemSortMatch = /system_sort integer\[\]\s*:=\s*ARRAY\[([^\]]+)\]/.exec(sql);
  check(migrationChecks, "迁移：内置类目排序 10/20/30/40/50", systemSortMatch ? JSON.stringify(systemSortMatch[1].split(",").map((value) => Number(value.trim()))) === JSON.stringify([10, 20, 30, 40, 50]) : false, systemSortMatch?.[1]);

  check(migrationChecks, "迁移：回填取 SELECT DISTINCT category FROM accounting_subjects", /SELECT DISTINCT "category" FROM "accounting_subjects"/.test(sql), null);
  check(migrationChecks, "迁移：回填 sort_order 从 60 起、按名称每行 +10", /60 \+ \(row_number\(\) OVER \(ORDER BY legacy\.category\) - 1\) \* 10/.test(sql), null);
  check(migrationChecks, "迁移：回填只插类目表里还没有的名字（NOT EXISTS）且 ON CONFLICT DO NOTHING", /WHERE NOT EXISTS \(\s*SELECT 1 FROM "accounting_subject_categories" existing WHERE existing\."name" = legacy\.category/.test(sql) && /ON CONFLICT \("name"\) DO NOTHING/.test(sql), null);
  check(migrationChecks, "迁移：内置五类先于回填插入", sql.indexOf("unnest(system_names, system_sort)") > 0 && sql.indexOf("unnest(system_names, system_sort)") < sql.indexOf("SELECT DISTINCT \"category\""), null);
  check(migrationChecks, "迁移：空库（无 users）时 RETURN 跳过种入/回填（建表仍执行）", /SELECT "id" INTO actor_id FROM "users" ORDER BY "created_at" LIMIT 1/.test(sql) && /IF actor_id IS NULL THEN\s*\n\s*RETURN;/.test(sql), null);
  check(migrationChecks, "迁移：插入的人使用最早创建的 user（与既有迁移同口径）", /ORDER BY "created_at" LIMIT 1/.test(sql), null);
  check(migrationChecks, "迁移：不加 deleted_at（类目是物理删除）", !/deleted_at/i.test(sql), null);

  // schema.prisma 与迁移一致
  const schema = fs.readFileSync(SCHEMA, "utf8");
  const modelBlock = /model AccountingSubjectCategory \{([\s\S]*?)\n\}/.exec(schema)?.[1] ?? "";
  check(migrationChecks, "schema：model AccountingSubjectCategory 存在且 @@map 正确", modelBlock.length > 0 && /@@map\("accounting_subject_categories"\)/.test(modelBlock), modelBlock.slice(0, 200));
  check(migrationChecks, "schema：name @unique @db.VarChar(30)", /name\s+String\s+@unique\s+@db\.VarChar\(30\)/.test(modelBlock), null);
  check(migrationChecks, "schema：sortOrder @default(0) @map(\"sort_order\")", /sortOrder\s+Int\s+@default\(0\)\s+@map\("sort_order"\)/.test(modelBlock), null);
  check(migrationChecks, "schema：isSystem @default(false) @map(\"is_system\")", /isSystem\s+Boolean\s+@default\(false\)\s+@map\("is_system"\)/.test(modelBlock), null);
  check(migrationChecks, "schema：createdBy/updatedBy 为 UUID、@@index([sortOrder])", /createdBy\s+String\s+@map\("created_by"\)\s+@db\.Uuid/.test(modelBlock) && /updatedBy\s+String\s+@map\("updated_by"\)\s+@db\.Uuid/.test(modelBlock) && /@@index\(\[sortOrder\]\)/.test(modelBlock), null);
  check(migrationChecks, "schema：不设 deletedAt（物理删除）", !/deletedAt/.test(modelBlock), null);

  // seed.ts：类目种入在科目种入之前
  const seed = fs.readFileSync(SEED, "utf8");
  const categoryLoopAt = seed.indexOf("for (const [index, name] of ACCOUNTING_SUBJECT_CATEGORIES.entries())");
  const subjectLoopAt = seed.indexOf("for (const subject of ACCOUNTING_SUBJECT_SEEDS)");
  check(migrationChecks, "seed：类目种入循环在科目种入循环之前", categoryLoopAt > 0 && subjectLoopAt > 0 && categoryLoopAt < subjectLoopAt, { categoryLoopAt, subjectLoopAt });
  check(migrationChecks, "seed：按 name upsert 5 个内置类目、isSystem=true、sortOrder=(index+1)*10", /tx\.accountingSubjectCategory\.upsert\(\{/.test(seed) && /where: \{ name \}/.test(seed) && /sortOrder: \(index \+ 1\) \* 10, isSystem: true/.test(seed), null);
  check(migrationChecks, "seed：导入了 ACCOUNTING_SUBJECT_CATEGORIES 常量（与迁移/目录同一份）", /import \{[^}]*ACCOUNTING_SUBJECT_CATEGORIES[^}]*\} from "\.\.\/src\/modules\/finance\/accounting-subject-catalog"/.test(seed), null);
}

// ===========================================================================
// 主流程
// ===========================================================================
async function main() {
  await checkList();
  await checkCreate();
  await checkUpdate();
  await checkRemove();
  await checkSubjectWriteGuard();
  checkController();
  checkMigration();

  const summarize = (list) => ({ total: list.length, passed: list.filter((item) => item.ok).length, failed: list.filter((item) => !item.ok).length });
  const result = {
    generatedAt: new Date().toISOString(),
    script: path.relative(REPO_ROOT, import.meta.filename),
    distModules: [
      "apps/api/dist/modules/finance/accounting-subject-category.service.js",
      "apps/api/dist/modules/finance/accounting-subject.service.js"
    ],
    summary: { api: summarize(apiChecks), migration: summarize(migrationChecks), total: summarize([...apiChecks, ...migrationChecks]) },
    api: apiChecks,
    migration: migrationChecks
  };
  fs.mkdirSync(path.dirname(RESULTS_JSON), { recursive: true });
  fs.writeFileSync(RESULTS_JSON, JSON.stringify(result, null, 2), "utf8");

  for (const [section, list] of [["API", apiChecks], ["迁移/seed", migrationChecks]]) {
    console.log(`\n=== ${section} ===`);
    for (const item of list) console.log(`${item.ok ? "PASS" : "FAIL"}  ${item.name}${item.ok || item.detail === null ? "" : `  ${JSON.stringify(item.detail).slice(0, 500)}`}`);
  }
  console.log(`\n汇总：API ${result.summary.api.passed}/${result.summary.api.total}（fail ${result.summary.api.failed}）；迁移/seed ${result.summary.migration.passed}/${result.summary.migration.total}（fail ${result.summary.migration.failed}）；合计 ${result.summary.total.passed}/${result.summary.total.total}`);
  console.log(`结果 JSON：${RESULTS_JSON}`);
  if (result.summary.total.failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
