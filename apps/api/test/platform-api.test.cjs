const assert = require("node:assert/strict");
const { test } = require("node:test");
const { apiSuccess, paginated } = require("../dist/platform/http/api-contract.js");
const { AuditService } = require("../dist/platform/audit/audit.service.js");

test("success response uses the standard envelope", () => {
  assert.deepEqual(apiSuccess({ status: "ok" }), { data: { status: "ok" }, meta: {} });
});

test("pagination metadata uses the standard field names", () => {
  assert.deepEqual(paginated(["row"], 2, 20, 21), { data: ["row"], meta: { page: 2, page_size: 20, total: 21 } });
});

test("audit helper always takes the server-side current user", () => {
  const audit = new AuditService();
  const user = { id: "1f7d261d-0089-4d32-9aa1-19942c41cb1d", username: "operator", display_name: "操作员" };
  assert.deepEqual(audit.create(user), { createdBy: user.id, updatedBy: user.id });
  assert.equal(audit.activeWhere({ username: "operator" }).deletedAt, null);
});
