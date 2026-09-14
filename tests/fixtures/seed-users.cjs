// 测试用户与 RBAC 种子。
//
// 解决什么问题（见 docs/test/01-test-master-plan.md §2.2 S4）：
//   改造前只有 tests/fixtures/test-users.cjs —— 一张 23 行的角色常量表，**零引用**（死夹具）。
//   结果是权限维度（401 / 403 / 模块隔离 / 管理员短路）在整个仓库中没有任何测试：
//   ModulePermissionGuard 被 34 个控制器使用，却从未被验证过。
//
// 角色设计（对齐 docs/design/testing-system-and-tooling-plan.md:120-126）：
//   sales_operator / procurement_operator / warehouse_operator / finance_operator / administrator
//   外加一个**没有任何模块权限**的登录用户，用于断言 403「无模块访问权限」。
//
// 隔离策略：
//   - 操作员角色用 run 后缀（如 sales_operator-ab12cd34），互不干扰，测试后即可删除；
//   - administrator 是共享角色（守卫按 role.key === "administrator" 短路），只 upsert、不删除。
//   - 用户同样用 run 后缀，避免与真实/其他测试用户撞 username 唯一约束。
const { createHash, randomBytes, randomUUID } = require("node:crypto");
const argon2 = require("argon2");
const { testRun } = require("../helpers/test-context.cjs");

/** 满足密码策略：≥10 位且同时含字母与数字（auth.service.ts:11,117-120）。 */
const TEST_PASSWORD = "DileeTest2026";

/** 默认会话有效期，与 auth.service.ts:8 的 12 小时一致。 */
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;

/** 与 auth.service.ts:122 保持一致的 token 摘要算法。 */
const hashToken = (token) => createHash("sha256").update(token).digest("hex");

/** 各测试角色对应的模块权限；null 表示不给任何模块权限。 */
const ROLE_DEFINITIONS = {
  administrator: { modules: null, shared: true },
  sales: { modules: ["sales"] },
  procurement: { modules: ["procurement"] },
  warehouse: { modules: ["warehouse"] },
  finance: { modules: ["finance"] },
  production: { modules: ["production"] },
  hr: { modules: ["hr"] },
  noModule: { modules: [] },
};

/**
 * 创建测试用户集合。
 *
 * @param {object} prisma 绑定到测试库的 PrismaClient
 * @param {object} [options]
 * @param {string} [options.prefix] 用户名/角色 key 的 run 前缀
 * @returns {Promise<{ run: object, password: string, users: Record<string, object>, credentials: Record<string, {username: string, roleKey: string|null, password: string}> }>}
 */
async function seedTestUsers(prisma, { prefix = "testuser" } = {}) {
  const run = testRun(prefix);
  const actorId = randomUUID();
  const audit = { createdBy: actorId, updatedBy: actorId };
  const passwordHash = await argon2.hash(TEST_PASSWORD, { type: argon2.argon2id });

  const users = {};
  const credentials = {};
  const createdRoleKeys = [];

  for (const [name, definition] of Object.entries(ROLE_DEFINITIONS)) {
    const roleKey = definition.shared ? "administrator" : `${name}_operator-${run.id}`;
    const role = await prisma.role.upsert({
      where: { key: roleKey },
      update: { name: `测试角色-${name}`, updatedBy: actorId },
      create: { id: randomUUID(), key: roleKey, name: `测试角色-${name}`, ...audit },
    });
    if (!definition.shared) createdRoleKeys.push(roleKey);

    // 模块权限按 (roleKey, moduleKey) 组合主键写入；administrator 靠 role.key 短路，不需要权限行。
    for (const moduleKey of definition.modules ?? []) {
      await prisma.rolePermission.upsert({
        where: { roleKey_moduleKey: { roleKey, moduleKey } },
        update: { updatedBy: actorId },
        create: { roleKey, moduleKey, ...audit },
      });
    }

    const username = `${name}-${run.id}`;
    const user = await prisma.user.create({
      data: { id: randomUUID(), username, passwordHash, displayName: `测试-${name}`, isActive: true, ...audit },
    });
    await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });

    users[name] = user;
    credentials[name] = { password: TEST_PASSWORD, roleKey: definition.shared ? null : roleKey, username };
  }

  /**
   * 为已种子用户建立真实会话，返回可直接放进 Cookie 的 token。
   *
   * 走 DB 而不是 HTTP：适用于直接调用 service 的集成测试。
   * 需要走真实登录链路（校验限流、Cookie 属性、Set-Cookie）时用 S9 的 api-client 登录。
   */
  async function createSession(userName, { ttlMs = SESSION_TTL_MS } = {}) {
    const user = users[userName];
    if (!user) throw new Error(`unknown seeded user "${userName}"; available: ${Object.keys(users).join(", ")}`);
    const token = randomBytes(32).toString("base64url");
    await prisma.session.create({
      data: { tokenHash: hashToken(token), userId: user.id, expiresAt: new Date(Date.now() + ttlMs), createdBy: user.id, updatedBy: user.id },
    });
    return { cookie: cookieHeader(token), token, user };
  }

  /** 删除本次种子产生的会话、用户、角色权限与角色（administrator 保留）。 */
  async function cleanup() {
    const failures = [];
    const userIds = Object.values(users).map((user) => user.id);
    const steps = [
      () => prisma.session.deleteMany({ where: { userId: { in: userIds } } }),
      () => prisma.userRole.deleteMany({ where: { userId: { in: userIds } } }),
      () => prisma.user.deleteMany({ where: { id: { in: userIds } } }),
      () => (createdRoleKeys.length ? prisma.rolePermission.deleteMany({ where: { roleKey: { in: createdRoleKeys } } }) : Promise.resolve()),
      () => (createdRoleKeys.length ? prisma.role.deleteMany({ where: { key: { in: createdRoleKeys } } }) : Promise.resolve()),
    ];
    for (const step of steps) {
      try {
        await step();
      } catch (error) {
        failures.push(error.message);
      }
    }
    if (failures.length) throw new Error(`test user cleanup failed for ${run.id} -> ${failures.join(" | ")}`);
  }

  return { cleanup, createSession, credentials, password: TEST_PASSWORD, run, users };
}

/** 组装 Cookie 请求头，与 auth.controller.ts:13 的 Cookie 名保持一致。 */
function cookieHeader(token) {
  return `dilee_session=${token}`;
}

/**
 * 直接以某个用户的身份构造已认证请求所需的 Cookie。
 * 与 createSession 的区别：本函数要求调用方自己已经有 userId，用于复用既有会话。
 */
function sessionCookie(token) {
  return { Cookie: cookieHeader(token) };
}

module.exports = { ROLE_DEFINITIONS, SESSION_TTL_MS, TEST_PASSWORD, cookieHeader, hashToken, seedTestUsers, sessionCookie };
