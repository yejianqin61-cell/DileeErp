// 两档数据档位判定的单元测试（require 编译产物 dist，不连数据库）。
//
// 档位是业务查询 Agent 的数据安全核心：`laoban/caiwu` → full（可见财务事实），
// 其他有效角色（qita/renshi/administrator 等）→ operational（只见非财务事实），无角色 → 拒绝。
// 依据：docs/design/business-query-agent-v0-architecture-2026-10-23.md「两档权限如何判定」。
// 注意 `administrator` 不因现有模块全授权而取得 full —— 它只是表面权限的"最高"，不是数据档位的 full。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { resolveAccessLevel } = require("../../dist/modules/business-query-agent/access-level.js");
const { QueryPermissionGuard } = require("../../dist/modules/business-query-agent/query-permission.guard.js");

test("resolveAccessLevel：laoban/caiwu 及多角色取最高档 → full", () => {
  assert.equal(resolveAccessLevel(["laoban"]), "full");
  assert.equal(resolveAccessLevel(["caiwu"]), "full");
  assert.equal(resolveAccessLevel(["qita", "laoban"]), "full");
});

test("resolveAccessLevel：qita/renshi/administrator → operational（administrator 不是 full）", () => {
  assert.equal(resolveAccessLevel(["qita"]), "operational");
  assert.equal(resolveAccessLevel(["renshi"]), "operational");
  assert.equal(resolveAccessLevel(["administrator"]), "operational");
});

test("resolveAccessLevel：无有效角色 → denied（角色 key 来自 roles 表，读取器只会回表内有效角色）", () => {
  assert.equal(resolveAccessLevel([]), "denied");
});

/** 假角色读取器：记录 userId，按预设返回角色 key。 */
function fakeRoleReader(roleKeys, { fail = false } = {}) {
  const seen = [];
  return {
    seen,
    async readActiveRoleKeys(userId) {
      seen.push(userId);
      if (fail) throw new Error("role lookup failed");
      return roleKeys;
    },
  };
}

const fakeContext = (request) => ({ switchToHttp: () => ({ getRequest: () => request }) });

test("QueryPermissionGuard：laoban 用户拿到 full 档位，且每次请求都重查角色（不缓存）", async () => {
  const reader = fakeRoleReader(["laoban"]);
  const guard = new QueryPermissionGuard(reader);
  const request = { currentUser: { id: "u-1", username: "boss", display_name: "老板" } };

  assert.equal(await guard.canActivate(fakeContext(request)), true);
  assert.deepEqual(reader.seen, ["u-1"], "守卫必须按当前请求重查角色");
  assert.equal(request.agentPrincipal.accessLevel, "full");
  assert.equal(request.agentPrincipal.user.id, "u-1");
});

test("QueryPermissionGuard：无有效角色 → 403 AGENT_ACCESS_DENIED，principal 不落 request", async () => {
  const guard = new QueryPermissionGuard(fakeRoleReader([]));
  const request = { currentUser: { id: "u-2", username: "ghost", display_name: "无角色" } };

  await assert.rejects(
    guard.canActivate(fakeContext(request)),
    (error) => error.getStatus() === 403 && error.getResponse().code === "AGENT_ACCESS_DENIED",
  );
  assert.equal(request.agentPrincipal, undefined, "拒绝时不得挂 principal，后续路由拿不到档位");
});

test("QueryPermissionGuard：未登录（无 currentUser）→ 401，不查角色", async () => {
  const reader = fakeRoleReader(["laoban"]);
  const guard = new QueryPermissionGuard(reader);
  const request = {};

  await assert.rejects(
    guard.canActivate(fakeContext(request)),
    (error) => error.getStatus() === 401,
  );
  assert.deepEqual(reader.seen, [], "未登录连角色都不该查");
});
