// ModulePermissionGuard 单元测试。
//
// 为什么补这一块：recon 指出该守卫被 **34 个控制器**使用，却**全仓库零测试**，
// 且不存在任何 403 / 模块隔离用例 —— 权限矩阵是整个后端最宽、最无人看守的表面
// （见 docs/test/00-recon-backend-coverage.md D6）。
//
// 这里用假的 Reflector 与假 Prisma 覆盖守卫的**全部求值分支**，包括最容易踩错的
// 「方法级只覆盖同一种元数据」语义（module-permission.guard.ts:14-27）：
//   - 类级 @RequireModules("X") + 方法级 @RequireModules("Y")  → 只用 Y（覆盖）
//   - 类级 @RequireModules("X") + 方法级 @RequireAnyModules(Y,Z) → X 与 (Y|Z) **同时**生效（AND）
// 第二条是常见误解，代码注释在 master-data-read.controller.ts:12-18 也专门记录了它。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { ModulePermissionGuard, isAdministratorEquivalent } = require("../../dist/platform/authorization/module-permission.guard.js");
const { REQUIRED_MODULES } = require("../../dist/platform/authorization/require-modules.decorator.js");
const { REQUIRED_ANY_MODULES } = require("../../dist/platform/authorization/require-any-modules.decorator.js");
const { REQUIRE_ADMINISTRATOR } = require("../../dist/platform/authorization/require-administrator.decorator.js");

/**
 * 假的 Reflector：按 metadata key 返回预设值。
 * 同时验证守卫**确实调用** getAllAndOverride 且传 [handler, class]（而不是只取一层）。
 */
function fakeReflector(metadata = {}) {
  const calls = [];
  return {
    calls,
    getAllAndOverride(key, targets) {
      calls.push({ key, targets });
      return metadata[key];
    },
  };
}

/** 假的 PrismaService：只实现守卫用到的 userRole.findMany。 */
function fakePrisma(roles = []) {
  const queries = [];
  return {
    queries,
    userRole: {
      async findMany(args) {
        queries.push(args);
        return roles;
      },
    },
  };
}

/** 假的 ExecutionContext：handler/class 用普通函数与类表示。 */
function fakeContext(currentUser) {
  class Handler {}
  class Controller {}
  return {
    getClass: () => Controller,
    getHandler: () => Handler,
    switchToHttp: () => ({ getRequest: () => ({ currentUser }) }),
  };
}

const role = (key, moduleKeys = []) => ({ role: { deletedAt: null, key, permissions: moduleKeys.map((moduleKey) => ({ moduleKey })) } });

const guardFor = (metadata, roles = []) => {
  const reflector = fakeReflector(metadata);
  const prisma = fakePrisma(roles);
  return { guard: new ModulePermissionGuard(reflector, prisma), prisma, reflector };
};

test("module permission guard: no permission metadata means the route only requires authentication", async () => {
  const { guard, prisma, reflector } = guardFor({});
  assert.equal(await guard.canActivate(fakeContext({ id: "u-1" })), true);
  // 未声明任何要求时不得查库 —— 否则每个无装饰器端点都会多打一次 DB
  assert.equal(prisma.queries.length, 0);
  assert.deepEqual(reflector.calls.map((call) => call.key), [REQUIRED_MODULES, REQUIRED_ANY_MODULES, REQUIRE_ADMINISTRATOR]);
});

test("module permission guard: authenticated user without any required module is forbidden", async () => {
  const { guard } = guardFor({ [REQUIRED_MODULES]: ["finance"] }, [role("sales_operator", ["sales"])]);
  await assert.rejects(() => guard.canActivate(fakeContext({ id: "u-1" })), (error) => error.getResponse().message === "无模块访问权限");
});

test("module permission guard: AND semantics require every declared module", async () => {
  const withBoth = guardFor({ [REQUIRED_MODULES]: ["finance", "hr"] }, [role("finance_operator", ["finance"]), role("hr_operator", ["hr"])]);
  assert.equal(await withBoth.guard.canActivate(fakeContext({ id: "u-1" })), true);

  const withOne = guardFor({ [REQUIRED_MODULES]: ["finance", "hr"] }, [role("finance_operator", ["finance"])]);
  await assert.rejects(() => withOne.guard.canActivate(fakeContext({ id: "u-1" })), (error) => error.getResponse().message === "无模块访问权限");
});

test("module permission guard: ANY semantics require at least one declared module", async () => {
  const hasOne = guardFor({ [REQUIRED_ANY_MODULES]: ["production", "sales", "finance"] }, [role("sales_operator", ["sales"])]);
  assert.equal(await hasOne.guard.canActivate(fakeContext({ id: "u-1" })), true);

  const hasNone = guardFor({ [REQUIRED_ANY_MODULES]: ["production", "sales", "finance"] }, [role("warehouse_operator", ["warehouse"])]);
  await assert.rejects(() => hasNone.guard.canActivate(fakeContext({ id: "u-1" })), (error) => error.getResponse().message === "无模块访问权限");
});

test("module permission guard: class-level modules and method-level ANY are ANDed, not overridden", async () => {
  // 这是最易误解的分支：两者是不同的元数据 key，getAllAndOverride 各自取值，因此**同时生效**。
  // 实测于 /production/payroll-sources：类级 production + 方法级 RequireAnyModules(hr, finance)，
  // 于是只有 hr 权限的用户会被 403（见 docs/test/00-recon-api-contract.md §5.3）。
  const both = guardFor({ [REQUIRED_MODULES]: ["production"], [REQUIRED_ANY_MODULES]: ["hr", "finance"] }, [role("hr_operator", ["production", "hr"])]);
  assert.equal(await both.guard.canActivate(fakeContext({ id: "u-1" })), true);

  const onlyAny = guardFor({ [REQUIRED_MODULES]: ["production"], [REQUIRED_ANY_MODULES]: ["hr", "finance"] }, [role("hr_operator", ["hr"])]);
  await assert.rejects(() => onlyAny.guard.canActivate(fakeContext({ id: "u-1" })), (error) => error.getResponse().message === "无模块访问权限");

  const onlyClass = guardFor({ [REQUIRED_MODULES]: ["production"], [REQUIRED_ANY_MODULES]: ["hr", "finance"] }, [role("production_operator", ["production"])]);
  await assert.rejects(() => onlyClass.guard.canActivate(fakeContext({ id: "u-1" })), (error) => error.getResponse().message === "无模块访问权限");
});

test("module permission guard: administrator role short-circuits every module check", async () => {
  // module-key.ts 的 MODULE_KEYS 不含 administrator —— 它是 role.key，不是 permission.moduleKey。
  const { guard, prisma } = guardFor({ [REQUIRED_MODULES]: ["finance"], [REQUIRE_ADMINISTRATOR]: true }, [{ role: { deletedAt: null, key: "administrator", permissions: [] } }]);
  assert.equal(await guard.canActivate(fakeContext({ id: "admin-1" })), true);
  assert.equal(prisma.queries.length, 1, "管理员短路发生在查权限之后、判定之前");
});

test("module permission guard: RequireAdministrator blocks a module operator", async () => {
  const { guard } = guardFor({ [REQUIRE_ADMINISTRATOR]: true }, [role("production_operator", ["production"])]);
  await assert.rejects(() => guard.canActivate(fakeContext({ id: "u-1" })), (error) => error.getResponse().message === "需要管理员权限");
});

test("module permission guard: missing current user is forbidden even when modules are declared", async () => {
  const { guard, prisma } = guardFor({ [REQUIRED_MODULES]: ["sales"] }, []);
  // 该分支抛的是**裸** ForbiddenException（module-permission.guard.ts:20），响应体是 Nest 默认的
  // 英文字符串 "Forbidden"；机器码 FORBIDDEN 是全局 ApiExceptionFilter 归一化时补上的。
  // 因此这里断言 HTTP 状态，而不是断言 exception 上存在 code。
  await assert.rejects(
    () => guard.canActivate(fakeContext(undefined)),
    (error) => error.getStatus?.() === 403,
  );
  assert.equal(prisma.queries.length, 0, "没有用户时不应查角色");
});

test("module permission guard: soft-deleted roles do not grant permissions", async () => {
  // 守卫把 deletedAt 过滤下推到查询里（module-permission.guard.ts:21）；
  // 这里断言查询条件确实带上了该过滤，避免"逻辑删除的角色仍然授权"。
  const { guard, prisma } = guardFor({ [REQUIRED_MODULES]: ["sales"] }, []);
  await assert.rejects(() => guard.canActivate(fakeContext({ id: "u-1" })), () => true);
  assert.deepEqual(prisma.queries[0].where, { userId: "u-1", role: { deletedAt: null } });
  assert.equal(prisma.queries[0].include.role.include.permissions, true);
});

test("module permission guard: permissions are the union across all of the user's roles", async () => {
  const { guard } = guardFor({ [REQUIRED_MODULES]: ["finance", "hr"] }, [role("finance_operator", ["finance"]), role("hr_operator", ["hr"])]);
  assert.equal(await guard.canActivate(fakeContext({ id: "u-1" })), true);
});

// ---------------------------------------------------------------------------
// 2026-09-19 权限规范：「所有角色都有等同于管理员的实际权限」
//
// 落地方式是给四个表面角色（老板/财务/人事/其他，见 surface-scope.ts）**各授予全部 6 个模块**，
// 守卫逻辑不动。但 @RequireAdministrator() 原本硬编码 `role.key === "administrator"`，
// 数据放行碰不到它——若不补这一条，财务导出等接口会**静默地**只对新角色 403。
// 下面两组用例就是这条不变量的警报器。
// ---------------------------------------------------------------------------

const ALL_MODULES = ["sales", "procurement", "production", "warehouse", "finance", "hr"];

test("module permission guard: a role granted every module counts as administrator-equivalent", () => {
  assert.equal(isAdministratorEquivalent({ key: "administrator", permissions: [] }), true, "administrator 仍然直通，即使没有显式授权行");
  assert.equal(isAdministratorEquivalent({ key: "laoban", permissions: ALL_MODULES.map((moduleKey) => ({ moduleKey })) }), true);
  // 缺一个就不算：这正是"将来要收紧只需删一行授权"的那个开关本身，必须准确。
  assert.equal(isAdministratorEquivalent({ key: "qita", permissions: ALL_MODULES.slice(1).map((moduleKey) => ({ moduleKey })) }), false);
  assert.equal(isAdministratorEquivalent({ key: "qita", permissions: [] }), false);
});

test("module permission guard: RequireAdministrator admits the four surface roles (actual permissions equal administrator)", async () => {
  for (const key of ["laoban", "caiwu", "renshi", "qita"]) {
    const { guard } = guardFor({ [REQUIRE_ADMINISTRATOR]: true }, [role(key, ALL_MODULES)]);
    assert.equal(await guard.canActivate(fakeContext({ id: "u-1" })), true, `${key} 必须通过管理员级校验，否则财务导出这类接口会把新角色挡在门外`);
  }
});

test("module permission guard: a partially-granted role is still blocked by RequireAdministrator", async () => {
  const { guard } = guardFor({ [REQUIRE_ADMINISTRATOR]: true }, [role("qita", ["sales", "hr"])]);
  await assert.rejects(() => guard.canActivate(fakeContext({ id: "u-1" })), (error) => error.getResponse().message === "需要管理员权限");
});

test("module permission guard: the four surface roles also pass class-level module requirements", async () => {
  // 每个表面角色都被授予全部模块，所以 finance/hr 这些类级要求对它们都成立——同一份数据的另一面。
  for (const key of ["laoban", "caiwu", "renshi", "qita"]) {
    const { guard } = guardFor({ [REQUIRED_MODULES]: ["finance", "hr"] }, [role(key, ALL_MODULES)]);
    assert.equal(await guard.canActivate(fakeContext({ id: "u-1" })), true);
  }
});
