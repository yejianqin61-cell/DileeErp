// AuthService 的账号能力单元测试（不连数据库）。
//
// 覆盖 2026-09-19 权限规范新增/收紧的这几条，它们每一条错了都会**安静地**出问题：
//   1) `/auth/me` 的表权限字段（surface_sections / surface_scope / module_keys）——
//      前端菜单与门禁全依赖它，算错不会报错，只会"菜单少一项"或"页面进不去"；
//   2) 自助改姓名/改密码——改密码必须先验旧密码，且**只保留当前会话**；
//   3) 两条防自锁约束（不能改自己的角色、系统至少留一个启用中的老板）——
//      失效的代价是所有人都进不了账号管理中心，只能上服务器改库。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const argon2 = require("argon2");
const { AuthService } = require("../../dist/platform/auth/auth.service.js");

const OLD_PASSWORD = "OldPassw0rd1";
let cachedHash = null;
/** 真实的 argon2 哈希（只算一次）：改密码要过 argon2.verify，假哈希会直接抛错。 */
async function oldPasswordHash() {
  if (!cachedHash) cachedHash = await argon2.hash(OLD_PASSWORD, { type: argon2.argon2id });
  return cachedHash;
}

const row = (overrides = {}) => ({ id: "u-1", username: "caiwu", displayName: "财务小李", isActive: true, createdAt: new Date("2026-09-19T00:00:00Z"), passwordHash: "hash", roles: [], ...overrides });

function build(overrides = {}) {
  const calls = { audits: [], userUpdates: [], sessionDeletes: [], roleGrants: [], userFindManyWhere: null, userCreated: null };
  const prisma = {
    user: {
      findFirst: async () => overrides.user ?? null,
      findMany: async (args) => { calls.userFindManyWhere = args?.where ?? null; return overrides.users ?? []; },
      create: async ({ data }) => { calls.userCreated = data; return row({ id: "new-1", username: data.username, displayName: data.displayName, roles: overrides.createdRoles ?? [] }); },
      update: async ({ where, data }) => { calls.userUpdates.push({ where, data }); return row({ id: where.id, ...data, roles: overrides.updatedRoles ?? [] }); },
      count: async () => overrides.remainingOwners ?? 0,
      findUnique: async () => overrides.exists ?? { id: "u-2" },
    },
    session: {
      findFirst: async () => overrides.session ?? null,
      create: async () => ({}),
      deleteMany: async (args) => { calls.sessionDeletes.push(args); return { count: 1 }; },
    },
    userRole: {
      findMany: async () => overrides.roles ?? [],
      findFirst: async () => overrides.ownerRow ?? null,
      deleteMany: async () => ({}),
      createMany: async ({ data }) => { calls.roleGrants.push(data); return { count: data.length }; },
    },
    role: {
      findMany: async () => overrides.roleRows ?? [],
      findFirst: async () => overrides.ownerRole ?? null,
    },
  };
  // setRoles 走 $transaction：把同一个替身当 tx 传进去就够了（它只用到上面这几个方法）。
  prisma.$transaction = async (fn) => fn(prisma);
  const audit = { record: async (...args) => { calls.audits.push(args); } };
  return { service: new AuthService(prisma, audit), calls };
}

const sessionFor = (user = row()) => ({ session: { user } });
const roleWith = (key, modules = []) => ({ role: { key, permissions: modules.map((moduleKey) => ({ moduleKey })) } });

test("profile: 表面权限由角色算出，并报出实际权限（模块）——人事只看得到人事与账号中心", async () => {
  const { service } = build({ ...sessionFor(), roles: [roleWith("renshi", ["sales", "procurement", "production", "warehouse", "finance", "hr"])] });
  const profile = await service.profile("tok");
  assert.deepEqual(profile.surface_roles, ["renshi"]);
  assert.equal(profile.surface_scope, "hr");
  assert.deepEqual(profile.surface_sections.sort(), ["account", "hr"]);
  assert.deepEqual(profile.role_keys, ["renshi"]);
  assert.equal(profile.module_keys.length, 6, "人事的实际权限也是全部模块：表面权限与实际权限是两件事");
  assert.equal(profile.username, "caiwu");
});

test("profile: 没有任何角色时落到「其他」兜底范围，而不是空权限", async () => {
  const { service } = build({ ...sessionFor(), roles: [] });
  const profile = await service.profile("tok");
  assert.equal(profile.surface_scope, "general");
  assert.ok(profile.surface_sections.includes("dashboard"));
  assert.equal(profile.surface_sections.includes("finance"), false);
});

test("updateOwnDisplayName: 去掉首尾空格后写入，并留审计；空白姓名必须拒绝", async () => {
  const { service, calls } = build();
  await service.updateOwnDisplayName("u-1", "  张三  ");
  assert.deepEqual(calls.userUpdates[0], { where: { id: "u-1" }, data: { displayName: "张三", updatedBy: "u-1" } });
  assert.equal(calls.audits[0][0], "user.profile_updated");

  await assert.rejects(() => service.updateOwnDisplayName("u-1", "   "), (error) => error.getResponse().code === "DISPLAY_NAME_REQUIRED");
});

test("changeOwnPassword: 旧密码不对时报 CURRENT_PASSWORD_INVALID（400，不能是 401）", async () => {
  const { service } = build({ user: row({ passwordHash: await oldPasswordHash() }) });
  // 用 401 的话，前端的会话过期处理会把用户直接踢回登录页——"打错一次旧密码"不该登出。
  await assert.rejects(
    () => service.changeOwnPassword("u-1", "WrongPassw0rd1", "NewPassw0rd1", "tok"),
    (error) => error.getStatus?.() === 400 && error.getResponse().code === "CURRENT_PASSWORD_INVALID",
  );
});

test("changeOwnPassword: 新密码太弱时按弱密码拒绝（且不改任何东西）", async () => {
  const { service, calls } = build({ user: row({ passwordHash: await oldPasswordHash() }) });
  await assert.rejects(() => service.changeOwnPassword("u-1", OLD_PASSWORD, "short1", "tok"), (error) => error.getResponse().code === "WEAK_PASSWORD");
  assert.equal(calls.userUpdates.length, 0, "拒绝时不得写库");
});

test("changeOwnPassword: 改成功时换哈希，并只保留当前会话（其它设备全部失效）", async () => {
  const { service, calls } = build({ user: row({ passwordHash: await oldPasswordHash() }) });
  await service.changeOwnPassword("u-1", OLD_PASSWORD, "NewPassw0rd1", "current-token");
  assert.equal(calls.userUpdates.length, 1);
  assert.notEqual(calls.userUpdates[0].data.passwordHash, await oldPasswordHash(), "必须是新哈希");
  assert.equal(await argon2.verify(calls.userUpdates[0].data.passwordHash, "NewPassw0rd1"), true);
  assert.deepEqual(calls.sessionDeletes, [{ where: { userId: "u-1", tokenHash: { not: require("node:crypto").createHash("sha256").update("current-token").digest("hex") } } }]);
  assert.equal(calls.audits[0][0], "user.password_changed");
});

test("setRoles: 不能改自己的角色（防自锁①）", async () => {
  const { service, calls } = build({ roleRows: [{ id: "r-1", key: "qita" }] });
  await assert.rejects(
    () => service.setRoles("actor-1", ["qita"], "actor-1"),
    (error) => error.getResponse().code === "SELF_ROLE_CHANGE_FORBIDDEN",
  );
  assert.equal(calls.roleGrants.length, 0, "拒绝时不得动角色");
});

test("setRoles: 把最后一个老板降级会被拦住（防自锁②）", async () => {
  const { service } = build({
    roleRows: [{ id: "r-qita", key: "qita" }],
    ownerRole: { id: "r-laoban", key: "laoban" },
    ownerRow: { userId: "u-2", roleId: "r-laoban" },
    remainingOwners: 0,
  });
  await assert.rejects(
    () => service.setRoles("u-2", ["qita"], "actor-1"),
    (error) => error.getResponse().code === "LAST_OWNER_REQUIRED",
  );
});

test("setRoles: 目标本来就不是老板时不触发「最后一个老板」约束", async () => {
  const { service, calls } = build({ roleRows: [{ id: "r-qita", key: "qita" }], ownerRole: { id: "r-laoban", key: "laoban" }, ownerRow: null });
  await service.setRoles("u-9", ["qita"], "actor-1");
  assert.equal(calls.roleGrants.length, 1, "改角色应当落在 user_roles 上");
});

test("setRoles: 角色为空数组要拒绝（账号不能没有角色）", async () => {
  const { service } = build();
  await assert.rejects(() => service.setRoles("u-2", [], "actor-1"), (error) => error.getResponse().code === "ROLE_REQUIRED");
});

test("setUserActive: 停用最后一个老板会被拦住；停用非老板放行并清其会话", async () => {
  const blocked = build({ ownerRole: { id: "r-laoban", key: "laoban" }, ownerRow: { userId: "u-2" }, remainingOwners: 0 });
  await assert.rejects(() => blocked.service.setUserActive("u-2", false, "actor-1"), (error) => error.getResponse().code === "LAST_OWNER_REQUIRED");

  const ok = build({ ownerRole: { id: "r-laoban", key: "laoban" }, ownerRow: null });
  await ok.service.setUserActive("u-5", false, "actor-1");
  assert.deepEqual(ok.calls.sessionDeletes, [{ where: { userId: "u-5" } }], "停用必须让该账号的会话立即失效");
});

test("listUsers: 只列未软删账号，并把角色与表面范围一起带上", async () => {
  const { service, calls } = build({ users: [row({ roles: [roleWith("qita")] })] });
  const users = await service.listUsers();
  assert.deepEqual(calls.userFindManyWhere, { deletedAt: null }, "软删账号不得出现在账号管理中心");
  assert.deepEqual(users[0].surface_roles, ["qita"]);
  assert.equal(users[0].surface_scope, "general");
  assert.equal(users[0].is_active, true);
});

test("createUser: 不指定角色要拒绝，指定后按角色建号并留审计", async () => {
  const noRole = build();
  await assert.rejects(() => noRole.service.createUser({ username: "x", password: "Passw0rd123", displayName: "小张", roleKeys: [] }, "actor-1"), (error) => error.getResponse().code === "ROLE_REQUIRED");

  const ok = build({ roleRows: [{ id: "r-caiwu", key: "caiwu" }], createdRoles: [roleWith("caiwu")] });
  const created = await ok.service.createUser({ username: "caiwu", password: "Passw0rd123", displayName: "财务小李", roleKeys: ["caiwu"] }, "actor-1");
  assert.equal(ok.calls.userCreated.username, "caiwu");
  assert.deepEqual(created.surface_roles, ["caiwu"]);
  assert.equal(ok.calls.audits[0][0], "user.create");
});
