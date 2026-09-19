const assert = require("node:assert/strict");
const { test } = require("node:test");
const { apiSuccess, paginated } = require("../dist/platform/http/api-contract.js");
const { AuditService } = require("../dist/platform/audit/audit.service.js");
const { AuthService } = require("../dist/platform/auth/auth.service.js");
const { HealthController } = require("../dist/health.controller.js");
const { UnauthorizedException, ServiceUnavailableException } = require("@nestjs/common");

test("success response uses the standard envelope", () => {
  assert.deepEqual(apiSuccess({ status: "ok" }), { data: { status: "ok" }, meta: {} });
});

test("pagination metadata uses the standard field names", () => {
  assert.deepEqual(paginated(["row"], 2, 20, 21), { data: ["row"], meta: { page: 2, page_size: 20, total: 21 } });
});

test("audit helper always takes the server-side current user", () => {
  const audit = new AuditService({});
  const user = { id: "1f7d261d-0089-4d32-9aa1-19942c41cb1d", username: "operator", display_name: "操作员" };
  assert.deepEqual(audit.create(user), { createdBy: user.id, updatedBy: user.id });
  assert.equal(audit.activeWhere({ username: "operator" }).deletedAt, null);
});

test("health reports database dependency status", async () => {
  // 第二个 $queryRaw 是 2026-09-16 加的会话时区自检；用 SQL 文本区分两次查询。
  const prismaWith = (timezone) => ({
    $queryRaw: async (strings) => (String(strings.join(" ")).includes("current_setting") ? [{ timezone }] : [{ result: 1 }])
  });
  const healthy = new HealthController(prismaWith("UTC"));
  const health = await healthy.check({});
  assert.equal(health.data.status, "ok");
  assert.equal(health.data.database, "ok");
  assert.equal(health.data.build, process.env.APP_VERSION || "development");
  assert.deepEqual(health.meta, {});
  // 时间列是 TIMESTAMP(3)（无时区）：created_at 按会话时区落盘、updated_at 按 UTC 落盘，
  // 会话时区不是 UTC 时同一行的「创建时间」与「最后修改时间」会差一个时区偏移，
  // 所以 /health 必须能回答「这个库到底是不是 UTC」。
  assert.equal(health.data.timezone, "UTC");
  assert.equal(health.data.timezone_utc, true);
  assert.equal(health.data.display_timezone, "Asia/Shanghai");
  assert.match(health.data.beijing_now, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, "北京时间到秒");

  const skewed = new HealthController(prismaWith("Asia/Shanghai"));
  const skewedHealth = await skewed.check({});
  assert.equal(skewedHealth.data.timezone, "Asia/Shanghai");
  assert.equal(skewedHealth.data.timezone_utc, false, "非 UTC 必须如实报 false，不能因为「能起来」就报 ok");

  const unavailable = new HealthController({ $queryRaw: async () => { throw new Error("offline"); } });
  await assert.rejects(() => unavailable.check({}), ServiceUnavailableException);
});

test("login failures are generic and temporarily throttled", async () => {
  const auth = new AuthService({ user: { findFirst: async () => null } }, { record: async () => {} });
  for (let attempt = 0; attempt < 5; attempt += 1) await assert.rejects(() => auth.login("unknown", "bad-password"), UnauthorizedException);
  await assert.rejects(() => auth.login("unknown", "bad-password"), /登录失败次数过多/);
});
