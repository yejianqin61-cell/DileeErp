const assert = require("node:assert/strict");
const { test } = require("node:test");
const { apiClient } = require("../../../../tests/helpers/api-client.cjs");

const baseUrl = process.env.API_BASE_URL;

test("platform.health.returns_the_standard_json_envelope", async () => {
  const response = await apiClient(baseUrl).request("/api/v1/health");
  assert.equal(response.status, 200);
  assert.equal(response.body.data.status, "ok");
  assert.equal(response.body.data.database, "ok");
  assert.deepEqual(response.body.meta, {});
  assert.ok(response.requestId);
});

test("platform.protected_routes.reject_anonymous_requests_with_standard_error", async () => {
  const response = await apiClient(baseUrl).request("/api/v1/customers");
  assert.equal(response.status, 401);
  assert.ok(response.body.error);
  assert.ok(response.body.error.code);
  assert.ok(response.requestId);
});
