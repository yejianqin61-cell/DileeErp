// AuthenticationGuard 单元测试。
//
// recon 指出该守卫被 34 个控制器使用、同样零测试（docs/test/00-recon-backend-coverage.md D6）。
// 它只有 15 行，但承担一个关键契约：**只认 Cookie `dilee_session`，不认 Authorization: Bearer**
// （authentication.guard.ts:12）。这条来自 docs/test/00-recon-api-contract.md:268 —— 旧测试工具曾用
// Bearer 头，导致"带 token 的调用"其实一直是匿名请求。本文件把该契约固定下来。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { AuthenticationGuard } = require("../../dist/platform/authorization/authentication.guard.js");

/** 假的 AuthService：记录收到的 token，并按预设决定成功或抛 401。 */
function fakeAuth({ user = { display_name: "测试", id: "u-1", username: "tester" }, fail = false } = {}) {
  const seen = [];
  return {
    seen,
    async currentUser(token) {
      seen.push(token);
      if (fail) {
        const { UnauthorizedException } = require("@nestjs/common");
        throw new UnauthorizedException();
      }
      return user;
    },
  };
}

const fakeContext = (request) => ({ switchToHttp: () => ({ getRequest: () => request }) });

test("authentication guard: reads the session token from the dilee_session cookie and attaches the current user", async () => {
  const auth = fakeAuth();
  const guard = new AuthenticationGuard(auth);
  const request = { cookies: { dilee_session: "tok-abc" } };

  assert.equal(await guard.canActivate(fakeContext(request)), true);
  assert.deepEqual(auth.seen, ["tok-abc"]);
  assert.equal(request.currentUser.id, "u-1", "守卫必须把用户挂到 request.currentUser 供后续守卫/装饰器使用");
});

test("authentication guard: ignores Authorization: Bearer entirely", async () => {
  // 关键契约：Bearer 头不参与鉴权。若哪天改成也认 Bearer，本用例会失败并提醒同步前端与测试工具。
  const auth = fakeAuth();
  const guard = new AuthenticationGuard(auth);
  const request = { cookies: {}, headers: { authorization: "Bearer tok-from-header" } };

  await guard.canActivate(fakeContext(request));
  assert.deepEqual(auth.seen, [undefined], "只应把 Cookie 值传给 currentUser；Bearer 头不得被读取");
});

test("authentication guard: missing cookie passes undefined so AuthService raises 401", async () => {
  const auth = fakeAuth();
  const guard = new AuthenticationGuard(auth);
  const request = {};

  await guard.canActivate(fakeContext(request));
  assert.deepEqual(auth.seen, [undefined], "没有 cookies 对象时不应抛 TypeError，而要交给 AuthService 判定 401");
});

test("authentication guard: propagates the 401 from AuthService and never returns true", async () => {
  const guard = new AuthenticationGuard(fakeAuth({ fail: true }));
  const request = { cookies: { dilee_session: "expired" } };

  await assert.rejects(() => guard.canActivate(fakeContext(request)), (error) => error.getStatus?.() === 401);
  assert.equal(request.currentUser, undefined, "鉴权失败不得写入 currentUser");
});
