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
  const healthy = new HealthController({ $queryRaw: async () => [{ result: 1 }] });
  const health = await healthy.check({});
  assert.deepEqual(health.data, { status: "ok", database: "ok", build: process.env.APP_VERSION || "development" });
  assert.deepEqual(health.meta, {});
  const unavailable = new HealthController({ $queryRaw: async () => { throw new Error("offline"); } });
  await assert.rejects(() => unavailable.check({}), ServiceUnavailableException);
});

test("login failures are generic and temporarily throttled", async () => {
  const auth = new AuthService({ user: { findFirst: async () => null } }, { record: async () => {} });
  for (let attempt = 0; attempt < 5; attempt += 1) await assert.rejects(() => auth.login("unknown", "bad-password"), UnauthorizedException);
  await assert.rejects(() => auth.login("unknown", "bad-password"), /登录失败次数过多/);
});
